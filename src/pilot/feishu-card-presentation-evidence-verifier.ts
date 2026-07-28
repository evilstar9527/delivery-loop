import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  FeishuCardPresentationEvidenceManifestV1Schema,
  type FeishuCardPresentationEvidenceManifestV1,
} from '../domain/feishu-card-presentation-evidence.js';
import {
  FeishuDeliveryCardPresentationV2Schema,
  renderFeishuDeliveryCard,
} from '../domain/feishu-delivery-card.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CARD_BYTES = 30 * 1024;
const HIDDEN_SUMMARY = '摘要已隐藏（检测到敏感内容）';

const PresentationV2Shape = FeishuDeliveryCardPresentationV2Schema.shape;
const PresentationSnapshotSchema = z.object({
  runVersion: PresentationV2Shape.runVersion,
  runState: PresentationV2Shape.runState,
  taskRevision: PresentationV2Shape.taskRevision,
  targetRepository: PresentationV2Shape.targetRepository,
  baseSha: PresentationV2Shape.baseSha,
  planVersion: PresentationV2Shape.planVersion,
  planDigest: PresentationV2Shape.planDigest,
  progress: PresentationV2Shape.progress,
  currentGoal: PresentationV2Shape.currentGoal,
  actionUrl: PresentationV2Shape.actionUrl,
  checkUrl: PresentationV2Shape.checkUrl,
  checkpointSummary: PresentationV2Shape.checkpointSummary,
  evidenceSummary: PresentationV2Shape.evidenceSummary,
  evidenceUrl: PresentationV2Shape.evidenceUrl,
  blocker: PresentationV2Shape.blocker,
  approvedEffects: PresentationV2Shape.approvedEffects,
  pr: PresentationV2Shape.pr,
  merge: PresentationV2Shape.merge,
  testDeploy: PresentationV2Shape.testDeploy,
  productionDeploy: PresentationV2Shape.productionDeploy,
}).strict().superRefine((snapshot, context) => {
  if ((snapshot.planVersion === null) !== (snapshot.planDigest === null)) {
    context.addIssue({ code: 'custom', message: 'Plan snapshot is inconsistent' });
  }
});

const LineageSchema = z.object({
  trigger: z.enum(['initial', 'source_change', 'approval_expiry', 'manual_refresh']),
  priorPresentationId: z.string().regex(ID_PATTERN).nullable(),
  priorSourceObservedAt: z.iso.datetime({ offset: true }).nullable(),
  sourceObservedAt: z.iso.datetime({ offset: true }),
  triggerRefreshAt: z.iso.datetime({ offset: true }).nullable(),
  nextRefreshAt: z.iso.datetime({ offset: true }).nullable(),
  projectedAt: z.iso.datetime({ offset: true }),
}).strict();

