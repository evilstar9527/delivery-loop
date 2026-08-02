import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOKEN_NAME_PATTERN =
  /^delivery-loop-workers-observability-read-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SCRIPT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,254}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });
const CLOUDFLARE_TOKEN_TIMESTAMP_SCHEMA = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .pipe(TIMESTAMP_SCHEMA);
const MIN_TOKEN_TTL_AFTER_AUTHORITY_MS = 7 * 24 * 60 * 60_000;
const MAX_TOKEN_TTL_FROM_AUTHORIZATION_MS = (7 * 24 * 60 + 30) * 60_000;

export const CLOUDFLARE_OBSERVABILITY_PERMISSION_GROUP_NAME =
  'Workers Observability Read' as const;
export const CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE =
  'delivery-loop-github-app-transport-diagnostic-cloudflare-observability-token' as const;

export const CloudflareObservabilityCredentialProvisioningEffectsV1Schema = z.object({
  tokenInventoryReads: z.literal(1),
  permissionGroupReads: z.literal(1),
  tokenCreates: z.literal(1),
  keychainWrites: z.literal(1),
  tokenVerifications: z.literal(1),
  telemetryQueries: z.literal(1),
  tokenDeletes: z.literal(0),
  retries: z.literal(0),
}).strict();

export const CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema = z.object({
  schemaVersion: z.literal('1'),
  authorizationId: z.string().regex(ID_PATTERN),
  authorizedAt: TIMESTAMP_SCHEMA,
  expiresAt: TIMESTAMP_SCHEMA,
  accountIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenName: z.string().regex(TOKEN_NAME_PATTERN),
  permissionGroupName: z.literal(CLOUDFLARE_OBSERVABILITY_PERMISSION_GROUP_NAME),
  keychainService: z.literal(CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE),
  tokenExpiresAt: CLOUDFLARE_TOKEN_TIMESTAMP_SCHEMA,
  telemetryProbe: z.object({
    scriptName: z.string().regex(SCRIPT_NAME_PATTERN),
    window: z.object({
      from: TIMESTAMP_SCHEMA,
      to: TIMESTAMP_SCHEMA,
    }).strict(),
  }).strict(),
  effects: CloudflareObservabilityCredentialProvisioningEffectsV1Schema,
  authorityDigest: z.string().regex(DIGEST_PATTERN),
}).strict().superRefine((authorization, context) => {
  const authorizedAt = Date.parse(authorization.authorizedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const tokenExpiresAt = Date.parse(authorization.tokenExpiresAt);
  const probeFrom = Date.parse(authorization.telemetryProbe.window.from);
  const probeTo = Date.parse(authorization.telemetryProbe.window.to);
  if (expiresAt <= authorizedAt || expiresAt - authorizedAt > 30 * 60_000) {
    context.addIssue({ code: 'custom', message: 'authority window must be at most 30 minutes' });
  }
  if (
    tokenExpiresAt - expiresAt < MIN_TOKEN_TTL_AFTER_AUTHORITY_MS ||
    tokenExpiresAt - authorizedAt > MAX_TOKEN_TTL_FROM_AUTHORIZATION_MS
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'target token TTL must leave seven days after authority expiry and stay within seven days 30 minutes',
    });
  }
  if (
    probeTo <= probeFrom || probeTo - probeFrom > 60_000 || probeTo > authorizedAt
  ) {
    context.addIssue({
      code: 'custom',
      message: 'telemetry probe must bind one completed window of at most 60 seconds',
    });
  }
});

export const CloudflareObservabilityCredentialProvisioningSummaryV1Schema = z.object({
  schemaVersion: z.literal('1'),
  authorizationId: z.string().regex(ID_PATTERN),
  accountIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenName: z.string().regex(TOKEN_NAME_PATTERN),
  permissionGroupName: z.literal(CLOUDFLARE_OBSERVABILITY_PERMISSION_GROUP_NAME),
  keychainService: z.literal(CLOUDFLARE_OBSERVABILITY_KEYCHAIN_SERVICE),
  tokenExpiresAt: TIMESTAMP_SCHEMA,
  status: z.literal('verified'),
  effects: CloudflareObservabilityCredentialProvisioningEffectsV1Schema,
  plaintextLeaks: z.literal(0),
}).strict();

export type CloudflareObservabilityCredentialProvisioningAuthorizationV1 = z.infer<
  typeof CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema
>;
export type CloudflareObservabilityCredentialProvisioningSummaryV1 = z.infer<
  typeof CloudflareObservabilityCredentialProvisioningSummaryV1Schema
>;

export async function cloudflareObservabilityCredentialProvisioningAuthorityDigest(
  authorization: object,
): Promise<string> {
  const bound = Object.fromEntries(
    Object.entries(authorization).filter(([key]) => key !== 'authorityDigest'),
  );
  return await canonicalSha256(bound);
}
