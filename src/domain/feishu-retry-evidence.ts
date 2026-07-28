import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;

const TimestampSchema = z.iso.datetime({ offset: true });
const ErrorCodeSchema = z.enum([
  'feishu_rate_limited',
  'feishu_api_timeout',
  'feishu_token_invalid',
  'feishu_api_unavailable',
  'feishu_token_unavailable',
  'feishu_unavailable',
]);

const RetryObservationSchema = z.object({
  attemptCount: z.number().int().positive(),
  errorCode: ErrorCodeSchema,
  observedAt: TimestampSchema,
}).strict();

const InitialDeliverySchema = z.object({
  outboxId: z.string().regex(ID_PATTERN),
  presentationId: z.string().regex(ID_PATTERN),
  initialRevision: z.number().int().positive(),
  finalRevision: z.number().int().positive(),
  initialMessageId: z.string().regex(MESSAGE_ID_PATTERN),
  finalMessageId: z.string().regex(MESSAGE_ID_PATTERN),
  retryHistory: z.array(RetryObservationSchema).min(3).max(100),
  deliveredAt: TimestampSchema,
}).strict().superRefine((delivery, context) => {
  if (delivery.finalRevision !== delivery.initialRevision) {
    context.addIssue({ code: 'custom', message: 'retry delivery must not regress revision' });
  }
  for (let index = 1; index < delivery.retryHistory.length; index += 1) {
    if (
      delivery.retryHistory[index]!.attemptCount !==
      delivery.retryHistory[index - 1]!.attemptCount + 1
    ) {
      context.addIssue({ code: 'custom', message: 'retry attempts must be contiguous' });
      break;
    }
  }
  const codes = new Set(delivery.retryHistory.map((retry) => retry.errorCode));
  for (const required of [
    'feishu_rate_limited', 'feishu_api_timeout', 'feishu_token_invalid',
  ] as const) {
    if (!codes.has(required)) {
      context.addIssue({ code: 'custom', message: `missing retry category: ${required}` });
    }
  }
});

const RefreshSchema = z.object({
  requestId: z.string().regex(ID_PATTERN),
  expectedPresentationId: z.string().regex(ID_PATTERN),
  expectedRevision: z.number().int().positive(),
  expectedDigest: z.string().regex(DIGEST_PATTERN),
  nextPresentationId: z.string().regex(ID_PATTERN),
  nextRevision: z.number().int().positive(),
  nextDigest: z.string().regex(DIGEST_PATTERN),
  nextOutboxId: z.string().regex(ID_PATTERN),
  finalMessageId: z.string().regex(MESSAGE_ID_PATTERN),
}).strict().superRefine((refresh, context) => {
  if (
    refresh.nextRevision <= refresh.expectedRevision ||
    refresh.nextPresentationId === refresh.expectedPresentationId ||
    refresh.nextOutboxId === refresh.requestId
  ) context.addIssue({ code: 'custom', message: 'refresh lineage must advance' });
});

export const FeishuRetryEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  runId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  first: InitialDeliverySchema,
  refresh: RefreshSchema,
  card: z.object({
    appId: z.string().regex(TARGET_ID_PATTERN),
    tenantKey: z.string().regex(TARGET_ID_PATTERN),
    chatId: z.string().regex(TARGET_ID_PATTERN),
    finalRenderedDigest: z.string().regex(DIGEST_PATTERN),
    finalCreatedAt: TimestampSchema,
    finalUpdatedAt: TimestampSchema,
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (
    manifest.refresh.expectedPresentationId !== manifest.first.presentationId ||
    manifest.refresh.expectedRevision !== manifest.first.finalRevision ||
    manifest.refresh.nextOutboxId === manifest.first.outboxId
  ) {
    context.addIssue({ code: 'custom', message: 'refresh does not bind initial delivery' });
  }
  if (Date.parse(manifest.card.finalCreatedAt) > Date.parse(manifest.card.finalUpdatedAt)) {
    context.addIssue({ code: 'custom', message: 'final message timestamps are invalid' });
  }
});

export type FeishuRetryEvidenceManifestV1 = z.infer<
  typeof FeishuRetryEvidenceManifestV1Schema
>;
