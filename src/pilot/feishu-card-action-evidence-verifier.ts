import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  FeishuCardActionEvidenceManifestV1Schema,
  FeishuCardActionObservabilityReportV1Schema,
  type FeishuCardActionEvidenceManifestV1,
  type FeishuCardActionObservabilityReportV1,
} from '../domain/feishu-card-action-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });

const EffectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    approvalId: IdSchema,
    decision: z.enum(['approve', 'reject']),
    effect: z.enum(['repo_write', 'test_deploy', 'merge', 'production_deploy']),
    expiresAt: TimestampSchema,
    lineageId: IdSchema,
    sourceOccurredAt: TimestampSchema,
    decisionRecordedAt: TimestampSchema,
    externalEventDigest: DigestSchema,
    currentTrusted: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal('cancellation'),
    outboxId: IdSchema,
    runId: IdSchema,
    deliveryState: z.enum(['pending', 'delivering', 'settled']),
  }).strict(),
  z.object({
    kind: z.literal('recovery_attempt'),
    attemptId: IdSchema,
    runId: IdSchema,
    status: z.enum([
      'pending', 'starting', 'running', 'cancel_requested',
      'completed', 'failed', 'cancelled', 'lost',
    ]),
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    planItemId: IdSchema,
    recoveredFromAttemptId: IdSchema,
    checkpointId: IdSchema,
    baseSha: z.string().regex(SHA_PATTERN),
    headSha: z.string().regex(SHA_PATTERN),
  }).strict(),
  z.object({
    kind: z.literal('workflow_replay'),
    replayId: IdSchema,
    runId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    targetKind: z.enum(['system_step', 'plan_item']),
    targetStepName: z.string().min(1).max(200),
    targetStepType: z.enum(['do', 'sleep', 'waitForEvent']),
    targetStepCount: z.number().int().positive(),
    outboxId: IdSchema,
    deliveryState: z.enum(['pending', 'delivering', 'settled']),
  }).strict(),
  z.object({
    kind: z.literal('task_revision'),
    contextId: IdSchema,
    priorTaskId: IdSchema,
    priorTaskRevisionDigest: DigestSchema,
    newTaskId: IdSchema,
    newTaskRevisionDigest: DigestSchema,
    newTaskDigest: DigestSchema,
    newRunId: IdSchema,
    contextDigest: DigestSchema,
    contextMode: z.enum(['new_run', 'apply_current']),
    appliedRunId: IdSchema.nullable(),
  }).strict(),
]);

const ActionSchema = z.object({
  actionReceiptId: IdSchema,
  deliveryId: IdSchema,
  eventCreatedAt: TimestampSchema,
  operatorDigest: DigestSchema,
  principalDigest: DigestSchema,
  rolesDigest: DigestSchema,
  chatDigest: DigestSchema,
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  cardId: IdSchema,
  presentationId: IdSchema,
  taskId: IdSchema,
  runId: IdSchema,
  runVersion: z.number().int().nonnegative(),
  taskRevisionDigest: DigestSchema,
  planId: IdSchema,
  planVersion: z.number().int().positive(),
  planDigest: DigestSchema,
  baseSha: z.string().regex(SHA_PATTERN),
  actionId: IdSchema,
  command: z.enum(['approve', 'reject', 'cancel', 'retry', 'replay', 'add_context']),
  effect: z.enum([
    'repo_write', 'test_deploy', 'merge', 'production_deploy',
    'cancel_run', 'retry_run', 'replay_run', 'add_context',
  ]),
  contextMode: z.enum(['new_run', 'apply_current']).nullable(),
  commandDigest: DigestSchema,
  receivedAt: TimestampSchema,
  createdAt: TimestampSchema,
  outcome: z.object({
    outcomeId: IdSchema,
    disposition: z.enum(['applied', 'rejected']),
    resultKind: z.enum([
      'approval', 'cancellation', 'recovery_attempt', 'workflow_replay', 'task_revision',
    ]).nullable(),
    resultId: IdSchema.nullable(),
    reasonCode: z.enum([
      'state_conflict', 'effect_failed', 'context_required', 'secret_detected',
      'identity_unresolved', 'actor_not_human', 'actor_not_authorized',
      'self_approval_denied',
    ]).nullable(),
    completedAt: TimestampSchema,
  }).strict().nullable(),
  businessEffect: EffectSchema.nullable(),
}).strict();

