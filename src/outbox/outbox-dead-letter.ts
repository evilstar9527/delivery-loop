import { canonicalSha256 } from '../domain/digest.js';
import {
  secureStructuredLogSink,
  type StructuredLogSink,
} from '../observability/structured-log.js';
import type { WorkflowOutboxMessage } from './workflow-outbox.js';

export const PRIMARY_OUTBOX_QUEUE = 'delivery-loop-workflow-outbox';
export const OUTBOX_DEAD_LETTER_QUEUE = 'delivery-loop-workflow-outbox-dlq';
export const OUTBOX_DEAD_LETTER_QUARANTINE_QUEUE =
  'delivery-loop-workflow-outbox-dlq-quarantine';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const OUTBOX_LABEL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LIST_LIMIT = 100;

export type OutboxDeadLetterStatus = 'open' | 'replay_requested' | 'resolved';
export type OutboxDeadLetterReplayReason =
  | 'operator_retry'
  | 'upstream_recovered'
  | 'configuration_fixed';

export interface OutboxDeadLetterView {
  id: string;
  outboxId: string;
  runId: string;
  sourceQueue: typeof PRIMARY_OUTBOX_QUEUE;
  sourceMessageId: string;
  sourceAttempts: number;
  outboxKind: string;
  destination: string;
  outboxAttemptCount: number;
  status: OutboxDeadLetterStatus;
  capturedAt: string;
  lastErrorCode?: string;
  replayRequestedAt?: string;
  resolvedAt?: string;
  resolutionCode?: 'outbox_settled';
}

export interface CaptureOutboxDeadLetterInput {
  sourceMessageId: string;
  outboxId: string;
  sourceAttempts: number;
  capturedAt: Date;
}

export interface CaptureOutboxDeadLetterResult {
  created: boolean;
  deadLetter: OutboxDeadLetterView;
}

export interface ReplayOutboxDeadLetterInput {
  deadLetterId: string;
  expectedOutboxAttemptCount: number;
  reasonCode: OutboxDeadLetterReplayReason;
  requestedAt: Date;
}

export interface ReplayOutboxDeadLetterResult {
  deadLetterId: string;
  outboxId: string;
  replayId: string;
  created: boolean;
  status: 'replay_requested';
}

export type OutboxDeadLetterErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'state_conflict';

export class OutboxDeadLetterError extends Error {
  constructor(readonly code: OutboxDeadLetterErrorCode) {
    super(`Outbox dead-letter operation failed: ${code}`);
    this.name = 'OutboxDeadLetterError';
  }
}

interface OutboxRow {
  outbox_id: string;
  run_id: string;
  kind: string;
  destination: string;
  delivery_state: 'pending' | 'delivering' | 'settled';
  attempt_count: number;
  lease_expires_at: string | null;
  last_error_code: string | null;
}

interface DeadLetterRow {
  dead_letter_id: string;
  outbox_id: string;
  run_id: string;
  source_queue: typeof PRIMARY_OUTBOX_QUEUE;
  source_message_id: string;
  source_attempts: number;
  outbox_kind: string;
  destination: string;
  outbox_attempt_count: number;
  last_error_code: string | null;
  status: OutboxDeadLetterStatus;
  captured_at: string;
  replay_requested_at: string | null;
  resolved_at: string | null;
  resolution_code: 'outbox_settled' | null;
}

interface ReplayRow {
  replay_id: string;
  dead_letter_id: string;
  outbox_id: string;
  expected_outbox_attempt_count: number;
  reason_code: OutboxDeadLetterReplayReason;
}

interface ReplayCandidateRow extends DeadLetterRow {
  delivery_state: 'pending' | 'delivering' | 'settled';
  current_attempt_count: number;
  lease_expires_at: string | null;
}

interface ReplayProjectionRow {
  dead_letter_status: string;
  delivery_state: string;
  last_error_code: string | null;
}

function deadLetterView(row: DeadLetterRow): OutboxDeadLetterView {
  return {
    id: row.dead_letter_id,
    outboxId: row.outbox_id,
    runId: row.run_id,
    sourceQueue: row.source_queue,
    sourceMessageId: row.source_message_id,
    sourceAttempts: row.source_attempts,
    outboxKind: row.outbox_kind,
    destination: row.destination,
    outboxAttemptCount: row.outbox_attempt_count,
    status: row.status,
    capturedAt: row.captured_at,
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.replay_requested_at === null
      ? {}
      : { replayRequestedAt: row.replay_requested_at }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.resolution_code === null ? {} : { resolutionCode: row.resolution_code }),
  };
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

