import { canonicalSha256 } from '../domain/digest.js';
import type { ExecutorPluginRegistry } from '../executor/core/executor-registry.js';
import type { ExecutionHandle, ExecutorCancelReason } from
  '../executor/core/executor-plugin.js';
import {
  ExecutorObservationError,
  ExecutorObservationService,
  type ExecutorObservationResult,
} from '../storage/executor-observation-store.js';

interface ActiveExecutionRow {
  execution_id: string;
  attempt_id: string;
  lease_generation: number;
  validated_handle_json: string;
}

interface CancellationCandidateRow extends ActiveExecutionRow {
  attempt_status: string;
  current_lease_generation: number;
  run_state: string;
}

interface PendingCancellationRow extends ActiveExecutionRow {
  cancellation_id: string;
  reason: ExecutorCancelReason;
}

export interface ExecutorReconciliationResult {
  executionId: string;
  operation: 'observe' | 'cancel';
  disposition: 'applied' | 'duplicate' | 'ignored' | 'retry' | 'settled' | 'busy';
}

export interface ExecutorReconcilerOptions {
  now?: () => Date;
  retryBaseMs?: number;
}

function parseHandle(raw: string): ExecutionHandle {
  try {
    return JSON.parse(raw) as ExecutionHandle;
  } catch {
    throw new Error('executor handle is invalid');
  }
}

function cancellationReason(row: CancellationCandidateRow): ExecutorCancelReason {
  if (row.run_state === 'cancelled') return 'run_cancelled';
  if (row.attempt_status === 'lost') return 'lease_expired';
  if (row.current_lease_generation !== row.lease_generation) return 'superseded';
  return 'policy_revoked';
}

/** Provider-neutral GET reconciliation plus idempotent cancellation intent delivery. */
export class ExecutorReconciler {
  private readonly now: () => Date;
  private readonly retryBaseMs: number;
  private readonly observer: ExecutorObservationService;

