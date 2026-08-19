type AttemptLifecycleErrorCode = 'not_found' | 'state_conflict' | 'result_already_reported';

const CANCELLABLE_RUN_STATES = new Set([
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
  'blocked',
  'failed',
]);

export class AttemptLifecycleError extends Error {
  constructor(readonly code: AttemptLifecycleErrorCode) {
    super(`Attempt lifecycle operation failed: ${code}`);
    this.name = 'AttemptLifecycleError';
  }
}

interface RunLifecycleRow {
  run_id: string;
  state: string;
  version: number;
}

interface ExpiredAttemptRow {
  attempt_id: string;
  run_id: string;
  status: 'starting' | 'running';
  version: number;
  lease_generation: number;
  lease_expires_at: string;
  run_state: string;
  run_version: number;
}

export interface CancelRunResult {
  runId: string;
  state: 'cancelled';
  version: number;
  revokedAttempts: number;
  workflowCancelOutboxId: string;
}

export interface StuckDetectionResult {
  attemptId: string;
  runId: string;
  disposition: 'lost';
}

function workflowCancelOutboxId(runId: string): string {
  return `workflow-cancel-${runId}`;
}

// Fixed internal SQL only. A completed/success execution with a trusted head,
// completed suite, and passed commit/test facts belongs to the completion
// projector, even when its Runner heartbeat has already crossed the watchdog
// threshold. This guard is repeated at candidate selection and mutation CAS so
// a webhook/API projection racing between them cannot still be fenced.
const SUCCESSFUL_EXECUTION_AWAITS_COMPLETION_SQL = `NOT (
  attempts.mode IN ('implement', 'review_fix')
  AND attempts.github_status = 'completed'
  AND attempts.github_conclusion = 'success'
  AND attempts.head_sha IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM verification_suites AS suites
    WHERE suites.attempt_id = attempts.attempt_id
      AND suites.head_sha = attempts.head_sha
      AND suites.status = 'completed'
  )
  AND EXISTS (
    SELECT 1 FROM evidence
    WHERE evidence.attempt_id = attempts.attempt_id
      AND evidence.sha = attempts.head_sha
      AND evidence.kind = 'commit'
      AND evidence.status = 'passed'
      AND evidence.verification_status IN ('unverified', 'verified')
  )
  AND EXISTS (
    SELECT 1 FROM evidence
    WHERE evidence.attempt_id = attempts.attempt_id
      AND evidence.sha = attempts.head_sha
      AND evidence.kind = 'test'
      AND evidence.status = 'passed'
      AND evidence.verification_status IN ('unverified', 'verified')
  )
)`;

// The credential-free publisher runs as a separate execution under the same
// implement/review_fix Attempt, after the work lane stopped heartbeating. Its
// setup:install + verify legitimately runs for several minutes with no Attempt
// heartbeat, so the running-threshold watchdog would otherwise fence a live
// publisher as lost and tear its container down mid-verification. Do not fence
// an Attempt while it still has a publisher execution that is starting or
// running; if that execution actually dies, the executor reconciler marks it
// failed/lost, which clears this guard and lets the watchdog fence normally.
const NO_ACTIVE_PUBLISHER_EXECUTION_SQL = `NOT EXISTS (
  SELECT 1 FROM attempt_execution_instances AS publisher_execution
  WHERE publisher_execution.attempt_id = attempts.attempt_id
    AND publisher_execution.execution_role = 'publisher'
    AND publisher_execution.status IN ('pending', 'starting', 'running')
)`;

export class AttemptLifecycleStore {
  constructor(private readonly db: D1Database) {}

