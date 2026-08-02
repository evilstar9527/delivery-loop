import { canonicalSha256 } from '../domain/digest.js';
import {
  CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema,
  CloudflareObservabilityCredentialReconciliationSummaryV1Schema,
  cloudflareObservabilityCredentialReconciliationAuthorityDigest,
  type CloudflareObservabilityCredentialReconciliationAuthorizationV1,
  type CloudflareObservabilityCredentialReconciliationSummaryV1,
} from '../domain/cloudflare-observability-credential-reconciliation.js';
import { SecretScanner } from '../security/redaction.js';

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[^\0\r\n]{20,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{20,20000}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const HTTP_TIMEOUT_MS = 10_000;

export type CloudflareObservabilityCredentialReconciliationErrorCode =
  | 'authorization_invalid'
  | 'authority_expired'
  | 'configuration_invalid'
  | 'token_inventory_unavailable'
  | 'token_inventory_invalid'
  | 'secret_leak_detected'
  | 'target_ambiguous'
  | 'target_mismatch';

export class CloudflareObservabilityCredentialReconciliationError extends Error {
  constructor(readonly code: CloudflareObservabilityCredentialReconciliationErrorCode) {
    super(`Cloudflare observability credential reconciliation failed: ${code}`);
    this.name = 'CloudflareObservabilityCredentialReconciliationError';
  }
}

export interface CloudflareObservabilityCredentialReconcilerOptions {
  bootstrapToken: string;
  cloudflareAccountId: string;
  canary: string;
  now?: () => Date;
  cloudflareApiOrigin?: string;
  fetcher?: typeof fetch;
}

interface TokenInventoryEntry {
  id: string;
  name: string;
  status: string;
  notBefore: string | undefined;
  expiresAt: string | undefined;
}

function fail(code: CloudflareObservabilityCredentialReconciliationErrorCode): never {
  throw new CloudflareObservabilityCredentialReconciliationError(code);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  const raw = response.headers.get('content-length');
  if (raw === null) return true;
  const declared = Number(raw);
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

function tokenHeaders(token: string): Record<string, string> {
  return { accept: 'application/json', authorization: `Bearer ${token}` };
}

function parseInventoryEnvelope(parsed: unknown): TokenInventoryEntry[] {
  const envelope = record(parsed);
  if (
    envelope === null || envelope.success !== true || !Array.isArray(envelope.errors) ||
    envelope.errors.length !== 0 || !Array.isArray(envelope.messages) ||
    !Array.isArray(envelope.result)
  ) fail('token_inventory_invalid');
  const result = envelope.result;
  const info = record(envelope.result_info);
  const expected = {
    page: 1,
    per_page: 50,
    count: result.length,
    total_count: result.length,
    total_pages: 1,
  };
  if (
    info === null ||
    Object.entries(expected).some(([key, value]) => info[key] !== value)
  ) fail('token_inventory_invalid');
  return result.map((raw): TokenInventoryEntry => {
    const item = record(raw);
    if (
      item === null || typeof item.id !== 'string' ||
      !EXTERNAL_ID_PATTERN.test(item.id) || typeof item.name !== 'string' ||
      typeof item.status !== 'string' ||
      (item.not_before !== undefined && typeof item.not_before !== 'string') ||
      (item.expires_on !== undefined && typeof item.expires_on !== 'string')
    ) fail('token_inventory_invalid');
    return {
      id: item.id,
      name: item.name,
      status: item.status,
      notBefore: item.not_before,
      expiresAt: item.expires_on,
    };
  });
}

async function readTokenInventory(
  options: CloudflareObservabilityCredentialReconcilerOptions,
  origin: string,
): Promise<TokenInventoryEntry[]> {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      `${origin}/client/v4/accounts/${encodeURIComponent(options.cloudflareAccountId)}` +
        '/tokens?per_page=50&include_expired=true',
      {
        method: 'GET',
        headers: tokenHeaders(options.bootstrapToken),
        redirect: 'error',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
  } catch { fail('token_inventory_unavailable'); }
  if (!response.ok) {
    await response.body?.cancel();
    fail('token_inventory_unavailable');
  }
  if (
    !responseSizeValid(response) ||
    /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    fail('token_inventory_invalid');
  }
  let raw: string | null;
  try { raw = await boundedText(response); }
  catch { fail('token_inventory_invalid'); }
  if (raw === null) fail('token_inventory_invalid');
  const scanner = new SecretScanner({ secrets: [options.bootstrapToken, options.canary] });
  if (scanner.scanText(raw, '$.response').length > 0) fail('secret_leak_detected');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { fail('token_inventory_invalid'); }
  if (scanner.scan(parsed, '$.response').length > 0) fail('secret_leak_detected');
  return parseInventoryEnvelope(parsed);
}

function summaryBase(
  authorization: CloudflareObservabilityCredentialReconciliationAuthorizationV1,
): Omit<CloudflareObservabilityCredentialReconciliationSummaryV1, 'status'> {
  return {
    schemaVersion: '1',
    authorizationId: authorization.authorizationId,
    sourceProvisioningAuthorizationId: authorization.sourceProvisioningAuthorizationId,
    sourceProvisioningAuthorityDigest: authorization.sourceProvisioningAuthorityDigest,
    sourceProvisioningAuthorizedAt: authorization.sourceProvisioningAuthorizedAt,
    accountIdDigest: authorization.accountIdDigest,
    tokenName: authorization.tokenName,
    tokenNotBefore: authorization.tokenNotBefore,
    tokenExpiresAt: authorization.tokenExpiresAt,
    effects: authorization.effects,
    plaintextLeaks: 0,
  };
}

export async function reconcileCloudflareObservabilityCredential(
  input: CloudflareObservabilityCredentialReconciliationAuthorizationV1,
  options: CloudflareObservabilityCredentialReconcilerOptions,
): Promise<CloudflareObservabilityCredentialReconciliationSummaryV1> {
  const parsed =
    CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema.safeParse(input);
  if (!parsed.success) fail('authorization_invalid');
  const authorization = parsed.data;
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) fail('configuration_invalid');
  if (now < new Date(authorization.authorizedAt) || now >= new Date(authorization.expiresAt)) {
    fail('authority_expired');
  }
  if (
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !TOKEN_PATTERN.test(options.bootstrapToken) ||
    !CANARY_PATTERN.test(options.canary) ||
    options.bootstrapToken === options.canary ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    authorization.accountIdDigest !== await canonicalSha256(options.cloudflareAccountId) ||
    authorization.authorityDigest !==
      await cloudflareObservabilityCredentialReconciliationAuthorityDigest(authorization)
  ) fail('configuration_invalid');
  const origin = safeOrigin(options.cloudflareApiOrigin ?? 'https://api.cloudflare.com');
  const inventory = await readTokenInventory(options, origin);
  const matches = inventory.filter((entry) => entry.name === authorization.tokenName);
  if (matches.length > 1) fail('target_ambiguous');
  const match = matches[0];
  if (match === undefined) {
    return CloudflareObservabilityCredentialReconciliationSummaryV1Schema.parse({
      ...summaryBase(authorization),
      status: 'absent',
    });
  }
  const notBeforeMatches = authorization.tokenNotBefore === null
    ? match.notBefore === undefined
    : match.notBefore !== undefined &&
      Date.parse(match.notBefore) === Date.parse(authorization.tokenNotBefore);
  if (
    !['active', 'disabled', 'expired'].includes(match.status) ||
    !notBeforeMatches || match.expiresAt === undefined ||
    Date.parse(match.expiresAt) !== Date.parse(authorization.tokenExpiresAt)
  ) fail('target_mismatch');
  return CloudflareObservabilityCredentialReconciliationSummaryV1Schema.parse({
    ...summaryBase(authorization),
    status: 'present',
    tokenIdDigest: await canonicalSha256(match.id),
    tokenStatus: match.status,
  });
}
