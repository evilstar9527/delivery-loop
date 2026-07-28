import { z } from 'zod';
import { RUN_STATES } from './run.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

const ResourceIdSchema = z.string().regex(ID_PATTERN);
const ShaSchema = z.string().regex(SHA_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const GitHubIdSchema = z.string().regex(GITHUB_ID_PATTERN);
const HeadBranchSchema = z.string().max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..') && !value.endsWith('/') && !value.endsWith('.'));

export const RunnerRecoveryEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: ResourceIdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  runId: ResourceIdSchema,
  expectedRunState: z.enum(RUN_STATES),
  planId: ResourceIdSchema,
  planVersion: z.number().int().positive(),
  recoveredPlanItemId: ResourceIdSchema,
  case8ReportDigest: DigestSchema,
  safety: z.object({
    canaryDigest: DigestSchema,
  }).strict(),
  lost: z.object({
    attemptId: ResourceIdSchema,
    ordinal: z.number().int().positive(),
    activeLeaseGenerationBeforeKill: z.number().int().positive(),
    fencedLeaseGeneration: z.number().int().positive(),
    tokenId: ResourceIdSchema,
    tokenRevokedAt: z.iso.datetime({ offset: true }),
    dispatchOutboxId: ResourceIdSchema,
    workflowCancelOutboxId: ResourceIdSchema,
    actionRunId: GitHubIdSchema,
    workflowHeadSha: ShaSchema,
  }).strict(),
  checkpoint: z.object({
    checkpointId: ResourceIdSchema,
    sequence: z.number().int().positive(),
    digest: DigestSchema,
    headBranch: HeadBranchSchema,
    headSha: ShaSchema,
  }).strict(),
  replacement: z.object({
    attemptId: ResourceIdSchema,
    ordinal: z.number().int().positive(),
    leaseGeneration: z.number().int().positive(),
    dispatchOutboxId: ResourceIdSchema,
    actionRunId: GitHubIdSchema,
    workflowHeadSha: ShaSchema,
    resultHeadSha: ShaSchema,
    verificationId: ResourceIdSchema,
    evidenceId: ResourceIdSchema,
  }).strict(),
  previouslyPassed: z.object({
    planItemId: ResourceIdSchema,
    verificationId: ResourceIdSchema,
    evidenceIds: z.array(ResourceIdSchema).min(1).max(50),
  }).strict(),
  sideEffects: z.object({
    effectOutboxIds: z.array(ResourceIdSchema).min(3).max(50),
    pullRequestPublicationIds: z.array(ResourceIdSchema).max(10),
    deploymentIds: z.array(ResourceIdSchema).max(20),
    replacementCommitCount: z.literal(1),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (manifest.lost.attemptId === manifest.replacement.attemptId) {
    context.addIssue({ code: 'custom', message: 'recovery Attempt IDs must differ' });
  }
  if (manifest.lost.actionRunId === manifest.replacement.actionRunId) {
    context.addIssue({ code: 'custom', message: 'recovery Action run IDs must differ' });
  }
  if (manifest.replacement.ordinal <= manifest.lost.ordinal) {
    context.addIssue({ code: 'custom', message: 'replacement ordinal must advance' });
  }
  if (
    manifest.lost.fencedLeaseGeneration !==
      manifest.lost.activeLeaseGenerationBeforeKill + 1
  ) {
    context.addIssue({ code: 'custom', message: 'lost Attempt lease generation must be fenced once' });
  }
  if (manifest.recoveredPlanItemId === manifest.previouslyPassed.planItemId) {
    context.addIssue({ code: 'custom', message: 'passed and recovered Items must differ' });
  }
  if (manifest.checkpoint.headSha === manifest.replacement.resultHeadSha) {
    context.addIssue({ code: 'custom', message: 'replacement result must advance checkpoint head' });
  }
  if (new Set(manifest.previouslyPassed.evidenceIds).size !==
    manifest.previouslyPassed.evidenceIds.length) {
    context.addIssue({ code: 'custom', message: 'passed Evidence IDs must be unique' });
  }
  const requiredOutboxes = [
    manifest.lost.dispatchOutboxId,
    manifest.lost.workflowCancelOutboxId,
    manifest.replacement.dispatchOutboxId,
  ];
  if (
    new Set(manifest.sideEffects.effectOutboxIds).size !==
      manifest.sideEffects.effectOutboxIds.length ||
    !requiredOutboxes.every((id) => manifest.sideEffects.effectOutboxIds.includes(id)) ||
    new Set(manifest.sideEffects.pullRequestPublicationIds).size !==
      manifest.sideEffects.pullRequestPublicationIds.length ||
    new Set(manifest.sideEffects.deploymentIds).size !== manifest.sideEffects.deploymentIds.length
  ) {
    context.addIssue({ code: 'custom', message: 'recovery side-effect inventory is inconsistent' });
  }
});

export type RunnerRecoveryEvidenceManifestV1 = z.infer<
  typeof RunnerRecoveryEvidenceManifestV1Schema
>;
