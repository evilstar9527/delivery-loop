import {
  AttemptLifecycleError,
  AttemptLifecycleStore,
} from '../storage/attempt-lifecycle-store.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';

/**
 * How long a run may sit behind a dead-lettered dispatch before it is cancelled.
 *
 * A dead letter already means the outbox exhausted its retries, so this is not a
 * "wait for it to recover" window: the dispatch will never be retried on its own
 * because the outbox claim statement excludes open dead letters. The delay only
 * leaves room for an operator-initiated replay to land first, and matches the
 * existing `deploying` threshold so the watchdog has one recognisable cadence.
 */
export const DEFAULT_DISPATCH_STALL_THRESHOLD_SECONDS = 30 * 60;

/** Run states a stalled dispatch can be cancelled out of. */
const STALLABLE_RUN_STATES = new Set([
  'received',
  'triaging',
  'awaiting_approval',
  'queued',
  'planning',
  'executing',
  'verifying',
  'pull_request_open',
  'awaiting_review',
  'ready_to_merge',
  'merging',
  'deploying',
]);

export type DispatchStallDisposition = 'cancelled' | 'cancel_conflicted';

export interface DispatchStallIncidentView {
  incidentId: string;
  runId: string;
  outboxId: string;
  deadLetterId: string;
  lastErrorCode: string;
  observedRunState: string;
  runVersion: number;
  thresholdSeconds: number;
  disposition: DispatchStallDisposition;
  detectedAt: string;
}

export interface DispatchStallLogRecord {
  schemaVersion: '1';
  event: 'dispatch_stall_cancelled' | 'dispatch_stall_conflicted';
  incidentId: string;
  correlationId: string;
  runId: string;
  outboxId: string;
  deadLetterId: string;
  lastErrorCode: string;
  observedRunState: string;
  runVersion: number;
  thresholdSeconds: number;
  disposition: DispatchStallDisposition;
  observedAt: string;
}

export type DispatchStallLogSink = (record: DispatchStallLogRecord) => void;

export interface DispatchStallDetectorOptions {
  now?: () => Date;
  thresholdSeconds?: number;
  sink?: DispatchStallLogSink;
}

interface StallCandidateRow {
  run_id: string;
  state: string;
  version: number;
  outbox_id: string;
  dead_letter_id: string;
  last_error_code: string | null;
}

/**
 * Cron-facing watchdog for runs stranded behind a dead-lettered dispatch.
 *
 * When an `agent_execution_start` delivery exhausts its retries it is captured in
 * `outbox_dead_letters` with status='open', and the outbox claim statement
 * deliberately skips open dead letters so the destination is not hammered
 * forever. Nothing else watches that condition, so the run keeps its
 * pre-dispatch state indefinitely: in production seven runs held 'planning' for
 * 36-44 hours before anyone noticed.
 *
 * This detector closes the loop by cancelling those runs through the normal
 * Attempt lifecycle path and recording why, so a task never silently lingers and
 * never silently vanishes either.
 */
export class DispatchStallDetector {
  private readonly now: () => Date;
  private readonly thresholdSeconds: number;
  private readonly sink: DispatchStallLogSink;

  constructor(
    private readonly db: D1Database,
    options: DispatchStallDetectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.thresholdSeconds = options.thresholdSeconds ?? DEFAULT_DISPATCH_STALL_THRESHOLD_SECONDS;
    if (
      !Number.isSafeInteger(this.thresholdSeconds) ||
      this.thresholdSeconds < 60 ||
      this.thresholdSeconds > 604_800
    ) {
      throw new Error('Dispatch stall threshold must be between 60 and 604800 seconds');
    }
    this.sink = options.sink ?? secureStructuredLogSink({ component: 'dispatch_stall' });
  }

  async scan(limit = 25): Promise<DispatchStallIncidentView[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Dispatch stall scan limit must be between 1 and 100');
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error('Dispatch stall scan time is invalid');
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - this.thresholdSeconds * 1_000).toISOString();

