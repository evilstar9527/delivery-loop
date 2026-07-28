import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
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

const PresentationReferenceSchema = z.object({
  presentationId: z.string().regex(ID_PATTERN),
  revision: z.number().int().min(2),
  presentationDigest: z.string().regex(DIGEST_PATTERN),
  renderedDigest: z.string().regex(DIGEST_PATTERN),
  outboxId: z.string().regex(ID_PATTERN),
  deliveredAt: TimestampSchema,
}).strict();

const ProgressSchema = z.object({
  passed: z.number().int().positive(),
  total: z.number().int().positive(),
  requiredPassed: z.number().int().positive(),
  requiredTotal: z.number().int().positive(),
  inProgress: z.literal(0),
  failed: z.literal(0),
  blocked: z.literal(0),
}).strict().superRefine((progress, context) => {
  if (
    progress.passed !== progress.total ||
    progress.requiredPassed !== progress.requiredTotal ||
    progress.requiredPassed > progress.passed
  ) context.addIssue({ code: 'custom', message: 'completion progress is incomplete' });
});

const CompletionCaseSchema = z.object({
  caseId: z.string().regex(ID_PATTERN),
  lane: z.enum(['test', 'production']),
  taskId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  runVersion: z.number().int().positive(),
  taskRevision: z.string().min(1).max(240).refine((value) => !/[\0\r\n]/.test(value)),
  baseSha: z.string().regex(SHA_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  progress: ProgressSchema,
  pullRequestUrl: SafeEvidenceUrlSchema,
  mergeUrl: SafeEvidenceUrlSchema,
  deploymentUrl: SafeEvidenceUrlSchema,
  card: z.object({
    appId: z.string().regex(TARGET_ID_PATTERN),
    tenantKey: z.string().regex(TARGET_ID_PATTERN),
    chatId: z.string().regex(TARGET_ID_PATTERN),
    messageId: z.string().regex(MESSAGE_ID_PATTERN),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }).strict(),
  completion: PresentationReferenceSchema,
  review: z.object({
    messageUrl: SafeEvidenceUrlSchema,
    screenshotUrl: SafeEvidenceUrlSchema,
    reviewer: z.string().regex(ID_PATTERN),
    reviewedAt: TimestampSchema,
  }).strict(),
}).strict().superRefine((item, context) => {
  const githubPrefix = `https://github.com/${item.repository}/`;
  if (
    !item.pullRequestUrl.startsWith(`${githubPrefix}pull/`) ||
    item.mergeUrl !== item.pullRequestUrl ||
    Date.parse(item.card.createdAt) > Date.parse(item.card.updatedAt) ||
    Date.parse(item.card.updatedAt) > Date.parse(item.review.reviewedAt) ||
    Date.parse(item.completion.deliveredAt) > Date.parse(item.card.updatedAt) + 5_000
  ) context.addIssue({ code: 'custom', message: 'completion case binding is inconsistent' });
});

export const FeishuCardCompletionEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: TimestampSchema,
  safety: z.object({ canaryDigest: z.string().regex(DIGEST_PATTERN) }).strict(),
  cases: z.array(CompletionCaseSchema).length(2),
}).strict().superRefine((manifest, context) => {
  const lanes = new Set(manifest.cases.map((item) => item.lane));
  const caseIds = manifest.cases.map((item) => item.caseId);
  const taskIds = manifest.cases.map((item) => item.taskId);
  const runIds = manifest.cases.map((item) => item.runId);
  const messageIds = manifest.cases.map((item) => item.card.messageId);
  if (
    !lanes.has('test') || !lanes.has('production') ||
    new Set(caseIds).size !== caseIds.length || new Set(taskIds).size !== taskIds.length ||
    new Set(runIds).size !== runIds.length || new Set(messageIds).size !== messageIds.length ||
    manifest.cases.some((item) =>
      item.repository !== manifest.repository ||
      Date.parse(item.review.reviewedAt) > Date.parse(manifest.recordedAt))
  ) context.addIssue({ code: 'custom', message: 'completion evidence lanes are incomplete' });
});

export type FeishuCardCompletionEvidenceManifestV1 = z.infer<
  typeof FeishuCardCompletionEvidenceManifestV1Schema
>;
