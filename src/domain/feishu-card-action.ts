/**
 * Feishu card-action decoding copied from Watt commit 476e3cd
 * packages/plugin-feishu/src/adapter/decode.ts.
 *
 * Delivery Loop keeps Watt's trusted-field extraction shape (`operator.open_id`,
 * `action.value`, `context.open_chat_id`, and header event identity/time), then
 * narrows `value.signal` to a version-fenced control-plane command. The generic
 * Watt signal model and raw event are deliberately not propagated.
 */

import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export const FeishuCardApprovalEffectSchema = z.enum([
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
]);

const FeishuCardActionCommonSchema = z.object({
  schemaVersion: z.literal('1'),
  actionId: z.string().regex(ID_PATTERN),
  cardId: z.string().regex(RESOURCE_ID_PATTERN),
  presentationId: z.string().regex(RESOURCE_ID_PATTERN),
  taskId: z.string().regex(RESOURCE_ID_PATTERN),
  runId: z.string().regex(RESOURCE_ID_PATTERN),
  runVersion: z.number().int().nonnegative(),
  taskRevision: z.string().min(1).max(500),
  taskRevisionDigest: z.string().regex(DIGEST_PATTERN),
  planId: z.string().regex(RESOURCE_ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
  nonce: z.string().regex(NONCE_PATTERN),
});

export const FeishuCardActionCommandSchema = z.discriminatedUnion('command', [
  FeishuCardActionCommonSchema.extend({
    command: z.literal('approve'),
    effect: FeishuCardApprovalEffectSchema,
  }).strict(),
  FeishuCardActionCommonSchema.extend({
    command: z.literal('reject'),
    effect: FeishuCardApprovalEffectSchema,
  }).strict(),
  FeishuCardActionCommonSchema.extend({
    command: z.literal('cancel'),
    effect: z.literal('cancel_run'),
  }).strict(),
  FeishuCardActionCommonSchema.extend({
    command: z.literal('retry'),
    effect: z.literal('retry_run'),
  }).strict(),
  FeishuCardActionCommonSchema.extend({
    command: z.literal('replay'),
    effect: z.literal('replay_run'),
  }).strict(),
  FeishuCardActionCommonSchema.extend({
    command: z.literal('add_context'),
    effect: z.literal('add_context'),
    contextMode: z.enum(['new_run', 'apply_current']),
  }).strict(),
]);

export type FeishuCardApprovalEffect = z.infer<typeof FeishuCardApprovalEffectSchema>;
export type FeishuCardActionCommand = z.infer<typeof FeishuCardActionCommandSchema>;

export interface DecodedFeishuCardAction {
  eventId: string;
  occurredAt: string;
  operatorOpenId: string;
  chatId: string;
  messageId: string;
  command: FeishuCardActionCommand;
  contextText: string | null;
}

export type FeishuCardActionDecodeResult =
  | { ok: true; action: DecodedFeishuCardAction }
  | { ok: false; reason: 'not_card_action' | 'invalid_card_action' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Copied from Watt decode.ts; invalid platform timestamps are rejected here
// instead of falling back to an in-memory clock.
function createTimeToIso(createTime: unknown): string | undefined {
  if (typeof createTime !== 'string' || createTime.length === 0) return undefined;
  const milliseconds = Number(createTime);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  return new Date(milliseconds).toISOString();
}

/** Extracts only verified card-action identity/binding fields from a v2 event. */
export function decodeFeishuCardAction(raw: unknown): FeishuCardActionDecodeResult {
  if (!isRecord(raw) || !isRecord(raw.header)) {
    return { ok: false, reason: 'not_card_action' };
  }
  if (raw.header.event_type !== 'card.action.trigger') {
    return { ok: false, reason: 'not_card_action' };
  }
  const eventId = raw.header.event_id;
  const occurredAt = createTimeToIso(raw.header.create_time);
  const event = isRecord(raw.event) ? raw.event : undefined;
  const action = event !== undefined && isRecord(event.action) ? event.action : undefined;
  const value = action !== undefined && isRecord(action.value) ? action.value : undefined;
  const signal = value !== undefined && isRecord(value.signal) ? value.signal : undefined;
  const operator = event !== undefined && isRecord(event.operator) ? event.operator : undefined;
  const context = event !== undefined && isRecord(event.context) ? event.context : undefined;
  const parsedCommand = FeishuCardActionCommandSchema.safeParse(signal);
  if (
    typeof eventId !== 'string' || !ID_PATTERN.test(eventId) || occurredAt === undefined ||
    typeof operator?.open_id !== 'string' ||
    typeof context?.open_chat_id !== 'string' ||
    typeof context.open_message_id !== 'string' ||
    typeof value?.id !== 'string' || !parsedCommand.success ||
    value.id !== parsedCommand.data.actionId
  ) return { ok: false, reason: 'invalid_card_action' };

  const formValue = action !== undefined && isRecord(action.form_value)
    ? action.form_value
    : undefined;
  const contextText = typeof formValue?.delivery_loop_context === 'string'
    ? formValue.delivery_loop_context
    : null;
  return {
    ok: true,
    action: {
      eventId,
      occurredAt,
      operatorOpenId: operator.open_id,
      chatId: context.open_chat_id,
      messageId: context.open_message_id,
      command: parsedCommand.data,
      contextText,
    },
  };
}
