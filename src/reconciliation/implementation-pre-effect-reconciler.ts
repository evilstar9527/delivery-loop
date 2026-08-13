import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface ImplementationPreEffectRecoveryResult {
  recoveryApprovalId: string;
  replacementAttemptId: string;
  created: boolean;
}

/** Creates one fresh implementation Attempt after an exact pre-effect approval. */
export class ImplementationPreEffectRecoveryReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recover(recoveryApprovalId: string): Promise<ImplementationPreEffectRecoveryResult> {
    if (!ID_PATTERN.test(recoveryApprovalId)) {
      throw new Error('Implementation pre-effect recovery request is invalid');
    }
    const identity = await canonicalSha256({
      source: 'implementation_pre_effect_recovery',
      recoveryApprovalId,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 48);
    const replacementAttemptId = `attempt_implementation_recovery_${suffix}`;
    const recoveryId = `implementation_recovery_${suffix}`;
    const outboxId = `dispatch_implementation_recovery_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, recovered_from_attempt_id,
           version, lease_generation, created_at, updated_at
         )
         SELECT ?, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'implement', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, failed.plan_id, failed.plan_version,
                failed.plan_item_id, progress.version, failed.attempt_id,
                0, 0, ?, ?
         FROM implementation_pre_effect_recovery_approvals AS recovery
         JOIN attempts AS failed ON failed.attempt_id = recovery.failed_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id AND runs.run_id = failed.run_id
         JOIN execution_plans AS plans
           ON plans.plan_id = recovery.plan_id AND plans.plan_id = failed.plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = recovery.plan_id
          AND progress.item_id = recovery.plan_item_id
         JOIN trusted_effect_approvals AS approval
           ON approval.approval_id = recovery.approval_id
          AND approval.run_id = recovery.run_id
          AND approval.plan_id = recovery.plan_id
          AND approval.plan_version = recovery.plan_version
          AND approval.plan_digest = plans.digest
          AND approval.base_sha = runs.base_sha
          AND approval.effect = 'repo_write'
          AND approval.decision = 'approve'
          AND approval.expires_at > ?
         WHERE recovery.recovery_approval_id = ?
           AND recovery.plan_version = failed.plan_version
           AND runs.state = 'awaiting_approval'
           AND runs.active_plan_id = recovery.plan_id
           AND runs.active_plan_version = recovery.plan_version
           AND runs.active_plan_digest = plans.digest
           AND plans.status = 'active' AND plans.base_sha = runs.base_sha
           AND progress.status = 'ready' AND progress.active_attempt_id IS NULL
           AND progress.protected_path_gate_id IS NULL
           AND failed.mode = 'implement' AND failed.status = 'lost'
           AND failed.plan_item_id = recovery.plan_item_id
           AND failed.result_event_id IS NULL
           AND failed.github_status = 'completed'
           AND failed.github_conclusion IS NOT NULL
           AND failed.github_conclusion <> 'success'
           AND failed.head_branch IS NULL AND failed.head_sha IS NULL
           AND EXISTS (
             SELECT 1 FROM run_stuck_incidents AS incident
             WHERE incident.run_id = recovery.run_id
               AND incident.attempt_id = failed.attempt_id
               AND incident.state_kind = 'running'
               AND incident.observed_run_state = 'executing'
               AND incident.action = 'fence_lost_attempt'
               AND incident.status = 'resolved'
               AND incident.resolution_code = 'attempt_fenced'
           )
           AND EXISTS (
             SELECT 1 FROM outbox AS cancel
             WHERE cancel.run_id = recovery.run_id
               AND cancel.kind = 'workflow_cancel'
               AND cancel.delivery_state = 'settled'
           )
           AND NOT EXISTS (
             SELECT 1 FROM run_blockers
             WHERE run_blockers.run_id = recovery.run_id
               AND run_blockers.resolved_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM invalidated_approvals
             WHERE invalidated_approvals.approval_id = approval.approval_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM github_write_credentials
             WHERE github_write_credentials.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM attempt_failures WHERE attempt_failures.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM attempt_head_updates WHERE attempt_head_updates.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM verification_suites WHERE verification_suites.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM evidence WHERE evidence.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM checkpoints WHERE checkpoints.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM attempts AS replacement
             WHERE replacement.recovered_from_attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM implementation_pre_effect_recoveries
             WHERE implementation_pre_effect_recoveries.recovery_approval_id =
                   recovery.recovery_approval_id
           )
         ON CONFLICT DO NOTHING`,
      ).bind(replacementAttemptId, nowIso, nowIso, nowIso, recoveryApprovalId),
      this.db.prepare(
        `INSERT INTO implementation_pre_effect_recoveries (
           recovery_id, recovery_approval_id, run_id, plan_id, plan_version,
           plan_item_id, failed_attempt_id, approval_id,
           replacement_attempt_id, created_at
         )
         SELECT ?, recovery.recovery_approval_id, recovery.run_id, recovery.plan_id,
                recovery.plan_version, recovery.plan_item_id,
                recovery.failed_attempt_id, recovery.approval_id,
                replacement.attempt_id, ?
         FROM implementation_pre_effect_recovery_approvals AS recovery
         JOIN attempts AS replacement
           ON replacement.attempt_id = ?
          AND replacement.run_id = recovery.run_id
          AND replacement.plan_id = recovery.plan_id
          AND replacement.plan_version = recovery.plan_version
          AND replacement.plan_item_id = recovery.plan_item_id
          AND replacement.recovered_from_attempt_id = recovery.failed_attempt_id
          AND replacement.mode = 'implement' AND replacement.status = 'pending'
         WHERE recovery.recovery_approval_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(recoveryId, nowIso, replacementAttemptId, recoveryApprovalId),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'in_progress', active_attempt_id = ?,
             version = version + 1, updated_at = ?
         WHERE status = 'ready' AND active_attempt_id IS NULL
           AND EXISTS (
             SELECT 1 FROM implementation_pre_effect_recoveries
             WHERE recovery_id = ?
               AND plan_id = plan_item_progress.plan_id
               AND plan_item_id = plan_item_progress.item_id
               AND replacement_attempt_id = ?
           )`,
      ).bind(replacementAttemptId, nowIso, recoveryId, replacementAttemptId),
      this.db.prepare(
        `UPDATE runs SET state = 'executing', version = version + 1, updated_at = ?
         WHERE state = 'awaiting_approval'
           AND EXISTS (
             SELECT 1 FROM implementation_pre_effect_recoveries AS recovery
             JOIN plan_item_progress AS progress
               ON progress.plan_id = recovery.plan_id
              AND progress.item_id = recovery.plan_item_id
             WHERE recovery.recovery_id = ?
               AND recovery.run_id = runs.run_id
               AND recovery.replacement_attempt_id = ?
               AND progress.status = 'in_progress'
               AND progress.active_attempt_id = ?
           )`,
      ).bind(nowIso, recoveryId, replacementAttemptId, replacementAttemptId),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, recovery.run_id, 'execution_dispatch', 'github_actions',
                ?, ?, 'pending', ?, ?
         FROM implementation_pre_effect_recoveries AS recovery
         JOIN runs ON runs.run_id = recovery.run_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = recovery.plan_id
          AND progress.item_id = recovery.plan_item_id
         WHERE recovery.recovery_id = ?
           AND recovery.replacement_attempt_id = ?
           AND runs.state = 'executing'
           AND progress.status = 'in_progress'
           AND progress.active_attempt_id = recovery.replacement_attempt_id
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${replacementAttemptId}`,
        `execution-implementation-recovery:${recoveryApprovalId}`,
        nowIso,
        nowIso,
        recoveryId,
        replacementAttemptId,
      ),
    ]);
    const persisted = await this.db.prepare(
      `SELECT replacement_attempt_id FROM implementation_pre_effect_recoveries
       WHERE recovery_approval_id = ?`,
    ).bind(recoveryApprovalId).first<{ replacement_attempt_id: string }>();
    if (persisted === null || persisted.replacement_attempt_id !== replacementAttemptId) {
      throw new Error('Implementation pre-effect recovery is unavailable');
    }
    return {
      recoveryApprovalId,
      replacementAttemptId,
      created: results[1]?.meta.changes === 1,
    };
  }

  async reconcileBatch(limit = 5): Promise<ImplementationPreEffectRecoveryResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 25) {
      throw new Error('Implementation pre-effect recovery limit is invalid');
    }
    const rows = await this.db.prepare(
      `SELECT recovery.recovery_approval_id
       FROM implementation_pre_effect_recovery_approvals AS recovery
       JOIN runs ON runs.run_id = recovery.run_id
       WHERE runs.state = 'awaiting_approval'
         AND NOT EXISTS (
           SELECT 1 FROM implementation_pre_effect_recoveries
           WHERE implementation_pre_effect_recoveries.recovery_approval_id =
                 recovery.recovery_approval_id
         )
       ORDER BY recovery.created_at, recovery.recovery_approval_id LIMIT ?`,
    ).bind(limit).all<{ recovery_approval_id: string }>();
    const results: ImplementationPreEffectRecoveryResult[] = [];
    for (const row of rows.results) {
      try {
        results.push(await this.recover(row.recovery_approval_id));
      } catch {
        // The approval may have expired or a concurrent reconciler may have won.
      }
    }
    return results;
  }
}
