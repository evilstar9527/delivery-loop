import { z } from 'zod';
import {
  ATTEMPTED_PATHS,
  ATTEMPTED_PATH_LABELS,
  FAILURE_CODES,
  FAILURE_SITES,
  HUMAN_INPUT_CODES,
  HUMAN_INPUT_PROMPTS,
  failureClassFor,
  type AttemptedPath,
} from '../domain/attempt-failure.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  FailureBlockerCardEvidenceManifestV1Schema,
  type FailureBlockerCardEvidenceManifestV1,
} from '../domain/failure-blocker-card-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CARD_BYTES = 30 * 1024;

const FailureClassSchema = z.enum([
  'invalid_output',
  'tool_error',
  'command_error',
  'verification_error',
  'policy_denied',
  'external_error',
  'timeout',
  'unknown',
]);

const LiveAttemptSchema = z.object({
  attemptId: z.string().regex(ID_PATTERN),
  ordinal: z.number().int().positive(),
  failureClass: FailureClassSchema,
  failureCode: z.enum(FAILURE_CODES),
  failureSite: z.enum(FAILURE_SITES),
  occurredAt: z.iso.datetime({ offset: true }),
  paths: z.array(z.object({
    code: z.enum(ATTEMPTED_PATHS),
    label: z.string().min(1).max(200),
  }).strict()).min(1).max(ATTEMPTED_PATHS.length),
  verificationFailure: z.object({
    sourceSuiteId: z.string().regex(ID_PATTERN),
    sourceEvidenceId: z.string().regex(ID_PATTERN),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    factDigest: z.string().regex(DIGEST_PATTERN),
  }).strict().optional(),
}).strict();

const LiveBlockerSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  reason: z.enum(['repeated_fingerprint', 'attempt_limit']),
  fingerprintDigest: z.string().regex(DIGEST_PATTERN),
  attemptCount: z.number().int().positive(),
  consecutiveFingerprintCount: z.number().int().positive(),
  attemptedPaths: z.array(LiveAttemptSchema).min(2).max(3),
  neededHumanInput: z.object({
    code: z.enum(HUMAN_INPUT_CODES),
    prompt: z.string().min(1).max(240),
  }).strict(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

const CardOperationsViewSchema = z.object({
  schemaVersion: z.literal('1'),
  card: z.object({
    runId: z.string().regex(ID_PATTERN),
    cardId: z.string().regex(ID_PATTERN),
    latest: z.object({
      presentationId: z.string().regex(ID_PATTERN),
      revision: z.number().int().positive(),
      digest: z.string().regex(DIGEST_PATTERN),
      renderedDigest: z.string().regex(DIGEST_PATTERN),
      outboxId: z.string().regex(ID_PATTERN),
      deliveryState: z.enum(['pending', 'delivering', 'settled']),
      attemptCount: z.number().int().nonnegative(),
      lastErrorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
    }).strict(),
    delivered: z.object({
      presentationId: z.string().regex(ID_PATTERN),
      revision: z.number().int().positive(),
      digest: z.string().regex(DIGEST_PATTERN),
      messageId: z.string().regex(MESSAGE_ID_PATTERN),
    }).strict().nullable(),
  }).strict(),
}).strict();

export type FailureBlockerCardEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'blocker_snapshot_mismatch'
  | 'card_delivery_mismatch'
  | 'feishu_api_unavailable'
  | 'feishu_response_invalid'
  | 'message_binding_mismatch'
  | 'card_digest_mismatch'
  | 'blocker_content_mismatch';

export class FailureBlockerCardEvidenceVerificationError extends Error {
  constructor(readonly code: FailureBlockerCardEvidenceVerificationErrorCode) {
    super(`Failure blocker card evidence verification failed: ${code}`);
    this.name = 'FailureBlockerCardEvidenceVerificationError';
  }
}

export interface FailureBlockerCardEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  queryToken: string;
  feishuAccessToken: string;
  feishuApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface FailureBlockerCardEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  blocker: 'verified';
  reason: 'repeated_fingerprint' | 'attempt_limit';
  attemptCount: number;
  attemptedPathCount: number;
  presentationId: string;
  messageId: string;
}

