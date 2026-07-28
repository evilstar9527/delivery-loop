import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CLOUDFLARE_ACCOUNT_PATTERN = /^[a-f0-9]{32}$/;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,31}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const KeySchema = z.string().regex(KEY_PATTERN);
const EventIdSchema = z.string().regex(EVENT_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });

const SafeUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); }
  catch {
    context.addIssue({ code: 'custom', message: 'evidence URL is invalid' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'evidence URL is unsafe' });
});

export const MONITOR_ALERT_CONFIGURATION_NAMES = [
  'MONITOR_WEBHOOK_SECRET',
  'MONITOR_TENANT_KEY',
  'MONITOR_ALLOWED_REPOSITORIES',
  'MONITOR_SUPPRESSION_WINDOW_SECONDS',
] as const;

const ConfigurationNamesSchema = z.tuple([
  z.literal(MONITOR_ALERT_CONFIGURATION_NAMES[0]),
  z.literal(MONITOR_ALERT_CONFIGURATION_NAMES[1]),
  z.literal(MONITOR_ALERT_CONFIGURATION_NAMES[2]),
  z.literal(MONITOR_ALERT_CONFIGURATION_NAMES[3]),
]);

export const MonitorAlertObservationScenarioSchema = z.enum([
  'primary',
  'retry',
  'suppressed_second',
  'suppressed_third',
  'after_window',
  'invalid_native_signature',
  'repository_denied',
  'authority_injection_denied',
]);

const ObservationSchema = z.object({
  scenario: MonitorAlertObservationScenarioSchema,
  sourceEventId: EventIdSchema,
  eventId: EventIdSchema,
  nativeRequestDigest: DigestSchema,
  normalizedRequestDigest: DigestSchema.nullable(),
  responseDigest: DigestSchema,
  signatureAlgorithm: z.literal('sentry_hook_hmac_sha256'),
  signatureVerified: z.boolean(),
  forwarded: z.boolean(),
  statusCode: z.union([
    z.literal(202), z.literal(400), z.literal(401), z.literal(403),
  ]),
  outcome: z.enum(['created', 'duplicate', 'suppressed', 'rejected']),
  receiptId: IdSchema.nullable(),
  lineageId: IdSchema.nullable(),
  candidateId: IdSchema.nullable(),
  reasonCode: z.enum([
    'invalid_signature', 'repository_not_allowed', 'invalid_request',
  ]).nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().max(60_000),
}).strict().superRefine((item, context) => {
  const expected = {
    primary: [true, true, 202, 'created', null],
    retry: [true, true, 202, 'duplicate', null],
    suppressed_second: [true, true, 202, 'suppressed', null],
    suppressed_third: [true, true, 202, 'suppressed', null],
    after_window: [true, true, 202, 'created', null],
    invalid_native_signature: [false, false, 401, 'rejected', 'invalid_signature'],
    repository_denied: [true, true, 403, 'rejected', 'repository_not_allowed'],
    authority_injection_denied: [true, true, 400, 'rejected', 'invalid_request'],
  } as const;
  const shape = expected[item.scenario];
  const accepted = item.outcome !== 'rejected';
  if (
    item.signatureVerified !== shape[0] || item.forwarded !== shape[1] ||
    item.statusCode !== shape[2] || item.outcome !== shape[3] || item.reasonCode !== shape[4] ||
    accepted !== (item.receiptId !== null) || accepted !== (item.lineageId !== null) ||
    accepted !== (item.candidateId !== null) ||
    item.forwarded !== (item.normalizedRequestDigest !== null) ||
    Date.parse(item.completedAt) - Date.parse(item.startedAt) !== item.latencyMs
  ) context.addIssue({ code: 'custom', message: 'monitor observation is inconsistent' });
});

export const MonitorAlertObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  service: z.literal('delivery-loop-monitor-alert-observer'),
  provider: z.literal('sentry'),
  generatedAt: TimestampSchema,
  requests: z.array(ObservationSchema).length(8),
  reportDigest: DigestSchema,
}).strict().superRefine((report, context) => {
  const scenarios = report.requests.map((item) => item.scenario);
  const byScenario = new Map(report.requests.map((item) => [item.scenario, item]));
  const primary = byScenario.get('primary');
  const retry = byScenario.get('retry');
  const second = byScenario.get('suppressed_second');
  const third = byScenario.get('suppressed_third');
  const after = byScenario.get('after_window');
  if (
    new Set(scenarios).size !== MonitorAlertObservationScenarioSchema.options.length ||
    MonitorAlertObservationScenarioSchema.options.some((item) => !scenarios.includes(item)) ||
    primary === undefined || retry === undefined || second === undefined ||
    third === undefined || after === undefined ||
    primary.sourceEventId !== retry.sourceEventId || primary.eventId !== retry.eventId ||
    primary.nativeRequestDigest !== retry.nativeRequestDigest ||
    primary.normalizedRequestDigest !== retry.normalizedRequestDigest ||
    primary.receiptId !== retry.receiptId || primary.lineageId !== retry.lineageId ||
    primary.candidateId !== retry.candidateId ||
    second.candidateId !== primary.candidateId || third.candidateId !== primary.candidateId ||
    after.candidateId === primary.candidateId ||
    new Set([primary.eventId, second.eventId, third.eventId, after.eventId]).size !== 4 ||
    new Set([primary.sourceEventId, second.sourceEventId, third.sourceEventId,
      after.sourceEventId]).size !== 4 ||
    report.requests.some((item) => Date.parse(item.completedAt) > Date.parse(report.generatedAt))
  ) context.addIssue({ code: 'custom', message: 'monitor observation inventory is incomplete' });
});

