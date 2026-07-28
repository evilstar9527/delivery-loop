import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PRINCIPAL_PATTERN = /^(?:user|service|agent):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const REVIEW_ID_PATTERN = /^[1-9][0-9]{0,31}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });
const PrincipalSchema = z.string().regex(PRINCIPAL_PATTERN);

const SafeEvidenceUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
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

const GitHubReviewUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); }
  catch {
    context.addIssue({ code: 'custom', message: 'GitHub review URL is invalid' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.hostname !== 'github.com' ||
    url.username !== '' || url.password !== '' || url.search !== '' ||
    !/^#pullrequestreview-[1-9][0-9]{0,31}$/.test(url.hash)
  ) context.addIssue({ code: 'custom', message: 'GitHub review URL is unsafe' });
});

export const ApprovalLineageObservationScenarioSchema = z.enum([
  'feishu_primary',
  'feishu_retry',
  'feishu_distinct_event',
  'github_primary',
  'github_retry',
  'github_snapshot_mutation',
]);

const ObservationSchema = z.object({
  scenario: ApprovalLineageObservationScenarioSchema,
  provider: z.enum(['feishu', 'github']),
  externalEventId: IdSchema,
  externalEventDigest: DigestSchema,
  requestDigest: DigestSchema,
  responseDigest: DigestSchema,
  signatureVerified: z.literal(true),
  signatureAlgorithm: z.enum(['feishu_v2', 'github_hmac_sha256']),
  statusCode: z.union([z.literal(200), z.literal(201), z.literal(409)]),
  outcome: z.enum(['created', 'converged', 'rejected']),
  approvalId: IdSchema.nullable(),
  lineageId: IdSchema.nullable(),
  reasonCode: z.enum(['replay_rejected', 'source_conflict']).nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().max(60_000),
}).strict().superRefine((item, context) => {
  const expected = {
    feishu_primary: {
      provider: 'feishu', algorithm: 'feishu_v2', statusCode: 200, outcome: 'created', reason: null,
    },
    feishu_retry: {
      provider: 'feishu', algorithm: 'feishu_v2', statusCode: 200, outcome: 'converged', reason: null,
    },
    feishu_distinct_event: {
      provider: 'feishu', algorithm: 'feishu_v2', statusCode: 409,
      outcome: 'rejected', reason: 'replay_rejected',
    },
    github_primary: {
      provider: 'github', algorithm: 'github_hmac_sha256', statusCode: 201,
      outcome: 'created', reason: null,
    },
    github_retry: {
      provider: 'github', algorithm: 'github_hmac_sha256', statusCode: 200,
      outcome: 'converged', reason: null,
    },
    github_snapshot_mutation: {
      provider: 'github', algorithm: 'github_hmac_sha256', statusCode: 409,
      outcome: 'rejected', reason: 'source_conflict',
    },
  } as const;
  const shape = expected[item.scenario];
  const accepted = item.outcome !== 'rejected';
  if (
    item.provider !== shape.provider || item.signatureAlgorithm !== shape.algorithm ||
    item.statusCode !== shape.statusCode || item.outcome !== shape.outcome ||
    item.reasonCode !== shape.reason ||
    accepted !== (item.approvalId !== null) || accepted !== (item.lineageId !== null) ||
    Date.parse(item.completedAt) - Date.parse(item.startedAt) !== item.latencyMs
  ) context.addIssue({ code: 'custom', message: 'approval observation is inconsistent' });
});