interface ResponseJson {
  body: unknown;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FailureBlockerCardEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new FailureBlockerCardEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Directly reuses the bounded streaming reader used by tool-bridge and the
// Watt-derived Runner recovery / controlled replay E2E verifiers.
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
): Promise<ResponseJson> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new FailureBlockerCardEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'feishu_api_unavailable',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FailureBlockerCardEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'feishu_api_unavailable',
    );
  }
  const invalidCode = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'feishu_response_invalid';
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FailureBlockerCardEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new FailureBlockerCardEvidenceVerificationError(invalidCode);
  }
  if (text === null) throw new FailureBlockerCardEvidenceVerificationError(invalidCode);
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    throw new FailureBlockerCardEvidenceVerificationError(invalidCode);
  }
}

function messageTime(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{9,15}$/.test(raw)) return null;
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function exactAttemptPaths(
  actual: z.infer<typeof LiveBlockerSchema>['attemptedPaths'],
  manifest: FailureBlockerCardEvidenceManifestV1,
): boolean {
  const projection = actual.map((attempt) => ({
    attemptId: attempt.attemptId,
    ordinal: attempt.ordinal,
    pathCodes: attempt.paths.map((path) => path.code),
  }));
  return JSON.stringify(projection) === JSON.stringify(manifest.blocker.attempts);
}

function validateLiveBlocker(
  raw: unknown,
  manifest: FailureBlockerCardEvidenceManifestV1,
): z.infer<typeof LiveBlockerSchema> {
  const parsed = LiveBlockerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FailureBlockerCardEvidenceVerificationError('control_plane_response_invalid');
  }
  const blocker = parsed.data;
  for (const attempt of blocker.attemptedPaths) {
    if (
      failureClassFor(attempt.failureCode) !== attempt.failureClass ||
      new Set(attempt.paths.map((path) => path.code)).size !== attempt.paths.length ||
      attempt.paths.some((path) => ATTEMPTED_PATH_LABELS[path.code] !== path.label)
    ) {
      throw new FailureBlockerCardEvidenceVerificationError('control_plane_response_invalid');
    }
  }
  if (
    blocker.id !== manifest.blocker.blockerId ||
    blocker.reason !== manifest.blocker.reason ||
    blocker.fingerprintDigest !== manifest.blocker.fingerprintDigest ||
    blocker.attemptCount !== manifest.blocker.attemptCount ||
    blocker.consecutiveFingerprintCount !== manifest.blocker.consecutiveFingerprintCount ||
    blocker.neededHumanInput.code !== manifest.blocker.neededHumanInput ||
    blocker.neededHumanInput.prompt !== HUMAN_INPUT_PROMPTS[manifest.blocker.neededHumanInput] ||
    blocker.createdAt !== manifest.blocker.createdAt ||
    !exactAttemptPaths(blocker.attemptedPaths, manifest)
  ) throw new FailureBlockerCardEvidenceVerificationError('blocker_snapshot_mismatch');
  return blocker;
}

function flattenedPaths(
  blocker: z.infer<typeof LiveBlockerSchema>,
): AttemptedPath[] {
  return [...new Set(blocker.attemptedPaths.flatMap(
    (attempt) => attempt.paths.map((path) => path.code),
  ))];
}

function exactBlockerText(
  blocker: z.infer<typeof LiveBlockerSchema>,
  paths: AttemptedPath[],
): string {
  return [
    `原因：${blocker.reason}`,
    `尝试：${blocker.attemptCount}`,
    ...paths.map((path) => ATTEMPTED_PATH_LABELS[path]),
    HUMAN_INPUT_PROMPTS[blocker.neededHumanInput.code],
  ].join(' · ');
}

function validateCardContent(
  raw: unknown,
  blocker: z.infer<typeof LiveBlockerSchema>,
  paths: AttemptedPath[],
): void {
  const card = record(raw);
  const config = card === null ? null : record(card.config);
  const elements = card === null || !Array.isArray(card.elements) ? null : card.elements;
  if (
    card === null || config === null || config.wide_screen_mode !== true ||
    config.update_multi !== true || elements === null || elements.length < 1 ||
    new TextEncoder().encode(JSON.stringify(card)).byteLength > MAX_CARD_BYTES
  ) throw new FailureBlockerCardEvidenceVerificationError('feishu_response_invalid');
  const blockerSections: string[] = [];
  for (const rawElement of elements) {
    const element = record(rawElement);
    const text = element === null ? null : record(element.text);
    if (
      element?.tag === 'div' && text?.tag === 'lark_md' &&
      typeof text.content === 'string' && text.content.startsWith('**Blocker**\n')
    ) blockerSections.push(text.content);
  }
  const expected = `**Blocker**\n${exactBlockerText(blocker, paths)}`;
  if (blockerSections.length !== 1 || blockerSections[0] !== expected) {
    throw new FailureBlockerCardEvidenceVerificationError('blocker_content_mismatch');
  }
}

