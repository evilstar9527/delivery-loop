import { isIP } from 'node:net';
import { GITHUB_APP_CREDENTIAL_ERROR_CODES } from '../auth/github-app-installation-token.js';
import { SecretScanner } from '../security/redaction.js';

const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_PATTERN = /^[^\0\r\n]{8,2000}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const BASE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const GITHUB_BASE_READINESS_FAILURE_REASONS = [
  'configuration_unavailable',
  'credential_unavailable',
  ...GITHUB_APP_CREDENTIAL_ERROR_CODES,
  'reference_unavailable',
  'reference_invalid',
] as const;

export type GitHubBaseReadinessFailureReason =
  typeof GITHUB_BASE_READINESS_FAILURE_REASONS[number];

export type GitHubBaseReadinessProbeErrorCode =
  | 'configuration_invalid'
  | 'request_already_attempted'
  | 'request_timed_out'
  | 'dns_failed'
  | 'tcp_failed'
  | 'tls_failed'
  | 'request_failed'
  | 'http_rejected'
  | 'response_invalid';

export class GitHubBaseReadinessProbeError extends Error {
  constructor(
    readonly code: GitHubBaseReadinessProbeErrorCode,
    readonly requestAttempts: 0 | 1,
  ) {
    super(`GitHub base readiness probe failed: ${code}`);
    this.name = 'GitHubBaseReadinessProbeError';
  }
}

export interface GitHubBaseReadinessProbeOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  repository: string;
  baseBranch: string;
  fetch?: typeof fetch;
}

export type GitHubBaseReadinessProbeSummary =
  | {
    requestAttempts: 1;
    status: 200;
    ready: true;
    repository: string;
    baseBranch: string;
    baseSha: string;
    cacheControl: 'no-store';
  }
  | {
    requestAttempts: 1;
    status: 503;
    ready: false;
    reason: GitHubBaseReadinessFailureReason;
    cacheControl: 'no-store';
  };

export interface GitHubBaseReadinessProbe {
  run(): Promise<GitHubBaseReadinessProbeSummary>;
}

function fail(code: GitHubBaseReadinessProbeErrorCode, attempts: 0 | 1): never {
  throw new GitHubBaseReadinessProbeError(code, attempts);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function safeOrigin(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  const ipCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    raw !== raw.trim() || raw.length > 2_048 || url.protocol !== 'https:' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') || isIP(ipCandidate) !== 0
  ) return null;
  return url.origin;
}

function safeRepository(value: string): boolean {
  if (!REPOSITORY_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
}

function safeBaseBranch(value: string): boolean {
  return BASE_BRANCH_PATTERN.test(value) && !value.includes('..') && !value.includes('//');
}

async function readBounded(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
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
  return bytes;
}

function discardBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* fixed rejection */ }
}

function safeErrorField(value: unknown, field: 'name' | 'code' | 'cause'): unknown {
  try {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  } catch { return undefined; }
}

function transportCode(error: unknown): GitHubBaseReadinessProbeErrorCode {
  const names = new Set<string>();
  const codes = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    const name = safeErrorField(current, 'name');
    const code = safeErrorField(current, 'code');
    if (typeof name === 'string') names.add(name);
    if (typeof code === 'string') codes.add(code.toUpperCase());
    current = safeErrorField(current, 'cause');
  }
  if (names.has('TimeoutError') || names.has('AbortError') || codes.has('ABORT_ERR')) {
    return 'request_timed_out';
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'].some((code) => codes.has(code))) {
    return 'dns_failed';
  }
  if ([
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ].some((code) => codes.has(code))) return 'tcp_failed';
  if ([...codes].some((code) =>
    code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') ||
    code.startsWith('CERT_') || [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
    ].includes(code))) return 'tls_failed';
  return 'request_failed';
}