/** Durable DLQ ledger and replay gate; it never copies the outbox payload. */
export class OutboxDeadLetterStore {
  constructor(private readonly db: D1Database) {}

  async capture(
    input: CaptureOutboxDeadLetterInput,
  ): Promise<CaptureOutboxDeadLetterResult> {
    if (
      !ID_PATTERN.test(input.sourceMessageId) ||
      !ID_PATTERN.test(input.outboxId) ||
      !Number.isSafeInteger(input.sourceAttempts) ||
      input.sourceAttempts < 1 ||
      !validDate(input.capturedAt)
    ) throw new OutboxDeadLetterError('invalid_argument');
    const outbox = await this.db.prepare(
      `SELECT outbox_id, run_id, kind, destination, delivery_state, attempt_count,
              lease_expires_at, last_error_code
       FROM outbox WHERE outbox_id = ?`,
    ).bind(input.outboxId).first<OutboxRow>();
    if (outbox === null) throw new OutboxDeadLetterError('not_found');
    if (
      !OUTBOX_LABEL_PATTERN.test(outbox.kind) ||
      !OUTBOX_LABEL_PATTERN.test(outbox.destination) ||
      (
        outbox.last_error_code !== null &&
        !ERROR_CODE_PATTERN.test(outbox.last_error_code)
      )
    ) throw new OutboxDeadLetterError('state_conflict');
    const digest = await canonicalSha256({
      sourceQueue: PRIMARY_OUTBOX_QUEUE,
      sourceMessageId: input.sourceMessageId,
      outboxId: input.outboxId,
    });
    const deadLetterId = `outbox-dlq-${digest.slice('sha256:'.length)}`;
    const capturedAt = input.capturedAt.toISOString();
    const settled = outbox.delivery_state === 'settled';
    const inserted = await this.db.prepare(
      `INSERT INTO outbox_dead_letters (
         dead_letter_id, outbox_id, run_id, source_queue, source_message_id,
         source_attempts, outbox_kind, destination, outbox_attempt_count,
         last_error_code, status, captured_at, resolved_at, resolution_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      deadLetterId,
      outbox.outbox_id,
      outbox.run_id,
      PRIMARY_OUTBOX_QUEUE,
      input.sourceMessageId,
      input.sourceAttempts,
      outbox.kind,
      outbox.destination,
      outbox.attempt_count,
      outbox.last_error_code,
      settled ? 'resolved' : 'open',
      capturedAt,
      settled ? capturedAt : null,
      settled ? 'outbox_settled' : null,
    ).run();
    let row = await this.row(deadLetterId);
    if (row === null) {
      row = await this.db.prepare(
        `SELECT * FROM outbox_dead_letters
         WHERE outbox_id = ? AND status = 'open'
         ORDER BY captured_at, dead_letter_id LIMIT 1`,
      ).bind(input.outboxId).first<DeadLetterRow>();
    }
    if (row === null || row.outbox_id !== input.outboxId) {
      throw new OutboxDeadLetterError('state_conflict');
    }
    return { created: inserted.meta.changes === 1, deadLetter: deadLetterView(row) };
  }

  async replay(
    input: ReplayOutboxDeadLetterInput,
  ): Promise<ReplayOutboxDeadLetterResult> {
    if (
      !ID_PATTERN.test(input.deadLetterId) ||
      !Number.isSafeInteger(input.expectedOutboxAttemptCount) ||
      input.expectedOutboxAttemptCount < 0 ||
      !['operator_retry', 'upstream_recovered', 'configuration_fixed']
        .includes(input.reasonCode) ||
      !validDate(input.requestedAt)
    ) throw new OutboxDeadLetterError('invalid_argument');
    const candidate = await this.db.prepare(
      `SELECT dead_letters.*, outbox.delivery_state,
              outbox.attempt_count AS current_attempt_count, outbox.lease_expires_at
       FROM outbox_dead_letters AS dead_letters
       JOIN outbox ON outbox.outbox_id = dead_letters.outbox_id
       WHERE dead_letters.dead_letter_id = ?`,
    ).bind(input.deadLetterId).first<ReplayCandidateRow>();
    if (candidate === null) throw new OutboxDeadLetterError('not_found');
    if (candidate.status === 'replay_requested') {
      return this.existingReplay(candidate, input);
    }
    if (
      candidate.status !== 'open' ||
      candidate.delivery_state === 'settled' ||
      candidate.current_attempt_count !== input.expectedOutboxAttemptCount ||
      (
        candidate.delivery_state === 'delivering' &&
        (candidate.lease_expires_at === null ||
          candidate.lease_expires_at > input.requestedAt.toISOString())
      )
    ) throw new OutboxDeadLetterError('state_conflict');

    const replayId = `outbox-dlq-replay-${candidate.dead_letter_id}`;
    const requestedAt = input.requestedAt.toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO outbox_dead_letter_replays (
           replay_id, dead_letter_id, outbox_id, expected_outbox_attempt_count,
           requested_by, reason_code, created_at
         )
         SELECT ?, dead_letters.dead_letter_id, dead_letters.outbox_id, ?,
                'service:operations', ?, ?
         FROM outbox_dead_letters AS dead_letters
         JOIN outbox ON outbox.outbox_id = dead_letters.outbox_id
         WHERE dead_letters.dead_letter_id = ? AND dead_letters.status = 'open'
           AND outbox.attempt_count = ?
           AND (
             outbox.delivery_state = 'pending'
             OR (
               outbox.delivery_state = 'delivering'
               AND outbox.lease_expires_at IS NOT NULL
               AND outbox.lease_expires_at <= ?
             )
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        replayId,
        input.expectedOutboxAttemptCount,
        input.reasonCode,
        requestedAt,
        input.deadLetterId,
        input.expectedOutboxAttemptCount,
        requestedAt,
      ),
      this.db.prepare(
        `UPDATE outbox_dead_letters
         SET status = 'replay_requested', replay_requested_at = ?
         WHERE dead_letter_id = ? AND status = 'open'
           AND EXISTS (
             SELECT 1 FROM outbox_dead_letter_replays WHERE replay_id = ?
           )`,
      ).bind(requestedAt, input.deadLetterId, replayId),
      this.db.prepare(
        `UPDATE outbox
         SET delivery_state = 'pending', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'dead_letter_replay', updated_at = ?
         WHERE outbox_id = ? AND attempt_count = ?
           AND EXISTS (
             SELECT 1 FROM outbox_dead_letters
             WHERE dead_letter_id = ? AND status = 'replay_requested'
           )`,
      ).bind(
        requestedAt,
        candidate.outbox_id,
        input.expectedOutboxAttemptCount,
        input.deadLetterId,
      ),
    ]);
    const replay = await this.replayRow(input.deadLetterId);
    const insertResult = results[0];
    if (insertResult === undefined) throw new OutboxDeadLetterError('state_conflict');
    const projection = await this.db.prepare(
      `SELECT dead_letters.status AS dead_letter_status,
              outbox.delivery_state, outbox.last_error_code
       FROM outbox_dead_letters AS dead_letters
       JOIN outbox ON outbox.outbox_id = dead_letters.outbox_id
       WHERE dead_letters.dead_letter_id = ?`,
    ).bind(input.deadLetterId).first<ReplayProjectionRow>();
    if (
      replay === null ||
      replay.outbox_id !== candidate.outbox_id ||
      replay.expected_outbox_attempt_count !== input.expectedOutboxAttemptCount ||
      replay.reason_code !== input.reasonCode ||
      projection?.dead_letter_status !== 'replay_requested' ||
      projection.delivery_state !== 'pending' ||
      projection.last_error_code !== 'dead_letter_replay'
    ) throw new OutboxDeadLetterError('state_conflict');
    return {
      deadLetterId: input.deadLetterId,
      outboxId: candidate.outbox_id,
      replayId: replay.replay_id,
      created: insertResult.meta.changes === 1,
      status: 'replay_requested',
    };
  }

  async list(status: OutboxDeadLetterStatus, limit = 50): Promise<OutboxDeadLetterView[]> {
    if (
      !['open', 'replay_requested', 'resolved'].includes(status) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIST_LIMIT
    ) throw new OutboxDeadLetterError('invalid_argument');
    const rows = await this.db.prepare(
      `SELECT * FROM outbox_dead_letters WHERE status = ?
       ORDER BY captured_at DESC, dead_letter_id DESC LIMIT ?`,
    ).bind(status, limit).all<DeadLetterRow>();
    return rows.results.map(deadLetterView);
  }

  async reconcile(limit = 100, now = new Date()): Promise<OutboxDeadLetterView[]> {
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT ||
      !validDate(now)
    ) throw new OutboxDeadLetterError('invalid_argument');
    const candidates = await this.db.prepare(
      `SELECT dead_letters.* FROM outbox_dead_letters AS dead_letters
       JOIN outbox ON outbox.outbox_id = dead_letters.outbox_id
       WHERE dead_letters.status IN ('open', 'replay_requested')
         AND outbox.delivery_state = 'settled'
       ORDER BY dead_letters.captured_at, dead_letters.dead_letter_id LIMIT ?`,
    ).bind(limit).all<DeadLetterRow>();
    const resolved: OutboxDeadLetterView[] = [];
    const nowIso = now.toISOString();
    for (const candidate of candidates.results) {
      const result = await this.db.prepare(
        `UPDATE outbox_dead_letters
         SET status = 'resolved', resolved_at = ?, resolution_code = 'outbox_settled'
         WHERE dead_letter_id = ? AND status IN ('open', 'replay_requested')`,
      ).bind(nowIso, candidate.dead_letter_id).run();
      if (result.meta.changes !== 1) continue;
      resolved.push(deadLetterView({
        ...candidate,
        status: 'resolved',
        resolved_at: nowIso,
        resolution_code: 'outbox_settled',
      }));
    }
    return resolved;
  }

  private async existingReplay(
    candidate: ReplayCandidateRow,
    input: ReplayOutboxDeadLetterInput,
  ): Promise<ReplayOutboxDeadLetterResult> {
    const replay = await this.replayRow(candidate.dead_letter_id);
    if (
      replay === null ||
      replay.expected_outbox_attempt_count !== input.expectedOutboxAttemptCount ||
      replay.reason_code !== input.reasonCode
    ) throw new OutboxDeadLetterError('state_conflict');
    return {
      deadLetterId: candidate.dead_letter_id,
      outboxId: candidate.outbox_id,
      replayId: replay.replay_id,
      created: false,
      status: 'replay_requested',
    };
  }

  private async row(deadLetterId: string): Promise<DeadLetterRow | null> {
    return await this.db.prepare(
      `SELECT * FROM outbox_dead_letters WHERE dead_letter_id = ?`,
    ).bind(deadLetterId).first<DeadLetterRow>();
  }

  private async replayRow(deadLetterId: string): Promise<ReplayRow | null> {
    return await this.db.prepare(
      `SELECT replay_id, dead_letter_id, outbox_id, expected_outbox_attempt_count,
              reason_code
       FROM outbox_dead_letter_replays WHERE dead_letter_id = ?`,
    ).bind(deadLetterId).first<ReplayRow>();
  }
}

/** DLQ consumer: malformed/missing identities are poison; D1 failures retry. */
export async function consumeOutboxDeadLetterBatch(
  batch: MessageBatch<unknown>,
  store: OutboxDeadLetterStore,
  now = new Date(),
  sink: StructuredLogSink = secureStructuredLogSink({ component: 'outbox_dead_letter' }),
): Promise<void> {
  if (batch.queue !== OUTBOX_DEAD_LETTER_QUEUE) {
    throw new Error('Outbox dead-letter consumer received the wrong queue');
  }
  for (const message of batch.messages) {
    const body = message.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      Object.keys(body).length !== 1 ||
      typeof (body as Partial<WorkflowOutboxMessage>).outboxId !== 'string' ||
      !ID_PATTERN.test((body as WorkflowOutboxMessage).outboxId) ||
      !ID_PATTERN.test(message.id) ||
      !Number.isSafeInteger(message.attempts) ||
      message.attempts < 1
    ) {
      message.ack();
      continue;
    }
    try {
      const result = await store.capture({
        sourceMessageId: message.id,
        outboxId: (body as WorkflowOutboxMessage).outboxId,
        sourceAttempts: message.attempts,
        capturedAt: now,
      });
      sink({
        schemaVersion: '1',
        event: 'outbox_dead_letter_captured',
        deadLetterId: result.deadLetter.id,
        correlationId: result.deadLetter.runId,
        runId: result.deadLetter.runId,
        outboxId: result.deadLetter.outboxId,
        destination: result.deadLetter.destination,
        sourceAttempts: result.deadLetter.sourceAttempts,
        status: result.deadLetter.status,
        observedAt: now.toISOString(),
      });
      message.ack();
    } catch (error) {
      if (error instanceof OutboxDeadLetterError && error.code === 'not_found') {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
