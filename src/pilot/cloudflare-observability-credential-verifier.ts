import { canonicalSha256 } from '../domain/digest.js';
import {
  CloudflareObservabilityCredentialVerificationAuthorizationV1Schema,
  CloudflareObservabilityCredentialVerificationSummaryV1Schema,
  cloudflareObservabilityCredentialVerificationAuthorityDigest,
  type CloudflareObservabilityCredentialVerificationAuthorizationV1,
  type CloudflareObservabilityCredentialVerificationSummaryV1,
} from '../domain/cloudflare-observability-credential-verification.js';
import { SecretScanner } from '../security/redaction.js';
import {
  CloudflareObservabilityReadError,
  probeCloudflareObservabilityTelemetry,
  verifyCloudflareAccountToken,
  type CloudflareObservabilityReadFailureKind,
} from './cloudflare-observability-credential-provisioner.js';

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const ACCOUNT_TOKEN_PATTERN = /^cfat_[A-Za-z0-9_-]{35,75}$/;
const CANARY_PATTERN = /^[^\0\r\n]{20,20000}$/;

export type CloudflareObservabilityCredentialVerificationErrorCode =
  | 'authorization_invalid'
  | 'authority_expired'
  | 'configuration_invalid'
  | 'token_verification_failed'
  | 'token_identity_mismatch'
  | 'telemetry_probe_failed'
  | 'secret_leak_detected';

export type CloudflareObservabilityCredentialVerificationStage =
  | 'token_verify'
  | 'telemetry_probe';

export class CloudflareObservabilityCredentialVerificationError extends Error {
  constructor(
    readonly code: CloudflareObservabilityCredentialVerificationErrorCode,
    readonly stage?: CloudflareObservabilityCredentialVerificationStage,
    readonly failureKind?: CloudflareObservabilityReadFailureKind,
  ) {
    super(`Cloudflare observability credential verification failed: ${code}`);
    this.name = 'CloudflareObservabilityCredentialVerificationError';
  }
}

export interface CloudflareObservabilityCredentialVerifierOptions {
  credential: string;
  cloudflareAccountId: string;
  canary: string;
  now?: () => Date;
  cloudflareApiOrigin?: string;
  fetcher?: typeof fetch;
}

function fail(
  code: CloudflareObservabilityCredentialVerificationErrorCode,
  stage?: CloudflareObservabilityCredentialVerificationStage,
): never {
  throw new CloudflareObservabilityCredentialVerificationError(code, stage);
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

function mapSharedFailure(
  error: unknown,
  stage: CloudflareObservabilityCredentialVerificationStage,
): never {
  if (
    error instanceof CloudflareObservabilityReadError &&
    error.failureKind === 'secret_leak_detected'
  ) fail('secret_leak_detected', stage);
  throw new CloudflareObservabilityCredentialVerificationError(
    stage === 'token_verify' ? 'token_verification_failed' : 'telemetry_probe_failed',
    stage,
    error instanceof CloudflareObservabilityReadError
      ? error.failureKind
      : 'response_invalid',
  );
}

export async function verifyExistingCloudflareObservabilityCredential(
  input: CloudflareObservabilityCredentialVerificationAuthorizationV1,
  options: CloudflareObservabilityCredentialVerifierOptions,
): Promise<CloudflareObservabilityCredentialVerificationSummaryV1> {
  const parsed = CloudflareObservabilityCredentialVerificationAuthorizationV1Schema.safeParse(input);
  if (!parsed.success) fail('authorization_invalid');
  const authorization = parsed.data;
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) fail('configuration_invalid');
  if (now < new Date(authorization.authorizedAt) || now >= new Date(authorization.expiresAt)) {
    fail('authority_expired');
  }
  if (
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !ACCOUNT_TOKEN_PATTERN.test(options.credential) ||
    !CANARY_PATTERN.test(options.canary) || options.credential === options.canary ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    authorization.accountIdDigest !== await canonicalSha256(options.cloudflareAccountId) ||
    authorization.authorityDigest !==
      await cloudflareObservabilityCredentialVerificationAuthorityDigest(authorization)
  ) fail('configuration_invalid');

  const origin = safeOrigin(options.cloudflareApiOrigin ?? 'https://api.cloudflare.com');
  const fetcher = options.fetcher ?? fetch;
  let verified: { id: string; status: 'active' };
  try {
    verified = await verifyCloudflareAccountToken({
      fetcher,
      origin,
      accountId: options.cloudflareAccountId,
      token: options.credential,
      secrets: [options.canary],
    });
  } catch (error) {
    mapSharedFailure(error, 'token_verify');
  }
  if (await canonicalSha256(verified.id) !== authorization.tokenIdDigest) {
    fail('token_identity_mismatch', 'token_verify');
  }
  try {
    await probeCloudflareObservabilityTelemetry({
      fetcher,
      origin,
      accountId: options.cloudflareAccountId,
      token: options.credential,
      secrets: [options.canary],
      probe: authorization.telemetryProbe,
    });
  } catch (error) {
    mapSharedFailure(error, 'telemetry_probe');
  }
  return CloudflareObservabilityCredentialVerificationSummaryV1Schema.parse({
    schemaVersion: '1',
    authorizationId: authorization.authorizationId,
    accountIdDigest: authorization.accountIdDigest,
    tokenIdDigest: authorization.tokenIdDigest,
    tokenName: authorization.tokenName,
    keychainService: authorization.keychainService,
    keychainAccount: authorization.keychainAccount,
    status: 'verified',
    effects: authorization.effects,
    plaintextLeaks: 0,
  });
}
