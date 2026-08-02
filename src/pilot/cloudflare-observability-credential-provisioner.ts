import { canonicalSha256 } from '../domain/digest.js';
import {
  CLOUDFLARE_OBSERVABILITY_PERMISSION_GROUP_NAME,
  CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema,
  CloudflareObservabilityCredentialProvisioningSummaryV1Schema,
  cloudflareObservabilityCredentialProvisioningAuthorityDigest,
  type CloudflareObservabilityCredentialProvisioningAuthorizationV1,
  type CloudflareObservabilityCredentialProvisioningSummaryV1,
} from '../domain/cloudflare-observability-credential-provisioning.js';
import { SecretScanner } from '../security/redaction.js';

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[^\0\r\n]{20,2000}$/;
const ACCOUNT_TOKEN_PATTERN = /^cfat_[A-Za-z0-9_-]{35,75}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CANARY_PATTERN = /^[^\0\r\n]{20,20000}$/;
const ACCOUNT_PERMISSION_SCOPE = 'com.cloudflare.api.account';
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const HTTP_TIMEOUT_MS = 10_000;

export type CloudflareObservabilityCredentialProvisioningErrorCode =
  | 'authorization_invalid'
  | 'authority_expired'
  | 'configuration_invalid'
  | 'token_inventory_unavailable'
  | 'token_inventory_invalid'
  | 'duplicate_token_name'
  | 'permission_groups_unavailable'
  | 'permission_groups_invalid'
  | 'permission_group_mismatch'
  | 'token_create_unavailable'
  | 'token_create_response_invalid'
  | 'secret_leak_detected'
  | 'created_unverified';

export type CloudflareObservabilityCredentialProvisioningStage =
  | 'token_create'
  | 'keychain'
  | 'token_verify'
  | 'telemetry_probe';

export class CloudflareObservabilityCredentialProvisioningError extends Error {
  readonly stage: CloudflareObservabilityCredentialProvisioningStage | undefined;

  constructor(
    readonly code: CloudflareObservabilityCredentialProvisioningErrorCode,
    stage?: CloudflareObservabilityCredentialProvisioningStage,
  ) {
    super(`Cloudflare observability credential provisioning failed: ${code}`);
    this.name = 'CloudflareObservabilityCredentialProvisioningError';
    this.stage = stage;
  }
}

export interface CloudflareObservabilityCredentialProvisionerOptions {
  bootstrapToken: string;
  cloudflareAccountId: string;
  canary: string;
  assertStorageAvailable: () => Promise<void>;
  storeSecret: (secret: string) => Promise<void>;
  now?: () => Date;
  cloudflareApiOrigin?: string;
  fetcher?: typeof fetch;
}

type PreCreateErrorCode = Exclude<
  CloudflareObservabilityCredentialProvisioningErrorCode,
  'created_unverified'
>;

function fail(code: PreCreateErrorCode): never {
  throw new CloudflareObservabilityCredentialProvisioningError(code);
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

interface ExternalResponse {
  raw: string;
  parsed: unknown;
}

async function externalResponse(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  unavailable: PreCreateErrorCode,
  invalid: PreCreateErrorCode,
  preParseSecrets: readonly string[],
): Promise<ExternalResponse> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch { fail(unavailable); }
  if (!response.ok) {
    await response.body?.cancel();
    fail(unavailable);
  }
  if (
    !responseSizeValid(response) ||
    /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    fail(invalid);
  }
  let raw: string | null;
  try { raw = await boundedText(response); }
  catch { fail(invalid); }
  if (raw === null) fail(invalid);
  if (
    new SecretScanner({ secrets: preParseSecrets }).scanText(raw, '$.response').length > 0
  ) fail('secret_leak_detected');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { fail(invalid); }
  return { raw, parsed };
}

function envelopeResult(parsed: unknown, invalid: PreCreateErrorCode): unknown {
  const envelope = record(parsed);
  if (
    envelope === null || envelope.success !== true || !Array.isArray(envelope.errors) ||
    envelope.errors.length !== 0 || !Array.isArray(envelope.messages) ||
    !Object.hasOwn(envelope, 'result')
  ) fail(invalid);
  return envelope.result;
}

