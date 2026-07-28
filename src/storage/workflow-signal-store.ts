import { canonicalSha256 } from '../domain/digest.js';
import {
  AttemptResultSignalV1Schema,
  attemptResultEventName,
  type AttemptResultSignalV1,
} from '../domain/workflow-event.js';

export class WorkflowSignalConflictError extends Error {
  readonly code = 'signal_conflict' as const;

  constructor() {
    super('workflow signal identity is already bound to different content');
    this.name = 'WorkflowSignalConflictError';
  }
}

export interface WorkflowSignalOutboxRef {
  signalId: string;
  outboxId: string;
}

interface SignalProjectionRow {
  signal_id: string;
  digest: string;
  workflow_event_type: string;
  signal_type: string;
  attempt_id: string;
  sequence: number;
  payload_ref: string;
  occurred_at: string;
  outbox_id: string | null;
}

export class WorkflowSignalStore {
  constructor(private readonly db: D1Database) {}

  async enqueueAttemptResult(
    input: AttemptResultSignalV1,
    now: string,
  ): Promise<WorkflowSignalOutboxRef> {
    const signal = AttemptResultSignalV1Schema.parse(input);
    const identityDigest = await canonicalSha256({
      runId: signal.runId,
      eventId: signal.eventId,
    });
    const suffix = identityDigest.slice('sha256:'.length, 'sha256:'.length + 56);
    const signalId = `signal_${suffix}`;
    const outboxId = `outbox_signal_${suffix}`;
    const workflowEventType = attemptResultEventName(signal.attemptId);

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO workflow_signals (
             signal_id, run_id, event_id, workflow_event_type, signal_type,
             attempt_id, sequence, payload_ref, digest, occurred_at, created_at
           ) VALUES (?, ?, ?, ?, 'attempt_completed', ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          signalId,
          signal.runId,
          signal.eventId,
          workflowEventType,
          signal.attemptId,
          signal.sequence,
          signal.payloadRef,
          signal.digest,
          signal.occurredAt,
          now,
        ),
      this.db
        .prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, ?, 'workflow_signal', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM workflow_signals
             WHERE signal_id = ? AND run_id = ? AND event_id = ? AND digest = ?
           )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          outboxId,
          signal.runId,
          `d1://workflow-signals/${signalId}`,
          `workflow-signal:${signal.runId}:${signal.eventId}`,
          now,
          now,
          signalId,
          signal.runId,
          signal.eventId,
          signal.digest,
        ),
    ]);

    const row = await this.db
      .prepare(
        `SELECT
           workflow_signals.signal_id,
           workflow_signals.digest,
           workflow_signals.workflow_event_type,
           workflow_signals.signal_type,
           workflow_signals.attempt_id,
           workflow_signals.sequence,
           workflow_signals.payload_ref,
           workflow_signals.occurred_at,
           outbox.outbox_id
         FROM workflow_signals
         LEFT JOIN outbox
           ON outbox.payload_ref = 'd1://workflow-signals/' || workflow_signals.signal_id
          AND outbox.kind = 'workflow_signal'
         WHERE workflow_signals.run_id = ? AND workflow_signals.event_id = ?`,
      )
      .bind(signal.runId, signal.eventId)
      .first<SignalProjectionRow>();
    if (
      row === null ||
      row.signal_id !== signalId ||
      row.digest !== signal.digest ||
      row.workflow_event_type !== workflowEventType ||
      row.signal_type !== signal.type ||
      row.attempt_id !== signal.attemptId ||
      row.sequence !== signal.sequence ||
      row.payload_ref !== signal.payloadRef ||
      row.occurred_at !== signal.occurredAt ||
      row.outbox_id !== outboxId
    ) {
      throw new WorkflowSignalConflictError();
    }
    return { signalId, outboxId };
  }
}
