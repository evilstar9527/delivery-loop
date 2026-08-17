import { z } from 'zod';
import type { Bindings } from '../../../env.js';
import type {
  ExecutionHandle,
  ExecutorCancelReason,
  ExecutorProfile,
  VerifiedExecutorIdentity,
} from '../../core/executor-plugin.js';
import type {
  CloudflareSandboxProviderFact,
  CloudflareSandboxStartRequest,
  CloudflareSandboxStartResult,
} from '../../cloudflare-worker/protocol.js';
import type { CloudflareSandboxExecutorEffects } from './cloudflare-sandbox-plugin.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const StartResultSchema: z.ZodType<CloudflareSandboxStartResult & { schemaVersion: '1' }> =
  z.object({
    schemaVersion: z.literal('1'),
    disposition: z.enum(['created', 'existing']),
    sandboxId: z.string().regex(ID_PATTERN),
    containerId: z.string().min(1).max(500),
  }).strict();

const ProviderFactSchema: z.ZodType<CloudflareSandboxProviderFact & { schemaVersion: '1' }> =
  z.object({
    schemaVersion: z.literal('1'),
    status: z.enum(['requested', 'queued', 'running', 'succeeded', 'failed', 'cancelled']),
    externalUpdatedAt: z.string().datetime({ offset: true }),
    exitCode: z.number().int().nullable(),
    imageDigest: z.string().regex(DIGEST_PATTERN),
  }).strict();

const CancelResultSchema = z.object({
  schemaVersion: z.literal('1'),
  disposition: z.enum(['cancelled', 'already_terminal']),
}).strict();

function httpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Cloudflare Sandbox runtime URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) throw new Error('Cloudflare Sandbox runtime URL is invalid');
  return url.origin;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || response.body === null) {
    await response.body?.cancel();
    throw new Error('executor response is invalid');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw new Error('executor response is too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('executor response is too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('executor response is invalid');
  }
}