    const candidates = await this.candidates(cutoff, limit);
    const incidents: DispatchStallIncidentView[] = [];
    for (const row of candidates) {
      const incident = await this.cancelStalledRun(row, nowIso);
      if (incident !== null) incidents.push(incident);
    }
    return incidents.sort((left, right) => left.incidentId.localeCompare(right.incidentId));
  }

  /**
   * Runs whose dispatch is dead-lettered and which have not moved since the
   * cutoff.
   *
   * The candidate test is the open dead letter rather than the run state,
   * because the stall lives in the dispatch lane: the same condition can strand
   * a run in 'planning', 'executing' or any other pre-terminal state. Filtering
   * on `dl.status = 'open'` also means an operator-requested replay or a
   * resolved dead letter drops out of scope automatically.
   */
  private async candidates(cutoff: string, limit: number): Promise<StallCandidateRow[]> {
    const rows = await this.db.prepare(
      `SELECT r.run_id, r.state, r.version, o.outbox_id, dl.dead_letter_id, o.last_error_code
       FROM outbox_dead_letters dl
       JOIN outbox o ON o.outbox_id = dl.outbox_id
       JOIN runs r ON r.run_id = o.run_id
       WHERE dl.status = 'open'
         AND o.kind = 'agent_execution_start'
         AND r.state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
         AND r.updated_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM dispatch_stall_incidents existing
           WHERE existing.dead_letter_id = dl.dead_letter_id
         )
       ORDER BY dl.captured_at, dl.dead_letter_id
       LIMIT ?`,
    ).bind(cutoff, limit).all<StallCandidateRow>();
    return rows.results;
  }

  /**
   * Cancels one stalled run and records the incident.
   *
   * Cancellation goes through AttemptLifecycleStore so it behaves exactly like an
   * operator cancel: pending Attempts are fenced, tokens revoked and the
   * workflow cancel intent enqueued. Reproducing any of that with direct UPDATEs
   * would let a runner that is mid-teardown write once more.
   *
   * A conflict is recorded rather than retried. `cancelRun` refuses when the run
   * has moved on or an Attempt already reported a result, and in both cases the
   * run is no longer stalled the way we observed it. Writing the incident anyway
   * keeps the scan from re-examining the same dead letter every minute forever,
   * and leaves the conflict visible instead of hiding it.
   */
  private async cancelStalledRun(
    row: StallCandidateRow,
    nowIso: string,
  ): Promise<DispatchStallIncidentView | null> {
    if (!STALLABLE_RUN_STATES.has(row.state)) return null;
    const incidentId = `dispatch-stall-${row.dead_letter_id}`;
    const lastErrorCode = row.last_error_code ?? 'unknown';

    let disposition: DispatchStallDisposition = 'cancelled';
    try {
      await new AttemptLifecycleStore(this.db).cancelRun(row.run_id, row.version, new Date(nowIso));
    } catch (error) {
      if (!(error instanceof AttemptLifecycleError)) throw error;
      disposition = 'cancel_conflicted';
    }

    const inserted = await this.db.prepare(
      `INSERT INTO dispatch_stall_incidents (
         incident_id, run_id, outbox_id, dead_letter_id, last_error_code,
         observed_run_state, run_version, threshold_seconds, disposition,
         detected_at, resolved_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      incidentId,
      row.run_id,
      row.outbox_id,
      row.dead_letter_id,
      lastErrorCode,
      row.state,
      row.version,
      this.thresholdSeconds,
      disposition,
      nowIso,
      nowIso,
    ).run();
    // A concurrent scan already recorded this stall; it owns the emission.
    if (inserted.meta.changes !== 1) return null;

    const view: DispatchStallIncidentView = {
      incidentId,
      runId: row.run_id,
      outboxId: row.outbox_id,
      deadLetterId: row.dead_letter_id,
      lastErrorCode,
      observedRunState: row.state,
      runVersion: row.version,
      thresholdSeconds: this.thresholdSeconds,
      disposition,
      detectedAt: nowIso,
    };
    this.emit(view, nowIso);
    return view;
  }

  private emit(view: DispatchStallIncidentView, observedAt: string): void {
    this.sink({
      schemaVersion: '1',
      event: view.disposition === 'cancelled'
        ? 'dispatch_stall_cancelled'
        : 'dispatch_stall_conflicted',
      incidentId: view.incidentId,
      correlationId: view.runId,
      runId: view.runId,
      outboxId: view.outboxId,
      deadLetterId: view.deadLetterId,
      lastErrorCode: view.lastErrorCode,
      observedRunState: view.observedRunState,
      runVersion: view.runVersion,
      thresholdSeconds: view.thresholdSeconds,
      disposition: view.disposition,
      observedAt,
    });
  }
}