const PresentationEvidenceSchema = z.object({
  presentationId: z.string().regex(ID_PATTERN),
  revision: z.number().int().positive(),
  digest: z.string().regex(DIGEST_PATTERN),
  renderedDigest: z.string().regex(DIGEST_PATTERN),
  createdAt: z.iso.datetime({ offset: true }),
  lineage: LineageSchema,
  snapshot: PresentationSnapshotSchema,
  outbox: z.object({
    outboxId: z.string().regex(ID_PATTERN),
    deliveryState: z.enum(['pending', 'delivering', 'settled']),
    attemptCount: z.number().int().nonnegative(),
    lastErrorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
    payloadKind: z.literal('presentation_ref'),
  }).strict(),
  delivery: z.object({
    disposition: z.enum(['created', 'updated']),
    messageId: z.string().regex(MESSAGE_ID_PATTERN),
    deliveredAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
}).strict();

const OperationsEvidenceSchema = z.object({
  schemaVersion: z.literal('1'),
  evidence: z.object({
    taskId: z.string().regex(ID_PATTERN),
    runId: z.string().regex(ID_PATTERN),
    repository: z.string().regex(REPOSITORY_PATTERN),
    tenantKey: z.string().regex(TARGET_ID_PATTERN),
    chatId: z.string().regex(TARGET_ID_PATTERN),
    cardId: z.string().regex(ID_PATTERN),
    presentations: z.array(PresentationEvidenceSchema).min(3).max(100),
  }).strict(),
}).strict();

export type FeishuCardOperationsEvidence = z.infer<typeof OperationsEvidenceSchema>['evidence'];
export type OperationsPresentation = z.infer<typeof PresentationEvidenceSchema>;

export type FeishuCardPresentationEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'secret_leak_detected'
  | 'presentation_snapshot_mismatch'
  | 'delivery_lineage_mismatch'
  | 'approval_expiry_mismatch'
  | 'feishu_api_unavailable'
  | 'feishu_response_invalid'
  | 'message_binding_mismatch'
  | 'card_digest_mismatch'
  | 'card_content_mismatch';

export class FeishuCardPresentationEvidenceVerificationError extends Error {
  constructor(readonly code: FeishuCardPresentationEvidenceVerificationErrorCode) {
    super(`Feishu card presentation evidence verification failed: ${code}`);
    this.name = 'FeishuCardPresentationEvidenceVerificationError';
  }
}

export interface FeishuCardPresentationEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  feishuAccessToken: string;
  canarySecret: string;
  feishuApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface FeishuCardPresentationEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  presentationCount: number;
  messageId: string;
  createAndPatch: 'verified';
  approvalExpiry: 'verified';
  liveCard: 'verified';
  plaintextLeaks: 0;
}

export interface FeishuCardPresentationReference {
  presentationId: string;
  revision: number;
  presentationDigest: string;
  renderedDigest: string;
  outboxId: string;
  deliveredAt: string;
}

export interface FeishuLivePresentationBinding {
  taskId: string;
  runId: string;
  repository: string;
  card: FeishuCardPresentationEvidenceManifestV1['card'];
  presentation: FeishuCardPresentationReference;
  canaryDigest: string;
}

export interface FeishuLivePresentationVerification {
  evidence: FeishuCardOperationsEvidence;
  presentation: OperationsPresentation;
  liveCard: unknown;
  messageCreatedAt: string;
  messageUpdatedAt: string;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeishuCardPresentationEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new FeishuCardPresentationEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Reuses the bounded streaming discipline shared by the Watt-derived E2E
// helpers. Raw upstream text is never included in an error or summary.
async function readBoundedResponse(response: Response): Promise<string | null> {
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
  source: 'control_plane' | 'feishu',
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
    throw new FeishuCardPresentationEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'feishu_api_unavailable',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FeishuCardPresentationEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'feishu_api_unavailable',
    );
  }
  const invalidCode = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'feishu_response_invalid';
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FeishuCardPresentationEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new FeishuCardPresentationEvidenceVerificationError(invalidCode);
  }
  if (text === null) throw new FeishuCardPresentationEvidenceVerificationError(invalidCode);
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new FeishuCardPresentationEvidenceVerificationError('secret_leak_detected');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FeishuCardPresentationEvidenceVerificationError(invalidCode);
  }
}

function messageTime(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{9,15}$/.test(raw)) return null;
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function withinMilliseconds(left: string, right: string, limit: number): boolean {
  return Math.abs(Date.parse(left) - Date.parse(right)) <= limit;
}

function exactReference(
  actual: OperationsPresentation,
  expected: FeishuCardPresentationReference,
): boolean {
  return actual.presentationId === expected.presentationId &&
    actual.revision === expected.revision && actual.digest === expected.presentationDigest &&
    actual.renderedDigest === expected.renderedDigest &&
    actual.outbox.outboxId === expected.outboxId &&
    actual.delivery?.deliveredAt === expected.deliveredAt &&
    actual.outbox.deliveryState === 'settled' && actual.outbox.attemptCount >= 1 &&
    actual.outbox.lastErrorCode === null;
}

function githubUrl(raw: string | null, repository: string, kind: 'actions' | 'pull'): boolean {
  if (raw === null) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const suffix = kind === 'actions' ? '/actions/runs/' : '/pull/';
  return url.origin === 'https://github.com' &&
    url.pathname.startsWith(`/${repository}${suffix}`);
}

