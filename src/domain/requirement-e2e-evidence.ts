import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,599}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });
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

const ComponentEvidenceSchema = z.object({
  evidenceId: IdSchema,
  manifestDigest: DigestSchema,
}).strict();

export const RequirementE2EEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  scenario: z.literal('E2E-1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  components: z.object({
    meegleWorkItem: ComponentEvidenceSchema,
    analysisAction: ComponentEvidenceSchema,
    feishuCardAction: ComponentEvidenceSchema,
  }).strict(),
  lineage: z.object({
    repository: z.string().regex(REPOSITORY_PATTERN),
    sourceEventId: IdSchema,
    sourceWorkItemId: z.string().regex(KEY_PATTERN),
    taskId: IdSchema,
    taskRevision: z.string().min(1).max(500).refine((value) => !/[\0\r\n]/.test(value)),
    taskDigest: DigestSchema,
    runId: IdSchema,
    runVersion: z.number().int().positive().max(1_000_000),
    workflowInstanceId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive().max(1_000_000),
    planDigest: DigestSchema,
    baseSha: z.string().regex(SHA_PATTERN),
    analysisAttemptId: IdSchema,
    analysisActionRunId: z.string().regex(GITHUB_ID_PATTERN),
  }).strict(),
  approval: z.object({
    eventId: IdSchema,
    actionReceiptId: IdSchema,
    approvalId: IdSchema,
    actorKey: IdSchema,
    decision: z.literal('approve'),
    effect: z.literal('repo_write'),
  }).strict(),
  cloudflare: z.object({
    accountIdDigest: DigestSchema,
    workflowName: z.literal('delivery-run'),
    instanceVersionId: z.string().uuid(),
    instanceStatus: z.literal('waiting'),
    instanceStartedAt: TimestampSchema,
    dashboardUrl: SafeEvidenceUrlSchema,
  }).strict(),
  safety: z.object({
    canaryDigest: DigestSchema,
  }).strict(),
  review: z.object({
    reviewer: IdSchema,
    reviewedAt: TimestampSchema,
    crossLineageEvidenceUrl: SafeEvidenceUrlSchema,
    requirementSemanticsReviewed: z.literal(true),
    planAndEffectReviewed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const componentIds = Object.values(manifest.components).map((item) => item.evidenceId);
  let dashboard: URL;
  try { dashboard = new URL(manifest.cloudflare.dashboardUrl); }
  catch { return; }
  if (
    new Set(componentIds).size !== componentIds.length ||
    manifest.lineage.workflowInstanceId !== manifest.lineage.runId ||
    Date.parse(manifest.cloudflare.instanceStartedAt) > Date.parse(manifest.recordedAt) ||
    Date.parse(manifest.review.reviewedAt) > Date.parse(manifest.recordedAt) ||
    dashboard.hostname !== 'dash.cloudflare.com'
  ) context.addIssue({ code: 'custom', message: 'E2E-1 evidence is inconsistent' });
});

export type RequirementE2EEvidenceManifestV1 = z.infer<
  typeof RequirementE2EEvidenceManifestV1Schema
>;
