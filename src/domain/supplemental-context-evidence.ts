import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,500}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const TargetIdSchema = z.string().regex(TARGET_ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });

const SafeEvidenceUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    context.addIssue({ code: 'custom', message: 'evidence URL is invalid' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'evidence URL is unsafe' });
});

export const SupplementalContextObservationScenarioSchema = z.enum([
  'feishu_new_run',
  'feishu_apply_current',
  'meegle_primary',
  'meegle_primary_retry',
  'meegle_peer',
]);

const ObservationSchema = z.object({
  scenario: SupplementalContextObservationScenarioSchema,
  provider: z.enum(['feishu', 'meegle']),
  eventId: IdSchema,
  requestDigest: DigestSchema,
  responseDigest: DigestSchema,
  statusCode: z.literal(200),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().max(60_000),
}).strict().superRefine((item, context) => {
  if (
    (item.scenario.startsWith('feishu_') ? 'feishu' : 'meegle') !== item.provider ||
    Date.parse(item.completedAt) - Date.parse(item.startedAt) !== item.latencyMs
  ) context.addIssue({ code: 'custom', message: 'observation is inconsistent' });
});

export const SupplementalContextObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  service: z.literal('delivery-loop-supplemental-context-observer'),
  generatedAt: TimestampSchema,
  requests: z.array(ObservationSchema).length(5),
  reportDigest: DigestSchema,
}).strict().superRefine((report, context) => {
  const scenarios = report.requests.map((item) => item.scenario);
  const primary = report.requests.find((item) => item.scenario === 'meegle_primary');
  const retry = report.requests.find((item) => item.scenario === 'meegle_primary_retry');
  if (
    new Set(scenarios).size !== SupplementalContextObservationScenarioSchema.options.length ||
    SupplementalContextObservationScenarioSchema.options.some((item) => !scenarios.includes(item)) ||
    primary === undefined || retry === undefined || primary.eventId !== retry.eventId ||
    new Set(report.requests.map((item) => item.eventId)).size !== 4 ||
    new Set(report.requests.map((item) => item.requestDigest)).size !== report.requests.length ||
    report.requests.some((item) => Date.parse(item.completedAt) > Date.parse(report.generatedAt))
  ) context.addIssue({ code: 'custom', message: 'observation inventory is incomplete' });
});

const FeishuCaseSchema = z.object({
  mode: z.enum(['new_run', 'apply_current']),
  tenantKey: TargetIdSchema,
  eventId: IdSchema,
  deliveryId: IdSchema,
  actionReceiptId: IdSchema,
  outcomeId: IdSchema,
  operatorDigest: DigestSchema,
  contextId: IdSchema,
  priorTaskId: IdSchema,
  newTaskId: IdSchema,
  newRunId: IdSchema,
  sourceRunId: IdSchema,
  expectedRunVersion: z.number().int().nonnegative(),
  priorAttemptId: IdSchema,
  priorAttemptVersion: z.number().int().nonnegative(),
  priorAttemptLeaseGeneration: z.number().int().nonnegative(),
  contextDigest: DigestSchema,
  newTaskDigest: DigestSchema,
  planRevisionId: IdSchema.nullable(),
  analysisAttemptId: IdSchema.nullable(),
}).strict().superRefine((item, context) => {
  const apply = item.mode === 'apply_current';
  if (apply !== (item.planRevisionId !== null) || apply !== (item.analysisAttemptId !== null)) {
    context.addIssue({ code: 'custom', message: 'Feishu context mode is inconsistent' });
  }
});

const MeegleConvergenceSchema = z.object({
  tenantKey: TargetIdSchema,
  projectKey: TargetIdSchema,
  workItemTypeKey: TargetIdSchema,
  workItemId: TargetIdSchema,
  externalRevision: TargetIdSchema,
  contextId: IdSchema,
  priorTaskId: IdSchema,
  newTaskId: IdSchema,
  newRunId: IdSchema,
  contextDigest: DigestSchema,
  newTaskDigest: DigestSchema,
  eventIds: z.tuple([IdSchema, IdSchema]),
  ingressOutboxIds: z.tuple([IdSchema, IdSchema]),
  exactSnapshotDigests: z.tuple([DigestSchema, DigestSchema]),
  mappingSnapshotDigest: DigestSchema,
  mappingProfileDigest: DigestSchema,
}).strict().superRefine((item, context) => {
  if (
    item.eventIds[0] === item.eventIds[1] ||
    item.ingressOutboxIds[0] === item.ingressOutboxIds[1] ||
    item.exactSnapshotDigests[0] === item.exactSnapshotDigests[1]
  ) context.addIssue({ code: 'custom', message: 'Meegle convergence requires two events' });
});

export const SupplementalContextEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  controlPlaneOrigin: SafeEvidenceUrlSchema,
  observabilityReportUrl: SafeEvidenceUrlSchema,
  observabilityReportDigest: DigestSchema,
  application: z.object({
    appId: TargetIdSchema,
    tenantKey: TargetIdSchema,
    chatId: TargetIdSchema,
    callbackUrl: SafeEvidenceUrlSchema,
  }).strict(),
  card: z.object({
    messageId: z.string().regex(MESSAGE_ID_PATTERN),
    cardDigest: DigestSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }).strict(),
  feishuCases: z.array(FeishuCaseSchema).length(2),
  meegleConvergence: MeegleConvergenceSchema,
  safety: z.object({ canaryDigest: DigestSchema }).strict(),
  review: z.object({
    feishuDeveloperConsoleUrl: SafeEvidenceUrlSchema,
    feishuPermissionUrl: SafeEvidenceUrlSchema,
    feishuChatUrl: SafeEvidenceUrlSchema,
    feishuMappingEvidenceUrl: SafeEvidenceUrlSchema,
    meegleProjectUrl: SafeEvidenceUrlSchema,
    screenshotBundleUrl: SafeEvidenceUrlSchema,
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    eventSubscription: z.literal('active'),
    botMembership: z.literal('member'),
    meegleProjectAccess: z.literal('verified'),
    feishuScopes: z.array(z.enum([
      'im:message',
      'im:message:readonly',
      'im:message.group_msg',
      'im:message:send_as_bot',
      'im:message:update',
    ])).min(4).max(5).refine((items) => new Set(items).size === items.length),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const modes = manifest.feishuCases.map((item) => item.mode);
  const events = [
    ...manifest.feishuCases.map((item) => item.eventId),
    ...manifest.meegleConvergence.eventIds,
  ];
  const scopes = new Set(manifest.review.feishuScopes);
  if (
    new Set(modes).size !== 2 || !modes.includes('new_run') || !modes.includes('apply_current') ||
    new Set(manifest.feishuCases.map((item) => item.contextId)).size !== 2 ||
    manifest.feishuCases.some((item) => item.tenantKey !== manifest.application.tenantKey) ||
    new Set(events).size !== 4 ||
    !scopes.has('im:message:send_as_bot') || !scopes.has('im:message:update') ||
    !scopes.has('im:message.group_msg') ||
    (!scopes.has('im:message') && !scopes.has('im:message:readonly')) ||
    Date.parse(manifest.card.updatedAt) < Date.parse(manifest.card.createdAt) ||
    Date.parse(manifest.card.updatedAt) > Date.parse(manifest.recordedAt) ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'supplemental context evidence is inconsistent' });
});

export type SupplementalContextEvidenceManifestV1 = z.infer<
  typeof SupplementalContextEvidenceManifestV1Schema
>;
export type SupplementalContextObservabilityReportV1 = z.infer<
  typeof SupplementalContextObservabilityReportV1Schema
>;