function assertNoResponseSecrets(
  response: ExternalResponse,
  secrets: readonly string[],
): void {
  const scanner = new SecretScanner({ secrets });
  if (scanner.scan(response.parsed, '$.response').length > 0) fail('secret_leak_detected');
}

function tokenHeaders(token: string, includeJson = false): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    ...(includeJson ? { 'content-type': 'application/json' } : {}),
  };
}

function inventoryValid(result: unknown, resultInfo: unknown): result is unknown[] {
  if (!Array.isArray(result)) return false;
  const info = record(resultInfo);
  if (info === null) return false;
  const expected = {
    page: 1,
    per_page: 50,
    count: result.length,
    total_count: result.length,
    total_pages: 1,
  };
  if (Object.entries(expected).some(([key, value]) => info[key] !== value)) return false;
  return result.every((entry) => {
    const item = record(entry);
    return item !== null && typeof item.id === 'string' && typeof item.name === 'string' &&
      typeof item.status === 'string';
  });
}

function permissionGroupResultInfoValid(result: readonly unknown[], raw: unknown): boolean {
  if (raw === undefined) return true;
  const info = record(raw);
  if (info === null) return false;
  const optionalInteger = (key: string, minimum: number): number | undefined | null => {
    const value = info[key];
    if (value === undefined) return undefined;
    return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : null;
  };
  const count = optionalInteger('count', 0);
  const page = optionalInteger('page', 1);
  const perPage = optionalInteger('per_page', 1);
  const totalCount = optionalInteger('total_count', 0);
  if (count === null || page === null || perPage === null || totalCount === null) return false;
  return (count === undefined || count === result.length) &&
    (page === undefined || page === 1) &&
    (perPage === undefined || perPage >= result.length) &&
    (totalCount === undefined || totalCount >= result.length);
}

async function readTokenInventory(
  fetcher: typeof fetch,
  origin: string,
  accountId: string,
  bootstrapToken: string,
  canary: string,
  tokenName: string,
): Promise<void> {
  const response = await externalResponse(
    fetcher,
    `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}` +
      '/tokens?per_page=50&include_expired=true',
    { method: 'GET', headers: tokenHeaders(bootstrapToken) },
    'token_inventory_unavailable',
    'token_inventory_invalid',
    [bootstrapToken, canary],
  );
  assertNoResponseSecrets(response, [bootstrapToken, canary]);
  const envelope = record(response.parsed);
  const result = envelopeResult(response.parsed, 'token_inventory_invalid');
  if (!inventoryValid(result, envelope?.result_info)) fail('token_inventory_invalid');
  if (result.some((entry) => record(entry)?.name === tokenName)) fail('duplicate_token_name');
}

async function readPermissionGroup(
  fetcher: typeof fetch,
  origin: string,
  accountId: string,
  bootstrapToken: string,
  canary: string,
): Promise<string> {
  const response = await externalResponse(
    fetcher,
    `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}` +
      '/tokens/permission_groups?name=Workers%20Observability%20Read' +
      '&scope=com.cloudflare.api.account',
    { method: 'GET', headers: tokenHeaders(bootstrapToken) },
    'permission_groups_unavailable',
    'permission_groups_invalid',
    [bootstrapToken, canary],
  );
  assertNoResponseSecrets(response, [bootstrapToken, canary]);
  const envelope = record(response.parsed);
  const result = envelopeResult(response.parsed, 'permission_groups_invalid');
  if (
    !Array.isArray(result) ||
    !permissionGroupResultInfoValid(result, envelope?.result_info)
  ) fail('permission_groups_invalid');
  const matches = result.filter((entry) =>
    record(entry)?.name === CLOUDFLARE_OBSERVABILITY_PERMISSION_GROUP_NAME
  );
  if (matches.length !== 1) fail('permission_group_mismatch');
  const match = record(matches[0]);
  if (
    match === null || typeof match.id !== 'string' || !EXTERNAL_ID_PATTERN.test(match.id) ||
    !Array.isArray(match.scopes) ||
    !match.scopes.every((scope) => typeof scope === 'string') ||
    !match.scopes.includes(ACCOUNT_PERMISSION_SCOPE)
  ) fail('permission_group_mismatch');
  return match.id;
}

