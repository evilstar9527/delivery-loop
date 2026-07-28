import { canonicalSha256 } from '../domain/digest.js';
import { AgentCheckpointStore } from './agent-checkpoint-store.js';

export type RecoveryAttemptErrorCode =
  | 'not_found'
  | 'state_conflict'
  | 'item_completed'
  | 'dependency_incomplete'
  | 'workflow_cancel_pending'
  | 'checkpoint_unavailable';

export class RecoveryAttemptError extends Error {
  constructor(readonly code: RecoveryAttemptErrorCode) {
    super(`Recovery Attempt operation failed: ${code}`);
    this.name = 'RecoveryAttemptError';
  }
}

export interface ScheduleRecoveryAttemptInput {
  runId: string;
  expectedRunVersion: number;
  planVersion: number;
  planItemId: string;
}

export interface RecoveryAttemptResult {
  attemptId: string;
  runId: string;
  ordinal: number;
  planVersion: number;
  planItemId: string;
  recoveredFromAttemptId: string;
  checkpointId: string;
  checkpointRef: string;
  checkpointDigest: string;
  headBranch?: string;
  headSha: string;
  created: boolean;
}

interface ItemStateRow {
  run_id: string;
  run_state: string;
  run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_id: string;
  item_id: string;
  progress_status: string;
  progress_version: number;
  active_attempt_id: string | null;
}

interface RecoveryCandidateRow extends ItemStateRow {
  old_attempt_id: string;
  old_ordinal: number;
  old_mode: string;
  old_status: string;
  old_base_sha: string;
  old_repository: string | null;
  old_workflow_ref: string | null;
  checkpoint_id: string;
  checkpoint_ref: string;
  checkpoint_digest: string;
  checkpoint_head_sha: string;
  cancel_state: string | null;
}

interface RecoveryProjectionRow {
  attempt_id: string;
  run_id: string;
  ordinal: number;
  plan_version: number;
  plan_item_id: string;
  recovered_from_attempt_id: string;
  recovery_checkpoint_id: string;
  head_branch: string | null;
  head_sha: string;
  checkpoint_ref: string;
  checkpoint_digest: string;
  run_version: number;
}

function optionalHeadBranch(
  result: Omit<RecoveryAttemptResult, 'headBranch'>,
  headBranch: string | null,
): RecoveryAttemptResult {
  return headBranch === null ? result : { ...result, headBranch };
}

/** Creates one replacement Attempt only after the lost Runner and old Workflow are fenced. */
export class RecoveryAttemptStore {
  private readonly checkpoints: AgentCheckpointStore;

  constructor(
    private readonly db: D1Database,
    checkpointObjects: R2Bucket,
  ) {
    this.checkpoints = new AgentCheckpointStore(db, checkpointObjects);
  }