export const ApprovalLineageObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  service: z.literal('delivery-loop-approval-lineage-observer'),
  generatedAt: TimestampSchema,
  requests: z.array(ObservationSchema).length(6),
  reportDigest: DigestSchema,
}).strict().superRefine((report, context) => {
  const scenarios = report.requests.map((item) => item.scenario);
  const byScenario = new Map(report.requests.map((item) => [item.scenario, item]));
  const feishu = byScenario.get('feishu_primary');
  const feishuRetry = byScenario.get('feishu_retry');
  const feishuDistinct = byScenario.get('feishu_distinct_event');
  const github = byScenario.get('github_primary');
  const githubRetry = byScenario.get('github_retry');
  const githubMutation = byScenario.get('github_snapshot_mutation');
  if (
    new Set(scenarios).size !== ApprovalLineageObservationScenarioSchema.options.length ||
    ApprovalLineageObservationScenarioSchema.options.some((item) => !scenarios.includes(item)) ||
    feishu === undefined || feishuRetry === undefined || feishuDistinct === undefined ||
    github === undefined || githubRetry === undefined || githubMutation === undefined ||
    feishu.externalEventId !== feishuRetry.externalEventId ||
    feishu.externalEventDigest !== feishuRetry.externalEventDigest ||
    feishu.requestDigest !== feishuRetry.requestDigest ||
    feishu.approvalId !== feishuRetry.approvalId || feishu.lineageId !== feishuRetry.lineageId ||
    feishuDistinct.externalEventId === feishu.externalEventId ||
    feishuDistinct.externalEventDigest === feishu.externalEventDigest ||
    feishuDistinct.requestDigest === feishu.requestDigest ||
    github.externalEventId !== githubRetry.externalEventId ||
    github.externalEventDigest !== githubRetry.externalEventDigest ||
    github.requestDigest !== githubRetry.requestDigest ||
    github.approvalId !== githubRetry.approvalId || github.lineageId !== githubRetry.lineageId ||
    githubMutation.externalEventId !== github.externalEventId ||
    githubMutation.externalEventDigest !== github.externalEventDigest ||
    githubMutation.requestDigest === github.requestDigest ||
    feishu.externalEventId === github.externalEventId ||
    feishu.approvalId === github.approvalId || feishu.lineageId === github.lineageId ||
    report.requests.some((item) => Date.parse(item.completedAt) > Date.parse(report.generatedAt))
  ) context.addIssue({ code: 'custom', message: 'approval observation inventory is incomplete' });
});

const SnapshotSchema = z.object({
  taskId: IdSchema,
  taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  taskDigest: DigestSchema,
  runId: IdSchema,
  runVersion: z.number().int().nonnegative(),
  planId: IdSchema,
  planVersion: z.number().int().positive(),
  planDigest: DigestSchema,
  baseSha: z.string().regex(SHA_PATTERN),
  effect: z.literal('merge'),
  decision: z.literal('approve'),
}).strict();

const IdentitySchema = z.object({
  principal: PrincipalSchema,
  principalDigest: DigestSchema,
  roles: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)).min(2).max(100),
  rolesDigest: DigestSchema,
  pullRequestAuthorPrincipal: PrincipalSchema,
  pullRequestAuthorLogin: z.string().regex(LOGIN_PATTERN),
  separationVerified: z.literal(true),
}).strict().superRefine((identity, context) => {
  if (
    identity.principal === identity.pullRequestAuthorPrincipal ||
    !identity.roles.includes('human') || !identity.roles.includes('approve:merge') ||
    identity.roles.some((role, index) => index > 0 && role <= identity.roles[index - 1]!)
  ) context.addIssue({ code: 'custom', message: 'approval identity is inconsistent' });
});

const SourceSchema = z.object({
  externalEventId: IdSchema,
  externalEventDigest: DigestSchema,
  sourceId: IdSchema,
  approvalId: IdSchema,
  lineageId: IdSchema,
  sourceOccurredAt: TimestampSchema,
  decisionRecordedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict().superRefine((source, context) => {
  if (
    Date.parse(source.decisionRecordedAt) < Date.parse(source.sourceOccurredAt) ||
    Date.parse(source.expiresAt) <= Date.parse(source.decisionRecordedAt)
  ) context.addIssue({ code: 'custom', message: 'approval source times are inconsistent' });
});

const FeishuSchema = SourceSchema.extend({
  tenantKey: IdSchema,
  appId: IdSchema,
  deliveryId: IdSchema,
  actionReceiptId: IdSchema,
  outcomeId: IdSchema,
  operatorDigest: DigestSchema,
  openIdDigest: DigestSchema,
  chatDigest: DigestSchema,
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  cardId: IdSchema,
  presentationId: IdSchema,
  actionId: IdSchema,
  requestDigest: DigestSchema,
}).strict().superRefine((source, context) => {
  if (source.operatorDigest !== source.openIdDigest) {
    context.addIssue({ code: 'custom', message: 'Feishu operator binding is inconsistent' });
  }
});

const GitHubSchema = SourceSchema.extend({
  requestDigest: DigestSchema,
  reviewerLogin: z.string().regex(LOGIN_PATTERN),
  pullRequestNumber: z.number().int().positive().safe(),
  reviewId: z.string().regex(REVIEW_ID_PATTERN),
  headBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/),
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/),
  headSha: z.string().regex(SHA_PATTERN),
  reviewSubmittedAt: TimestampSchema,
}).strict();