  constructor(
    private readonly db: D1Database,
    private readonly registry: ExecutorPluginRegistry,
    options: ExecutorReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.retryBaseMs) || this.retryBaseMs <= 0 ||
      this.retryBaseMs > 60_000
    ) throw new Error('executor reconciliation retry interval is invalid');
    this.observer = new ExecutorObservationService(db, registry, { now: this.now });
  }

  async reconcileObservations(limit = 25): Promise<ExecutorReconciliationResult[]> {
    this.assertLimit(limit);
    const now = this.now();
    const rows = await this.db.prepare(
      `SELECT execution.execution_id, execution.attempt_id, execution.lease_generation,
              execution.validated_handle_json
       FROM attempt_execution_instances AS execution
       LEFT JOIN executor_reconciliation_failures AS failure
         ON failure.execution_id = execution.execution_id AND failure.operation = 'observe'
       WHERE execution.status IN ('starting', 'running')
         AND execution.validated_handle_json IS NOT NULL
         AND (failure.next_retry_at IS NULL OR failure.next_retry_at <= ?)
       ORDER BY COALESCE(execution.external_updated_at, execution.started_at),
                execution.execution_id
       LIMIT ?`,
    ).bind(now.toISOString(), limit).all<ActiveExecutionRow>();
    const results: ExecutorReconciliationResult[] = [];
    for (const row of rows.results) {
      try {
        const observed = await this.observer.observe(row.execution_id);
        await this.clearFailure(row.execution_id, 'observe');
        results.push(this.observationResult(observed));
      } catch (error) {
        await this.recordFailure(
          row.execution_id,
          'observe',
          error instanceof ExecutorObservationError ? 'projection_conflict' : 'provider_unavailable',
          now,
        );
        results.push({ executionId: row.execution_id, operation: 'observe', disposition: 'retry' });
      }
    }
    return results;
  }

  async reconcileCancellations(limit = 25): Promise<ExecutorReconciliationResult[]> {
    this.assertLimit(limit);
    const now = this.now();
    const candidates = await this.db.prepare(
      `SELECT execution.execution_id, execution.attempt_id, execution.lease_generation,
              execution.validated_handle_json, attempts.status AS attempt_status,
              attempts.lease_generation AS current_lease_generation, runs.state AS run_state
       FROM attempt_execution_instances AS execution
       JOIN attempts ON attempts.attempt_id = execution.attempt_id
       JOIN runs ON runs.run_id = attempts.run_id
       WHERE execution.status IN ('starting', 'running')
         AND execution.validated_handle_json IS NOT NULL
         AND (
           attempts.status IN ('lost', 'failed', 'cancelled') OR
           runs.state IN ('failed', 'cancelled') OR
           attempts.lease_generation <> execution.lease_generation
         )
       ORDER BY execution.updated_at, execution.execution_id LIMIT ?`,
    ).bind(limit).all<CancellationCandidateRow>();
    for (const row of candidates.results) {
      const reason = cancellationReason(row);
      const digest = await canonicalSha256({
        executionId: row.execution_id,
        attemptId: row.attempt_id,
        leaseGeneration: row.lease_generation,
        reason,
      });
      await this.db.prepare(
        `INSERT INTO executor_cancellations (
           cancellation_id, execution_id, attempt_id, lease_generation, reason,
           delivery_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        `executor_cancel_${digest.slice('sha256:'.length)}`,
        row.execution_id,
        row.attempt_id,
        row.lease_generation,
        reason,
        now.toISOString(),
        now.toISOString(),
      ).run();
    }
    const pending = await this.db.prepare(
      `SELECT cancellation.cancellation_id, cancellation.execution_id,
              cancellation.attempt_id, cancellation.lease_generation,
              cancellation.reason, execution.validated_handle_json
       FROM executor_cancellations AS cancellation
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = cancellation.execution_id
       LEFT JOIN executor_reconciliation_failures AS failure
         ON failure.execution_id = cancellation.execution_id AND failure.operation = 'cancel'
       WHERE cancellation.delivery_state = 'pending'
         AND (failure.next_retry_at IS NULL OR failure.next_retry_at <= ?)
       ORDER BY cancellation.created_at, cancellation.cancellation_id LIMIT ?`,
    ).bind(now.toISOString(), limit).all<PendingCancellationRow>();
    const results: ExecutorReconciliationResult[] = [];
    for (const row of pending.results) {
      const claimed = await this.db.prepare(
        `UPDATE executor_cancellations SET delivery_state = 'delivering', updated_at = ?
         WHERE cancellation_id = ? AND delivery_state = 'pending'`,
      ).bind(now.toISOString(), row.cancellation_id).run();
      if (claimed.meta.changes !== 1) {
        results.push({ executionId: row.execution_id, operation: 'cancel', disposition: 'busy' });
        continue;
      }
      try {
        const outcome = await this.registry.cancel(parseHandle(row.validated_handle_json), row.reason);
        const terminalStatus = outcome === 'cancelled' ? 'cancelled' : 'lost';
        await this.db.batch([
          this.db.prepare(
            `UPDATE executor_cancellations
             SET delivery_state = 'settled', outcome = ?, settled_at = ?, updated_at = ?
             WHERE cancellation_id = ? AND delivery_state = 'delivering'`,
          ).bind(outcome, now.toISOString(), now.toISOString(), row.cancellation_id),
          this.db.prepare(
            `UPDATE attempt_execution_instances
             SET status = ?, terminal_at = COALESCE(terminal_at, ?), updated_at = ?
             WHERE execution_id = ? AND status IN ('starting', 'running')`,
          ).bind(terminalStatus, now.toISOString(), now.toISOString(), row.execution_id),
          this.db.prepare(
            `DELETE FROM executor_reconciliation_failures
             WHERE execution_id = ? AND operation = 'cancel'`,
          ).bind(row.execution_id),
        ]);
        results.push({ executionId: row.execution_id, operation: 'cancel', disposition: 'settled' });
      } catch {
        await this.db.prepare(
          `UPDATE executor_cancellations SET delivery_state = 'pending', updated_at = ?
           WHERE cancellation_id = ? AND delivery_state = 'delivering'`,
        ).bind(now.toISOString(), row.cancellation_id).run();
        await this.recordFailure(row.execution_id, 'cancel', 'provider_unavailable', now);
        results.push({ executionId: row.execution_id, operation: 'cancel', disposition: 'retry' });
      }
    }
    return results;
  }

  private async recordFailure(
    executionId: string,
    operation: 'observe' | 'cancel',
    errorCode: 'provider_unavailable' | 'projection_conflict',
    now: Date,
  ): Promise<void> {
    const existing = await this.db.prepare(
      `SELECT consecutive_failures FROM executor_reconciliation_failures
       WHERE execution_id = ? AND operation = ?`,
    ).bind(executionId, operation).first<{ consecutive_failures: number }>();
    const count = (existing?.consecutive_failures ?? 0) + 1;
    const delay = Math.min(this.retryBaseMs * 2 ** Math.min(count - 1, 6), 5 * 60_000);
    await this.db.prepare(
      `INSERT INTO executor_reconciliation_failures (
         execution_id, operation, consecutive_failures, first_failed_at,
         last_failed_at, next_retry_at, last_error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(execution_id, operation) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         last_failed_at = excluded.last_failed_at,
         next_retry_at = excluded.next_retry_at,
         last_error_code = excluded.last_error_code`,
    ).bind(
      executionId, operation, count, now.toISOString(), now.toISOString(),
      new Date(now.getTime() + delay).toISOString(), errorCode,
    ).run();
  }

  private async clearFailure(executionId: string, operation: 'observe' | 'cancel'): Promise<void> {
    await this.db.prepare(
      `DELETE FROM executor_reconciliation_failures WHERE execution_id = ? AND operation = ?`,
    ).bind(executionId, operation).run();
  }

  private observationResult(result: ExecutorObservationResult): ExecutorReconciliationResult {
    return {
      executionId: result.executionId,
      operation: 'observe',
      disposition: result.disposition,
    };
  }

  private assertLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('executor reconciliation limit is invalid');
    }
  }
}
