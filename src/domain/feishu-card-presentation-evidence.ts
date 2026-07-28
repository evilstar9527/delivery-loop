import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;

const TimestampSchema = z.iso.datetime({ offset: true });
const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);

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
  presentationId: IdSchema,
  revision: z.number().int().positive(),
  presentationDigest: DigestSchema,
  renderedDigest: DigestSchema,
  outboxId: IdSchema,
  deliveredAt: TimestampSchema,
}).strict();

const FeishuScopeSchema = z.enum([
  'im:message',
  'im:message:readonly',
  'im:message.group_msg',
  'im:message:send_as_bot',
  'im:message:update',
]);

export const FeishuCardPresentationEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  recordedAt: TimestampSchema,
  taskId: IdSchema,
  runId: IdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  card: z.object({
    appId: z.string().regex(TARGET_ID_PATTERN),
    tenantKey: z.string().regex(TARGET_ID_PATTERN),
    chatId: z.string().regex(TARGET_ID_PATTERN),
    messageId: z.string().regex(MESSAGE_ID_PATTERN),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }).strict(),
  lifecycle: z.object({
    created: PresentationReferenceSchema,
    beforeExpiry: PresentationReferenceSchema,
    afterExpiry: PresentationReferenceSchema,
    expiringEffect: z.enum(['repo_write', 'test_deploy', 'merge', 'production_deploy']),
    expiresAt: TimestampSchema,
  }).strict(),
  safety: z.object({
    canaryDigest: DigestSchema,
    largeLog: z.object({
      digest: DigestSchema,
      sizeBytes: z.number().int().min(30 * 1_024).max(100 * 1_024 * 1_024),
      controlledUrl: SafeEvidenceUrlSchema,
    }).strict(),
  }).strict(),
  review: z.object({
    developerConsoleUrl: SafeEvidenceUrlSchema,
    messageUrl: SafeEvidenceUrlSchema,
    screenshotUrl: SafeEvidenceUrlSchema,
    reviewer: z.string().regex(ID_PATTERN),
    reviewedAt: TimestampSchema,
    botMembership: z.literal('member'),
    scopes: z.array(FeishuScopeSchema).min(4).max(5).refine(
      (scopes) => new Set(scopes).size === scopes.length,
      'Feishu scopes must be unique',
    ),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const refs = [
    manifest.lifecycle.created,
    manifest.lifecycle.beforeExpiry,
    manifest.lifecycle.afterExpiry,
  ];
  const presentationIds = refs.map((item) => item.presentationId);
  const outboxIds = refs.map((item) => item.outboxId);
  if (
    new Set(presentationIds).size !== refs.length ||
    new Set(outboxIds).size !== refs.length ||
    !(refs[0]!.revision < refs[1]!.revision && refs[1]!.revision < refs[2]!.revision)
  ) context.addIssue({ code: 'custom', message: 'presentation lifecycle is inconsistent' });

  const deliveredAt = refs.map((item) => Date.parse(item.deliveredAt));
  const expiresAt = Date.parse(manifest.lifecycle.expiresAt);
  const cardCreatedAt = Date.parse(manifest.card.createdAt);
  const cardUpdatedAt = Date.parse(manifest.card.updatedAt);
  const reviewedAt = Date.parse(manifest.review.reviewedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  if (
    !(deliveredAt[0]! <= deliveredAt[1]! && deliveredAt[1]! < expiresAt &&
      expiresAt < deliveredAt[2]!) ||
    cardCreatedAt > cardUpdatedAt || cardUpdatedAt > recordedAt ||
    reviewedAt < cardUpdatedAt || reviewedAt > recordedAt
  ) context.addIssue({ code: 'custom', message: 'evidence timestamps are inconsistent' });

  const scopes = new Set(manifest.review.scopes);
  if (
    !scopes.has('im:message:send_as_bot') || !scopes.has('im:message:update') ||
    !scopes.has('im:message.group_msg') ||
    (!scopes.has('im:message') && !scopes.has('im:message:readonly'))
  ) context.addIssue({ code: 'custom', message: 'required Feishu scopes are incomplete' });
});

export type FeishuCardPresentationEvidenceManifestV1 = z.infer<
  typeof FeishuCardPresentationEvidenceManifestV1Schema
>;
