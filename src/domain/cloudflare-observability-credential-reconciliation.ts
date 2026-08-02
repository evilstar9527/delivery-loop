import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOKEN_NAME_PATTERN =
  /^delivery-loop-workers-observability-read-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

export const CloudflareObservabilityCredentialReconciliationEffectsV1Schema = z.object({
  tokenInventoryReads: z.literal(1),
  permissionGroupReads: z.literal(0),
  tokenCreates: z.literal(0),
  keychainReads: z.literal(0),
  keychainWrites: z.literal(0),
  tokenVerifications: z.literal(0),
  telemetryQueries: z.literal(0),
  tokenDeletes: z.literal(0),
  retries: z.literal(0),
}).strict();

export const CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema = z.object({
  schemaVersion: z.literal('1'),
  authorizationId: z.string().regex(ID_PATTERN),
  authorizedAt: TIMESTAMP_SCHEMA,
  expiresAt: TIMESTAMP_SCHEMA,
  sourceProvisioningAuthorizationId: z.string().regex(ID_PATTERN),
  sourceProvisioningAuthorityDigest: z.string().regex(DIGEST_PATTERN),
  accountIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenName: z.string().regex(TOKEN_NAME_PATTERN),
  tokenNotBefore: TIMESTAMP_SCHEMA,
  tokenExpiresAt: TIMESTAMP_SCHEMA,
  effects: CloudflareObservabilityCredentialReconciliationEffectsV1Schema,
  authorityDigest: z.string().regex(DIGEST_PATTERN),
}).strict().superRefine((authorization, context) => {
  const authorizedAt = Date.parse(authorization.authorizedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const tokenNotBefore = Date.parse(authorization.tokenNotBefore);
  const tokenExpiresAt = Date.parse(authorization.tokenExpiresAt);
  if (expiresAt <= authorizedAt || expiresAt - authorizedAt > 30 * 60_000) {
    context.addIssue({ code: 'custom', message: 'authority window must be at most 30 minutes' });
  }
  if (
    tokenExpiresAt <= tokenNotBefore ||
    tokenExpiresAt - tokenNotBefore > 2 * 60 * 60_000
  ) {
    context.addIssue({ code: 'custom', message: 'source token TTL must be at most two hours' });
  }
});

const RECONCILIATION_SUMMARY_BASE = z.object({
  schemaVersion: z.literal('1'),
  authorizationId: z.string().regex(ID_PATTERN),
  sourceProvisioningAuthorizationId: z.string().regex(ID_PATTERN),
  sourceProvisioningAuthorityDigest: z.string().regex(DIGEST_PATTERN),
  accountIdDigest: z.string().regex(DIGEST_PATTERN),
  tokenName: z.string().regex(TOKEN_NAME_PATTERN),
  tokenNotBefore: TIMESTAMP_SCHEMA,
  tokenExpiresAt: TIMESTAMP_SCHEMA,
  effects: CloudflareObservabilityCredentialReconciliationEffectsV1Schema,
  plaintextLeaks: z.literal(0),
});

export const CloudflareObservabilityCredentialReconciliationSummaryV1Schema =
  z.discriminatedUnion('status', [
    RECONCILIATION_SUMMARY_BASE.extend({
      status: z.literal('absent'),
    }).strict(),
    RECONCILIATION_SUMMARY_BASE.extend({
      status: z.literal('present'),
      tokenIdDigest: z.string().regex(DIGEST_PATTERN),
      tokenStatus: z.enum(['active', 'disabled', 'expired']),
    }).strict(),
  ]);

export type CloudflareObservabilityCredentialReconciliationAuthorizationV1 = z.infer<
  typeof CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema
>;
export type CloudflareObservabilityCredentialReconciliationSummaryV1 = z.infer<
  typeof CloudflareObservabilityCredentialReconciliationSummaryV1Schema
>;

export async function cloudflareObservabilityCredentialReconciliationAuthorityDigest(
  authorization: object,
): Promise<string> {
  const bound = Object.fromEntries(
    Object.entries(authorization).filter(([key]) => key !== 'authorityDigest'),
  );
  return await canonicalSha256(bound);
}
