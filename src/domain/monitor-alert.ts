import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export const MonitorAlertSeveritySchema = z.enum([
  'info',
  'warning',
  'error',
  'critical',
]);

export const MonitorAlertWebhookV1Schema = z.object({
  schemaVersion: z.literal('1'),
  eventId: z.string().regex(EVENT_ID_PATTERN),
  occurredAt: z.iso.datetime({ offset: true }),
  status: z.literal('firing'),
  alert: z.object({
    ruleId: z.string().regex(KEY_PATTERN),
    resourceKey: z.string().min(1).max(1_000).refine((value) => value.trim().length > 0),
    repository: z.string().regex(REPOSITORY_PATTERN).max(201),
    environment: z.enum(['none', 'test', 'production']),
    severity: MonitorAlertSeveritySchema,
    title: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
    description: z.string().min(1).max(100_000).refine((value) => value.trim().length > 0),
  }).strict(),
}).strict();

export type MonitorAlertWebhookV1 = z.infer<typeof MonitorAlertWebhookV1Schema>;
export type MonitorAlertSeverity = z.infer<typeof MonitorAlertSeveritySchema>;

export const MonitorAdapterProfileV1Schema = z.object({
  schemaVersion: z.literal('1'),
  adapter: z.literal('generic'),
  tenantKey: z.string().regex(KEY_PATTERN),
  allowedRepositories: z.array(z.string().regex(REPOSITORY_PATTERN).max(201)).min(1).max(200),
  suppressionWindowMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1_000),
}).strict().superRefine((profile, context) => {
  if (new Set(profile.allowedRepositories).size !== profile.allowedRepositories.length) {
    context.addIssue({
      code: 'custom',
      path: ['allowedRepositories'],
      message: 'allowedRepositories must be unique',
    });
  }
});

export type MonitorAdapterProfileV1 = z.infer<typeof MonitorAdapterProfileV1Schema>;

export async function monitorAdapterProfileDigest(
  rawProfile: MonitorAdapterProfileV1,
): Promise<string> {
  return await canonicalSha256(MonitorAdapterProfileV1Schema.parse(rawProfile));
}

export async function monitorAlertSnapshotDigest(
  rawAlert: MonitorAlertWebhookV1,
): Promise<string> {
  return await canonicalSha256(MonitorAlertWebhookV1Schema.parse(rawAlert));
}

export async function monitorAlertResourceDigest(resourceKey: string): Promise<string> {
  return await canonicalSha256({ schemaVersion: '1', resourceKey });
}

/**
 * Prose and provider delivery identity do not define alert sameness. The
 * trusted adapter profile and normalized routing/resource fields do.
 */
export async function monitorAlertFingerprint(
  rawAlert: MonitorAlertWebhookV1,
  rawProfile: MonitorAdapterProfileV1,
): Promise<string> {
  const event = MonitorAlertWebhookV1Schema.parse(rawAlert);
  const profile = MonitorAdapterProfileV1Schema.parse(rawProfile);
  const profileDigest = await monitorAdapterProfileDigest(profile);
  return await canonicalSha256({
    schemaVersion: '1',
    adapter: profile.adapter,
    tenantKey: profile.tenantKey,
    profileDigest,
    ruleId: event.alert.ruleId,
    resourceKey: event.alert.resourceKey,
    repository: event.alert.repository,
    environment: event.alert.environment,
    severity: event.alert.severity,
  });
}
