import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const APP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TimestampSchema = z.iso.datetime({ offset: true });

const SafeUrlSchema = z.string().url().max(2_048).superRefine((raw, context) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid evidence URL' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'unsafe evidence URL' });
});

const FeishuConsoleUrlSchema = SafeUrlSchema.superRefine((raw, context) => {
  try {
    if (new URL(raw).hostname !== 'open.feishu.cn') {
      context.addIssue({ code: 'custom', message: 'not a Feishu developer console URL' });
    }
  } catch { /* SafeUrlSchema owns URL shape errors. */ }
});

const CommonObservationSchema = z.object({
  requestDigest: z.string().regex(DIGEST_PATTERN),
  responseDigest: z.string().regex(DIGEST_PATTERN),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().max(60_000),
}).strict();

const ChallengeObservationSchema = CommonObservationSchema.extend({
  case: z.literal('challenge'),
  statusCode: z.literal(200),
  outcome: z.literal('challenge_echoed'),
}).strict();

export const FeishuWebhookEventObservationV1Schema = CommonObservationSchema.extend({
  case: z.literal('event'),
  statusCode: z.literal(200),
  outcome: z.literal('event_accepted'),
  eventId: z.string().regex(ID_PATTERN),
  eventType: z.string().regex(EVENT_TYPE_PATTERN),
  deliveryId: z.string().regex(ID_PATTERN),
}).strict();

const InvalidSignatureObservationSchema = CommonObservationSchema.extend({
  case: z.literal('invalid_signature'),
  statusCode: z.literal(401),
  outcome: z.literal('signature_invalid'),
}).strict();

const ExpiredTimestampObservationSchema = CommonObservationSchema.extend({
  case: z.literal('expired_timestamp'),
  statusCode: z.literal(401),
  outcome: z.literal('timestamp_invalid'),
}).strict();

const WrongTenantObservationSchema = CommonObservationSchema.extend({
  case: z.literal('wrong_tenant'),
  statusCode: z.literal(403),
  outcome: z.literal('binding_rejected'),
  eventId: z.string().regex(ID_PATTERN),
  eventType: z.string().regex(EVENT_TYPE_PATTERN),
}).strict();

const RequestObservationSchema = z.discriminatedUnion('case', [
  ChallengeObservationSchema,
  FeishuWebhookEventObservationV1Schema,
  InvalidSignatureObservationSchema,
  ExpiredTimestampObservationSchema,
  WrongTenantObservationSchema,
]).superRefine((request, context) => {
  const startedAt = Date.parse(request.startedAt);
  const completedAt = Date.parse(request.completedAt);
  if (completedAt < startedAt || completedAt - startedAt !== request.latencyMs) {
    context.addIssue({ code: 'custom', message: 'request latency is inconsistent' });
  }
});

export const FeishuWebhookObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  service: z.literal('delivery-loop-control-plane'),
  callbackUrl: SafeUrlSchema,
  generatedAt: TimestampSchema,
  requests: z.array(RequestObservationSchema).length(5),
  reportDigest: z.string().regex(DIGEST_PATTERN),
}).strict().superRefine((report, context) => {
  const cases = report.requests.map((request) => request.case);
  const expected = [
    'challenge', 'event', 'expired_timestamp', 'invalid_signature', 'wrong_tenant',
  ];
  if (
    new Set(cases).size !== expected.length ||
    expected.some((caseName) => !cases.includes(caseName as typeof cases[number])) ||
    report.requests.some((request) => Date.parse(request.completedAt) > Date.parse(report.generatedAt))
  ) context.addIssue({ code: 'custom', message: 'observability request inventory is incomplete' });
});

const ConsoleReviewSchema = z.object({
  developerConsoleStatus: z.literal('SUCCESS'),
  developerConsoleLogUrl: FeishuConsoleUrlSchema,
  reviewedAt: TimestampSchema,
}).strict();