function parseSuccess(
  body: Record<string, unknown>,
  options: GitHubBaseReadinessProbeOptions,
): GitHubBaseReadinessProbeSummary {
  if (
    !exactKeys(body, [
      'schemaVersion', 'ready', 'repository', 'baseBranch', 'baseSha',
    ]) ||
    body.schemaVersion !== '1' || body.ready !== true ||
    body.repository !== options.repository || body.baseBranch !== options.baseBranch ||
    typeof body.baseSha !== 'string' || !BASE_SHA_PATTERN.test(body.baseSha)
  ) fail('response_invalid', 1);
  return {
    requestAttempts: 1,
    status: 200,
    ready: true,
    repository: options.repository,
    baseBranch: options.baseBranch,
    baseSha: body.baseSha,
    cacheControl: 'no-store',
  };
}

function parseUnavailable(body: Record<string, unknown>): GitHubBaseReadinessProbeSummary {
  if (
    !exactKeys(body, [
      'schemaVersion', 'ready', 'reason', 'code', 'message', 'retryable', 'correlationId',
    ]) ||
    body.schemaVersion !== '1' || body.ready !== false ||
    typeof body.reason !== 'string' ||
    !GITHUB_BASE_READINESS_FAILURE_REASONS.includes(
      body.reason as GitHubBaseReadinessFailureReason,
    ) ||
    body.code !== 'unavailable' || body.message !== 'GitHub base readiness check failed' ||
    body.retryable !== true || typeof body.correlationId !== 'string' ||
    !UUID_PATTERN.test(body.correlationId)
  ) fail('response_invalid', 1);
  return {
    requestAttempts: 1,
    status: 503,
    ready: false,
    reason: body.reason as GitHubBaseReadinessFailureReason,
    cacheControl: 'no-store',
  };
}

export function createGitHubBaseReadinessProbe(
  options: GitHubBaseReadinessProbeOptions,
): GitHubBaseReadinessProbe {
  let attempted = false;
  return {
    run: async () => {
      if (attempted) fail('request_already_attempted', 1);
      attempted = true;
      const origin = safeOrigin(options.controlPlaneOrigin);
      if (
        origin === null || !TOKEN_PATTERN.test(options.operationsToken) ||
        !safeRepository(options.repository) || !safeBaseBranch(options.baseBranch)
      ) fail('configuration_invalid', 0);
      const scanner = new SecretScanner({ secrets: [options.operationsToken] });
      if (scanner.scan({
        repository: options.repository,
        baseBranch: options.baseBranch,
      }, '$.configuration').length > 0) fail('configuration_invalid', 0);
      const query = new URLSearchParams({
        repository: options.repository,
        baseBranch: options.baseBranch,
      });
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(
          `${origin}/v1/operations/github-base/readiness?${query.toString()}`,
          {
            method: 'GET',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${options.operationsToken}`,
            },
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
      } catch (error) {
        fail(transportCode(error), 1);
      }
      if (response.status !== 200 && response.status !== 503) {
        discardBody(response);
        fail('http_rejected', 1);
      }
      if (
        response.headers.get('cache-control')?.trim().toLowerCase() !== 'no-store' ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
      ) {
        discardBody(response);
        fail('response_invalid', 1);
      }
      const lengthHeader = response.headers.get('content-length');
      const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
      if (
        declaredLength !== null &&
        (!Number.isSafeInteger(declaredLength) || declaredLength < 0 ||
          declaredLength > MAX_RESPONSE_BYTES)
      ) {
        discardBody(response);
        fail('response_invalid', 1);
      }
      let bytes: Uint8Array | null;
      try { bytes = await readBounded(response); }
      catch { fail('response_invalid', 1); }
      if (bytes === null) fail('response_invalid', 1);
      const text = new TextDecoder().decode(bytes);
      if (scanner.scanText(text, '$.response').length > 0) fail('response_invalid', 1);
      let body: Record<string, unknown> | null;
      try { body = record(JSON.parse(text) as unknown); }
      catch { fail('response_invalid', 1); }
      if (body === null) fail('response_invalid', 1);
      return response.status === 200 ? parseSuccess(body, options) : parseUnavailable(body);
    },
  };
}