const ProjectionSchema = z.object({
  schemaVersion: z.literal('1'),
  tenantKey: IdSchema,
  eventId: IdSchema,
  counts: z.object({
    deliveries: z.number().int().nonnegative(),
    ingressOutboxes: z.number().int().nonnegative(),
    actionReceipts: z.number().int().nonnegative(),
    actionOutcomes: z.number().int().nonnegative(),
    businessEffects: z.number().int().nonnegative(),
  }).strict(),
  delivery: z.object({
    deliveryId: IdSchema,
    appId: IdSchema,
    eventType: z.literal('card.action.trigger'),
    eventCreatedAt: TimestampSchema,
    verificationMode: z.enum(['encrypted', 'plaintext']),
    requestDigest: DigestSchema,
    eventDigest: DigestSchema,
    receivedAt: TimestampSchema,
  }).strict().nullable(),
  action: ActionSchema.nullable(),
}).strict();

type Projection = z.infer<typeof ProjectionSchema>;
type ManifestSuccess = FeishuCardActionEvidenceManifestV1['successes'][number];

export type FeishuCardActionEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'observability_unavailable'
  | 'observability_response_invalid'
  | 'observability_digest_mismatch'
  | 'observation_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'secret_leak_detected'
  | 'delivery_mismatch'
  | 'action_binding_mismatch'
  | 'business_effect_mismatch'
  | 'rejected_effect_observed';

export class FeishuCardActionEvidenceVerificationError extends Error {
  constructor(readonly code: FeishuCardActionEvidenceVerificationErrorCode) {
    super(`Feishu card action evidence verification failed: ${code}`);
    this.name = 'FeishuCardActionEvidenceVerificationError';
  }
}

export interface FeishuCardActionEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  observabilityReportUrl: string;
  observabilityToken: string;
  canarySecret: string;
  fetch?: typeof fetch;
}

export interface FeishuCardActionEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  tenantKey: string;
  successCommands: Array<'approve' | 'reject' | 'cancel' | 'retry' | 'replay' | 'add_context'>;
  rejectionCases: string[];
  mappedHumanPrincipals: number;
  ingressOutboxes: 0;
  rejectedBusinessEffects: 0;
  unauthorizedRepositoryWriteRejections: 2;
  serverDerivedRetry: 'verified';
  serverDerivedReplay: 'verified';
  humanReview: 'required_and_recorded';
  plaintextLeaks: 0;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function httpsUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.hash !== ''
  ) throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  return url.toString();
}

async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: 'observability' | 'control_plane',
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new FeishuCardActionEvidenceVerificationError(
      source === 'observability' ? 'observability_unavailable' : 'control_plane_unavailable',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FeishuCardActionEvidenceVerificationError(
      source === 'observability' ? 'observability_unavailable' : 'control_plane_unavailable',
    );
  }
  const text = await readBounded(response).catch(() => null);
  if (text === null) {
    throw new FeishuCardActionEvidenceVerificationError(
      source === 'observability'
        ? 'observability_response_invalid'
        : 'control_plane_response_invalid',
    );
  }
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new FeishuCardActionEvidenceVerificationError('secret_leak_detected');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FeishuCardActionEvidenceVerificationError(
      source === 'observability'
        ? 'observability_response_invalid'
        : 'control_plane_response_invalid',
    );
  }
}

function observationByScenario(
  report: FeishuCardActionObservabilityReportV1,
  scenario: string,
): FeishuCardActionObservabilityReportV1['requests'][number] {
  const found = report.requests.find((item) => item.scenario === scenario);
  if (found === undefined) {
    throw new FeishuCardActionEvidenceVerificationError('observation_mismatch');
  }
  return found;
}

