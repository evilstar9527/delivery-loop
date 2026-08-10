import { canonicalSha256 } from '../domain/digest.js';
import { DEFAULT_MAX_ATTEMPTS, REPEATED_FAILURE_LIMIT } from '../domain/attempt-failure.js';
import {
  PlanRevisionError,
  PlanRevisionStore,
} from '../storage/plan-revision-store.js';

interface PreparedCandidateRow {
  revision_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
}

interface RetryCandidateRow {
  revision_id: string;
  run_id: string;
  failure_id: string;
  failed_attempt_id: string;
  retry_sequence: number;
}

export interface PlanRevisionAnalysisReconcilerOptions {
  now?: () => Date;
}

function stableSuffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 56);
}

/** Re-arms one failed re-analysis without changing the immutable revision snapshot. */
export class PlanRevisionAnalysisReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    options: PlanRevisionAnalysisReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileBatch(limit = 5): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Plan revision analysis reconciliation limit must be between 1 and 100');
    }
    const activated = await this.reconcilePreparedPlans(limit);
    const remaining = limit - activated;
    if (remaining === 0) return activated;
    return activated + await this.reconcileFailedAttempts(remaining);
  }

  /**
   * Activates a server-validated replacement Plan after the Runner completion
   * callback is durable. This does not replay the model or trust Action status.
   */
  async reconcilePreparedPlans(limit = 5): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Prepared Plan revision reconciliation limit must be between 1 and 100');
    }
    const result = await this.db.prepare(
      `SELECT revisions.revision_id, runs.version AS run_version,
              replacement.plan_id, replacement.plan_version,
              replacement.digest AS plan_digest
       FROM plan_revisions AS revisions
       JOIN runs ON runs.run_id = revisions.run_id
       JOIN execution_plans AS prior
         ON prior.plan_id = revisions.prior_plan_id
        AND prior.run_id = revisions.run_id
        AND prior.plan_version = revisions.prior_plan_version
        AND prior.digest = revisions.prior_plan_digest
       JOIN attempts AS analysis
         ON analysis.attempt_id = COALESCE(
           (SELECT retry.retry_attempt_id
            FROM plan_revision_analysis_retries AS retry
            WHERE retry.revision_id = revisions.revision_id
            ORDER BY retry.retry_sequence DESC LIMIT 1),
           revisions.analysis_attempt_id
         )
       JOIN execution_plans AS replacement
         ON replacement.run_id = revisions.run_id
        AND replacement.created_by_attempt_id = analysis.attempt_id
       JOIN workflow_signals AS signal
         ON signal.run_id = revisions.run_id
        AND signal.attempt_id = analysis.attempt_id
        AND signal.event_id = analysis.result_event_id
        AND signal.sequence = analysis.result_sequence
        AND signal.payload_ref = analysis.result_payload_ref
        AND signal.digest = analysis.result_digest
       WHERE revisions.status = 'analyzing'
         AND runs.state = 'planning'
         AND runs.base_sha = revisions.requested_base_sha
         AND runs.active_plan_id = revisions.prior_plan_id
         AND runs.active_plan_version = revisions.prior_plan_version
         AND runs.active_plan_digest = revisions.prior_plan_digest
         AND prior.status = 'active'
         AND analysis.mode = 'analysis' AND analysis.status = 'running'
         AND analysis.base_sha = revisions.requested_base_sha
         AND analysis.result_event_id IS NOT NULL
         AND analysis.result_sequence IS NOT NULL
         AND analysis.result_payload_ref = 'd1://execution-plans/' || replacement.plan_id
         AND analysis.result_digest = replacement.digest
         AND replacement.plan_version = revisions.prior_plan_version + 1
         AND replacement.base_sha = revisions.requested_base_sha
         AND replacement.status = 'validated'
         AND NOT EXISTS (
           SELECT 1 FROM run_blockers
           WHERE run_blockers.run_id = revisions.run_id
             AND run_blockers.resolved_at IS NULL
         )
       ORDER BY analysis.result_reported_at, revisions.revision_id
       LIMIT ?`,
    ).bind(limit).all<PreparedCandidateRow>();
    let activated = 0;
    const store = new PlanRevisionStore(this.db);
    for (const candidate of result.results) {
      try {
        const outcome = await store.activate({
          revisionId: candidate.revision_id,
          expectedRunVersion: candidate.run_version,
          planId: candidate.plan_id,
          planVersion: candidate.plan_version,
          planDigest: candidate.plan_digest,
        }, this.now());
        if (outcome.created) activated += 1;
      } catch (error) {
        // activate() durably rejects a semantically unchanged proposal before
        // surfacing no_change. That is a successful reconciliation outcome,
        // not a reason to abort the rest of the scheduled handler.
        if (!(error instanceof PlanRevisionError) || error.code !== 'no_change') throw error;
      }
    }
    return activated;
  }

  private async reconcileFailedAttempts(limit: number): Promise<number> {
    const candidates = await this.candidates(limit);
    let created = 0;
    for (const candidate of candidates) {
      if (await this.schedule(candidate)) created += 1;
    }
    return created;
  }

  private async candidates(limit: number): Promise<RetryCandidateRow[]> {
    const result = await this.db.prepare(
      `SELECT revisions.revision_id, revisions.run_id,
              failures.failure_id, failed.attempt_id AS failed_attempt_id,
              COALESCE(current_retry.retry_sequence, 0) + 1 AS retry_sequence
       FROM plan_revisions AS revisions
       JOIN runs ON runs.run_id = revisions.run_id
       LEFT JOIN plan_revision_analysis_retries AS current_retry
         ON current_retry.revision_id = revisions.revision_id
        AND NOT EXISTS (
          SELECT 1 FROM plan_revision_analysis_retries AS later
          WHERE later.revision_id = current_retry.revision_id
            AND later.retry_sequence > current_retry.retry_sequence
        )
       JOIN attempts AS failed
         ON failed.attempt_id = COALESCE(
           current_retry.retry_attempt_id, revisions.analysis_attempt_id
         )
       JOIN attempt_failures AS failures
         ON failures.attempt_id = failed.attempt_id
        AND failures.run_id = revisions.run_id
       JOIN execution_plans AS prior
         ON prior.plan_id = revisions.prior_plan_id
        AND prior.run_id = revisions.run_id
        AND prior.plan_version = revisions.prior_plan_version
        AND prior.digest = revisions.prior_plan_digest
       WHERE revisions.status = 'analyzing'
         AND runs.state = 'planning'
         AND runs.base_sha = revisions.requested_base_sha
         AND runs.active_plan_id = revisions.prior_plan_id
         AND runs.active_plan_version = revisions.prior_plan_version
         AND runs.active_plan_digest = revisions.prior_plan_digest
         AND prior.status = 'active'
         AND failed.mode = 'analysis' AND failed.status = 'failed'
         AND failed.base_sha = revisions.requested_base_sha
         AND failures.scope_attempt_count < ?
         AND failures.consecutive_fingerprint_count < ?
         AND NOT EXISTS (
           SELECT 1 FROM run_blockers
           WHERE run_blockers.run_id = revisions.run_id
             AND run_blockers.resolved_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM execution_plans AS proposal
           WHERE proposal.created_by_attempt_id = failed.attempt_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM plan_revision_analysis_retries AS consumed
           WHERE consumed.failure_id = failures.failure_id
              OR consumed.failed_attempt_id = failed.attempt_id
         )
       ORDER BY failures.created_at, revisions.revision_id
       LIMIT ?`,
    ).bind(DEFAULT_MAX_ATTEMPTS, REPEATED_FAILURE_LIMIT, limit).all<RetryCandidateRow>();
    return result.results;
  }

  private async schedule(candidate: RetryCandidateRow): Promise<boolean> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      revisionId: candidate.revision_id,
      failureId: candidate.failure_id,
      failedAttemptId: candidate.failed_attempt_id,
      retrySequence: candidate.retry_sequence,
    });
    const suffix = stableSuffix(identity);
    const retryId = `plan_revision_retry_${suffix}`;
    const attemptId = `attempt_replan_retry_${suffix}`;
    const outboxId = `dispatch_replan_retry_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
         `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT ?, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'analysis', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, 0, 0, ?, ?
         FROM attempts AS failed
         JOIN attempt_failures AS failures
           ON failures.failure_id = ? AND failures.attempt_id = failed.attempt_id
         JOIN plan_revisions AS revisions
           ON revisions.revision_id = ? AND revisions.run_id = failed.run_id
         JOIN runs ON runs.run_id = failed.run_id
         JOIN execution_plans AS prior ON prior.plan_id = revisions.prior_plan_id
         WHERE failed.attempt_id = ? AND failed.mode = 'analysis'
           AND failed.status = 'failed'
           AND revisions.status = 'analyzing'
           AND runs.state = 'planning'
           AND runs.base_sha = revisions.requested_base_sha
           AND runs.active_plan_id = revisions.prior_plan_id
           AND runs.active_plan_version = revisions.prior_plan_version
           AND runs.active_plan_digest = revisions.prior_plan_digest
           AND prior.status = 'active'
           AND failures.scope_attempt_count < ?
           AND failures.consecutive_fingerprint_count < ?
           AND NOT EXISTS (
             SELECT 1 FROM run_blockers
             WHERE run_blockers.run_id = revisions.run_id
               AND run_blockers.resolved_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM execution_plans AS proposal
             WHERE proposal.created_by_attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM plan_revision_analysis_retries AS consumed
             WHERE consumed.failure_id = failures.failure_id
                OR consumed.failed_attempt_id = failed.attempt_id
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        attemptId,
        nowIso,
        nowIso,
        candidate.failure_id,
        candidate.revision_id,
        candidate.failed_attempt_id,
        DEFAULT_MAX_ATTEMPTS,
        REPEATED_FAILURE_LIMIT,
      ),
      this.db.prepare(
        `INSERT INTO plan_revision_analysis_retries (
           retry_id, revision_id, failure_id, failed_attempt_id,
           retry_attempt_id, retry_sequence, created_at
         )
         SELECT ?, revisions.revision_id, failures.failure_id, failed.attempt_id,
                retry.attempt_id, ?, ?
         FROM plan_revisions AS revisions
         JOIN attempt_failures AS failures ON failures.failure_id = ?
         JOIN attempts AS failed ON failed.attempt_id = failures.attempt_id
         JOIN attempts AS retry
           ON retry.attempt_id = ? AND retry.run_id = revisions.run_id
          AND retry.mode = 'analysis' AND retry.status = 'pending'
         WHERE revisions.revision_id = ? AND revisions.status = 'analyzing'
           AND failed.attempt_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        retryId,
        candidate.retry_sequence,
        nowIso,
        candidate.failure_id,
        attemptId,
        candidate.revision_id,
        candidate.failed_attempt_id,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, revisions.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM plan_revision_analysis_retries AS retries
         JOIN plan_revisions AS revisions ON revisions.revision_id = retries.revision_id
         JOIN attempts ON attempts.attempt_id = retries.retry_attempt_id
         JOIN runs ON runs.run_id = revisions.run_id
         WHERE retries.retry_id = ? AND retries.retry_attempt_id = ?
           AND revisions.status = 'analyzing'
           AND runs.state = 'planning' AND attempts.status = 'pending'
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${attemptId}`,
        `analysis-replan-retry:${candidate.failure_id}`,
        nowIso,
        nowIso,
        retryId,
        attemptId,
      ),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1 &&
      results[2]?.meta.changes === 1;
  }
}