const WorkerSchema = z.object({
  accountId: z.string().regex(CLOUDFLARE_ACCOUNT_PATTERN),
  service: z.string().regex(SLUG_PATTERN),
  environment: z.literal('production'),
  settingsUrl: SafeUrlSchema,
  dashboardUrl: SafeUrlSchema,
  configurationNames: ConfigurationNamesSchema,
}).strict();

const DecisionSchema = z.object({
  owner: IdSchema,
  decisionId: IdSchema,
  decisionDigest: DigestSchema,
  decisionEvidenceUrl: SafeUrlSchema,
  decidedAt: TimestampSchema,
}).strict();

const CommonSchema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  worker: WorkerSchema,
  decision: DecisionSchema,
  safety: z.object({ canaryDigest: DigestSchema }).strict(),
}).strict();

const EventCaseSchema = z.object({
  scenario: z.enum(['primary', 'suppressed_second', 'suppressed_third', 'after_window']),
  sourceEventId: EventIdSchema,
  eventId: EventIdSchema,
  receiptId: IdSchema,
  lineageId: IdSchema,
  candidateId: IdSchema,
  occurrenceOrdinal: z.number().int().positive().max(10_000),
  suppressed: z.boolean(),
  occurredAt: TimestampSchema,
  receivedAt: TimestampSchema,
}).strict();

const RejectionCaseSchema = z.object({
  scenario: z.enum([
    'invalid_native_signature', 'repository_denied', 'authority_injection_denied',
  ]),
  sourceEventId: EventIdSchema,
  eventId: EventIdSchema,
  expectedStatus: z.union([z.literal(400), z.literal(401), z.literal(403)]),
  expectedReason: z.enum([
    'invalid_signature', 'repository_not_allowed', 'invalid_request',
  ]),
}).strict();