function verifyObservations(
  manifest: FeishuCardActionEvidenceManifestV1,
  report: FeishuCardActionObservabilityReportV1,
): void {
  for (const expected of manifest.successes) {
    const actual = observationByScenario(report, expected.scenario);
    if (
      actual.outcome !== 'applied' || actual.eventId !== expected.eventId ||
      actual.deliveryId !== expected.deliveryId ||
      actual.requestDigest !== expected.requestDigest ||
      actual.responseDigest !== expected.responseDigest ||
      actual.statusCode !== expected.statusCode || actual.startedAt !== expected.startedAt ||
      actual.operatorDigest !== expected.operatorDigest ||
      actual.actionReceiptId !== expected.actionReceiptId ||
      actual.command !== expected.command || actual.effect !== expected.effect ||
      actual.resultKind !== expected.resultKind || actual.resultId !== expected.resultId ||
      actual.latencyMs > 3_000
    ) throw new FeishuCardActionEvidenceVerificationError('observation_mismatch');
  }
  for (const expected of manifest.rejections) {
    const actual = observationByScenario(report, expected.scenario);
    if (
      actual.outcome !== 'rejected' || actual.eventId !== expected.eventId ||
      actual.deliveryId !== expected.deliveryId ||
      actual.requestDigest !== expected.requestDigest ||
      actual.responseDigest !== expected.responseDigest ||
      actual.statusCode !== expected.statusCode || actual.startedAt !== expected.startedAt ||
      actual.operatorDigest !== expected.operatorDigest ||
      actual.reasonCode !== expected.reasonCode ||
      actual.attemptedCommand !== expected.attemptedCommand ||
      actual.attemptedEffect !== expected.attemptedEffect || actual.latencyMs > 3_000
    ) throw new FeishuCardActionEvidenceVerificationError('observation_mismatch');
  }
}

async function projection(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  tenantKey: string,
  eventId: string,
  scanner: SecretScanner,
): Promise<Projection> {
  const raw = await getJson(
    fetcher,
    `${origin}/v1/operations/feishu-card-action/evidence` +
      `?tenantKey=${encodeURIComponent(tenantKey)}&eventId=${encodeURIComponent(eventId)}`,
    token,
    'control_plane',
    scanner,
  );
  const parsed = ProjectionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.tenantKey !== tenantKey || parsed.data.eventId !== eventId) {
    throw new FeishuCardActionEvidenceVerificationError('control_plane_response_invalid');
  }
  return parsed.data;
}

function verifyDelivery(
  projectionValue: Projection,
  manifest: FeishuCardActionEvidenceManifestV1,
  expected: { deliveryId: string; requestDigest: string; eventDigest: string },
): void {
  const delivery = projectionValue.delivery;
  if (
    projectionValue.counts.deliveries !== 1 ||
    projectionValue.counts.ingressOutboxes !== 0 || delivery === null ||
    delivery.deliveryId !== expected.deliveryId ||
    delivery.appId !== manifest.application.appId ||
    delivery.verificationMode !== 'encrypted' ||
    delivery.requestDigest !== expected.requestDigest ||
    delivery.eventDigest !== expected.eventDigest
  ) throw new FeishuCardActionEvidenceVerificationError('delivery_mismatch');
}

