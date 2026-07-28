import { z } from 'zod';
import { FeishuWebhookEventObservationV1Schema } from './feishu-webhook-evidence.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TimestampSchema = z.iso.datetime({ offset: true });

const SafeUrlSchema = z.string().url().max(2_048).superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); } catch {
    context.addIssue({ code: 'custom', message: 'invalid evidence URL' });
    return;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: 'custom', message: 'unsafe evidence URL' });
});

const QueueLineageFields = {
  relayAttemptCount: z.literal(1),
  queueMessageIdDigest: z.string().regex(DIGEST_PATTERN),
  queueObservationCount: z.number().int().positive().max(100),
  maximumQueueDeliveryAttempt: z.number().int().positive().max(100),
  enqueuedAt: TimestampSchema,
  queueObservedAt: TimestampSchema,
  settledAt: TimestampSchema,
} as const;

const EventIdentityFields = {
  eventId: z.string().regex(ID_PATTERN),
  deliveryId: z.string().regex(ID_PATTERN),
  ingressOutboxId: z.string().regex(ID_PATTERN),
  eventDigest: z.string().regex(DIGEST_PATTERN),
} as const;

const ReplayedEventSchema = z.object({
  ...EventIdentityFields,
  requestDigests: z.array(z.string().regex(DIGEST_PATTERN)).length(3),
  ...QueueLineageFields,
}).strict();

const PeerEventSchema = z.object({
  ...EventIdentityFields,
  requestDigests: z.array(z.string().regex(DIGEST_PATTERN)).length(1),
  ...QueueLineageFields,
}).strict();

function validLineageTime(
  event: z.infer<typeof ReplayedEventSchema> | z.infer<typeof PeerEventSchema>,
): boolean {
  return Date.parse(event.enqueuedAt) <= Date.parse(event.queueObservedAt) &&
    Date.parse(event.queueObservedAt) <= Date.parse(event.settledAt) &&
    event.queueObservationCount === event.maximumQueueDeliveryAttempt;
}

export const FeishuIngressObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  service: z.literal('delivery-loop-control-plane'),
  generatedAt: TimestampSchema,
  requests: z.array(FeishuWebhookEventObservationV1Schema).length(4),
  reportDigest: z.string().regex(DIGEST_PATTERN),
}).strict().superRefine((report, context) => {
  const eventCounts = new Map<string, number>();
  const eventDeliveries = new Map<string, Set<string>>();
  for (const request of report.requests) {
    eventCounts.set(request.eventId, (eventCounts.get(request.eventId) ?? 0) + 1);
    const deliveries = eventDeliveries.get(request.eventId) ?? new Set<string>();
    deliveries.add(request.deliveryId);
    eventDeliveries.set(request.eventId, deliveries);
  }
  const counts = [...eventCounts.values()].sort((left, right) => left - right);
  if (
    counts.length !== 2 || counts[0] !== 1 || counts[1] !== 3 ||
    [...eventDeliveries.values()].some((deliveries) => deliveries.size !== 1) ||
    new Set(report.requests.map((request) => request.requestDigest)).size !== 4 ||
    report.requests.some((request) =>
      request.latencyMs > 3_000 ||
      Date.parse(request.completedAt) > Date.parse(report.generatedAt))
  ) context.addIssue({ code: 'custom', message: 'ingress request inventory is inconsistent' });
});

export const FeishuIngressEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  tenantKey: z.string().regex(TENANT_PATTERN),
  eventType: z.string().regex(EVENT_TYPE_PATTERN),
  observabilityReportUrl: SafeUrlSchema,
  observabilityReportDigest: z.string().regex(DIGEST_PATTERN),
  events: z.object({
    replayed: ReplayedEventSchema,
    sameRevisionPeer: PeerEventSchema,
  }).strict(),
  task: z.object({
    sourceSystem: z.enum(['feishu', 'meego']),
    sourceTaskKey: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
    taskRevision: z.string().min(1).max(255).refine((value) => !/[\0\r\n]/.test(value)),
    taskDigest: z.string().regex(DIGEST_PATTERN),
    taskId: z.string().regex(ID_PATTERN),
    runId: z.string().regex(ID_PATTERN),
    workflowInstanceId: z.string().regex(ID_PATTERN),
    workflowCreateOutboxId: z.string().regex(ID_PATTERN),
  }).strict(),
  cloudflare: z.object({
    accountIdDigest: z.string().regex(DIGEST_PATTERN),
    queueName: z.literal('delivery-loop-feishu-ingress'),
    queueDashboardUrl: SafeUrlSchema,
    queueReviewedAt: TimestampSchema,
    workflowName: z.literal('delivery-run'),
    workflowInstanceVersionId: z.string().regex(UUID_PATTERN),
    workflowInstanceStatus: z.enum(['queued', 'running', 'waiting']),
    workflowInstanceStartedAt: TimestampSchema,
    workflowDashboardUrl: SafeUrlSchema,
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const replayed = manifest.events.replayed;
  const peer = manifest.events.sameRevisionPeer;
  const requestDigests = [...replayed.requestDigests, ...peer.requestDigests];
  const recordedAt = Date.parse(manifest.recordedAt);
  const latestSettledAt = Math.max(Date.parse(replayed.settledAt), Date.parse(peer.settledAt));
  if (
    !validLineageTime(replayed) || !validLineageTime(peer) ||
    replayed.eventId === peer.eventId || replayed.deliveryId === peer.deliveryId ||
    replayed.ingressOutboxId === peer.ingressOutboxId ||
    replayed.queueMessageIdDigest === peer.queueMessageIdDigest ||
    new Set(requestDigests).size !== requestDigests.length ||
    manifest.task.workflowInstanceId !== manifest.task.runId ||
    Date.parse(manifest.cloudflare.queueReviewedAt) > recordedAt ||
    Date.parse(manifest.cloudflare.workflowInstanceStartedAt) < latestSettledAt ||
    Date.parse(manifest.cloudflare.workflowInstanceStartedAt) > recordedAt
  ) context.addIssue({ code: 'custom', message: 'Feishu ingress evidence is inconsistent' });
  for (const raw of [
    manifest.cloudflare.queueDashboardUrl,
    manifest.cloudflare.workflowDashboardUrl,
  ]) {
    try {
      if (new URL(raw).hostname !== 'dash.cloudflare.com') {
        context.addIssue({ code: 'custom', message: 'Cloudflare audit URL is invalid' });
      }
    } catch { /* SafeUrlSchema owns URL shape errors. */ }
  }
});

export type FeishuIngressEvidenceManifestV1 = z.infer<
  typeof FeishuIngressEvidenceManifestV1Schema
>;
export type FeishuIngressObservabilityReportV1 = z.infer<
  typeof FeishuIngressObservabilityReportV1Schema
>;
