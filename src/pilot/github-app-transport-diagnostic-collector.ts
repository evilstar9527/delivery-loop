import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubAppTransportDiagnosticCollectionRequestV1Schema,
  GitHubAppTransportDiagnosticLogRecordV1Schema,
  GitHubAppTransportDiagnosticObservationV2Schema,
  type GitHubAppTransportDiagnosticCollectionRequestV1,
  type GitHubAppTransportDiagnosticObservationV2,
} from '../domain/github-app-transport-diagnostic-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{8,2000}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const HTTP_TIMEOUT_MS = 10_000;

export type GitHubAppTransportDiagnosticCollectionErrorCode =
  | 'request_invalid'
  | 'configuration_invalid'
  | 'cloudflare_api_unavailable'
  | 'cloudflare_response_invalid'
  | 'cloudflare_log_absent'
  | 'cloudflare_log_ambiguous'
  | 'cloudflare_log_envelope_mismatch'
  | 'cloudflare_log_source_mismatch'
  | 'cloudflare_log_time_mismatch'
  | 'secret_leak_detected';

export class GitHubAppTransportDiagnosticCollectionError extends Error {
  constructor(readonly code: GitHubAppTransportDiagnosticCollectionErrorCode) {
    super(`GitHub App transport diagnostic collection failed: ${code}`);
    this.name = 'GitHubAppTransportDiagnosticCollectionError';
  }
}

export interface GitHubAppTransportDiagnosticCollectorOptions {
  githubToken: string;
  cloudflareDeploymentReadToken: string;
  cloudflareObservabilityToken: string;
  cloudflareAccountId: string;
  canary: string;
  cloudflareApiOrigin?: string;
  fetcher?: typeof fetch;
}

function fail(code: GitHubAppTransportDiagnosticCollectionErrorCode): never {
  throw new GitHubAppTransportDiagnosticCollectionError(code);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = parent[key];
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { fail('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) fail('configuration_invalid');
  return url.origin;
}

function responseSizeValid(response: Response): boolean {
  const header = response.headers.get('content-length');
  if (header === null) return true;
  const declared = Number(header);
  return Number.isSafeInteger(declared) && declared >= 0 && declared <= MAX_RESPONSE_BYTES;
}

async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function externalJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch { fail('cloudflare_api_unavailable'); }
  if (!response.ok) {
    await response.body?.cancel();
    fail('cloudflare_api_unavailable');
  }
  if (
    !responseSizeValid(response) ||
    /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    fail('cloudflare_response_invalid');
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { fail('cloudflare_response_invalid'); }
  if (text === null) fail('cloudflare_response_invalid');
  if (scanner.scanText(text, '$.cloudflare').length > 0) fail('secret_leak_detected');
  try { return JSON.parse(text) as unknown; }
  catch { fail('cloudflare_response_invalid'); }
}

function telemetryBody(
  request: GitHubAppTransportDiagnosticCollectionRequestV1,
): Record<string, unknown> {
  return {
    queryId: request.collectionId,
    view: 'events',
    dry: true,
    timeframe: {
      from: Date.parse(request.cloudflare.window.from),
      to: Date.parse(request.cloudflare.window.to),
    },
    limit: 2,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$metadata.service', operation: 'eq', type: 'string',
          value: request.cloudflare.scriptName },
        { key: 'event', operation: 'eq', type: 'string',
          value: 'github_app_installation_token_transport_failed' },
        { key: 'component', operation: 'eq', type: 'string',
          value: 'github_app_credential' },
        { key: 'operation', operation: 'eq', type: 'string',
          value: 'installation_token_exchange' },
        { key: 'requestAttempts', operation: 'eq', type: 'number', value: 1 },
      ],
      groupBys: [],
      calculations: [],
    },
  };
}

