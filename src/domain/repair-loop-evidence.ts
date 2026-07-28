import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';

const AttemptSchema = z.object({
  attemptId: z.string().regex(ID_PATTERN),
  ordinal: z.number().int().positive().max(100),
  mode: z.enum(['implement', 'review_fix']),
  actionRunId: z.string().regex(GITHUB_ID_PATTERN),
  actionConclusion: z.enum(['failure', 'success']),
  workflowHeadSha: z.string().regex(SHA_PATTERN),
  branch: z.string().regex(BRANCH_PATTERN),
  checkoutSha: z.string().regex(SHA_PATTERN),
  resultHeadSha: z.string().regex(SHA_PATTERN).nullable(),
  failureFingerprint: z.string().regex(DIGEST_PATTERN).nullable(),
}).strict();

const EvidenceSchema = z.object({
  evidenceId: z.string().regex(ID_PATTERN),
  attemptId: z.string().regex(ID_PATTERN),
  kind: z.enum(['commit', 'test']),
  status: z.enum(['passed', 'failed']),
  verificationStatus: z.enum(['verified', 'unverified']),
  sha: z.string().regex(SHA_PATTERN),
}).strict();

const BlockerSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  reason: z.enum(['repeated_fingerprint', 'attempt_limit']),
  fingerprintDigest: z.string().regex(DIGEST_PATTERN),
  attemptCount: z.number().int().positive().max(100),
  consecutiveFingerprintCount: z.number().int().positive().max(100),
  neededHumanInputCode: z.enum([
    'clarify_requirement', 'provide_reproduction', 'grant_context_access',
    'resolve_external_dependency', 'approve_policy_change', 'manual_investigation',
  ]),
  attemptedPaths: z.array(z.string().regex(ID_PATTERN)).min(1).max(20),
}).strict();

const CommonCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  runState: z.enum(['executing', 'verifying', 'blocked']),
  repository: z.string().regex(REPOSITORY_PATTERN),
  taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  planItemId: z.string().regex(ID_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  workflowPath: z.literal(WORKFLOW_PATH),
  attempts: z.array(AttemptSchema).min(2).max(3),
  evidence: z.array(EvidenceSchema).min(1).max(20),
  blocker: BlockerSchema.nullable(),
  noDuplicate: z.object({
    repairAttempts: z.number().int().positive().max(3),
    executionDispatches: z.number().int().positive().max(3),
    commitEvidence: z.number().int().nonnegative().max(3),
  }).strict(),
}).strict();

function refineCommonCase(
  item: z.infer<typeof CommonCaseSchema>,
  context: z.RefinementCtx,
): void {
  const ids = item.attempts.map((attempt) => attempt.attemptId);
  const actionIds = item.attempts.map((attempt) => attempt.actionRunId);
  if (
    new Set(ids).size !== ids.length || new Set(actionIds).size !== actionIds.length ||
    item.attempts.some((attempt, index) =>
      attempt.ordinal !== index + 1 || attempt.branch.includes('..') ||
      (attempt.actionConclusion === 'success' && attempt.resultHeadSha === null) ||
      (attempt.actionConclusion === 'success' && attempt.resultHeadSha !== attempt.workflowHeadSha) ||
      (attempt.actionConclusion === 'failure' && attempt.resultHeadSha !== null))
  ) context.addIssue({ code: 'custom', message: 'repair attempts are not sequentially bound' });
  if (item.attempts.some((attempt) => attempt.workflowHeadSha !== attempt.checkoutSha && attempt.ordinal === 1)) {
    context.addIssue({ code: 'custom', message: 'initial attempt checkout is not base-bound' });
  }
  if (item.noDuplicate.repairAttempts !== item.attempts.length ||
      item.noDuplicate.executionDispatches !== item.attempts.length ||
      item.noDuplicate.commitEvidence !== item.evidence.filter((entry) => entry.kind === 'commit').length) {
    context.addIssue({ code: 'custom', message: 'repair effect counts are inconsistent' });
  }
}

const RepairSucceededCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('repair_succeeded'),
  blocker: z.null(),
}).strict().superRefine((item, context) => {
  refineCommonCase(item, context);
  const first = item.attempts[0]!;
  const last = item.attempts.at(-1)!;
  if (
    item.attempts.length !== 2 || item.runState === 'blocked' ||
    first.actionConclusion !== 'failure' || last.actionConclusion !== 'success' ||
    item.evidence.filter((entry) => entry.attemptId === last.attemptId &&
      entry.kind === 'commit' && entry.status === 'passed' && entry.verificationStatus === 'verified').length !== 1 ||
    item.evidence.filter((entry) => entry.attemptId === last.attemptId &&
      entry.kind === 'test' && entry.status === 'passed' && entry.verificationStatus === 'verified').length < 1
  ) context.addIssue({ code: 'custom', message: 'successful repair case is inconsistent' });
});

const RepeatedFingerprintCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('repeated_fingerprint_blocked'),
  runState: z.literal('blocked'),
  blocker: BlockerSchema,
}).strict().superRefine((item, context) => {
  refineCommonCase(item, context);
  const fingerprints = item.attempts.map((attempt) => attempt.failureFingerprint);
  if (
    item.attempts.length !== 2 || item.attempts.some((attempt) => attempt.actionConclusion !== 'failure') ||
    fingerprints[0] === null || fingerprints[0] !== fingerprints[1] ||
    item.blocker.reason !== 'repeated_fingerprint' ||
    item.blocker.attemptCount !== 2 || item.blocker.consecutiveFingerprintCount < 2
  ) context.addIssue({ code: 'custom', message: 'repeated fingerprint blocker case is inconsistent' });
});

const AttemptLimitCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('attempt_limit_blocked'),
  runState: z.literal('blocked'),
  blocker: BlockerSchema,
}).strict().superRefine((item, context) => {
  refineCommonCase(item, context);
  const fingerprints = item.attempts.map((attempt) => attempt.failureFingerprint);
  if (
    item.attempts.length !== 3 || item.attempts.some((attempt) => attempt.actionConclusion !== 'failure') ||
    fingerprints.some((fingerprint) => fingerprint === null) || new Set(fingerprints).size !== 3 ||
    item.blocker.reason !== 'attempt_limit' || item.blocker.attemptCount !== 3
  ) context.addIssue({ code: 'custom', message: 'attempt limit blocker case is inconsistent' });
});

export const RepairLoopEvidenceCaseSchema = z.discriminatedUnion('outcome', [
  RepairSucceededCaseSchema,
  RepeatedFingerprintCaseSchema,
  AttemptLimitCaseSchema,
]);

export const RepairLoopEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  cases: z.array(RepairLoopEvidenceCaseSchema).min(3).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const runIds = manifest.cases.map((item) => item.runId);
  if (
    new Set(caseIds).size !== caseIds.length || new Set(runIds).size !== runIds.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !manifest.cases.some((item) => item.outcome === 'repair_succeeded') ||
    !manifest.cases.some((item) => item.outcome === 'repeated_fingerprint_blocked') ||
    !manifest.cases.some((item) => item.outcome === 'attempt_limit_blocked')
  ) context.addIssue({ code: 'custom', message: 'repair loop evidence cases are incomplete' });
});

export type RepairLoopEvidenceManifestV1 = z.infer<typeof RepairLoopEvidenceManifestV1Schema>;
