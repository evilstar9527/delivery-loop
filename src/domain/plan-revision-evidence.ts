import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EFFECTS = ['repo_write', 'test_deploy', 'merge', 'production_deploy'] as const;
const TimestampSchema = z.iso.datetime({ offset: true });
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const IdSchema = z.string().regex(ID_PATTERN);

const SafeUrlSchema = z.string().min(1).max(2_048).superRefine((raw, context) => {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== ''
    ) context.addIssue({ code: 'custom', message: 'URL is not a safe HTTPS link' });
  } catch {
    context.addIssue({ code: 'custom', message: 'URL is invalid' });
  }
});

const PlanSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  digest: DigestSchema,
  baseSha: z.string().regex(SHA_PATTERN),
  status: z.enum(['superseded', 'active']),
}).strict();

const BaseSourceSchema = z.object({
  kind: z.literal('base_update'),
  recordId: IdSchema,
  digest: DigestSchema,
  observedAt: TimestampSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  beforeSha: z.string().regex(SHA_PATTERN),
  afterSha: z.string().regex(SHA_PATTERN),
  aheadBy: z.number().int().positive(),
  referenceDigest: DigestSchema,
  comparisonDigest: DigestSchema,
}).strict();

const ReviewSourceSchema = z.object({
  kind: z.literal('review_feedback'),
  recordId: IdSchema,
  digest: DigestSchema,
  observedAt: TimestampSchema,
  deliveryId: IdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  pullRequestNumber: z.number().int().positive(),
  reviewId: z.string().regex(/^[0-9]{1,32}$/),
  bodyDigest: DigestSchema,
  reviewedHeadSha: z.string().regex(SHA_PATTERN),
  branch: z.string().regex(BRANCH_PATTERN),
  reviewUrl: SafeUrlSchema,
}).strict();

const ContextSourceSchema = z.object({
  kind: z.literal('supplemental_context'),
  recordId: IdSchema,
  digest: DigestSchema,
  observedAt: TimestampSchema,
  eventDigest: DigestSchema,
  sourceSystem: z.enum(['feishu', 'meego']),
  tenantKey: z.string().regex(EXTERNAL_ID_PATTERN),
  sourceTaskKey: z.string().regex(EXTERNAL_ID_PATTERN),
  priorTaskId: IdSchema,
  priorTaskRevision: z.string().min(1).max(500),
  newTaskId: IdSchema,
  newTaskRevision: z.string().min(1).max(500),
  newTaskDigest: DigestSchema,
  newRunId: IdSchema,
  appliedRunId: IdSchema,
}).strict();

const SourceSchema = z.discriminatedUnion('kind', [
  ReviewSourceSchema,
  BaseSourceSchema,
  ContextSourceSchema,
]);

const InvalidatedApprovalSchema = z.object({
  approvalId: IdSchema,
  effect: z.enum(EFFECTS),
  invalidated: z.literal(true),
}).strict();

const FreshApprovalSchema = z.object({
  approvalId: IdSchema,
  effect: z.enum(EFFECTS),
  decision: z.literal('approve'),
  approver: z.string().regex(/^(user|human):[A-Za-z0-9_.:@/-]{1,240}$/),
  provider: z.enum(['github', 'feishu']),
  externalEventId: z.string().regex(EXTERNAL_ID_PATTERN),
  eventDigest: DigestSchema,
  expiresAt: TimestampSchema,
  invalidated: z.literal(false),
}).strict();

export const PlanRevisionEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  runId: IdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  revision: z.object({
    revisionId: IdSchema,
    expectedRunVersion: z.number().int().nonnegative(),
    status: z.literal('activated'),
    analysisAttemptId: IdSchema,
    priorPlan: PlanSchema.extend({ status: z.literal('superseded') }).strict(),
    newPlan: PlanSchema.extend({ status: z.literal('active') }).strict(),
    changes: z.object({
      body: z.boolean(),
      base: z.boolean(),
      effects: z.boolean(),
    }).strict(),
    activatedAt: TimestampSchema,
  }).strict(),
  source: SourceSchema,
  approvals: z.object({
    invalidated: z.array(InvalidatedApprovalSchema).min(1).max(20),
    fresh: z.array(FreshApprovalSchema).min(1).max(20),
  }).strict(),
  analysisAction: z.object({
    githubRunId: z.string().regex(/^[0-9]{1,32}$/),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml$/),
    displayTitle: z.string().regex(/^delivery-loop\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
    status: z.literal('completed'),
    conclusion: z.literal('success'),
    headSha: z.string().regex(SHA_PATTERN),
    headBranch: z.string().regex(BRANCH_PATTERN),
    runAttempt: z.literal(1),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const { revision, source, approvals, analysisAction } = manifest;
  if (
    revision.newPlan.version !== revision.priorPlan.version + 1 ||
    revision.newPlan.id === revision.priorPlan.id ||
    revision.newPlan.digest === revision.priorPlan.digest ||
    !Object.values(revision.changes).some(Boolean) ||
    revision.changes.base !== (revision.priorPlan.baseSha !== revision.newPlan.baseSha) ||
    analysisAction.headSha !== revision.newPlan.baseSha ||
    analysisAction.displayTitle !== `delivery-loop/${revision.analysisAttemptId}` ||
    Date.parse(manifest.recordedAt) < Date.parse(revision.activatedAt) ||
    Date.parse(revision.activatedAt) < Date.parse(source.observedAt)
  ) context.addIssue({ code: 'custom', message: 'Plan revision binding is inconsistent' });
  if (
    source.kind === 'base_update' &&
    (source.repository !== manifest.repository ||
      source.beforeSha !== revision.priorPlan.baseSha ||
      source.afterSha !== revision.newPlan.baseSha)
  ) context.addIssue({ code: 'custom', message: 'base source binding is inconsistent' });
  if (source.kind === 'review_feedback' && source.repository !== manifest.repository) {
    context.addIssue({ code: 'custom', message: 'review source binding is inconsistent' });
  }
  if (
    source.kind === 'supplemental_context' &&
    (source.priorTaskId === source.newTaskId ||
      source.priorTaskRevision === source.newTaskRevision ||
      source.appliedRunId !== manifest.runId)
  ) context.addIssue({ code: 'custom', message: 'context source binding is inconsistent' });
  const invalidatedIds = approvals.invalidated.map((approval) => approval.approvalId);
  const freshIds = approvals.fresh.map((approval) => approval.approvalId);
  const allIds = [...invalidatedIds, ...freshIds];
  if (new Set(allIds).size !== allIds.length) {
    context.addIssue({ code: 'custom', message: 'approval identities must be unique' });
  }
  const invalidatedEffects = approvals.invalidated.map((approval) => approval.effect);
  const freshEffects = approvals.fresh.map((approval) => approval.effect);
  if (
    new Set(invalidatedEffects).size !== invalidatedEffects.length ||
    new Set(freshEffects).size !== freshEffects.length
  ) context.addIssue({ code: 'custom', message: 'approval effects must be unique' });
  if (approvals.fresh.some((approval) =>
    Date.parse(approval.expiresAt) <= Date.parse(revision.activatedAt))) {
    context.addIssue({ code: 'custom', message: 'fresh approval must outlive activation' });
  }
});

export type PlanRevisionEvidenceManifestV1 = z.infer<
  typeof PlanRevisionEvidenceManifestV1Schema
>;
