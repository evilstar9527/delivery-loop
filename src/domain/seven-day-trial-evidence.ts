import { z } from 'zod';

export const SEVEN_DAY_TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const SEVEN_DAY_TRIAL_MINUTE_BUCKETS = 10_080;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_LOGIN_PATTERN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const ResourceIdSchema = z.string().regex(ID_PATTERN);
const TrialWindowSchema = z.object({
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((window, context) => {
  const startedAt = Date.parse(window.startedAt);
  const endedAt = Date.parse(window.endedAt);
  if (
    endedAt - startedAt !== SEVEN_DAY_TRIAL_DURATION_MS ||
    startedAt % 60_000 !== 0 || endedAt % 60_000 !== 0
  ) context.addIssue({ code: 'custom', message: 'trial window must be exactly seven days' });
});

const EvidenceUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    context.addIssue({ code: 'custom', message: 'trial evidence URL is invalid' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'trial evidence URL is unsafe' });
});

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export const SevenDayTrialEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  trialId: ResourceIdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  githubActorLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
  window: TrialWindowSchema,
  recordedAt: z.iso.datetime({ offset: true }),
  observabilityReportUrl: EvidenceUrlSchema,
  observabilityReportDigest: z.string().regex(DIGEST_PATTERN),
  metricsDashboardUrl: EvidenceUrlSchema,
  logQueryUrl: EvidenceUrlSchema,
  secretAlertQueryUrl: EvidenceUrlSchema,
}).strict().superRefine((manifest, context) => {
  if (Date.parse(manifest.recordedAt) < Date.parse(manifest.window.endedAt)) {
    context.addIssue({ code: 'custom', message: 'trial evidence was recorded before the window ended' });
  }
});

const BoundedIdsSchema = z.array(ResourceIdSchema).max(500);

export const SevenDayTrialObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  trialId: ResourceIdSchema,
  service: z.literal('delivery-loop-control-plane'),
  repository: z.string().regex(REPOSITORY_PATTERN),
  window: TrialWindowSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  detectors: z.object({
    stuckRun: z.enum(['active', 'inactive']),
    runtimeSecret: z.enum(['active', 'inactive']),
  }).strict(),
  minuteBuckets: z.object({
    expected: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
  }).strict(),
  runIds: z.array(ResourceIdSchema).min(1).max(100),
  detectedStuckIncidentIds: BoundedIdsSchema,
  resolvedStuckIncidentIds: BoundedIdsSchema,
  unresolvedKnownStuckRunIds: BoundedIdsSchema,
  unknownStuckRunIds: BoundedIdsSchema,
  runtimeSecretAlertIds: BoundedIdsSchema,
  reportDigest: z.string().regex(DIGEST_PATTERN),
}).strict().superRefine((report, context) => {
  if (Date.parse(report.generatedAt) < Date.parse(report.window.endedAt)) {
    context.addIssue({ code: 'custom', message: 'observability report predates trial completion' });
  }
  for (const values of [
    report.runIds,
    report.detectedStuckIncidentIds,
    report.resolvedStuckIncidentIds,
    report.unresolvedKnownStuckRunIds,
    report.unknownStuckRunIds,
    report.runtimeSecretAlertIds,
  ]) {
    if (duplicate(values)) {
      context.addIssue({ code: 'custom', message: 'observability report IDs must be unique' });
    }
  }
  const detected = new Set(report.detectedStuckIncidentIds);
  if (report.resolvedStuckIncidentIds.some((id) => !detected.has(id))) {
    context.addIssue({ code: 'custom', message: 'resolved stuck incident was not detected' });
  }
});

export type SevenDayTrialEvidenceManifestV1 = z.infer<
  typeof SevenDayTrialEvidenceManifestV1Schema
>;
export type SevenDayTrialObservabilityReportV1 = z.infer<
  typeof SevenDayTrialObservabilityReportV1Schema
>;
