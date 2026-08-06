import { z } from 'zod';
import { GitHubPullRequestEvidenceManifestV1Schema } from
  './github-pull-request-evidence.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const ShaSchema = z.string().regex(SHA_PATTERN);
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

const RequiredItemSchema = z.object({
  itemId: IdSchema,
  kind: z.enum(['investigation', 'change', 'verification', 'delivery']),
  verificationId: IdSchema,
  headSha: ShaSchema,
  evidenceSetDigest: DigestSchema,
  evidenceIds: z.array(IdSchema).min(1).max(100),
}).strict().superRefine((item, context) => {
  if (new Set(item.evidenceIds).size !== item.evidenceIds.length) {
    context.addIssue({ code: 'custom', message: 'item evidence IDs must be unique' });
  }
});

const TestCommandSchema = z.object({
  position: z.number().int().nonnegative().max(99),
  phase: z.enum(['targeted', 'required']),
  commandRef: z.string().regex(KEY_PATTERN),
  evidenceId: IdSchema,
}).strict();

const DraftPrCaseSchema = z.object({
  scenario: z.enum(['requirement', 'bug']),
  inputClass: z.enum(['prd', 'user_feedback']),
  task: z.object({
    taskId: IdSchema,
    sourceSystem: z.enum(['manual', 'feishu', 'meego', 'github']),
    sourceRevision: z.string().regex(KEY_PATTERN),
    taskDigest: DigestSchema,
    acceptanceCriteriaCount: z.number().int().positive().max(10_000),
  }).strict(),
  runId: IdSchema,
  plan: z.object({
    planId: IdSchema,
    version: z.number().int().positive().max(10_000),
    digest: DigestSchema,
    baseSha: ShaSchema,
    requiredItems: z.array(RequiredItemSchema).min(1).max(100),
  }).strict(),
  execution: z.object({
    attemptId: IdSchema,
    mode: z.enum(['implement', 'review_fix']),
    actionRunId: z.string().regex(GITHUB_ID_PATTERN),
    actionCheckoutSha: ShaSchema,
    updateId: IdSchema,
    commitEvidenceId: IdSchema,
    parentSha: ShaSchema,
    headSha: ShaSchema,
    branch: z.string().regex(BRANCH_PATTERN),
  }).strict(),
  testSuite: z.object({
    suiteId: IdSchema,
    planItemId: IdSchema,
    deliveryPolicyDigest: DigestSchema,
    commands: z.array(TestCommandSchema).min(2).max(100),
  }).strict().superRefine((suite, context) => {
    let requiredSeen = false;
    for (const [index, command] of suite.commands.entries()) {
      if (command.position !== index) {
        context.addIssue({ code: 'custom', message: 'test command positions must be contiguous' });
      }
      if (command.phase === 'required') requiredSeen = true;
      if (requiredSeen && command.phase === 'targeted') {
        context.addIssue({ code: 'custom', message: 'targeted tests must run before required tests' });
      }
    }
    if (
      !suite.commands.some((command) => command.phase === 'targeted') ||
      !suite.commands.some((command) => command.phase === 'required') ||
      new Set(suite.commands.map((command) => command.commandRef)).size !== suite.commands.length ||
      new Set(suite.commands.map((command) => command.evidenceId)).size !== suite.commands.length
    ) context.addIssue({ code: 'custom', message: 'test command inventory is incomplete' });
  }),
  diff: z.object({
    changedFileCount: z.number().int().positive().max(300),
    changedFilesDigest: DigestSchema,
  }).strict(),
  pullRequest: GitHubPullRequestEvidenceManifestV1Schema,
}).strict().superRefine((item, context) => {
  const expectedInput = item.scenario === 'requirement' ? 'prd' : 'user_feedback';
  const changeItems = item.plan.requiredItems.filter((required) => required.kind === 'change');
  const testItem = item.plan.requiredItems.find(
    (required) => required.itemId === item.testSuite.planItemId,
  );
  let prUrl: URL;
  try { prUrl = new URL(item.pullRequest.publication.url); }
  catch {
    context.addIssue({ code: 'custom', message: 'pull request URL is invalid' });
    return;
  }
  if (
    item.inputClass !== expectedInput ||
    new Set(item.plan.requiredItems.map((required) => required.itemId)).size !==
      item.plan.requiredItems.length ||
    item.plan.requiredItems.some((required, index) =>
      index > 0 && required.itemId <= item.plan.requiredItems[index - 1]!.itemId) ||
    changeItems.length !== 1 || testItem === undefined || testItem.kind !== 'change' ||
    item.execution.mode !== 'implement' ||
    item.testSuite.planItemId !== changeItems[0]!.itemId ||
    !item.testSuite.commands.every((command) =>
      testItem.evidenceIds.includes(command.evidenceId)) ||
    !testItem.evidenceIds.includes(item.execution.commitEvidenceId) ||
    item.execution.actionCheckoutSha !== item.plan.baseSha ||
    item.execution.actionCheckoutSha !== item.execution.parentSha ||
    item.execution.parentSha === item.execution.headSha ||
    item.execution.branch === item.pullRequest.publication.baseBranch ||
    item.execution.branch !== item.pullRequest.publication.headBranch ||
    item.execution.headSha !== item.pullRequest.publication.headSha ||
    item.pullRequest.runId !== item.runId ||
    prUrl.hostname !== 'github.com' ||
    prUrl.pathname !== `/${item.pullRequest.repository}/pull/` +
      `${item.pullRequest.publication.number}`
  ) context.addIssue({ code: 'custom', message: 'Draft PR case binding is inconsistent' });
});

export const DraftPrCasesEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  cases: z.tuple([DraftPrCaseSchema, DraftPrCaseSchema]),
  safety: z.object({ canaryDigest: DigestSchema }).strict(),
  review: z.object({
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    requirementSemanticsEvidenceUrl: SafeUrlSchema,
    bugRootCauseEvidenceUrl: SafeUrlSchema,
    diffAndTestTraceReviewed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const [requirement, bug] = manifest.cases;
  if (
    requirement.scenario !== 'requirement' || bug.scenario !== 'bug' ||
    requirement.pullRequest.repository !== manifest.repository ||
    bug.pullRequest.repository !== manifest.repository ||
    requirement.pullRequest.publication.baseBranch !== manifest.baseBranch ||
    bug.pullRequest.publication.baseBranch !== manifest.baseBranch ||
    requirement.pullRequest.runId === bug.pullRequest.runId ||
    requirement.task.taskId === bug.task.taskId ||
    requirement.execution.actionRunId === bug.execution.actionRunId ||
    requirement.execution.headSha === bug.execution.headSha ||
    requirement.pullRequest.publication.number === bug.pullRequest.publication.number ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt) ||
    manifest.cases.some((item) =>
      Date.parse(item.pullRequest.recordedAt) > Date.parse(manifest.recordedAt))
  ) context.addIssue({ code: 'custom', message: 'Draft PR case inventory is inconsistent' });
});

export type DraftPrCasesEvidenceManifestV1 = z.infer<
  typeof DraftPrCasesEvidenceManifestV1Schema
>;
export type DraftPrCaseEvidenceV1 = z.infer<typeof DraftPrCaseSchema>;