function verifyBusinessEffect(success: ManifestSuccess, action: z.infer<typeof ActionSchema>): void {
  const effect = action.businessEffect;
  if (
    action.outcome?.disposition !== 'applied' ||
    action.outcome.resultKind !== success.resultKind ||
    action.outcome.resultId !== success.resultId || effect === null
  ) throw new FeishuCardActionEvidenceVerificationError('business_effect_mismatch');
  if (success.command === 'approve' || success.command === 'reject') {
    if (
      effect.kind !== 'approval' || effect.approvalId !== success.resultId ||
      effect.decision !== success.command || effect.effect !== success.effect ||
      effect.externalEventDigest !== success.eventDigest ||
      (success.command === 'approve' ? !effect.currentTrusted : effect.currentTrusted)
    ) throw new FeishuCardActionEvidenceVerificationError('business_effect_mismatch');
    return;
  }
  if (success.command === 'cancel') {
    if (
      effect.kind !== 'cancellation' || effect.outboxId !== success.resultId ||
      effect.runId !== success.runId
    ) throw new FeishuCardActionEvidenceVerificationError('business_effect_mismatch');
    return;
  }
  if (success.command === 'retry') {
    if (
      effect.kind !== 'recovery_attempt' || effect.attemptId !== success.resultId ||
      effect.runId !== success.runId || effect.planId !== success.planId ||
      effect.planVersion !== success.planVersion || effect.baseSha !== success.baseSha ||
      effect.planItemId === effect.recoveredFromAttemptId ||
      effect.checkpointId === effect.recoveredFromAttemptId
    ) throw new FeishuCardActionEvidenceVerificationError('business_effect_mismatch');
    return;
  }
  if (success.command === 'replay') {
    if (
      effect.kind !== 'workflow_replay' || effect.replayId !== success.resultId ||
      effect.runId !== success.runId || effect.planId !== success.planId ||
      effect.planVersion !== success.planVersion || effect.targetKind !== 'system_step' ||
      effect.targetStepName !== 'verify-analysis-result' || effect.targetStepType !== 'do' ||
      effect.targetStepCount !== 1
    ) throw new FeishuCardActionEvidenceVerificationError('business_effect_mismatch');
    return;
  }
  if (
    effect.kind !== 'task_revision' || effect.newTaskId !== success.resultId ||
    effect.priorTaskId !== success.taskId ||
    effect.priorTaskRevisionDigest !== success.taskRevisionDigest ||
    effect.contextMode !== success.contextMode ||
    (effect.contextMode === 'apply_current' && effect.appliedRunId !== success.runId) ||
    (effect.contextMode === 'new_run' && effect.appliedRunId !== null)
  ) throw new FeishuCardActionEvidenceVerificationError('business_effect_mismatch');
}

async function verifySuccess(
  success: ManifestSuccess,
  actor: FeishuCardActionEvidenceManifestV1['actors'][number],
  projectionValue: Projection,
  manifest: FeishuCardActionEvidenceManifestV1,
  chatDigest: string,
): Promise<void> {
  verifyDelivery(projectionValue, manifest, success);
  const action = projectionValue.action;
  if (
    projectionValue.counts.actionReceipts !== 1 ||
    projectionValue.counts.actionOutcomes !== 1 ||
    projectionValue.counts.businessEffects !== 1 || action === null ||
    action.actionReceiptId !== success.actionReceiptId ||
    action.deliveryId !== success.deliveryId || action.operatorDigest !== success.operatorDigest ||
    action.principalDigest !== actor.principalDigest || action.rolesDigest !== actor.rolesDigest ||
    action.chatDigest !== chatDigest || action.messageId !== success.messageId ||
    action.cardId !== success.cardId || action.presentationId !== success.presentationId ||
    action.taskId !== success.taskId || action.runId !== success.runId ||
    action.runVersion !== success.runVersion ||
    action.taskRevisionDigest !== success.taskRevisionDigest ||
    action.planId !== success.planId || action.planVersion !== success.planVersion ||
    action.planDigest !== success.planDigest || action.baseSha !== success.baseSha ||
    action.actionId !== success.actionId || action.command !== success.command ||
    action.effect !== success.effect || action.contextMode !== success.contextMode ||
    action.commandDigest !== success.commandDigest
  ) throw new FeishuCardActionEvidenceVerificationError('action_binding_mismatch');
  verifyBusinessEffect(success, action);
}