function validatePresentationSnapshot(
  before: OperationsPresentation,
  after: OperationsPresentation,
  manifest: FeishuCardPresentationEvidenceManifestV1,
): void {
  const snapshot = before.snapshot;
  if (
    snapshot.targetRepository !== manifest.repository || snapshot.taskRevision.length < 1 ||
    snapshot.planVersion === null || snapshot.planDigest === null ||
    snapshot.progress.total < 1 || snapshot.progress.requiredTotal < 1 ||
    !/[`*_{}[\]()<>#~]/.test(snapshot.currentGoal) ||
    !githubUrl(snapshot.actionUrl, manifest.repository, 'actions') ||
    !githubUrl(snapshot.pr.url, manifest.repository, 'pull') ||
    snapshot.blocker === null || snapshot.checkpointSummary !== HIDDEN_SUMMARY ||
    snapshot.evidenceSummary === null ||
    snapshot.evidenceUrl !== manifest.safety.largeLog.controlledUrl ||
    snapshot.approvedEffects.length !== 1 ||
    snapshot.approvedEffects[0]!.effect !== manifest.lifecycle.expiringEffect ||
    snapshot.approvedEffects[0]!.expiresAt !== manifest.lifecycle.expiresAt
  ) throw new FeishuCardPresentationEvidenceVerificationError(
    'presentation_snapshot_mismatch',
  );
  const expectedAfter = { ...snapshot, approvedEffects: [] };
  if (JSON.stringify(after.snapshot) !== JSON.stringify(expectedAfter)) {
    throw new FeishuCardPresentationEvidenceVerificationError('approval_expiry_mismatch');
  }
}

function validateLifecycle(
  rows: OperationsPresentation[],
  manifest: FeishuCardPresentationEvidenceManifestV1,
): { created: OperationsPresentation; before: OperationsPresentation; after: OperationsPresentation } {
  if (
    new Set(rows.map((row) => row.presentationId)).size !== rows.length ||
    new Set(rows.map((row) => row.revision)).size !== rows.length
  ) {
    throw new FeishuCardPresentationEvidenceVerificationError('delivery_lineage_mismatch');
  }
  const sorted = [...rows].sort((left, right) => left.revision - right.revision);
  const created = sorted.find(
    (row) => row.presentationId === manifest.lifecycle.created.presentationId,
  );
  const before = sorted.find(
    (row) => row.presentationId === manifest.lifecycle.beforeExpiry.presentationId,
  );
  const after = sorted.find(
    (row) => row.presentationId === manifest.lifecycle.afterExpiry.presentationId,
  );
  const firstDelivered = sorted.find((row) => row.delivery !== null);
  if (
    created === undefined || before === undefined || after === undefined ||
    !exactReference(created, manifest.lifecycle.created) ||
    !exactReference(before, manifest.lifecycle.beforeExpiry) ||
    !exactReference(after, manifest.lifecycle.afterExpiry) ||
    created.delivery?.disposition !== 'created' ||
    before.delivery?.disposition !== 'updated' || after.delivery?.disposition !== 'updated' ||
    firstDelivered?.presentationId !== created.presentationId ||
    sorted.at(-1)?.presentationId !== after.presentationId ||
    before.revision + 1 !== after.revision ||
    created.delivery.messageId !== manifest.card.messageId ||
    before.delivery.messageId !== manifest.card.messageId ||
    after.delivery.messageId !== manifest.card.messageId ||
    created.lineage.trigger !== 'initial' || created.lineage.priorPresentationId !== null ||
    before.lineage.trigger !== 'source_change' ||
    before.lineage.nextRefreshAt !== manifest.lifecycle.expiresAt ||
    after.lineage.priorPresentationId !== before.presentationId
  ) throw new FeishuCardPresentationEvidenceVerificationError('delivery_lineage_mismatch');

  const lineage = after.lineage;
  if (
    lineage.trigger !== 'approval_expiry' ||
    lineage.priorSourceObservedAt === null ||
    lineage.priorSourceObservedAt !== lineage.sourceObservedAt ||
    lineage.triggerRefreshAt !== manifest.lifecycle.expiresAt ||
    Date.parse(lineage.projectedAt) < Date.parse(manifest.lifecycle.expiresAt)
  ) throw new FeishuCardPresentationEvidenceVerificationError('approval_expiry_mismatch');
  validatePresentationSnapshot(before, after, manifest);
  return { created, before, after };
}

function validateLiveCard(
  raw: unknown,
  expected: OperationsPresentation,
  outer: z.infer<typeof OperationsEvidenceSchema>['evidence'],
): void {
  const card = record(raw);
  const config = card === null ? null : record(card.config);
  const header = card === null ? null : record(card.header);
  const title = header === null ? null : record(header.title);
  const elements = card === null || !Array.isArray(card.elements) ? null : card.elements;
  if (
    card === null || config?.wide_screen_mode !== true || config.update_multi !== true ||
    header?.template !== 'blue' || title?.tag !== 'plain_text' ||
    title.content !== 'Delivery Loop 交付状态' || elements === null ||
    new TextEncoder().encode(JSON.stringify(card)).byteLength > MAX_CARD_BYTES
  ) throw new FeishuCardPresentationEvidenceVerificationError('feishu_response_invalid');
  const expectedPresentation = FeishuDeliveryCardPresentationV2Schema.parse({
    schemaVersion: '2',
    cardId: outer.cardId,
    presentationId: expected.presentationId,
    runId: outer.runId,
    ...expected.snapshot,
    actions: [],
  });
  const expectedDivs = renderFeishuDeliveryCard(expectedPresentation).elements;
  const actualDivs = elements.filter((element) => record(element)?.tag === 'div');
  if (
    JSON.stringify(actualDivs) !== JSON.stringify(expectedDivs) ||
    elements.some((element) => {
      const tag = record(element)?.tag;
      return tag !== 'div' && tag !== 'input' && tag !== 'action';
    })
  ) throw new FeishuCardPresentationEvidenceVerificationError('card_content_mismatch');
}

/** Shared bounded control-plane + Feishu Message GET authority for card evidence verifiers. */
export async function verifyFeishuLivePresentation(
  binding: FeishuLivePresentationBinding,
  options: FeishuCardPresentationEvidenceVerifierOptions,
): Promise<FeishuLivePresentationVerification> {
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.feishuAccessToken) ||
    !CANARY_PATTERN.test(options.canarySecret)
  ) throw new FeishuCardPresentationEvidenceVerificationError('configuration_invalid');
  if (new SecretScanner().scanText(options.canarySecret, '$.canary').length === 0) {
    throw new FeishuCardPresentationEvidenceVerificationError('configuration_invalid');
  }
  if (await canonicalSha256(options.canarySecret) !== binding.canaryDigest) {
    throw new FeishuCardPresentationEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const feishuApiOrigin = httpsOrigin(options.feishuApiOrigin ?? 'https://open.feishu.cn');
  const scanner = new SecretScanner({ secrets: [options.canarySecret] });
  const fetcher = options.fetch ?? fetch;
  const operationsRaw = await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/operations/feishu-card-presentation/evidence` +
      `?runId=${encodeURIComponent(binding.runId)}`,
    options.operationsToken,
    'control_plane',
    scanner,
  );
  const operations = OperationsEvidenceSchema.safeParse(operationsRaw);
  if (!operations.success) {
    throw new FeishuCardPresentationEvidenceVerificationError('control_plane_response_invalid');
  }
  const evidence = operations.data.evidence;
  if (
    evidence.taskId !== binding.taskId || evidence.runId !== binding.runId ||
    evidence.repository !== binding.repository ||
    evidence.tenantKey !== binding.card.tenantKey || evidence.chatId !== binding.card.chatId
  ) throw new FeishuCardPresentationEvidenceVerificationError('presentation_snapshot_mismatch');
  const sorted = [...evidence.presentations].sort((left, right) => left.revision - right.revision);
  const presentation = sorted.find((row) =>
    row.presentationId === binding.presentation.presentationId);
  if (
    presentation === undefined || sorted.at(-1)?.presentationId !== presentation.presentationId ||
    !exactReference(presentation, binding.presentation) || presentation.delivery === null ||
    presentation.delivery.messageId !== binding.card.messageId
  ) throw new FeishuCardPresentationEvidenceVerificationError('delivery_lineage_mismatch');

  const messageRaw = await getJson(
    fetcher,
    `${feishuApiOrigin}/open-apis/im/v1/messages/${binding.card.messageId}` +
      '?card_msg_content_type=user_card_content',
    options.feishuAccessToken,
    'feishu',
    scanner,
  );
  const response = record(messageRaw);
  const data = response === null ? null : record(response.data);
  const items = data === null || !Array.isArray(data.items) ? null : data.items;
  const item = items?.length === 1 ? record(items[0]) : null;
  const sender = item === null ? null : record(item.sender);
  const body = item === null ? null : record(item.body);
  const createdAt = item === null ? null : messageTime(item.create_time);
  const updatedAt = item === null ? null : messageTime(item.update_time);
  if (
    response?.code !== 0 || item === null || sender === null || body === null ||
    typeof body.content !== 'string' || body.content.length > MAX_CARD_BYTES * 2 ||
    createdAt === null || updatedAt === null
  ) throw new FeishuCardPresentationEvidenceVerificationError('feishu_response_invalid');
  if (
    item.message_id !== binding.card.messageId || item.msg_type !== 'interactive' ||
    item.deleted !== false || item.chat_id !== binding.card.chatId ||
    sender.sender_type !== 'app' || sender.id !== binding.card.appId ||
    sender.tenant_key !== binding.card.tenantKey ||
    createdAt !== binding.card.createdAt || updatedAt !== binding.card.updatedAt ||
    !withinMilliseconds(presentation.delivery.deliveredAt, updatedAt, 5_000)
  ) throw new FeishuCardPresentationEvidenceVerificationError('message_binding_mismatch');
  let liveCard: unknown;
  try {
    liveCard = JSON.parse(body.content) as unknown;
  } catch {
    throw new FeishuCardPresentationEvidenceVerificationError('feishu_response_invalid');
  }
  if (await canonicalSha256(liveCard) !== presentation.renderedDigest) {
    throw new FeishuCardPresentationEvidenceVerificationError('card_digest_mismatch');
  }
  validateLiveCard(liveCard, presentation, evidence);
  return {
    evidence,
    presentation,
    liveCard,
    messageCreatedAt: createdAt,
    messageUpdatedAt: updatedAt,
  };
}

export async function verifyFeishuCardPresentationEvidence(
  input: FeishuCardPresentationEvidenceManifestV1,
  options: FeishuCardPresentationEvidenceVerifierOptions,
): Promise<FeishuCardPresentationEvidenceVerificationSummary> {
  const parsed = FeishuCardPresentationEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new FeishuCardPresentationEvidenceVerificationError('manifest_invalid');
  }
  const manifest = parsed.data;
  const live = await verifyFeishuLivePresentation({
    taskId: manifest.taskId,
    runId: manifest.runId,
    repository: manifest.repository,
    card: manifest.card,
    presentation: manifest.lifecycle.afterExpiry,
    canaryDigest: manifest.safety.canaryDigest,
  }, options);
  const evidence = live.evidence;
  const { created, after } = validateLifecycle(evidence.presentations, manifest);
  if (
    !withinMilliseconds(created.delivery!.deliveredAt, live.messageCreatedAt, 5_000) ||
    !withinMilliseconds(after.delivery!.deliveredAt, live.messageUpdatedAt, 5_000)
  ) throw new FeishuCardPresentationEvidenceVerificationError('message_binding_mismatch');

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    runId: manifest.runId,
    presentationCount: evidence.presentations.length,
    messageId: manifest.card.messageId,
    createAndPatch: 'verified',
    approvalExpiry: 'verified',
    liveCard: 'verified',
    plaintextLeaks: 0,
  };
}
