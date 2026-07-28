import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TimestampSchema = z.iso.datetime({ offset: true });
const IdSchema = z.string().regex(ID_PATTERN);
const ShaSchema = z.string().regex(SHA_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const BranchSchema = z.string().regex(BRANCH_PATTERN);

const BaseComparisonSchema = z.object({
  observationId: IdSchema,
  sourceDigest: DigestSchema,
  referenceDigest: DigestSchema,
  comparisonDigest: DigestSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: BranchSchema,
  beforeSha: ShaSchema,
  afterSha: ShaSchema,
  relationship: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  aheadBy: z.number().int().nonnegative(),
  behindBy: z.number().int().nonnegative(),
  mergeBaseSha: ShaSchema,
}).strict();

const ActionSchema = z.object({
  githubRunId: z.string().regex(/^\d{1,32}$/),
  workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml$/),
  displayTitle: z.string().regex(/^delivery-loop\/[A-Za-z0-9][A-Za-z0-9_/-]{0,239}$/),
  status: z.literal('completed'),
  conclusion: z.literal('success'),
  headSha: ShaSchema,
  headBranch: BranchSchema,
  runAttempt: z.literal(1),
}).strict();

const BranchUpdateSchema = z.object({
  ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/),
  beforeSha: ShaSchema,
  afterSha: ShaSchema,
  fastForward: z.literal(true),
  force: z.literal(false),
}).strict();

const SuccessSchema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  runId: IdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  outcome: z.literal('passed'),
  rebase: z.object({
    rebaseId: IdSchema,
    revisionId: IdSchema,
    sourcePlanId: IdSchema,
    sourcePlanVersion: z.number().int().positive(),
    targetPlanId: IdSchema,
    targetPlanVersion: z.number().int().positive(),
    planItemId: IdSchema,
    sourceAttemptId: IdSchema,
    rebaseAttemptId: IdSchema,
    oldBaseSha: ShaSchema,
    newBaseSha: ShaSchema,
    sourceBranch: BranchSchema,
    sourceHeadSha: ShaSchema,
    targetBranch: BranchSchema,
    resultHeadSha: ShaSchema,
    status: z.literal('passed'),
    verificationSuiteId: IdSchema,
    dispatchOutboxId: IdSchema,
  }).strict(),
  baseComparison: BaseComparisonSchema,
  branchUpdate: BranchUpdateSchema,
  action: ActionSchema,
  verification: z.object({
    suiteId: IdSchema,
    headSha: ShaSchema,
    targetedPassed: z.literal(true),
    requiredPassed: z.literal(true),
    evidenceCount: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const { rebase, baseComparison, branchUpdate, action, verification } = manifest;
  if (
    manifest.repository !== baseComparison.repository ||
    baseComparison.baseBranch !== action.headBranch ||
    baseComparison.beforeSha !== rebase.oldBaseSha ||
    baseComparison.afterSha !== rebase.newBaseSha ||
    baseComparison.relationship !== 'ahead' ||
    baseComparison.aheadBy <= 0 || baseComparison.behindBy !== 0 ||
    baseComparison.mergeBaseSha !== rebase.oldBaseSha ||
    rebase.oldBaseSha === rebase.newBaseSha ||
    rebase.sourceHeadSha === rebase.resultHeadSha ||
    branchUpdate.ref !== `refs/heads/${rebase.targetBranch}` ||
    branchUpdate.beforeSha !== rebase.sourceHeadSha ||
    branchUpdate.afterSha !== rebase.resultHeadSha ||
    action.headSha !== rebase.newBaseSha ||
    action.displayTitle !== `delivery-loop/${rebase.rebaseAttemptId}` ||
    action.workflowPath !== '.github/workflows/delivery-agent.yml' ||
    verification.suiteId !== rebase.verificationSuiteId ||
    verification.headSha !== rebase.resultHeadSha
  ) {
    context.addIssue({ code: 'custom', message: 'base rebase success binding is inconsistent' });
  }
});

const ConflictSchema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  runId: IdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  outcome: z.literal('blocked'),
  conflict: z.object({
    conflictId: IdSchema,
    expectedRunVersion: z.number().int().nonnegative(),
    priorPlanId: IdSchema,
    priorPlanVersion: z.number().int().positive(),
    priorPlanDigest: DigestSchema,
    repository: z.string().regex(REPOSITORY_PATTERN),
    baseBranch: BranchSchema,
    targetBranch: BranchSchema,
    beforeSha: ShaSchema,
    afterSha: ShaSchema,
    relationship: z.enum(['behind', 'diverged', 'identical']),
    aheadBy: z.number().int().nonnegative(),
    behindBy: z.number().int().nonnegative(),
    mergeBaseSha: ShaSchema,
    referenceDigest: DigestSchema,
    comparisonDigest: DigestSchema,
    sourceDigest: DigestSchema,
    blockerReason: z.literal('base_history_diverged'),
    neededHumanInput: z.literal('manual_rebase'),
    runVersion: z.number().int().nonnegative(),
    runState: z.literal('blocked'),
    planStatus: z.literal('blocked'),
    cancelOutboxId: IdSchema,
    observedAt: TimestampSchema,
  }).strict(),
  baseComparison: BaseComparisonSchema,
  forbiddenAction: z.object({
    displayTitle: z.string().regex(/^delivery-loop\/[A-Za-z0-9][A-Za-z0-9_/-]{0,239}$/),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml$/),
  }).strict(),
  noSideEffects: z.object({
    actionRuns: z.literal(0),
    pushEvents: z.literal(0),
    evidence: z.literal(0),
    executionDispatches: z.literal(0),
    targetBranchAbsent: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const { conflict, baseComparison, forbiddenAction } = manifest;
  if (
    manifest.repository !== conflict.repository ||
    conflict.repository !== baseComparison.repository ||
    conflict.baseBranch !== baseComparison.baseBranch ||
    conflict.beforeSha !== baseComparison.beforeSha ||
    conflict.afterSha !== baseComparison.afterSha ||
    conflict.relationship !== baseComparison.relationship ||
    conflict.aheadBy !== baseComparison.aheadBy ||
    conflict.behindBy !== baseComparison.behindBy ||
    conflict.mergeBaseSha !== baseComparison.mergeBaseSha ||
    conflict.runVersion !== conflict.expectedRunVersion + 1 ||
    Date.parse(manifest.recordedAt) < Date.parse(conflict.observedAt) ||
    forbiddenAction.workflowPath !== '.github/workflows/delivery-agent.yml'
  ) context.addIssue({ code: 'custom', message: 'base rebase conflict binding is inconsistent' });
});

export const BaseRebaseEvidenceManifestV1Schema = z.discriminatedUnion('outcome', [
  SuccessSchema,
  ConflictSchema,
]);

export type BaseRebaseEvidenceManifestV1 = z.infer<
  typeof BaseRebaseEvidenceManifestV1Schema
>;