function createBody(
  authorization: CloudflareObservabilityCredentialProvisioningAuthorizationV1,
  accountId: string,
  permissionGroupId: string,
): Record<string, unknown> {
  return {
    name: authorization.tokenName,
    policies: [{
      effect: 'allow',
      permission_groups: [{ id: permissionGroupId }],
      resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
    }],
    not_before: authorization.authorizedAt,
    expires_on: authorization.tokenExpiresAt,
  };
}

function createdSecret(
  response: ExternalResponse,
  authorization: CloudflareObservabilityCredentialProvisioningAuthorizationV1,
  bootstrapToken: string,
  canary: string,
): { id: string; value: string } {
  const result = record(envelopeResult(response.parsed, 'token_create_response_invalid'));
  if (
    result === null || typeof result.id !== 'string' || !EXTERNAL_ID_PATTERN.test(result.id) ||
    result.name !== authorization.tokenName || result.status !== 'active' ||
    typeof result.value !== 'string' || !ACCOUNT_TOKEN_PATTERN.test(result.value) ||
    result.value === bootstrapToken || result.value === canary
  ) fail('token_create_response_invalid');
  const serializedSecret = JSON.stringify(result.value);
  if (response.raw.split(serializedSecret).length - 1 !== 1) {
    fail('token_create_response_invalid');
  }
  const safe = structuredClone(response.parsed);
  const safeEnvelope = record(safe);
  const safeResult = record(safeEnvelope?.result);
  if (safeResult === null) fail('token_create_response_invalid');
  safeResult.value = '[created-token-redacted]';
  const scanner = new SecretScanner({ secrets: [bootstrapToken, canary, result.value] });
  if (scanner.scan(safe, '$.create-response').length > 0) {
    fail('token_create_response_invalid');
  }
  return { id: result.id, value: result.value };
}

async function createToken(
  fetcher: typeof fetch,
  origin: string,
  accountId: string,
  bootstrapToken: string,
  canary: string,
  authorization: CloudflareObservabilityCredentialProvisioningAuthorizationV1,
  permissionGroupId: string,
): Promise<{ id: string; value: string }> {
  const response = await externalResponse(
    fetcher,
    `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}/tokens`,
    {
      method: 'POST',
      headers: tokenHeaders(bootstrapToken, true),
      body: JSON.stringify(createBody(authorization, accountId, permissionGroupId)),
    },
    'token_create_unavailable',
    'token_create_response_invalid',
    [bootstrapToken, canary],
  );
  return createdSecret(response, authorization, bootstrapToken, canary);
}