async function collectObservation(
  raw: unknown,
  accountId: string,
  request: GitHubAppTransportDiagnosticCollectionRequestV1,
): Promise<GitHubAppTransportDiagnosticObservationV2> {
  const root = record(raw);
  const result = root === null ? null : record(root.result);
  const run = result === null ? null : record(result.run);
  if (
    root === null || result === null || run === null || root.success !== true ||
    !Array.isArray(root.errors) || root.errors.length !== 0 ||
    !Array.isArray(root.messages) || run.accountId !== accountId || run.dry !== true
  ) fail('cloudflare_response_invalid');
  const group = record(result.events);
  if (group === null) fail('cloudflare_response_invalid');
  const events = records(group, 'events');
  if (group.count === 0 && events.length === 0) fail('cloudflare_log_absent');
  if (
    (typeof group.count === 'number' && group.count > 1) || events.length > 1
  ) fail('cloudflare_log_ambiguous');
  if (group.count !== 1 || events.length !== 1) fail('cloudflare_response_invalid');
  const event = events[0]!;
  const metadata = record(event.$metadata);
  const workers = record(event.$workers);
  if (
    metadata === null || workers === null || metadata.account !== accountId ||
    metadata.service !== request.cloudflare.scriptName ||
    metadata.type !== 'cf-worker' || workers.truncated !== false ||
    typeof metadata.requestId !== 'string' || metadata.rayId !== metadata.requestId ||
    workers.requestId !== metadata.requestId ||
    event.dataset !== 'cloudflare-workers'
  ) fail('cloudflare_log_envelope_mismatch');
  const parsed = GitHubAppTransportDiagnosticLogRecordV1Schema.safeParse(event.source);
  if (!parsed.success) fail('cloudflare_log_source_mismatch');
  const observedAt = Date.parse(parsed.data.observedAt);
  if (
    event.timestamp !== observedAt ||
    observedAt < Date.parse(request.github.readinessStartedAt) ||
    observedAt > Date.parse(request.github.readinessCompletedAt)
  ) fail('cloudflare_log_time_mismatch');
  const observation = GitHubAppTransportDiagnosticObservationV2Schema.safeParse({
    schemaVersion: '2',
    collectionId: request.collectionId,
    repository: request.repository,
    githubRunId: request.github.runId,
    githubHeadSha: request.github.headSha,
    githubRunAttempt: request.github.runAttempt,
    readinessJobId: request.github.readinessJobId,
    deploymentId: request.cloudflare.deploymentId,
    versionId: request.cloudflare.versionId,
    observedAt: parsed.data.observedAt,
    workerInvocationId: metadata.requestId,
    failureKind: parsed.data.failureKind,
    logRecordDigest: await canonicalSha256(parsed.data),
    requestAttempts: 1,
    cloudflareLogQueries: 1,
    plaintextLeaks: 0,
    formalVerification: 'still_required',
  });
  if (!observation.success) fail('cloudflare_log_envelope_mismatch');
  return observation.data;
}

export async function collectGitHubAppTransportDiagnosticObservation(
  input: GitHubAppTransportDiagnosticCollectionRequestV1,
  options: GitHubAppTransportDiagnosticCollectorOptions,
): Promise<GitHubAppTransportDiagnosticObservationV2> {
  const parsed = GitHubAppTransportDiagnosticCollectionRequestV1Schema.safeParse(input);
  if (!parsed.success) fail('request_invalid');
  const request = parsed.data;
  const tokens = [
    options.githubToken,
    options.cloudflareDeploymentReadToken,
    options.cloudflareObservabilityToken,
  ];
  if (
    tokens.some((token) => !TOKEN_PATTERN.test(token)) || new Set(tokens).size !== tokens.length ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    request.cloudflare.accountIdDigest !== await canonicalSha256(options.cloudflareAccountId)
  ) fail('configuration_invalid');
  const origin = safeOrigin(options.cloudflareApiOrigin ?? 'https://api.cloudflare.com');
  const scanner = new SecretScanner({ secrets: [...tokens, options.canary] });
  const raw = await externalJson(
    options.fetcher ?? fetch,
    `${origin}/client/v4/accounts/${encodeURIComponent(options.cloudflareAccountId)}` +
      '/workers/observability/telemetry/query',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.cloudflareObservabilityToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(telemetryBody(request)),
    },
    scanner,
  );
  return await collectObservation(raw, options.cloudflareAccountId, request);
}