const RejectionSchema = z.discriminatedUnion('case', [
  z.object({
    case: z.literal('invalid_signature'),
    tenantKey: z.string().regex(TENANT_PATTERN),
    eventId: z.string().regex(ID_PATTERN),
    requestDigest: z.string().regex(DIGEST_PATTERN),
    responseDigest: z.string().regex(DIGEST_PATTERN),
    statusCode: z.literal(401),
    observedAt: TimestampSchema,
  }).strict(),
  z.object({
    case: z.literal('expired_timestamp'),
    tenantKey: z.string().regex(TENANT_PATTERN),
    eventId: z.string().regex(ID_PATTERN),
    requestDigest: z.string().regex(DIGEST_PATTERN),
    responseDigest: z.string().regex(DIGEST_PATTERN),
    statusCode: z.literal(401),
    observedAt: TimestampSchema,
  }).strict(),
  z.object({
    case: z.literal('wrong_tenant'),
    tenantKey: z.string().regex(TENANT_PATTERN),
    eventId: z.string().regex(ID_PATTERN),
    requestDigest: z.string().regex(DIGEST_PATTERN),
    responseDigest: z.string().regex(DIGEST_PATTERN),
    statusCode: z.literal(403),
    observedAt: TimestampSchema,
  }).strict(),
]);

export const FeishuWebhookEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  application: z.object({
    appId: z.string().regex(APP_PATTERN),
    tenantKey: z.string().regex(TENANT_PATTERN),
    callbackUrl: SafeUrlSchema,
    encryptionMode: z.literal('encrypted'),
    subscriptionStatus: z.literal('active'),
    reviewedAt: TimestampSchema,
    developerConsoleUrl: FeishuConsoleUrlSchema,
  }).strict(),
  observabilityReportUrl: SafeUrlSchema,
  observabilityReportDigest: z.string().regex(DIGEST_PATTERN),
  challenge: z.object({
    requestDigest: z.string().regex(DIGEST_PATTERN),
    responseDigest: z.string().regex(DIGEST_PATTERN),
    observedAt: TimestampSchema,
    latencyMs: z.number().int().nonnegative().max(60_000),
  }).strict().and(ConsoleReviewSchema),
  event: z.object({
    tenantKey: z.string().regex(TENANT_PATTERN),
    eventId: z.string().regex(ID_PATTERN),
    eventType: z.string().regex(EVENT_TYPE_PATTERN),
    deliveryId: z.string().regex(ID_PATTERN),
    requestDigest: z.string().regex(DIGEST_PATTERN),
    responseDigest: z.string().regex(DIGEST_PATTERN),
    eventDigest: z.string().regex(DIGEST_PATTERN),
    observedAt: TimestampSchema,
  }).strict().and(ConsoleReviewSchema),
  rejections: z.array(RejectionSchema).length(3),
}).strict().superRefine((manifest, context) => {
  const recordedAt = Date.parse(manifest.recordedAt);
  const cases = manifest.rejections.map((rejection) => rejection.case);
  const eventIds = [manifest.event.eventId, ...manifest.rejections.map((item) => item.eventId)];
  const digests = [
    manifest.challenge.requestDigest,
    manifest.event.requestDigest,
    ...manifest.rejections.map((item) => item.requestDigest),
  ];
  if (
    manifest.event.tenantKey !== manifest.application.tenantKey ||
    manifest.rejections.some((item) =>
      item.case !== 'wrong_tenant' && item.tenantKey !== manifest.application.tenantKey) ||
    manifest.rejections.find((item) => item.case === 'wrong_tenant')?.tenantKey ===
      manifest.application.tenantKey ||
    new Set(cases).size !== 3 ||
    !cases.includes('invalid_signature') || !cases.includes('expired_timestamp') ||
    !cases.includes('wrong_tenant') ||
    new Set(eventIds).size !== eventIds.length || new Set(digests).size !== digests.length ||
    [
      manifest.application.reviewedAt,
      manifest.challenge.observedAt,
      manifest.challenge.reviewedAt,
      manifest.event.observedAt,
      manifest.event.reviewedAt,
      ...manifest.rejections.map((item) => item.observedAt),
    ].some((value) => Date.parse(value) > recordedAt)
  ) context.addIssue({ code: 'custom', message: 'Feishu webhook evidence is inconsistent' });

  for (const raw of [
    manifest.application.developerConsoleUrl,
    manifest.challenge.developerConsoleLogUrl,
    manifest.event.developerConsoleLogUrl,
  ]) {
    try {
      if (!new URL(raw).pathname.startsWith(`/app/${manifest.application.appId}/`)) {
        context.addIssue({ code: 'custom', message: 'Feishu console URL is not app-bound' });
      }
    } catch { /* URL schemas own shape errors. */ }
  }
});

export type FeishuWebhookEvidenceManifestV1 = z.infer<
  typeof FeishuWebhookEvidenceManifestV1Schema
>;
export type FeishuWebhookObservabilityReportV1 = z.infer<
  typeof FeishuWebhookObservabilityReportV1Schema
>;