async function verifyCreatedToken(
  fetcher: typeof fetch,
  origin: string,
  accountId: string,
  bootstrapToken: string,
  canary: string,
  created: { id: string; value: string },
): Promise<void> {
  const response = await externalResponse(
    fetcher,
    `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
    { method: 'GET', headers: tokenHeaders(created.value) },
    'configuration_invalid',
    'configuration_invalid',
    [bootstrapToken, canary, created.value],
  );
  assertNoResponseSecrets(response, [bootstrapToken, canary, created.value]);
  const result = record(envelopeResult(response.parsed, 'configuration_invalid'));
  if (result === null || result.id !== created.id || result.status !== 'active') {
    fail('configuration_invalid');
  }
}

function telemetryProbeBody(
  authorization: CloudflareObservabilityCredentialProvisioningAuthorizationV1,
): Record<string, unknown> {
  return {
    view: 'events',
    dry: true,
    timeframe: authorization.telemetryProbe.window,
    limit: 1,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [{
        key: '$metadata.service',
        operation: 'eq',
        type: 'string',
        value: authorization.telemetryProbe.scriptName,
      }],
      groupBys: [],
      calculations: [],
    },
  };
}

async function probeTelemetry(
  fetcher: typeof fetch,
  origin: string,
  accountId: string,
  bootstrapToken: string,
  canary: string,
  createdToken: string,
  authorization: CloudflareObservabilityCredentialProvisioningAuthorizationV1,
): Promise<void> {
  const response = await externalResponse(
    fetcher,
    `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}` +
      '/workers/observability/telemetry/query',
    {
      method: 'POST',
      headers: tokenHeaders(createdToken, true),
      body: JSON.stringify(telemetryProbeBody(authorization)),
    },
    'configuration_invalid',
    'configuration_invalid',
    [bootstrapToken, canary, createdToken],
  );
  assertNoResponseSecrets(response, [bootstrapToken, canary, createdToken]);
  const result = record(envelopeResult(response.parsed, 'configuration_invalid'));
  const run = record(result?.run);
  if (result === null || run?.accountId !== accountId || run.dry !== true) {
    fail('configuration_invalid');
  }
}

export async function provisionCloudflareObservabilityCredential(
  input: CloudflareObservabilityCredentialProvisioningAuthorizationV1,
  options: CloudflareObservabilityCredentialProvisionerOptions,
): Promise<CloudflareObservabilityCredentialProvisioningSummaryV1> {
  const parsed = CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema.safeParse(input);
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
    !CANARY_PATTERN.test(options.canary) || options.bootstrapToken === options.canary ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    authorization.accountIdDigest !== await canonicalSha256(options.cloudflareAccountId) ||
    authorization.authorityDigest !==
      await cloudflareObservabilityCredentialProvisioningAuthorityDigest(authorization)
  ) fail('configuration_invalid');
  const origin = safeOrigin(options.cloudflareApiOrigin ?? 'https://api.cloudflare.com');
  const fetcher = options.fetcher ?? fetch;
  try { await options.assertStorageAvailable(); }
  catch { fail('configuration_invalid'); }
  await readTokenInventory(
    fetcher,
    origin,
    options.cloudflareAccountId,
    options.bootstrapToken,
    options.canary,
    authorization.tokenName,
  );
  const permissionGroupId = await readPermissionGroup(
    fetcher,
    origin,
    options.cloudflareAccountId,
    options.bootstrapToken,
    options.canary,
  );
  let created: { id: string; value: string };
  try {
    created = await createToken(
      fetcher,
      origin,
      options.cloudflareAccountId,
      options.bootstrapToken,
      options.canary,
      authorization,
      permissionGroupId,
    );
  } catch {
    throw new CloudflareObservabilityCredentialProvisioningError(
      'created_unverified',
      'token_create',
    );
  }
  try { await options.storeSecret(created.value); }
  catch {
    throw new CloudflareObservabilityCredentialProvisioningError(
      'created_unverified',
      'keychain',
    );
  }
  try {
    await verifyCreatedToken(
      fetcher,
      origin,
      options.cloudflareAccountId,
      options.bootstrapToken,
      options.canary,
      created,
    );
  } catch {
    throw new CloudflareObservabilityCredentialProvisioningError(
      'created_unverified',
      'token_verify',
    );
  }
  try {
    await probeTelemetry(
      fetcher,
      origin,
      options.cloudflareAccountId,
      options.bootstrapToken,
      options.canary,
      created.value,
      authorization,
    );
  } catch {
    throw new CloudflareObservabilityCredentialProvisioningError(
      'created_unverified',
      'telemetry_probe',
    );
  }
  return CloudflareObservabilityCredentialProvisioningSummaryV1Schema.parse({
    schemaVersion: '1',
    authorizationId: authorization.authorizationId,
    accountIdDigest: authorization.accountIdDigest,
    tokenName: authorization.tokenName,
    permissionGroupName: authorization.permissionGroupName,
    keychainService: authorization.keychainService,
    tokenExpiresAt: authorization.tokenExpiresAt,
    status: 'verified',
    effects: authorization.effects,
    plaintextLeaks: 0,
  });
}
