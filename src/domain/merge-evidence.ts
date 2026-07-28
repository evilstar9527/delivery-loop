import { z } from 'zod';
import { GitHubPullRequestMergeFactSchema } from './github-merge-status.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const URL_SCHEMA = z.string().min(1).max(2_048).superRefine((raw, context) => {
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
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

const MergeObservationSchema = z.object({
  sourceKind: z.enum(['webhook', 'api']),
  id: z.string().regex(ID_PATTERN),
  digest: z.string().regex(DIGEST_PATTERN),
  processingState: z.enum(['applied', 'ignored']),
  ignoreReason: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).nullable(),
  externalUpdatedAt: TIMESTAMP_SCHEMA,
  observedAt: TIMESTAMP_SCHEMA,
  processedAt: TIMESTAMP_SCHEMA,
}).strict();

const PullRequestRequestSchema = z.object({
  repository: z.string().regex(REPOSITORY_PATTERN),
  number: z.number().int().positive(),
  url: URL_SCHEMA,
  headBranch: z.string().regex(BRANCH_PATTERN),
  headSha: z.string().regex(SHA_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
}).strict();

const CommonCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  runVersion: z.number().int().nonnegative(),
  currentRunVersion: z.number().int().nonnegative(),
  repository: z.string().regex(REPOSITORY_PATTERN),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  decisionId: z.string().regex(ID_PATTERN),
  publicationId: z.string().regex(ID_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  pullRequest: PullRequestRequestSchema,
}).strict();

const MergedCaseSchema = CommonCaseSchema.extend({
  outcome: z.enum(['merged_none', 'merged_test', 'merged_production']),
  runState: z.enum(['succeeded', 'deploying']),
  mergeId: z.string().regex(ID_PATTERN),
  mergeEvidenceId: z.string().regex(ID_PATTERN),
  deploymentDisposition: z.enum(['none', 'test', 'production']),
  merge: GitHubPullRequestMergeFactSchema,
  webhook: MergeObservationSchema.extend({ sourceKind: z.literal('webhook') }),
  apiObservation: MergeObservationSchema.extend({ sourceKind: z.literal('api') }),
  noDuplicate: z.object({
    merges: z.literal(1),
    observations: z.literal(2),
    mergeEvidence: z.literal(1),
    mergeOutboxes: z.literal(0),
  }).strict(),
}).strict().superRefine((item, context) => {
  const expectedDisposition = item.outcome === 'merged_none' ? 'none'
    : item.outcome === 'merged_test' ? 'test' : 'production';
  const expectedState = item.outcome === 'merged_production' ? 'deploying' : 'succeeded';
  if (
    item.repository !== item.pullRequest.repository ||
    item.merge.repository !== item.repository || item.merge.number !== item.pullRequest.number ||
    item.merge.url !== item.pullRequest.url || item.merge.headBranch !== item.pullRequest.headBranch ||
    item.merge.headSha !== item.pullRequest.headSha || item.merge.baseBranch !== item.pullRequest.baseBranch ||
    item.deploymentDisposition !== expectedDisposition || item.runState !== expectedState ||
    item.currentRunVersion !== item.runVersion + 2 ||
    item.webhook.processingState !== 'applied' || item.apiObservation.processingState !== 'applied' ||
    item.webhook.ignoreReason !== null || item.apiObservation.ignoreReason !== null ||
    Date.parse(item.webhook.processedAt) < Date.parse(item.webhook.observedAt) ||
    Date.parse(item.apiObservation.processedAt) < Date.parse(item.apiObservation.observedAt)
  ) context.addIssue({ code: 'custom', message: 'merged case binding is inconsistent' });
});

const NotMergedCaseSchema = CommonCaseSchema.extend({
  outcome: z.literal('not_merged'),
  runState: z.literal('ready_to_merge'),
  currentRunVersion: z.number().int().nonnegative(),
  mergeId: z.null(),
  mergeEvidenceId: z.null(),
  deploymentDisposition: z.literal('none'),
  merge: z.null(),
  webhook: z.null(),
  apiObservation: z.null(),
  noDuplicate: z.object({
    merges: z.literal(0),
    observations: z.literal(0),
    mergeEvidence: z.literal(0),
    mergeOutboxes: z.literal(0),
  }).strict(),
}).strict().superRefine((item, context) => {
  if (item.repository !== item.pullRequest.repository || item.currentRunVersion !== item.runVersion) {
    context.addIssue({ code: 'custom', message: 'not-merged case binding is inconsistent' });
  }
});

export const MergeEvidenceCaseSchema = z.union([MergedCaseSchema, NotMergedCaseSchema]);

export const MergeEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  cases: z.array(MergeEvidenceCaseSchema).min(4).max(20),
}).strict().superRefine((manifest, context) => {
  const caseIds = manifest.cases.map((item) => item.caseId);
  const runIds = manifest.cases.map((item) => item.runId);
  const prKeys = manifest.cases.map((item) => `${item.repository}:${item.pullRequest.number}`);
  const outcomes = new Set(manifest.cases.map((item) => item.outcome));
  if (
    new Set(caseIds).size !== caseIds.length || new Set(runIds).size !== runIds.length ||
    new Set(prKeys).size !== prKeys.length ||
    manifest.cases.some((item) => item.repository !== manifest.repository) ||
    !outcomes.has('merged_none') || !outcomes.has('merged_test') ||
    !outcomes.has('merged_production') || !outcomes.has('not_merged')
  ) context.addIssue({ code: 'custom', message: 'merge evidence cases are incomplete' });
});

export type MergeEvidenceManifestV1 = z.infer<typeof MergeEvidenceManifestV1Schema>;
export type MergeEvidenceCase = MergeEvidenceManifestV1['cases'][number];