const IsolationSchema = z.object({
  feishuDistinctEvent: z.object({
    eventId: IdSchema,
    eventDigest: DigestSchema,
    deliveryId: IdSchema,
    requestDigest: DigestSchema,
    expectedReason: z.literal('replay_rejected'),
  }).strict(),
  githubSnapshotMutation: z.object({
    requestDigest: DigestSchema,
    expectedReason: z.literal('source_conflict'),
  }).strict(),
}).strict();

export const ApprovalLineageEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  controlPlaneOrigin: SafeEvidenceUrlSchema,
  observabilityReportUrl: SafeEvidenceUrlSchema,
  observabilityReportDigest: DigestSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  snapshot: SnapshotSchema,
  identity: IdentitySchema,
  feishu: FeishuSchema,
  github: GitHubSchema,
  isolation: IsolationSchema,
  noEffect: z.object({
    mergeOutboxes: z.literal(0),
    merges: z.literal(0),
  }).strict(),
  safety: z.object({ canaryDigest: DigestSchema }).strict(),
  review: z.object({
    mappingEvidenceUrl: SafeEvidenceUrlSchema,
    feishuEventEvidenceUrl: SafeEvidenceUrlSchema,
    githubReviewUrl: GitHubReviewUrlSchema,
    case8ReportUrl: SafeEvidenceUrlSchema,
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    sameHumanConfirmed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const feishu = manifest.feishu;
  const github = manifest.github;
  const isolation = manifest.isolation;
  let reviewUrl: URL;
  let case8Url: URL;
  try {
    reviewUrl = new URL(manifest.review.githubReviewUrl);
    case8Url = new URL(manifest.review.case8ReportUrl);
  } catch {
    context.addIssue({ code: 'custom', message: 'approval review URLs are invalid' });
    return;
  }
  if (
    feishu.externalEventId === github.externalEventId ||
    feishu.sourceId === github.sourceId || feishu.approvalId === github.approvalId ||
    feishu.lineageId === github.lineageId ||
    isolation.feishuDistinctEvent.eventId === feishu.externalEventId ||
    isolation.feishuDistinctEvent.eventDigest === feishu.externalEventDigest ||
    isolation.feishuDistinctEvent.requestDigest === feishu.requestDigest ||
    isolation.githubSnapshotMutation.requestDigest === github.requestDigest ||
    manifest.identity.pullRequestAuthorLogin === github.reviewerLogin ||
    reviewUrl.hostname !== 'github.com' ||
    reviewUrl.pathname !== `/${manifest.repository}/pull/${github.pullRequestNumber}` ||
    reviewUrl.hash !== `#pullrequestreview-${github.reviewId}` ||
    case8Url.origin !== new URL(manifest.controlPlaneOrigin).origin ||
    case8Url.pathname !== `/v1/runs/${manifest.snapshot.runId}/audit` ||
    Date.parse(github.reviewSubmittedAt) !== Date.parse(github.sourceOccurredAt) ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt) ||
    Date.parse(feishu.decisionRecordedAt) > Date.parse(manifest.recordedAt) ||
    Date.parse(github.decisionRecordedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'approval lineage evidence is inconsistent' });
});

export type ApprovalLineageEvidenceManifestV1 = z.infer<
  typeof ApprovalLineageEvidenceManifestV1Schema
>;
export type ApprovalLineageObservabilityReportV1 = z.infer<
  typeof ApprovalLineageObservabilityReportV1Schema
>;
export type ApprovalLineageObservationScenario = z.infer<
  typeof ApprovalLineageObservationScenarioSchema
>;