export async function verifyFeishuCardActionEvidence(
  input: FeishuCardActionEvidenceManifestV1,
  options: FeishuCardActionEvidenceVerifierOptions,
): Promise<FeishuCardActionEvidenceVerificationSummary> {
  const parsed = FeishuCardActionEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new FeishuCardActionEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.observabilityToken) ||
    !CANARY_PATTERN.test(options.canarySecret)
  ) throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  if (new SecretScanner().scanText(options.canarySecret, '$.canary').length === 0) {
    throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  }
  if (await canonicalSha256(options.canarySecret) !== manifest.safety.canaryDigest) {
    throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  }
  const origin = httpsOrigin(options.controlPlaneOrigin);
  const reportUrl = httpsUrl(options.observabilityReportUrl);
  if (
    reportUrl !== manifest.observabilityReportUrl ||
    new URL(manifest.application.callbackUrl).origin !== origin ||
    new URL(manifest.application.callbackUrl).pathname !== '/v1/webhooks/feishu'
  ) throw new FeishuCardActionEvidenceVerificationError('configuration_invalid');
  const fetcher = options.fetch ?? fetch;
  const scanner = new SecretScanner({ secrets: [options.canarySecret] });
  const reportRaw = await getJson(
    fetcher,
    reportUrl,
    options.observabilityToken,
    'observability',
    scanner,
  );
  const report = FeishuCardActionObservabilityReportV1Schema.safeParse(reportRaw);
  if (!report.success) {
    throw new FeishuCardActionEvidenceVerificationError('observability_response_invalid');
  }
  const { reportDigest, ...reportBody } = report.data;
  if (
    reportDigest !== manifest.observabilityReportDigest ||
    await canonicalSha256(reportBody) !== reportDigest ||
    report.data.evidenceId !== manifest.evidenceId ||
    report.data.callbackUrl !== manifest.application.callbackUrl ||
    Date.parse(report.data.generatedAt) > Date.parse(manifest.recordedAt)
  ) throw new FeishuCardActionEvidenceVerificationError('observability_digest_mismatch');
  verifyObservations(manifest, report.data);

  const actors = new Map(manifest.actors.map((actor) => [actor.actorKey, actor]));
  const chatDigest = await canonicalSha256(manifest.application.chatId);
  for (const success of manifest.successes) {
    const actor = actors.get(success.actorKey);
    if (actor === undefined || actor.mappingStatus !== 'mapped_human') {
      throw new FeishuCardActionEvidenceVerificationError('action_binding_mismatch');
    }
    const current = await projection(
      fetcher,
      origin,
      options.operationsToken,
      manifest.application.tenantKey,
      success.eventId,
      scanner,
    );
    await verifySuccess(success, actor, current, manifest, chatDigest);
  }

  for (const rejection of manifest.rejections) {
    const current = await projection(
      fetcher,
      origin,
      options.operationsToken,
      manifest.application.tenantKey,
      rejection.eventId,
      scanner,
    );
    verifyDelivery(current, manifest, rejection);
    if (
      current.counts.ingressOutboxes !== 0 || current.counts.businessEffects !== 0 ||
      (rejection.scenario === 'secret_add_context'
        ? current.counts.actionReceipts !== 1 || current.counts.actionOutcomes !== 1 ||
          current.action?.deliveryId !== rejection.deliveryId ||
          current.action?.operatorDigest !== rejection.operatorDigest ||
          current.action?.command !== 'add_context' || current.action?.effect !== 'add_context' ||
          current.action?.outcome?.disposition !== 'rejected' ||
          current.action?.outcome?.reasonCode !== 'secret_detected' ||
          current.action?.businessEffect !== null
        : current.counts.actionReceipts !== 0 || current.counts.actionOutcomes !== 0 ||
          current.action !== null)
    ) throw new FeishuCardActionEvidenceVerificationError('rejected_effect_observed');
  }

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    tenantKey: manifest.application.tenantKey,
    successCommands: ['approve', 'reject', 'cancel', 'retry', 'replay', 'add_context'],
    rejectionCases: [...manifest.rejections.map((item) => item.scenario)].sort(),
    mappedHumanPrincipals: new Set(
      manifest.actors
        .filter((actor) => actor.mappingStatus === 'mapped_human')
        .map((actor) => actor.principalDigest),
    ).size,
    ingressOutboxes: 0,
    rejectedBusinessEffects: 0,
    unauthorizedRepositoryWriteRejections: 2,
    serverDerivedRetry: 'verified',
    serverDerivedReplay: 'verified',
    humanReview: 'required_and_recorded',
    plaintextLeaks: 0,
  };
}
