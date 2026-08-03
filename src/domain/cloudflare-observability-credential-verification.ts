import { z } from 'zod';
import { canonicalSha256 } from './digest.js';
import { CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE } from './cloudflare-observability-credential-provisioning.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOKEN_NAME_PATTERN =
  /^delivery-loop-workers-observability-read-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SCRIPT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,254}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

export const CLOUDFLARE_OBSERVABILITY_KEYCHAIN_ACCOUNT =
  'delivery-loop-transport-diagnostic' as const;

export const CloudflareObservabilityCredentialVerificationEffectsV1Schema = z.object({
  keychainReads: z.literal(1),
  tokenVerifications: z.literal(1),
  telemetryQueries: z.literal(1),
  tokenInventoryReads: z.literal(0),
  permissionGroupReads: z.literal(0),
  tokenCreates: z.literal(0),
  keychainWrites: z.literal(0),
  tokenDeletes: z.literal(0),
  retries: z.literal(0),
}).strict();

export const CloudflareObservabilityCredentialVerificationAuthorizationV1Schema = z.object({
  schemaVersion: z.literal('1'),
  authorizationId: z.string().regex(ID_PATTERN),
  authorizedAt: TIMESTAMP_SCHEMA,
  expiresAt: TIMESTAMP_SCHEMA,
  accountIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenName: z.string().regex(TOKEN_NAME_PATTERN),
  keychainService: z.literal(CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE),
  keychainAccount: z.literal(CLOUDFLARE_OBSERVABILITY_KEYCHAIN_ACCOUNT),
  telemetryProbe: z.object({
    scriptName: z.string().regex(SCRIPT_NAME_PATTERN),
    window: z.object({
      from: TIMESTAMP_SCHEMA,
      to: TIMESTAMP_SCHEMA,
    }).strict(),
  }).strict(),
  effects: CloudflareObservabilityCredentialVerificationEffectsV1Schema,
  authorityDigest: z.string().regex(DIGEST_PATTERN),
}).strict().superRefine((authorization, context) => {
  const authorizedAt = Date.parse(authorization.authorizedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const probeFrom = Date.parse(authorization.telemetryProbe.window.from);
  const probeTo = Date.parse(authorization.telemetryProbe.window.to);
  if (expiresAt <= authorizedAt || expiresAt - authorizedAt > 30 * 60_000) {
    context.addIssue({ code: 'custom', message: 'authority window must be at most 30 minutes' });
  }
  if (probeTo <= probeFrom || probeTo - probeFrom > 60_000 || probeTo > authorizedAt) {
    context.addIssue({
      code: 'custom',
      message: 'telemetry probe must bind one completed window of at most 60 seconds',
    });
  }
});

export const CloudflareObservabilityCredentialVerificationSummaryV1Schema = z.object({
  schemaVersion: z.literal('1'),
  authorizationId: z.string().regex(ID_PATTERN),
  accountIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenName: z.string().regex(TOKEN_NAME_PATTERN),
  keychainService: z.literal(CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE),
  keychainAccount: z.literal(CLOUDFLARE_OBSERVABILITY_KEYCHAIN_ACCOUNT),
  status: z.literal('verified'),
  effects: CloudflareObservabilityCredentialVerificationEffectsV1Schema,
  plaintextLeaks: z.literal(0),
}).strict();

export type CloudflareObservabilityCredentialVerificationAuthorizationV1 = z.infer<
  typeof CloudflareObservabilityCredentialVerificationAuthorizationV1Schema
>;
export type CloudflareObservabilityCredentialVerificationSummaryV1 = z.infer<
  typeof CloudflareObservabilityCredentialVerificationSummaryV1Schema
>;

export async function cloudflareObservabilityCredentialVerificationAuthorityDigest(
  authorization: object,
): Promise<string> {
  const bound = Object.fromEntries(
    Object.entries(authorization).filter(([key]) => key !== 'authorityDigest'),
  );
  return await canonicalSha256(bound);
}