const EnabledSchema = CommonSchema.extend({
  mode: z.literal('enabled'),
  decision: DecisionSchema.extend({ decision: z.literal('enabled') }).strict(),
  controlPlaneOrigin: SafeUrlSchema,
  observabilityReportUrl: SafeUrlSchema,
  observabilityReportDigest: DigestSchema,
  source: z.object({
    provider: z.literal('sentry'),
    organizationSlug: z.string().regex(SLUG_PATTERN),
    projectSlug: z.string().regex(SLUG_PATTERN),
    projectId: z.string().regex(NUMERIC_ID_PATTERN),
    ruleId: z.string().regex(NUMERIC_ID_PATTERN),
    projectUrl: SafeUrlSchema,
    ruleUrl: SafeUrlSchema,
    integrationUrl: SafeUrlSchema,
    nativeSignatureHeader: z.literal('Sentry-Hook-Signature'),
    nativeSignatureAlgorithm: z.literal('HMAC-SHA256(client-secret, exact-body)'),
  }).strict(),
  profile: z.object({
    adapter: z.literal('generic'),
    tenantKey: KeySchema,
    allowedRepositories: z.array(z.string().regex(REPOSITORY_PATTERN)).min(1).max(200),
    suppressionWindowMs: z.number().int().min(60_000).max(86_400_000),
    alertRuleId: KeySchema,
    repository: z.string().regex(REPOSITORY_PATTERN),
    environment: z.enum(['none', 'test', 'production']),
    severity: z.enum(['info', 'warning', 'error', 'critical']),
  }).strict(),
  events: z.array(EventCaseSchema).length(4),
  rejections: z.array(RejectionCaseSchema).length(3),
  review: z.object({
    observerDeploymentUrl: SafeUrlSchema,
    mappingEvidenceUrl: SafeUrlSchema,
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    nativeSignatureVerified: z.literal(true),
    projectAccessVerified: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const scenarios = manifest.events.map((item) => item.scenario);
  const rejections = manifest.rejections.map((item) => item.scenario);
  const primary = manifest.events.find((item) => item.scenario === 'primary');
  const second = manifest.events.find((item) => item.scenario === 'suppressed_second');
  const third = manifest.events.find((item) => item.scenario === 'suppressed_third');
  const after = manifest.events.find((item) => item.scenario === 'after_window');
  let projectUrl: URL;
  let ruleUrl: URL;
  let settingsUrl: URL;
  let dashboardUrl: URL;
  try {
    projectUrl = new URL(manifest.source.projectUrl);
    ruleUrl = new URL(manifest.source.ruleUrl);
    settingsUrl = new URL(manifest.worker.settingsUrl);
    dashboardUrl = new URL(manifest.worker.dashboardUrl);
  } catch {
    context.addIssue({ code: 'custom', message: 'monitor evidence URLs are invalid' });
    return;
  }
  if (
    new Set(scenarios).size !== 4 ||
    ['primary', 'suppressed_second', 'suppressed_third', 'after_window']
      .some((item) => !scenarios.includes(item as typeof scenarios[number])) ||
    new Set(rejections).size !== 3 ||
    ['invalid_native_signature', 'repository_denied', 'authority_injection_denied']
      .some((item) => !rejections.includes(item as typeof rejections[number])) ||
    primary === undefined || second === undefined || third === undefined || after === undefined ||
    primary.occurrenceOrdinal !== 1 || primary.suppressed ||
    second.occurrenceOrdinal !== 2 || !second.suppressed ||
    third.occurrenceOrdinal !== 3 || !third.suppressed ||
    after.occurrenceOrdinal !== 1 || after.suppressed ||
    second.candidateId !== primary.candidateId || third.candidateId !== primary.candidateId ||
    after.candidateId === primary.candidateId ||
    new Set(manifest.events.map((item) => item.eventId)).size !== 4 ||
    new Set(manifest.events.map((item) => item.sourceEventId)).size !== 4 ||
    new Set(manifest.events.map((item) => item.receiptId)).size !== 4 ||
    new Set(manifest.events.map((item) => item.lineageId)).size !== 4 ||
    Date.parse(second.receivedAt) < Date.parse(primary.receivedAt) ||
    Date.parse(third.receivedAt) < Date.parse(second.receivedAt) ||
    Date.parse(after.receivedAt) <= Date.parse(primary.receivedAt) + manifest.profile.suppressionWindowMs ||
    manifest.profile.allowedRepositories.some((item, index) =>
      index > 0 && item <= manifest.profile.allowedRepositories[index - 1]!) ||
    !manifest.profile.allowedRepositories.includes(manifest.profile.repository) ||
    manifest.profile.alertRuleId !== `sentry:${manifest.source.ruleId}` ||
    projectUrl.hostname !== 'sentry.io' ||
    projectUrl.pathname !== `/organizations/${manifest.source.organizationSlug}/projects/` +
      `${manifest.source.projectSlug}/` ||
    ruleUrl.hostname !== 'sentry.io' ||
    !ruleUrl.pathname.includes(`/projects/${manifest.source.projectSlug}/alerts/rules/`) ||
    !ruleUrl.pathname.endsWith(`/${manifest.source.ruleId}/details/`) ||
    settingsUrl.hostname !== 'api.cloudflare.com' ||
    settingsUrl.pathname !== `/client/v4/accounts/${manifest.worker.accountId}/workers/services/` +
      `${manifest.worker.service}/environments/${manifest.worker.environment}/settings` ||
    dashboardUrl.hostname !== 'dash.cloudflare.com' ||
    dashboardUrl.pathname !== `/${manifest.worker.accountId}/workers/services/view/` +
      `${manifest.worker.service}/${manifest.worker.environment}/settings` ||
    Date.parse(manifest.decision.decidedAt) > Date.parse(manifest.recordedAt) ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'enabled monitor evidence is inconsistent' });
});

const DisabledSchema = CommonSchema.extend({
  mode: z.literal('disabled'),
  decision: DecisionSchema.extend({ decision: z.literal('not_enabled') }).strict(),
  review: z.object({
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    productionConfigurationAbsent: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  let settingsUrl: URL;
  let dashboardUrl: URL;
  try {
    settingsUrl = new URL(manifest.worker.settingsUrl);
    dashboardUrl = new URL(manifest.worker.dashboardUrl);
  } catch {
    context.addIssue({ code: 'custom', message: 'monitor evidence URLs are invalid' });
    return;
  }
  if (
    settingsUrl.hostname !== 'api.cloudflare.com' ||
    settingsUrl.pathname !== `/client/v4/accounts/${manifest.worker.accountId}/workers/services/` +
      `${manifest.worker.service}/environments/${manifest.worker.environment}/settings` ||
    dashboardUrl.hostname !== 'dash.cloudflare.com' ||
    dashboardUrl.pathname !== `/${manifest.worker.accountId}/workers/services/view/` +
      `${manifest.worker.service}/${manifest.worker.environment}/settings` ||
    Date.parse(manifest.decision.decidedAt) > Date.parse(manifest.recordedAt) ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'disabled monitor evidence is inconsistent' });
});

export const MonitorAlertEvidenceManifestV1Schema = z.discriminatedUnion('mode', [
  EnabledSchema,
  DisabledSchema,
]);

export type MonitorAlertEvidenceManifestV1 = z.infer<
  typeof MonitorAlertEvidenceManifestV1Schema
>;
export type MonitorAlertObservabilityReportV1 = z.infer<
  typeof MonitorAlertObservabilityReportV1Schema
>;
export type MonitorAlertObservationScenario = z.infer<
  typeof MonitorAlertObservationScenarioSchema
>;
