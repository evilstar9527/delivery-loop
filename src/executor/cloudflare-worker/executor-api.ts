import { z } from 'zod';
import type { ExecutorCancelReason } from '../core/executor-plugin.js';
import type {
  CloudflareSandboxProviderFact,
  CloudflareSandboxStartRequest,
  CloudflareSandboxStartResult,
} from './protocol.js';

const MAX_BODY_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

const HttpsOriginSchema = z.string().max(500).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '' && (url.pathname === '' || url.pathname === '/');
  } catch {
    return false;
  }
});

const StartRequestSchema: z.ZodType<CloudflareSandboxStartRequest> = z.object({
  schemaVersion: z.literal('1'),
  profileId: z.string().regex(ID_PATTERN),
  releaseDigest: z.string().regex(DIGEST_PATTERN),
  executionId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  attemptId: z.string().regex(ID_PATTERN),
  leaseGeneration: z.number().int().positive(),
  role: z.enum(['work', 'publisher']),
  mode: z.enum(['analysis', 'implement', 'review_fix']),
  imageRef: z.string().min(1).max(500),
  taskDigest: z.string().regex(DIGEST_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  checkoutSha: z.string().regex(SHA_PATTERN),
  targetBaseBranch: z.string().min(1).max(255).refine((value) => !value.includes('..')),
  controlPlaneUrl: HttpsOriginSchema,
  planVersion: z.number().int().positive().optional(),
  planItemId: z.string().regex(ID_PATTERN).optional(),
  modelProfileId: z.string().regex(ID_PATTERN).optional(),
  patchArtifactId: z.string().regex(ID_PATTERN).optional(),
}).strict().refine(
  (value) => (value.role === 'publisher') === (value.patchArtifactId !== undefined),
  { message: 'publisher patch binding is invalid' },
);

const CancelRequestSchema = z.object({
  reason: z.enum(['lease_expired', 'run_cancelled', 'superseded', 'policy_revoked']),
}).strict();

const ProviderFactSchema: z.ZodType<CloudflareSandboxProviderFact> = z.object({
  status: z.enum(['requested', 'queued', 'running', 'succeeded', 'failed', 'cancelled']),
  externalUpdatedAt: z.string().datetime({ offset: true }),
  exitCode: z.number().int().nullable(),
  imageDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

export interface CloudflareSandboxExecutorBackend {
  ensure(request: CloudflareSandboxStartRequest): Promise<CloudflareSandboxStartResult>;
  observe(executionId: string): Promise<CloudflareSandboxProviderFact>;
  cancel(
    executionId: string,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'>;
}

export type CloudflareExecutorBackendErrorCode =
  | 'execution_not_found'
  | 'execution_binding_conflict'
  | 'execution_not_started';

export class CloudflareExecutorBackendError extends Error {
  constructor(readonly code: CloudflareExecutorBackendErrorCode) {
    super(`Cloudflare executor backend failed: ${code}`);
    this.name = 'CloudflareExecutorBackendError';
  }
}

export interface CloudflareSandboxExecutorHandlerOptions {
  controlToken: string;
  configuredImageRef: string;
  backend: CloudflareSandboxExecutorBackend;
}

class RequestBodyError extends Error {
  constructor(readonly kind: 'invalid' | 'too_large') {
    super(kind);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  });
}

function error(code: string, status: number): Response {
  return json({ error: { code } }, status);
}

async function timingSafeTokenMatches(header: string | null, expected: string): Promise<boolean> {
  if (!header?.startsWith('Bearer ') || expected.length < 16 || expected.length > 4_096) {
    return false;
  }
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
  ]);
  const actual = new Uint8Array(actualDigest);
  const wanted = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (wanted[index] ?? 0);
  }
  return difference === 0;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || request.body === null) {
    throw new RequestBodyError('invalid');
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestBodyError('too_large');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyError('too_large');
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
    throw new RequestBodyError('invalid');
  }
}

function backendFailure(cause: unknown): Response {
  if (cause instanceof CloudflareExecutorBackendError) {
    if (cause.code === 'execution_not_found') return error(cause.code, 404);
    return error(cause.code, 409);
  }
  return error('sandbox_unavailable', 503);
}

/** Strict, Secret-free HTTP facade for the independent executor Worker. */
export function createCloudflareSandboxExecutorHandler(
  options: CloudflareSandboxExecutorHandlerOptions,
): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/healthz' && request.method === 'GET') {
        return json({ ok: true, service: 'delivery-loop-agent-executor' });
      }
      if (!await timingSafeTokenMatches(
        request.headers.get('authorization'),
        options.controlToken,
      )) return error('invalid_auth', 401);

      if (url.pathname === '/v1/executions/ensure' && request.method === 'POST') {
        try {
          const parsed = StartRequestSchema.safeParse(await readBoundedJson(request));
          if (!parsed.success) return error('invalid_argument', 400);
          if (parsed.data.imageRef !== options.configuredImageRef) {
            return error('image_binding_conflict', 409);
          }
          const result = await options.backend.ensure(parsed.data);
          return json({ schemaVersion: '1', ...result });
        } catch (cause) {
          if (cause instanceof RequestBodyError) {
            return cause.kind === 'too_large'
              ? error('payload_too_large', 413)
              : error('invalid_argument', 400);
          }
          return backendFailure(cause);
        }
      }

      const match = /^\/v1\/executions\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,255})\/(observe|cancel)$/.exec(
        url.pathname,
      );
      if (match === null) return error('not_found', 404);
      const executionId = match[1];
      const operation = match[2];
      if (executionId === undefined || operation === undefined) return error('not_found', 404);
      try {
        if (operation === 'observe' && request.method === 'GET') {
          const fact = ProviderFactSchema.safeParse(await options.backend.observe(executionId));
          return fact.success
            ? json({ schemaVersion: '1', ...fact.data })
            : error('sandbox_unavailable', 503);
        }
        if (operation === 'cancel' && request.method === 'POST') {
          const parsed = CancelRequestSchema.safeParse(await readBoundedJson(request));
          if (!parsed.success) return error('invalid_argument', 400);
          const disposition = await options.backend.cancel(executionId, parsed.data.reason);
          return json({ schemaVersion: '1', disposition });
        }
        return error('method_not_allowed', 405);
      } catch (cause) {
        if (cause instanceof RequestBodyError) {
          return cause.kind === 'too_large'
            ? error('payload_too_large', 413)
            : error('invalid_argument', 400);
        }
        return backendFailure(cause);
      }
    },
  };
}
