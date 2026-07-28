import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REVIEW_ID_PATTERN = /^[0-9]{1,32}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
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

const TimestampSchema = z.iso.datetime({ offset: true });
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const ReviewIdSchema = z.string().regex(REVIEW_ID_PATTERN);

const AppliedReviewSchema = z.object({
  deliveryId: z.string().regex(ID_PATTERN),
  payloadDigest: DigestSchema,
  reviewId: ReviewIdSchema,
  reviewUrl: URL_SCHEMA,
  reviewerLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
  reviewerType: z.literal('User'),
  bodyDigest: DigestSchema,
  reviewedHeadSha: z.string().regex(SHA_PATTERN),
  processingState: z.literal('applied'),
  receivedAt: TimestampSchema,
  processedAt: TimestampSchema,
  submittedAt: TimestampSchema,
  feedbackId: z.string().regex(ID_PATTERN),
  priorAttemptId: z.string().regex(ID_PATTERN),
  reviewAttemptId: z.string().regex(ID_PATTERN),
  branch: z.string().regex(BRANCH_PATTERN),
}).strict();

const StaleReviewSchema = z.object({
  deliveryId: z.string().regex(ID_PATTERN),
  payloadDigest: DigestSchema,
  reviewId: ReviewIdSchema,
  reviewedHeadSha: z.string().regex(SHA_PATTERN),
  processingState: z.literal('ignored'),
  ignoreReason: z.literal('stale_head'),
  receivedAt: TimestampSchema,
  processedAt: TimestampSchema,
}).strict();

const CheckSchema = z.object({
  name: z.string().min(1).max(200),
  conclusion: z.literal('success'),
}).strict();

const TestCommandSchema = z.object({
  position: z.number().int().nonnegative().max(99),
  phase: z.enum(['targeted', 'required']),
  commandRef: z.string().regex(KEY_PATTERN),
  evidenceId: z.string().regex(ID_PATTERN),
}).strict();

export const GitHubReviewFeedbackEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  runId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  case8ReportDigest: DigestSchema,
  plan: z.object({
    planId: z.string().regex(ID_PATTERN),
    version: z.number().int().positive().max(10_000),
    digest: DigestSchema,
    baseSha: z.string().regex(SHA_PATTERN),
    itemId: z.string().regex(ID_PATTERN),
  }).strict(),
  publication: z.object({
    publicationId: z.string().regex(ID_PATTERN),
    number: z.number().int().positive(),
    url: URL_SCHEMA,
    baseBranch: z.string().regex(BRANCH_PATTERN),
    headBranch: z.string().regex(BRANCH_PATTERN),
    reviewedHeadSha: z.string().regex(SHA_PATTERN),
  }).strict(),
  appliedReview: AppliedReviewSchema,
  staleReview: StaleReviewSchema,
  replacement: z.object({
    attemptId: z.string().regex(ID_PATTERN),
    priorAttemptId: z.string().regex(ID_PATTERN),
    actionRunId: ReviewIdSchema,
    actionWorkflowPath: z.literal('.github/workflows/delivery-agent.yml'),
    actionTitle: z.string().regex(/^delivery-loop\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
    actionWorkflowHeadSha: z.string().regex(SHA_PATTERN),
    actionHeadBranch: z.string().regex(BRANCH_PATTERN),
    actionStatus: z.literal('completed'),
    actionConclusion: z.literal('success'),
    checkoutSha: z.string().regex(SHA_PATTERN),
    claimedProgressVersion: z.number().int().positive().max(1_000_000),
    updateId: z.string().regex(ID_PATTERN),
    commitEvidenceId: z.string().regex(ID_PATTERN),
    resultHeadSha: z.string().regex(SHA_PATTERN),
    branch: z.string().regex(BRANCH_PATTERN),
    testSuite: z.object({
      suiteId: z.string().regex(ID_PATTERN),
      deliveryPolicyDigest: DigestSchema,
      commands: z.array(TestCommandSchema).min(2).max(100),
    }).strict(),
    itemVerification: z.object({
      verificationId: z.string().regex(ID_PATTERN),
      evidenceSetDigest: DigestSchema,
      evidenceIds: z.array(z.string().regex(ID_PATTERN)).min(3).max(100),
    }).strict(),
    checks: z.array(CheckSchema).min(1).max(100),
  }).strict(),
  safety: z.object({
    canaryDigest: DigestSchema,
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const { publication, appliedReview, staleReview, replacement, plan } = manifest;
  let requiredSeen = false;
  for (const [index, command] of replacement.testSuite.commands.entries()) {
    if (command.position !== index) {
      context.addIssue({ code: 'custom', message: 'review command positions must be contiguous' });
    }
    if (command.phase === 'required') requiredSeen = true;
    if (requiredSeen && command.phase === 'targeted') {
      context.addIssue({ code: 'custom', message: 'targeted review tests must precede required tests' });
    }
  }
  const commandEvidenceIds = replacement.testSuite.commands.map((command) => command.evidenceId);
  if (
    appliedReview.reviewedHeadSha !== publication.reviewedHeadSha ||
    appliedReview.branch !== publication.headBranch ||
    appliedReview.reviewAttemptId !== replacement.attemptId ||
    appliedReview.priorAttemptId !== replacement.priorAttemptId ||
    replacement.branch !== publication.headBranch ||
    replacement.priorAttemptId !== appliedReview.priorAttemptId ||
    replacement.attemptId === replacement.priorAttemptId ||
    replacement.resultHeadSha === publication.reviewedHeadSha ||
    replacement.checkoutSha !== publication.reviewedHeadSha ||
    replacement.actionWorkflowHeadSha !== plan.baseSha ||
    replacement.actionHeadBranch !== publication.baseBranch ||
    replacement.actionTitle !== `delivery-loop/${replacement.attemptId}` ||
    staleReview.reviewId === appliedReview.reviewId ||
    staleReview.reviewedHeadSha === publication.reviewedHeadSha ||
    Date.parse(appliedReview.processedAt) < Date.parse(appliedReview.receivedAt) ||
    Date.parse(staleReview.processedAt) < Date.parse(staleReview.receivedAt) ||
    Date.parse(appliedReview.processedAt) < Date.parse(appliedReview.submittedAt) ||
    !replacement.testSuite.commands.some((command) => command.phase === 'targeted') ||
    !replacement.testSuite.commands.some((command) => command.phase === 'required') ||
    new Set(replacement.testSuite.commands.map((command) => command.commandRef)).size !==
      replacement.testSuite.commands.length ||
    new Set(commandEvidenceIds).size !== commandEvidenceIds.length ||
    new Set(replacement.itemVerification.evidenceIds).size !==
      replacement.itemVerification.evidenceIds.length ||
    !replacement.itemVerification.evidenceIds.includes(replacement.commitEvidenceId) ||
    commandEvidenceIds.some((evidenceId) =>
      !replacement.itemVerification.evidenceIds.includes(evidenceId))
  ) context.addIssue({ code: 'custom', message: 'review evidence binding is inconsistent' });
  const uniqueChecks = new Set(replacement.checks.map((check) => check.name));
  if (uniqueChecks.size !== replacement.checks.length) {
    context.addIssue({ code: 'custom', message: 'review check names must be unique' });
  }
});

export type GitHubReviewFeedbackEvidenceManifestV1 = z.infer<
  typeof GitHubReviewFeedbackEvidenceManifestV1Schema
>;
