import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LABEL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const TimestampSchema = z.iso.datetime({ offset: true });
const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);

const SafeUrlSchema = z.string().url().max(2_048).superRefine((raw, context) => {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== ''
    ) context.addIssue({ code: 'custom', message: 'unsafe evidence URL' });
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid evidence URL' });
  }
});

const ComponentIdentitySchema = z.object({
  manifestDigest: DigestSchema,
  evidenceId: IdSchema,
  runId: IdSchema,
}).strict();

const TimedRequestFields = {
  requestId: IdSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().max(60_000),
} as const;

const GitHubReplayRequestSchema = z.object({
  ...TimedRequestFields,
  deliveryId: IdSchema,
  eventType: z.literal('pull_request'),
  action: z.literal('opened'),
  payloadDigest: DigestSchema,
  statusCode: z.literal(202),
  disposition: z.enum(['applied', 'duplicate']),
}).strict();

const QueueReplayRequestSchema = z.object({
  ...TimedRequestFields,
  deadLetterId: IdSchema,
  outboxId: IdSchema,
  replayId: IdSchema,
  expectedOutboxAttemptCount: z.number().int().nonnegative(),
  reasonCode: z.enum(['operator_retry', 'upstream_recovered', 'configuration_fixed']),
  statusCode: z.literal(202),
  created: z.boolean(),
}).strict();

function requestTimelineIsValid(
  requests: Array<{ startedAt: string; completedAt: string; latencyMs: number }>,
  generatedAt: string,
): boolean {
  let priorStart = Number.NEGATIVE_INFINITY;
  for (const request of requests) {
    const startedAt = Date.parse(request.startedAt);
    const completedAt = Date.parse(request.completedAt);
    if (
      startedAt <= priorStart || completedAt < startedAt ||
      completedAt - startedAt !== request.latencyMs ||
      completedAt > Date.parse(generatedAt)
    ) return false;
    priorStart = startedAt;
  }
  return true;
}

/** External transport observations only; business state is always re-read from the control plane. */
export const ReplayFailureObservabilityReportV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  service: z.literal('delivery-loop-control-plane'),
  generatedAt: TimestampSchema,
  githubRequests: z.array(GitHubReplayRequestSchema).length(3),
  queueReplayRequests: z.array(QueueReplayRequestSchema).length(3),
  reportDigest: DigestSchema,
}).strict().superRefine((report, context) => {
  const github = report.githubRequests;
  const queue = report.queueReplayRequests;
  if (
    !requestTimelineIsValid(github, report.generatedAt) ||
    !requestTimelineIsValid(queue, report.generatedAt) ||
    new Set([...github, ...queue].map((request) => request.requestId)).size !== 6 ||
    github.some((request) =>
      request.deliveryId !== github[0]!.deliveryId ||
      request.payloadDigest !== github[0]!.payloadDigest) ||
    github.map((request) => request.disposition).join(',') !== 'applied,duplicate,duplicate' ||
    queue.some((request) =>
      request.deadLetterId !== queue[0]!.deadLetterId ||
      request.outboxId !== queue[0]!.outboxId ||
      request.replayId !== queue[0]!.replayId ||
      request.expectedOutboxAttemptCount !== queue[0]!.expectedOutboxAttemptCount ||
      request.reasonCode !== queue[0]!.reasonCode) ||
    queue.map((request) => request.created).join(',') !== 'true,false,false'
  ) context.addIssue({ code: 'custom', message: 'replay observability inventory is inconsistent' });
});

export const ReplayFailureE2EEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: IdSchema,
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: TimestampSchema,
  observedWindow: z.object({
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
  }).strict(),
  components: z.object({
    feishuIngress: ComponentIdentitySchema,
    feishuRetry: ComponentIdentitySchema,
    githubPullRequest: ComponentIdentitySchema.extend({
      publicationId: IdSchema,
      deliveryId: IdSchema,
    }).strict(),
    controlledReplay: ComponentIdentitySchema,
  }).strict(),
  observability: z.object({
    reportUrl: SafeUrlSchema,
    reportDigest: DigestSchema,
  }).strict(),
  callbackRecovery: z.object({
    runId: IdSchema,
    publicationId: IdSchema,
    apiObservationId: IdSchema,
    factDigest: DigestSchema,
    externalUpdatedAt: TimestampSchema,
    observedAt: TimestampSchema,
    processedAt: TimestampSchema,
    webhookObservationCount: z.literal(0),
    apiObservationCount: z.literal(1),
  }).strict(),
  queueReplay: z.object({
    runId: IdSchema,
    deadLetterId: IdSchema,
    outboxId: IdSchema,
    replayId: IdSchema,
    sourceQueue: z.literal('delivery-loop-workflow-outbox'),
    sourceAttempts: z.number().int().positive().max(100),
    outboxKind: z.string().regex(LABEL_PATTERN),
    destination: z.literal('github_actions'),
    expectedOutboxAttemptCount: z.number().int().nonnegative(),
    reasonCode: z.enum(['operator_retry', 'upstream_recovered', 'configuration_fixed']),
    capturedAt: TimestampSchema,
    replayRequestedAt: TimestampSchema,
    resolvedAt: TimestampSchema,
    resolutionCode: z.literal('outbox_settled'),
  }).strict(),
  safety: z.object({ canaryDigest: DigestSchema }).strict(),
}).strict().superRefine((manifest, context) => {
  const startedAt = Date.parse(manifest.observedWindow.startedAt);
  const endedAt = Date.parse(manifest.observedWindow.endedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  const evidenceIds = [
    manifest.evidenceId,
    ...Object.values(manifest.components).map((component) => component.evidenceId),
  ];
  const componentRuns = [
    manifest.components.feishuIngress.runId,
    manifest.components.githubPullRequest.runId,
    manifest.components.controlledReplay.runId,
  ];
  if (
    startedAt >= endedAt || endedAt - startedAt > MAX_WINDOW_MS || endedAt > recordedAt ||
    new Set(evidenceIds).size !== evidenceIds.length ||
    manifest.components.feishuIngress.runId !== manifest.components.feishuRetry.runId ||
    new Set(componentRuns).size !== componentRuns.length ||
    manifest.callbackRecovery.runId !== manifest.components.controlledReplay.runId ||
    manifest.queueReplay.runId !== manifest.components.controlledReplay.runId ||
    manifest.callbackRecovery.publicationId === manifest.components.githubPullRequest.publicationId ||
    !manifest.queueReplay.outboxKind.endsWith('_dispatch') ||
    manifest.queueReplay.replayId !==
      `outbox-dlq-replay-${manifest.queueReplay.deadLetterId}` ||
    Date.parse(manifest.callbackRecovery.externalUpdatedAt) >
      Date.parse(manifest.callbackRecovery.observedAt) ||
    Date.parse(manifest.callbackRecovery.observedAt) >
      Date.parse(manifest.callbackRecovery.processedAt) ||
    Date.parse(manifest.queueReplay.capturedAt) >
      Date.parse(manifest.queueReplay.replayRequestedAt) ||
    Date.parse(manifest.queueReplay.replayRequestedAt) >
      Date.parse(manifest.queueReplay.resolvedAt)
  ) context.addIssue({ code: 'custom', message: 'replay/failure E2E evidence is inconsistent' });
});

export type ReplayFailureE2EEvidenceManifestV1 = z.infer<
  typeof ReplayFailureE2EEvidenceManifestV1Schema
>;
export type ReplayFailureObservabilityReportV1 = z.infer<
  typeof ReplayFailureObservabilityReportV1Schema
>;