  async cancelRun(
    runId: string,
    expectedRunVersion: number,
    now = new Date(),
  ): Promise<CancelRunResult> {
    const before = await this.db
      .prepare('SELECT run_id, state, version FROM runs WHERE run_id = ?')
      .bind(runId)
      .first<RunLifecycleRow>();
    if (before === null) throw new AttemptLifecycleError('not_found');
    const outboxId = workflowCancelOutboxId(runId);
    if (before.state === 'cancelled' && before.version === expectedRunVersion + 1) {
      return await this.cancelledProjection(runId, before.version, outboxId);
    }
    if (
      before.version !== expectedRunVersion ||
      !CANCELLABLE_RUN_STATES.has(before.state)
    ) {
      throw new AttemptLifecycleError('state_conflict');
    }
    const reported = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE run_id = ? AND result_event_id IS NOT NULL
           AND status IN ('pending', 'starting', 'running', 'cancel_requested')`,
      )
      .bind(runId)
      .first<{ count: number }>();
    if ((reported?.count ?? 0) > 0) {
      throw new AttemptLifecycleError('result_already_reported');
    }

    const nowIso = now.toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE runs
           SET state = 'cancelled', version = version + 1, updated_at = ?
           WHERE run_id = ? AND version = ?
             AND state IN (
               'received', 'triaging', 'awaiting_approval', 'queued', 'planning',
               'executing', 'verifying', 'pull_request_open', 'awaiting_review',
               'ready_to_merge', 'blocked', 'failed'
             )
             AND NOT EXISTS (
               SELECT 1 FROM attempts
               WHERE run_id = runs.run_id AND result_event_id IS NOT NULL
                 AND status IN ('pending', 'starting', 'running', 'cancel_requested')
             )`,
        )
        .bind(nowIso, runId, expectedRunVersion),
      this.db
        .prepare(
          `UPDATE attempts
           SET status = 'cancelled', version = version + 1,
               lease_generation = lease_generation + 1,
               lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE run_id = ?
             AND status IN ('pending', 'starting', 'running', 'cancel_requested')
             AND result_event_id IS NULL
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE run_id = ? AND state = 'cancelled' AND version = ?
             )`,
        )
        .bind(nowIso, runId, runId, expectedRunVersion + 1),
      this.db
        .prepare(
          `UPDATE attempt_tokens
           SET revoked_at = ?
           WHERE revoked_at IS NULL
             AND attempt_id IN (
               SELECT attempt_id FROM attempts
               WHERE run_id = ? AND status = 'cancelled' AND updated_at = ?
             )
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE run_id = ? AND state = 'cancelled' AND version = ?
             )`,
        )
        .bind(nowIso, runId, nowIso, runId, expectedRunVersion + 1),
      this.db
        .prepare(
          `INSERT INTO attempt_revocations (
             revocation_id, run_id, attempt_id, reason, revoked_lease_generation,
             attempt_version, occurred_at, created_at
           )
           SELECT 'revoke_cancel_' || attempt_id || '_' || (lease_generation - 1),
                  run_id, attempt_id, 'cancelled', lease_generation - 1,
                  version, ?, ?
           FROM attempts
           WHERE run_id = ? AND status = 'cancelled' AND updated_at = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(nowIso, nowIso, runId, nowIso),
      this.db
        .prepare(
          `UPDATE outbox
           SET delivery_state = 'settled', lease_token = NULL, lease_expires_at = NULL,
               last_error_code = 'run_cancelled', updated_at = ?
           WHERE run_id = ?
             AND kind IN ('workflow_create', 'analysis_dispatch', 'execution_dispatch')
             AND delivery_state IN ('pending', 'delivering')
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE run_id = ? AND state = 'cancelled' AND version = ?
             )`,
        )
        .bind(nowIso, runId, runId, expectedRunVersion + 1),
      this.db
        .prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, ?, 'workflow_cancel', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM runs
             WHERE run_id = ? AND state = 'cancelled' AND version = ?
           )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          outboxId,
          runId,
          `d1://runs/${runId}`,
          `workflow-cancel:${runId}`,
          nowIso,
          nowIso,
          runId,
          expectedRunVersion + 1,
        ),
    ]);
    const after = await this.db
      .prepare('SELECT state, version FROM runs WHERE run_id = ?')
      .bind(runId)
      .first<{ state: string; version: number }>();
    if (after?.state !== 'cancelled' || after.version !== expectedRunVersion + 1) {
      throw new AttemptLifecycleError('state_conflict');
    }
    return await this.cancelledProjection(runId, after.version, outboxId);
  }

  private async cancelledProjection(
    runId: string,
    version: number,
    outboxId: string,
  ): Promise<CancelRunResult> {
    const revocations = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempt_revocations
         WHERE run_id = ? AND reason = 'cancelled'`,
      )
      .bind(runId)
      .first<{ count: number }>();
    const outbox = await this.db
      .prepare('SELECT outbox_id FROM outbox WHERE outbox_id = ? AND run_id = ?')
      .bind(outboxId, runId)
      .first<{ outbox_id: string }>();
    if (outbox === null) throw new AttemptLifecycleError('state_conflict');
    return {
      runId,
      state: 'cancelled',
      version,
      revokedAttempts: revocations?.count ?? 0,
      workflowCancelOutboxId: outbox.outbox_id,
    };
  }
}

export interface AttemptStuckDetectorOptions {
  now?: () => Date;
  runningThresholdSeconds?: number;
}

export class AttemptStuckDetector {
  private readonly now: () => Date;
  private readonly runningThresholdSeconds: number;

  constructor(
    private readonly db: D1Database,
    options: AttemptStuckDetectorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.runningThresholdSeconds = options.runningThresholdSeconds ?? 90;
    if (
      !Number.isSafeInteger(this.runningThresholdSeconds) ||
      this.runningThresholdSeconds < 60 ||
      this.runningThresholdSeconds > 604800
    ) throw new Error('Running stuck threshold must be between 60 and 604800 seconds');
  }

  async scan(limit = 25): Promise<StuckDetectionResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Attempt stuck scan limit must be between 1 and 100');
    }
    const now = this.now();
    const nowIso = now.toISOString();
    const heartbeatCutoff = new Date(
      now.getTime() - this.runningThresholdSeconds * 1_000,
    ).toISOString();
    const candidates = await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.status,
                attempts.version, attempts.lease_generation, attempts.lease_expires_at,
                runs.state AS run_state, runs.version AS run_version
         FROM attempts JOIN runs ON runs.run_id = attempts.run_id
         WHERE attempts.status IN ('starting', 'running')
           AND attempts.result_event_id IS NULL
           AND attempts.lease_expires_at IS NOT NULL
           AND ${SUCCESSFUL_EXECUTION_AWAITS_COMPLETION_SQL}
           AND ${NO_ACTIVE_PUBLISHER_EXECUTION_SQL}
           AND runs.state IN (
             'triaging', 'awaiting_approval', 'planning', 'executing',
             'verifying', 'awaiting_review', 'deploying'
           )
           AND (
             attempts.lease_expires_at <= ?
             OR COALESCE(attempts.heartbeat_at, attempts.updated_at) <= ?
           )
         ORDER BY COALESCE(attempts.heartbeat_at, attempts.updated_at), attempts.attempt_id
         LIMIT ?`,
      )
      .bind(nowIso, heartbeatCutoff, limit)
      .all<ExpiredAttemptRow>();
    const results: StuckDetectionResult[] = [];
    for (const candidate of candidates.results) {
      if (await this.markLost(candidate, nowIso, heartbeatCutoff)) {
        results.push({
          attemptId: candidate.attempt_id,
          runId: candidate.run_id,
          disposition: 'lost',
        });
      }
    }
    return results;
  }

  private async markLost(
    candidate: ExpiredAttemptRow,
    nowIso: string,
    heartbeatCutoff: string,
  ): Promise<boolean> {
    const outboxId = workflowCancelOutboxId(candidate.run_id);
    const incidentId =
      `run-stuck-running-${candidate.attempt_id}-${candidate.lease_generation}`;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO run_stuck_incidents (
             incident_id, run_id, state_kind, observed_run_state, run_version,
             attempt_id, threshold_seconds, action, status, detected_at,
             recovery_requested_at
           )
           SELECT ?, attempts.run_id, 'running', runs.state, runs.version,
                  attempts.attempt_id, ?, 'fence_lost_attempt', 'open', ?, ?
           FROM attempts JOIN runs ON runs.run_id = attempts.run_id
           WHERE attempts.attempt_id = ? AND attempts.run_id = ?
             AND attempts.status = ? AND attempts.version = ?
             AND attempts.lease_generation = ? AND attempts.result_event_id IS NULL
             AND attempts.lease_expires_at IS NOT NULL
             AND ${SUCCESSFUL_EXECUTION_AWAITS_COMPLETION_SQL}
             AND ${NO_ACTIVE_PUBLISHER_EXECUTION_SQL}
             AND runs.state = ? AND runs.version = ?
             AND (
               attempts.lease_expires_at <= ?
               OR COALESCE(attempts.heartbeat_at, attempts.updated_at) <= ?
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          incidentId,
          this.runningThresholdSeconds,
          nowIso,
          nowIso,
          candidate.attempt_id,
          candidate.run_id,
          candidate.status,
          candidate.version,
          candidate.lease_generation,
          candidate.run_state,
          candidate.run_version,
          nowIso,
          heartbeatCutoff,
        ),
      this.db
        .prepare(
          `UPDATE attempts
           SET status = 'lost', version = version + 1,
               lease_generation = lease_generation + 1,
               lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE attempt_id = ? AND run_id = ? AND status = ? AND version = ?
             AND lease_generation = ? AND lease_expires_at IS NOT NULL
             AND ${SUCCESSFUL_EXECUTION_AWAITS_COMPLETION_SQL}
             AND ${NO_ACTIVE_PUBLISHER_EXECUTION_SQL}
             AND (
               lease_expires_at <= ? OR COALESCE(heartbeat_at, updated_at) <= ?
             )
             AND result_event_id IS NULL
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE run_id = ? AND state = ? AND version = ?
             )`,
        )
        .bind(
          nowIso,
          candidate.attempt_id,
          candidate.run_id,
          candidate.status,
          candidate.version,
          candidate.lease_generation,
          nowIso,
          heartbeatCutoff,
          candidate.run_id,
          candidate.run_state,
          candidate.run_version,
        ),
      this.db
        .prepare(
          `UPDATE attempt_tokens
           SET revoked_at = ?
           WHERE attempt_id = ? AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = ? AND status = 'lost' AND version = ?
                 AND lease_generation = ? AND updated_at = ?
             )`,
        )
        .bind(
          nowIso,
          candidate.attempt_id,
          candidate.attempt_id,
          candidate.version + 1,
          candidate.lease_generation + 1,
          nowIso,
        ),
      this.db
        .prepare(
          `INSERT INTO attempt_revocations (
             revocation_id, run_id, attempt_id, reason, revoked_lease_generation,
             attempt_version, occurred_at, created_at
           )
           SELECT 'revoke_timeout_' || attempt_id || '_' || ?, run_id, attempt_id,
                  'heartbeat_timeout', ?, version, ?, ?
           FROM attempts
           WHERE attempt_id = ? AND status = 'lost' AND version = ?
             AND lease_generation = ? AND updated_at = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          candidate.lease_generation,
          candidate.lease_generation,
          nowIso,
          nowIso,
          candidate.attempt_id,
          candidate.version + 1,
          candidate.lease_generation + 1,
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE runs
           SET state = 'blocked', version = version + 1, updated_at = ?
           WHERE run_id = ?
             AND state = ? AND version = ?
             AND EXISTS (
               SELECT 1 FROM attempt_revocations
               WHERE attempt_id = ? AND reason = 'heartbeat_timeout'
                 AND revoked_lease_generation = ?
             )`,
        )
        .bind(
          nowIso,
          candidate.run_id,
          candidate.run_state,
          candidate.run_version,
          candidate.attempt_id,
          candidate.lease_generation,
        ),
      this.db
        .prepare(
          `UPDATE outbox
           SET delivery_state = 'settled', lease_token = NULL, lease_expires_at = NULL,
               last_error_code = 'attempt_lost', updated_at = ?
           WHERE run_id = ? AND kind IN ('analysis_dispatch', 'execution_dispatch')
             AND delivery_state IN ('pending', 'delivering')
             AND EXISTS (
               SELECT 1 FROM attempt_revocations
               WHERE attempt_id = ? AND reason = 'heartbeat_timeout'
                 AND revoked_lease_generation = ?
             )`,
        )
        .bind(nowIso, candidate.run_id, candidate.attempt_id, candidate.lease_generation),
      this.db
        .prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, ?, 'workflow_cancel', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM attempt_revocations
             WHERE attempt_id = ? AND reason = 'heartbeat_timeout'
               AND revoked_lease_generation = ?
           )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          outboxId,
          candidate.run_id,
          `d1://runs/${candidate.run_id}`,
          `workflow-cancel:${candidate.run_id}`,
          nowIso,
          nowIso,
          candidate.attempt_id,
          candidate.lease_generation,
        ),
    ]);
    return results[1]?.meta.changes === 1;
  }
}
