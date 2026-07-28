import { z } from 'zod';
import { GitHubMergeGateFactSchema } from './github-merge-gate.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TimestampSchema = z.iso.datetime({ offset: true });

const ApprovalSchema = z.object({
  approvalId: z.string().regex(ID_PATTERN),
  effect: z.literal('merge'),
  decision: z.literal('approve'),
  expiresAt: TimestampSchema,
  invalidated: z.literal(false),
}).strict();

const CaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  pullRequestNumber: z.number().int().positive().safe(),
  runVersion: z.number().int().nonnegative(),
  currentRunVersion: z.number().int().nonnegative(),
  runState: z.enum(['pull_request_open', 'awaiting_review', 'ready_to_merge']),
  outcome: z.enum(['ready_to_merge', 'rejected']),
  rejectionReason: z.enum([
    'required_checks_incomplete', 'required_checks_failed', 'review_insufficient',
    'base_not_latest', 'approval_required',
  ]).nullable(),
  fact: GitHubMergeGateFactSchema,
  observation: z.object({
    observationId: z.string().regex(ID_PATTERN),
    factDigest: z.string().regex(DIGEST_PATTERN),
    observedAt: TimestampSchema,
  }).strict(),
  evaluation: z.object({
    evaluationId: z.string().regex(ID_PATTERN),
    status: z.enum(['passed', 'rejected']),
    rejectionReason: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).nullable(),
    createdAt: TimestampSchema,
  }).strict(),
  decisionId: z.string().regex(ID_PATTERN).nullable(),
  approval: ApprovalSchema.nullable(),
  noMergeEffect: z.object({
    mergeOutboxes: z.literal(0),
    merges: z.literal(0),
  }).strict(),
}).strict();

export const MergeGateEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  cases: z.array(CaseSchema).min(6).max(20),
}).strict().superRefine((manifest, context) => {
  const requiredReasons = [
    'required_checks_incomplete', 'required_checks_failed', 'review_insufficient',
    'base_not_latest', 'approval_required',
  ] as const;
  const ready = manifest.cases.filter((item) => item.outcome === 'ready_to_merge');
  const reasons = manifest.cases.flatMap((item) =>
    item.rejectionReason === null ? [] : [item.rejectionReason]);
  const runIds = manifest.cases.map((item) => item.runId);
  const prNumbers = manifest.cases.map((item) => `${item.repository}#${item.pullRequestNumber}`);
  if (
    ready.length !== 1 ||
    requiredReasons.some((reason) => !reasons.includes(reason)) ||
    new Set(runIds).size !== runIds.length ||
    new Set(prNumbers).size !== prNumbers.length ||
    manifest.cases.some((item) => (
      item.repository !== manifest.repository || item.fact.repository !== item.repository ||
      item.fact.number !== item.pullRequestNumber ||
      item.currentRunVersion < item.runVersion
    ))
  ) context.addIssue({ code: 'custom', message: 'merge gate evidence cases are incomplete or inconsistent' });
  for (const item of manifest.cases) {
    if (
      item.outcome === 'ready_to_merge' && (
        item.rejectionReason !== null || item.evaluation.status !== 'passed' ||
        item.evaluation.rejectionReason !== null || item.decisionId === null ||
        item.runState !== 'ready_to_merge' || item.approval === null ||
        item.currentRunVersion <= item.runVersion
      )
    ) context.addIssue({ code: 'custom', message: 'ready merge gate case is inconsistent' });
    if (
      item.outcome === 'rejected' && (
        item.rejectionReason === null || item.evaluation.status !== 'rejected' ||
        item.evaluation.rejectionReason !== item.rejectionReason || item.decisionId !== null ||
        item.runState === 'ready_to_merge' || item.currentRunVersion !== item.runVersion
      )
    ) context.addIssue({ code: 'custom', message: 'rejected merge gate case is inconsistent' });
    if (
      item.approval !== null &&
      (item.approval.effect !== 'merge' || item.approval.invalidated !== false)
    ) context.addIssue({ code: 'custom', message: 'merge approval binding is inconsistent' });
  }
});

export type MergeGateEvidenceManifestV1 = z.infer<typeof MergeGateEvidenceManifestV1Schema>;