export interface CloudflareSandboxWorkerEffectsOptions {
  binding?: Fetcher;
  workerOrigin?: string;
  controlToken: string;
  callbackToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Authenticated, bounded transport from the control plane to the Executor Worker. */
export class CloudflareSandboxWorkerEffects implements CloudflareSandboxExecutorEffects {
  private readonly binding: Fetcher | undefined;
  private readonly configuredOrigin: string | undefined;
  private readonly controlToken: string;
  private readonly callbackToken: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: CloudflareSandboxWorkerEffectsOptions) {
    if ((options.binding === undefined) === (options.workerOrigin === undefined)) {
      throw new Error('Cloudflare Sandbox runtime must configure exactly one transport');
    }
    if (options.controlToken.length < 16 || options.controlToken.length > 4_096) {
      throw new Error('Cloudflare Sandbox runtime control token is invalid');
    }
    this.binding = options.binding;
    this.configuredOrigin = options.workerOrigin === undefined
      ? undefined
      : httpsOrigin(options.workerOrigin);
    this.controlToken = options.controlToken;
    this.callbackToken = options.callbackToken;
    if (
      this.callbackToken !== undefined &&
      (this.callbackToken.length < 16 || this.callbackToken.length > 4_096)
    ) throw new Error('Cloudflare Sandbox runtime callback token is invalid');
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
      throw new Error('Cloudflare Sandbox runtime timeout is invalid');
    }
    if (
      !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0 ||
      this.maxResponseBytes > MAX_RESPONSE_BYTES
    ) throw new Error('Cloudflare Sandbox runtime response limit is invalid');
  }

  async ensureSandbox(
    workerOrigin: string,
    request: CloudflareSandboxStartRequest,
  ): Promise<CloudflareSandboxStartResult> {
    const response = await this.request(workerOrigin, '/v1/executions/ensure', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const parsed = StartResultSchema.safeParse(response);
    if (!parsed.success) throw new Error('executor response is invalid');
    return {
      disposition: parsed.data.disposition,
      sandboxId: parsed.data.sandboxId,
      containerId: parsed.data.containerId,
    };
  }

  async observeSandbox(
    workerOrigin: string,
    sandboxId: string,
  ): Promise<CloudflareSandboxProviderFact> {
    if (!ID_PATTERN.test(sandboxId)) throw new Error('executor request identity is invalid');
    const response = await this.request(
      workerOrigin,
      `/v1/executions/${encodeURIComponent(sandboxId)}/observe`,
      { method: 'GET' },
    );
    const parsed = ProviderFactSchema.safeParse(response);
    if (!parsed.success) throw new Error('executor response is invalid');
    return {
      status: parsed.data.status,
      externalUpdatedAt: parsed.data.externalUpdatedAt,
      exitCode: parsed.data.exitCode,
      imageDigest: parsed.data.imageDigest,
    };
  }

  async cancelSandbox(
    workerOrigin: string,
    sandboxId: string,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    if (!ID_PATTERN.test(sandboxId)) throw new Error('executor request identity is invalid');
    const response = await this.request(
      workerOrigin,
      `/v1/executions/${encodeURIComponent(sandboxId)}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
    const parsed = CancelResultSchema.safeParse(response);
    if (!parsed.success) throw new Error('executor response is invalid');
    return parsed.data.disposition;
  }

  async verifySandboxIdentity(
    profile: ExecutorProfile,
    handle: ExecutionHandle,
    payload: unknown,
  ): Promise<VerifiedExecutorIdentity> {
    if (this.callbackToken === undefined) {
      throw new Error('executor identity verification is unavailable');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('executor identity assertion is invalid');
    }
    const assertion = payload as Record<string, unknown>;
    if (
      Object.keys(assertion).length !== 3 ||
      typeof assertion.authorization !== 'string' ||
      typeof assertion.executionId !== 'string' ||
      typeof assertion.containerId !== 'string' ||
      assertion.executionId !== handle.executionId ||
      assertion.containerId !== handle.attributes.containerId ||
      profile.profileId !== handle.profileId ||
      !await bearerMatches(assertion.authorization, this.callbackToken)
    ) throw new Error('executor identity assertion is invalid');
    return {
      schemaVersion: '1',
      kind: handle.kind,
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      leaseGeneration: handle.leaseGeneration,
      role: handle.role,
      repository: handle.repository,
      providerSubject: `cloudflare-sandbox:${assertion.containerId}`,
    };
  }

  private async request(
    workerOrigin: string,
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
  ): Promise<unknown> {
    const origin = httpsOrigin(workerOrigin);
    if (this.configuredOrigin !== undefined && origin !== this.configuredOrigin) {
      throw new Error('executor request origin is not configured');
    }
    const controller = new AbortController();
    const request = new Request(`${origin}${path}`, {
      method: init.method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.controlToken}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'manual',
      signal: controller.signal,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('executor request timed out'));
      }, this.timeoutMs);
    });
    let response: Response;
    try {
      response = await Promise.race([
        this.binding === undefined ? this.fetcher(request) : this.binding.fetch(request),
        deadline,
      ]);
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'executor request timed out') throw cause;
      throw new Error('executor request failed');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404) throw new Error('executor request was not found');
      if (response.status === 409) throw new Error('executor request conflicted');
      throw new Error('executor request was rejected');
    }
    return await readBoundedJson(response, this.maxResponseBytes);
  }
}

export function cloudflareSandboxEffectsFromEnv(
  env: Pick<Bindings,
    | 'AGENT_EXECUTOR'
    | 'AGENT_EXECUTOR_URL'
    | 'AGENT_EXECUTOR_CONTROL_TOKEN'
    | 'AGENT_EXECUTOR_CALLBACK_TOKEN'>,
): CloudflareSandboxWorkerEffects | null {
  const hasBinding = env.AGENT_EXECUTOR !== undefined;
  const hasUrl = env.AGENT_EXECUTOR_URL !== undefined;
  const hasToken = env.AGENT_EXECUTOR_CONTROL_TOKEN !== undefined;
  if (!hasBinding && !hasUrl && !hasToken) return null;
  if (hasBinding && hasUrl) {
    throw new Error('Cloudflare Sandbox runtime configuration mixes transports');
  }
  if ((!hasBinding && !hasUrl) || !hasToken) {
    throw new Error('Cloudflare Sandbox runtime configuration is incomplete');
  }
  if (hasBinding) {
    return new CloudflareSandboxWorkerEffects({
      binding: env.AGENT_EXECUTOR!,
      controlToken: env.AGENT_EXECUTOR_CONTROL_TOKEN!,
      ...(env.AGENT_EXECUTOR_CALLBACK_TOKEN === undefined
        ? {}
        : { callbackToken: env.AGENT_EXECUTOR_CALLBACK_TOKEN }),
    });
  }
  return new CloudflareSandboxWorkerEffects({
    workerOrigin: env.AGENT_EXECUTOR_URL!,
    controlToken: env.AGENT_EXECUTOR_CONTROL_TOKEN!,
    ...(env.AGENT_EXECUTOR_CALLBACK_TOKEN === undefined
      ? {}
      : { callbackToken: env.AGENT_EXECUTOR_CALLBACK_TOKEN }),
  });
}

async function bearerMatches(header: string, expected: string): Promise<boolean> {
  if (!header.startsWith('Bearer ')) return false;
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
  ]);
  const actual = new Uint8Array(actualDigest);
  const wanted = new Uint8Array(expectedDigest);
  let difference = actual.length ^ wanted.length;
  for (let index = 0; index < wanted.length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (wanted[index] ?? 0);
  }
  return difference === 0;
}