export async function verifyFailureBlockerCardEvidence(
  input: FailureBlockerCardEvidenceManifestV1,
  options: FailureBlockerCardEvidenceVerifierOptions,
): Promise<FailureBlockerCardEvidenceVerificationSummary> {
  const parsed = FailureBlockerCardEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new FailureBlockerCardEvidenceVerificationError('manifest_invalid');
  }
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.operationsToken) || !TOKEN_PATTERN.test(options.queryToken) ||
    !TOKEN_PATTERN.test(options.feishuAccessToken)
  ) throw new FailureBlockerCardEvidenceVerificationError('configuration_invalid');
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const feishuApiOrigin = httpsOrigin(options.feishuApiOrigin ?? 'https://open.feishu.cn');
  const fetcher = options.fetch ?? fetch;

  const taskResult = await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/tasks/${manifest.taskId}`,
    options.queryToken,
    'control_plane',
  );
  const taskRoot = record(taskResult.body);
  const task = taskRoot === null ? null : record(taskRoot.task);
  const target = task === null ? null : record(task.target);
  const run = taskRoot === null ? null : record(taskRoot.run);
  if (
    task === null || target === null || run === null || task.id !== manifest.taskId ||
    target.repository !== manifest.repository || run.id !== manifest.runId ||
    run.state !== 'blocked'
  ) throw new FailureBlockerCardEvidenceVerificationError('blocker_snapshot_mismatch');
  const blocker = validateLiveBlocker(run.blocker, manifest);
  const paths = flattenedPaths(blocker);

  const cardResult = await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/runs/${manifest.runId}/feishu-card`,
    options.operationsToken,
    'control_plane',
  );
  const operations = CardOperationsViewSchema.safeParse(cardResult.body);
  if (!operations.success) {
    throw new FailureBlockerCardEvidenceVerificationError('control_plane_response_invalid');
  }
  const cardView = operations.data.card;
  const latest = cardView.latest;
  const delivered = cardView.delivered;
  if (
    cardView.runId !== manifest.runId || delivered === null ||
    latest.presentationId !== manifest.card.presentationId ||
    latest.revision !== manifest.card.revision ||
    latest.digest !== manifest.card.presentationDigest ||
    latest.renderedDigest !== manifest.card.renderedCardDigest ||
    latest.outboxId !== manifest.card.outboxId || latest.deliveryState !== 'settled' ||
    latest.attemptCount < 1 || latest.lastErrorCode !== null ||
    delivered.presentationId !== latest.presentationId ||
    delivered.revision !== latest.revision || delivered.digest !== latest.digest ||
    delivered.messageId !== manifest.card.messageId
  ) throw new FailureBlockerCardEvidenceVerificationError('card_delivery_mismatch');

  const messageResult = await getJson(
    fetcher,
    `${feishuApiOrigin}/open-apis/im/v1/messages/${manifest.card.messageId}` +
      '?card_msg_content_type=user_card_content',
    options.feishuAccessToken,
    'feishu',
  );
  const response = record(messageResult.body);
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
  ) throw new FailureBlockerCardEvidenceVerificationError('feishu_response_invalid');
  if (
    item.message_id !== manifest.card.messageId || item.msg_type !== 'interactive' ||
    item.deleted !== false || item.chat_id !== manifest.card.chatId ||
    sender.sender_type !== 'app' || sender.id !== manifest.card.appId ||
    sender.tenant_key !== manifest.card.tenantKey ||
    createdAt !== manifest.card.createdAt || updatedAt !== manifest.card.updatedAt
  ) throw new FailureBlockerCardEvidenceVerificationError('message_binding_mismatch');
  let rendered: unknown;
  try {
    rendered = JSON.parse(body.content) as unknown;
  } catch {
    throw new FailureBlockerCardEvidenceVerificationError('feishu_response_invalid');
  }
  if (await canonicalSha256(rendered) !== manifest.card.renderedCardDigest) {
    throw new FailureBlockerCardEvidenceVerificationError('card_digest_mismatch');
  }
  validateCardContent(rendered, blocker, paths);

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    runId: manifest.runId,
    blocker: 'verified',
    reason: manifest.blocker.reason,
    attemptCount: manifest.blocker.attemptCount,
    attemptedPathCount: paths.length,
    presentationId: manifest.card.presentationId,
    messageId: manifest.card.messageId,
  };
}