  async schedule(
    input: ScheduleRecoveryAttemptInput,
    now = new Date(),
  ): Promise<RecoveryAttemptResult> {
    const item = await this.itemState(input);
    if (item === null) throw new RecoveryAttemptError('not_found');
    if (item.progress_status === 'passed' || item.progress_status === 'skipped') {
      throw new RecoveryAttemptError('item_completed');
    }

    const existing = await this.existingRecovery(input);
    if (existing !== null && existing.run_version === input.expectedRunVersion + 1) {
      return this.result(existing, false);
    }
    const candidate = await this.candidate(input);
    if (candidate === null) throw new RecoveryAttemptError('state_conflict');
    if (candidate.run_state !== 'blocked' || candidate.run_version !== input.expectedRunVersion) {
      throw new RecoveryAttemptError('state_conflict');
    }
    if (candidate.old_status !== 'lost') throw new RecoveryAttemptError('state_conflict');
    if (candidate.cancel_state !== 'settled') {
      throw new RecoveryAttemptError('workflow_cancel_pending');
    }
    if (!(await this.dependenciesPassed(candidate.plan_id, candidate.item_id))) {
      throw new RecoveryAttemptError('dependency_incomplete');
    }

    const recoverable = await this.checkpoints.loadLatestForRecovery(
      input.runId,
      input.planVersion,
      input.planItemId,
    );
    if (
      recoverable === null ||
      recoverable.checkpointId !== candidate.checkpoint_id ||
      recoverable.digest !== candidate.checkpoint_digest ||
      recoverable.checkpoint.headSha !== candidate.checkpoint_head_sha
    ) {
      throw new RecoveryAttemptError('checkpoint_unavailable');
    }

    const identityDigest = await canonicalSha256({
      runId: input.runId,
      planVersion: input.planVersion,
      planItemId: input.planItemId,
      recoveredFromAttemptId: candidate.old_attempt_id,
      checkpointId: candidate.checkpoint_id,
    });
    const attemptId = `attempt_recovery_${identityDigest.slice(
      'sha256:'.length,
      'sha256:'.length + 48,
    )}`;
    const ordinal = await this.nextOrdinal(input.runId);
    const nowIso = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO attempts (
             attempt_id, run_id, ordinal, mode, status, base_sha, repository,
             workflow_ref, plan_id, plan_version, plan_item_id,
             head_branch, head_sha, recovered_from_attempt_id,
             recovery_checkpoint_id, version, lease_generation, created_at, updated_at
           )
           SELECT ?, attempts.run_id, ?, attempts.mode, 'pending', attempts.base_sha,
                  attempts.repository, attempts.workflow_ref, attempts.plan_id,
                  attempts.plan_version, attempts.plan_item_id, ?,
                  checkpoints.head_sha, attempts.attempt_id, checkpoints.checkpoint_id,
                  0, 0, ?, ?
           FROM attempts
           JOIN checkpoints
             ON checkpoints.checkpoint_id = ?
            AND checkpoints.plan_id = attempts.plan_id
            AND checkpoints.plan_version = attempts.plan_version
            AND checkpoints.plan_item_id = attempts.plan_item_id
           JOIN runs ON runs.run_id = attempts.run_id
           JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = attempts.plan_id
            AND plan_item_progress.item_id = attempts.plan_item_id
           WHERE attempts.attempt_id = ?
             AND attempts.status = 'lost'
             AND attempts.run_id = ?
             AND attempts.plan_version = ?
             AND attempts.plan_item_id = ?
             AND runs.state = 'blocked'
             AND runs.version = ?
             AND runs.active_plan_id = attempts.plan_id
             AND runs.active_plan_version = attempts.plan_version
             AND execution_plans.status = 'active'
             AND plan_item_progress.status = 'in_progress'
             AND plan_item_progress.active_attempt_id = attempts.attempt_id
             AND EXISTS (
               SELECT 1 FROM outbox
               WHERE outbox.run_id = attempts.run_id
                 AND outbox.kind = 'workflow_cancel'
                 AND outbox.delivery_state = 'settled'
             )
             AND NOT EXISTS (
               SELECT 1 FROM attempts AS recovery
               WHERE recovery.recovered_from_attempt_id = attempts.attempt_id
                 AND recovery.recovery_checkpoint_id = checkpoints.checkpoint_id
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          attemptId,
          ordinal,
          recoverable.checkpoint.headBranch ?? null,
          nowIso,
          nowIso,
          candidate.checkpoint_id,
          candidate.old_attempt_id,
          input.runId,
          input.planVersion,
          input.planItemId,
          input.expectedRunVersion,
        ),
      this.db
        .prepare(
          `UPDATE plan_item_progress
           SET active_attempt_id = ?, version = version + 1, updated_at = ?
           WHERE plan_id = ? AND item_id = ? AND status = 'in_progress'
             AND version = ? AND active_attempt_id = ?
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = ? AND recovery_checkpoint_id = ?
             )`,
        )
        .bind(
          attemptId,
          nowIso,
          candidate.plan_id,
          candidate.item_id,
          candidate.progress_version,
          candidate.old_attempt_id,
          attemptId,
          candidate.checkpoint_id,
        ),
      this.db
        .prepare(
          `UPDATE runs
           SET state = 'executing', version = version + 1, updated_at = ?
           WHERE run_id = ? AND state = 'blocked' AND version = ?
             AND EXISTS (
               SELECT 1 FROM plan_item_progress
               WHERE plan_id = ? AND item_id = ?
                 AND status = 'in_progress' AND active_attempt_id = ?
             )`,
        )
        .bind(
          nowIso,
          input.runId,
          input.expectedRunVersion,
          candidate.plan_id,
          candidate.item_id,
          attemptId,
        ),
    ]);
    const projection = await this.existingRecovery(input);
    if (projection === null || projection.run_version !== input.expectedRunVersion + 1) {
      throw new RecoveryAttemptError('state_conflict');
    }
    return this.result(projection, results[0]?.meta.changes === 1);
  }

  private async itemState(
    input: ScheduleRecoveryAttemptInput,
  ): Promise<ItemStateRow | null> {
    return await this.db
      .prepare(
        `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
                runs.active_plan_id, runs.active_plan_version,
                execution_plans.plan_id, plan_items.item_id,
                plan_item_progress.status AS progress_status,
                plan_item_progress.version AS progress_version,
                plan_item_progress.active_attempt_id
         FROM runs
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         JOIN plan_items ON plan_items.plan_id = execution_plans.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = plan_items.plan_id
          AND plan_item_progress.item_id = plan_items.item_id
         WHERE runs.run_id = ?
           AND execution_plans.plan_version = ?
           AND plan_items.item_id = ?`,
      )
      .bind(input.runId, input.planVersion, input.planItemId)
      .first<ItemStateRow>();
  }

  private async candidate(
    input: ScheduleRecoveryAttemptInput,
  ): Promise<RecoveryCandidateRow | null> {
    return await this.db
      .prepare(
        `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
                runs.active_plan_id, runs.active_plan_version,
                execution_plans.plan_id, plan_items.item_id,
                plan_item_progress.status AS progress_status,
                plan_item_progress.version AS progress_version,
                plan_item_progress.active_attempt_id,
                attempts.attempt_id AS old_attempt_id, attempts.ordinal AS old_ordinal,
                attempts.mode AS old_mode, attempts.status AS old_status,
                attempts.base_sha AS old_base_sha,
                attempts.repository AS old_repository,
                attempts.workflow_ref AS old_workflow_ref,
                checkpoints.checkpoint_id,
                checkpoints.payload_ref AS checkpoint_ref,
                checkpoints.payload_digest AS checkpoint_digest,
                checkpoints.head_sha AS checkpoint_head_sha,
                cancel.delivery_state AS cancel_state
         FROM runs
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         JOIN plan_items ON plan_items.plan_id = execution_plans.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = plan_items.plan_id
          AND plan_item_progress.item_id = plan_items.item_id
         JOIN attempts ON attempts.attempt_id = plan_item_progress.active_attempt_id
         JOIN checkpoints
           ON checkpoints.plan_id = execution_plans.plan_id
          AND checkpoints.plan_version = execution_plans.plan_version
          AND checkpoints.plan_item_id = plan_items.item_id
         JOIN attempts AS checkpoint_attempt
           ON checkpoint_attempt.attempt_id = checkpoints.attempt_id
         LEFT JOIN outbox AS cancel
           ON cancel.run_id = runs.run_id AND cancel.kind = 'workflow_cancel'
         WHERE runs.run_id = ?
           AND execution_plans.plan_version = ?
           AND execution_plans.status = 'active'
           AND plan_items.item_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM checkpoints AS newer
             JOIN attempts AS newer_attempt
               ON newer_attempt.attempt_id = newer.attempt_id
             WHERE newer.plan_id = checkpoints.plan_id
               AND newer.plan_version = checkpoints.plan_version
               AND newer.plan_item_id = checkpoints.plan_item_id
               AND (
                 newer_attempt.ordinal > checkpoint_attempt.ordinal
                 OR (
                   newer_attempt.ordinal = checkpoint_attempt.ordinal
                   AND newer.sequence > checkpoints.sequence
                 )
               )
           )`,
      )
      .bind(input.runId, input.planVersion, input.planItemId)
      .first<RecoveryCandidateRow>();
  }

  private async existingRecovery(
    input: ScheduleRecoveryAttemptInput,
  ): Promise<RecoveryProjectionRow | null> {
    return await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.ordinal,
                attempts.plan_version, attempts.plan_item_id,
                attempts.recovered_from_attempt_id, attempts.recovery_checkpoint_id,
                attempts.head_branch, attempts.head_sha,
                checkpoints.payload_ref AS checkpoint_ref,
                checkpoints.payload_digest AS checkpoint_digest,
                runs.version AS run_version
         FROM attempts
         JOIN checkpoints ON checkpoints.checkpoint_id = attempts.recovery_checkpoint_id
         JOIN runs ON runs.run_id = attempts.run_id
         WHERE attempts.run_id = ?
           AND attempts.plan_version = ?
           AND attempts.plan_item_id = ?
           AND attempts.recovery_checkpoint_id IS NOT NULL
         ORDER BY attempts.ordinal DESC
         LIMIT 1`,
      )
      .bind(input.runId, input.planVersion, input.planItemId)
      .first<RecoveryProjectionRow>();
  }

  private async dependenciesPassed(planId: string, itemId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM plan_item_dependencies
         LEFT JOIN plan_item_progress AS dependency_progress
           ON dependency_progress.plan_id = plan_item_dependencies.plan_id
          AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
         WHERE plan_item_dependencies.plan_id = ?
           AND plan_item_dependencies.item_id = ?
           AND (dependency_progress.status IS NULL OR dependency_progress.status <> 'passed')`,
      )
      .bind(planId, itemId)
      .first<{ count: number }>();
    return (row?.count ?? 0) === 0;
  }

  private async nextOrdinal(runId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM attempts WHERE run_id = ?')
      .bind(runId)
      .first<{ ordinal: number }>();
    if (row === null || !Number.isSafeInteger(row.ordinal) || row.ordinal <= 0) {
      throw new RecoveryAttemptError('state_conflict');
    }
    return row.ordinal;
  }

  private result(row: RecoveryProjectionRow, created: boolean): RecoveryAttemptResult {
    return optionalHeadBranch(
      {
        attemptId: row.attempt_id,
        runId: row.run_id,
        ordinal: row.ordinal,
        planVersion: row.plan_version,
        planItemId: row.plan_item_id,
        recoveredFromAttemptId: row.recovered_from_attempt_id,
        checkpointId: row.recovery_checkpoint_id,
        checkpointRef: row.checkpoint_ref,
        checkpointDigest: row.checkpoint_digest,
        headSha: row.head_sha,
        created,
      },
      row.head_branch,
    );
  }
}
