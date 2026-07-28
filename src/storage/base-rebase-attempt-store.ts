import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import { isExactExecutionToolActions } from '../domain/tool-bridge.js';
import { repositoryAttemptBranch } from '../runner/git-repository-writer.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

export const BaseRebaseConflictReportSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  reason: z.literal('content_conflict'),
}).strict();

export const BaseRebaseCompletionReportSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  headSha: z.string().regex(SHA_PATTERN),
  suiteId: z.string().regex(ID_PATTERN),
}).strict();

export type BaseRebaseConflictReport = z.infer<typeof BaseRebaseConflictReportSchema>;
export type BaseRebaseCompletionReport = z.infer<typeof BaseRebaseCompletionReportSchema>;

export type BaseRebaseAttemptErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict';

export class BaseRebaseAttemptError extends Error {
  constructor(readonly code: BaseRebaseAttemptErrorCode) {
    super(`Base rebase Attempt operation failed: ${code}`);
    this.name = 'BaseRebaseAttemptError';
  }
}

export interface BaseRebaseScheduleResult {
  rebaseId: string;
  attemptId: string;
  dispatchOutboxId: string;
  created: boolean;
}

export interface BaseRebaseBlockedResult {
  rebaseId: string;
  status: 'blocked';
  reason: 'content_conflict';
  runVersion: number;
  cancelOutboxId: string;
  created: boolean;
}

export interface BaseRebaseCompletedResult {
  rebaseId: string;
  status: 'passed';
  headSha: string;
  suiteId: string;
  created: boolean;
}

interface ScheduleCandidateRow {
  run_id: string;
  run_version: number;
  task_id: string;
  task_revision: string;
  task_digest: string;
  repository: string;
  base_branch: string;
  revision_id: string;
  source_plan_id: string;
  source_plan_version: number;
  source_plan_status: string;
  target_plan_id: string;
  target_plan_version: number;
  target_plan_digest: string;
  plan_item_id: string;
  progress_version: number;
  source_attempt_id: string;
  source_attempt_status: string;
  source_branch: string;
  source_head_sha: string;
  old_base_sha: string;
  new_base_sha: string;
}

interface ScheduleProjectionRow {
  rebase_id: string;
  rebase_attempt_id: string;
  target_branch: string;
  status: string;
  attempt_status: string;
  attempt_base_sha: string;
  attempt_head_sha: string | null;
  attempt_plan_id: string | null;
  attempt_plan_version: number | null;
  attempt_plan_item_id: string | null;
  progress_status: string;
  active_attempt_id: string | null;
  outbox_id: string | null;
}

interface ResultCandidateRow {
  rebase_id: string;
  run_id: string;
  revision_id: string;
  target_plan_id: string;
  target_plan_version: number;
  plan_item_id: string;
  rebase_attempt_id: string;
  source_head_sha: string;
  target_branch: string;
  rebase_status: string;
  result_head_sha: string | null;
  verification_suite_id: string | null;
  blocker_reason: string | null;
  attempt_mode: string;
  attempt_status: string;
  attempt_version: number;
  attempt_generation: number;
  attempt_lease_expires_at: string | null;
  attempt_head_sha: string | null;
  attempt_head_branch: string | null;
  run_state: string;
  run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_status: string;
  progress_status: string;
  active_attempt_id: string | null;
}

function suffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 32);
}

/** Schedules and settles the trusted rebase path for one base-only Plan revision Item. */
export class BaseRebaseAttemptStore {
  constructor(private readonly db: D1Database) {}

  async schedule(runId: string, now = new Date()): Promise<BaseRebaseScheduleResult> {
    if (!ID_PATTERN.test(runId)) throw new BaseRebaseAttemptError('invalid_request');
    const candidate = await this.scheduleCandidate(runId, now);
    if (candidate === null) {
      const existing = await this.existingForRun(runId);
      if (existing !== null) return this.scheduleResult(existing, false);
      throw new BaseRebaseAttemptError('not_found');
    }
    let expectedSourceBranch: string;
    try {
      expectedSourceBranch = repositoryAttemptBranch(
        candidate.task_id,
        candidate.source_attempt_id,
      );
    } catch {
      throw new BaseRebaseAttemptError('state_conflict');
    }
    if (
      candidate.source_branch !== expectedSourceBranch ||
      candidate.source_attempt_status !== 'completed' ||
      candidate.source_plan_status !== 'superseded'
    ) throw new BaseRebaseAttemptError('state_conflict');

    const identity = await canonicalSha256({
      schemaVersion: '1',
      runId: candidate.run_id,
      revisionId: candidate.revision_id,
      targetPlanId: candidate.target_plan_id,
      planItemId: candidate.plan_item_id,
      sourceAttemptId: candidate.source_attempt_id,
      sourceHeadSha: candidate.source_head_sha,
      progressVersion: candidate.progress_version,
    });
    const stable = suffix(identity);
    const rebaseId = `base_rebase_${stable}`;
    const attemptId = `attempt_base_rebase_${stable}`;
    const outboxId = `dispatch_base_rebase_${stable}`;
    const targetBranch = repositoryAttemptBranch(candidate.task_id, attemptId);
    const workflowRef =
      `${candidate.repository}/.github/workflows/delivery-agent.yml@refs/heads/${candidate.base_branch}`;
    const nowIso = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, head_sha, version, lease_generation,
           created_at, updated_at
         )
         SELECT ?, runs.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = runs.run_id),
                'review_fix', 'pending', runs.base_sha, tasks.target_repository,
                ?, plans.plan_id, plans.plan_version, items.item_id,
                progress.version, ?, 0, 0, ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN plan_items AS items ON items.plan_id = plans.plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
         JOIN plan_revisions AS revision
           ON revision.run_id = runs.run_id AND revision.new_plan_id = plans.plan_id
         WHERE runs.run_id = ? AND runs.state = 'executing' AND runs.version = ?
           AND runs.base_sha = ? AND plans.status = 'active'
           AND plans.plan_id = ? AND plans.plan_version = ? AND plans.digest = ?
           AND items.item_id = ? AND items.required = 1
           AND progress.status = 'ready' AND progress.version = ?
           AND progress.active_attempt_id IS NULL
           AND revision.revision_id = ? AND revision.status = 'activated'
           AND revision.source_kind = 'base_update'
           AND revision.body_changed = 0 AND revision.base_changed = 1
           AND revision.effects_changed = 0
           AND NOT EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE revision_id = revision.revision_id AND plan_item_id = items.item_id
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        attemptId,
        workflowRef,
        candidate.source_head_sha,
        nowIso,
        nowIso,
        candidate.run_id,
        candidate.run_version,
        candidate.new_base_sha,
        candidate.target_plan_id,
        candidate.target_plan_version,
        candidate.target_plan_digest,
        candidate.plan_item_id,
        candidate.progress_version,
        candidate.revision_id,
      ),
      this.db.prepare(
        `INSERT INTO base_rebase_attempts (
           rebase_id, run_id, revision_id, source_plan_id, source_plan_version,
           target_plan_id, target_plan_version, plan_item_id, source_attempt_id,
           rebase_attempt_id, old_base_sha, new_base_sha, source_branch,
           source_head_sha, target_branch, status, created_at, updated_at
         )
         SELECT ?, attempts.run_id, ?, ?, ?, attempts.plan_id,
                attempts.plan_version, attempts.plan_item_id, ?, attempts.attempt_id,
                ?, attempts.base_sha, ?, attempts.head_sha, ?, 'scheduled', ?, ?
         FROM attempts
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.mode = 'review_fix' AND attempts.status = 'pending'
           AND attempts.plan_id = ? AND attempts.plan_version = ?
           AND attempts.plan_item_id = ? AND attempts.head_sha = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        rebaseId,
        candidate.revision_id,
        candidate.source_plan_id,
        candidate.source_plan_version,
        candidate.source_attempt_id,
        candidate.old_base_sha,
        candidate.source_branch,
        targetBranch,
        nowIso,
        nowIso,
        attemptId,
        candidate.run_id,
        candidate.target_plan_id,
        candidate.target_plan_version,
        candidate.plan_item_id,
        candidate.source_head_sha,
      ),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'in_progress', active_attempt_id = ?,
             version = version + 1, updated_at = ?
         WHERE plan_id = ? AND item_id = ? AND status = 'ready' AND version = ?
           AND active_attempt_id IS NULL
           AND EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE rebase_id = ? AND rebase_attempt_id = ?
               AND target_plan_id = plan_item_progress.plan_id
               AND plan_item_id = plan_item_progress.item_id
               AND status = 'scheduled'
           )`,
      ).bind(
        attemptId,
        nowIso,
        candidate.target_plan_id,
        candidate.plan_item_id,
        candidate.progress_version,
        rebaseId,
        attemptId,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, attempts.run_id, 'execution_dispatch', 'github_actions',
                ?, ?, 'pending', ?, ?
         FROM attempts
         JOIN base_rebase_attempts AS rebase
           ON rebase.rebase_attempt_id = attempts.attempt_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = attempts.plan_id
          AND progress.item_id = attempts.plan_item_id
         WHERE rebase.rebase_id = ? AND attempts.attempt_id = ?
           AND attempts.status = 'pending' AND rebase.status = 'scheduled'
           AND progress.status = 'in_progress'
           AND progress.active_attempt_id = attempts.attempt_id
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${attemptId}`,
        `execution-base-rebase:${rebaseId}`,
        nowIso,
        nowIso,
        rebaseId,
        attemptId,
      ),
    ]);
    const projection = await this.scheduleProjection(rebaseId);
    if (projection === null) throw new BaseRebaseAttemptError('state_conflict');
    return this.scheduleResult(projection, results[1]?.meta.changes === 1);
  }

  async blockContentConflict(
    authorization: RunnerAuthorization,
    report: BaseRebaseConflictReport,
    now = new Date(),
  ): Promise<BaseRebaseBlockedResult> {
    const parsed = BaseRebaseConflictReportSchema.safeParse(report);
    if (!parsed.success) throw new BaseRebaseAttemptError('invalid_request');
    const candidate = await this.resultCandidate(authorization.attemptId);
    if (candidate === null) throw new BaseRebaseAttemptError('not_found');
    if (candidate.rebase_status === 'blocked') {
      return this.blockedResult(candidate, false);
    }
    if (!this.activeResultCandidate(candidate, authorization, parsed.data, now) ||
      candidate.attempt_head_sha !== candidate.source_head_sha ||
      candidate.attempt_head_branch !== null) {
      throw new BaseRebaseAttemptError('state_conflict');
    }
    const nowIso = now.toISOString();
    const cancelOutboxId = `cancel_${candidate.rebase_id}`;
    await this.db.batch([
      this.db.prepare(
        `UPDATE base_rebase_attempts
         SET status = 'blocked', blocker_reason = 'base_rebase_content_conflict',
             completed_at = ?, updated_at = ?
         WHERE rebase_id = ? AND rebase_attempt_id = ? AND status = 'scheduled'
           AND source_head_sha = ?
           AND EXISTS (
             SELECT 1 FROM attempts
             JOIN runs ON runs.run_id = attempts.run_id
             JOIN execution_plans AS plans ON plans.plan_id = attempts.plan_id
             JOIN plan_item_progress AS progress
               ON progress.plan_id = attempts.plan_id
              AND progress.item_id = attempts.plan_item_id
             WHERE attempts.attempt_id = base_rebase_attempts.rebase_attempt_id
               AND attempts.status = 'running' AND attempts.version = ?
               AND attempts.lease_generation = ? AND attempts.lease_expires_at > ?
               AND attempts.head_sha = base_rebase_attempts.source_head_sha
               AND attempts.head_branch IS NULL
               AND runs.state IN ('executing', 'verifying') AND runs.version = ?
               AND runs.active_plan_id = base_rebase_attempts.target_plan_id
               AND runs.active_plan_version = base_rebase_attempts.target_plan_version
               AND plans.status = 'active'
               AND progress.status = 'in_progress'
               AND progress.active_attempt_id = attempts.attempt_id
           )`,
      ).bind(
        nowIso,
        nowIso,
        candidate.rebase_id,
        authorization.attemptId,
        candidate.source_head_sha,
        report.expectedVersion,
        report.leaseGeneration,
        nowIso,
        candidate.run_version,
      ),
      this.db.prepare(
        `INSERT INTO base_rebase_approval_invalidations (
           approval_id, rebase_id, reason, invalidated_at
         )
         SELECT approvals.approval_id, rebase.rebase_id,
                'base_rebase_content_conflict', ?
         FROM base_rebase_attempts AS rebase
         JOIN approvals ON approvals.run_id = rebase.run_id
          AND approvals.plan_id = rebase.target_plan_id
          AND approvals.plan_version = rebase.target_plan_version
         WHERE rebase.rebase_id = ? AND rebase.status = 'blocked'
         ON CONFLICT DO NOTHING`,
      ).bind(nowIso, candidate.rebase_id),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'cancelled', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND run_id = ? AND status = 'running'
           AND version = ? AND lease_generation = ?
           AND EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE rebase_id = ? AND status = 'blocked'
           )`,
      ).bind(
        nowIso,
        authorization.attemptId,
        authorization.runId,
        report.expectedVersion,
        report.leaseGeneration,
        candidate.rebase_id,
      ),
      this.db.prepare(
        `INSERT INTO attempt_revocations (
           revocation_id, run_id, attempt_id, reason, revoked_lease_generation,
           attempt_version, occurred_at, created_at
         )
         SELECT ?, attempts.run_id, attempts.attempt_id, 'cancelled', ?,
                attempts.version, ?, ?
         FROM attempts
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.status = 'cancelled' AND attempts.version = ?
           AND attempts.lease_generation = ?
           AND EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE rebase_id = ? AND status = 'blocked'
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        `revoke_${candidate.rebase_id}_${report.leaseGeneration}`,
        report.leaseGeneration,
        nowIso,
        nowIso,
        authorization.attemptId,
        authorization.runId,
        report.expectedVersion + 1,
        report.leaseGeneration + 1,
        candidate.rebase_id,
      ),
      this.db.prepare(
        `UPDATE attempt_tokens SET revoked_at = ?
         WHERE attempt_id = ? AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND status = 'cancelled' AND updated_at = ?
           )`,
      ).bind(nowIso, authorization.attemptId, authorization.attemptId, nowIso),
      this.db.prepare(
        `UPDATE github_write_credentials
         SET status = 'revocation_pending', updated_at = ?
         WHERE attempt_id = ? AND status IN ('issuing', 'active')`,
      ).bind(nowIso, authorization.attemptId),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'blocked', active_attempt_id = NULL,
             version = version + 1, updated_at = ?
         WHERE plan_id = ? AND item_id = ? AND status = 'in_progress'
           AND active_attempt_id = ?
           AND EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE rebase_id = ? AND status = 'blocked'
           )`,
      ).bind(
        nowIso,
        candidate.target_plan_id,
        candidate.plan_item_id,
        authorization.attemptId,
        candidate.rebase_id,
      ),
      this.db.prepare(
        `UPDATE execution_plans SET status = 'blocked', updated_at = ?
         WHERE plan_id = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE rebase_id = ? AND status = 'blocked'
           )`,
      ).bind(nowIso, candidate.target_plan_id, candidate.rebase_id),
      this.db.prepare(
        `UPDATE runs SET state = 'blocked', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state IN ('executing', 'verifying') AND version = ?
           AND active_plan_id = ? AND active_plan_version = ?
           AND EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE rebase_id = ? AND status = 'blocked'
           )`,
      ).bind(
        nowIso,
        candidate.run_id,
        candidate.run_version,
        candidate.target_plan_id,
        candidate.target_plan_version,
        candidate.rebase_id,
      ),
      this.db.prepare(
        `UPDATE outbox
         SET delivery_state = 'settled', lease_token = NULL,
             lease_expires_at = NULL,
             last_error_code = 'base_rebase_content_conflict', updated_at = ?
         WHERE run_id = ? AND kind IN ('execution_dispatch', 'pull_request')
           AND delivery_state IN ('pending', 'delivering')
           AND EXISTS (
             SELECT 1 FROM base_rebase_attempts
             WHERE rebase_id = ? AND status = 'blocked'
           )`,
      ).bind(nowIso, candidate.run_id, candidate.rebase_id),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, ?, 'workflow_cancel', 'cloudflare_workflows', ?, ?,
                'pending', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM runs
           JOIN base_rebase_attempts AS rebase ON rebase.run_id = runs.run_id
           WHERE rebase.rebase_id = ? AND rebase.status = 'blocked'
             AND runs.state = 'blocked'
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        cancelOutboxId,
        candidate.run_id,
        `d1://runs/${candidate.run_id}`,
        `workflow-cancel:${candidate.run_id}`,
        nowIso,
        nowIso,
        candidate.rebase_id,
      ),
    ]);
    const projection = await this.resultCandidate(authorization.attemptId);
    if (projection === null || projection.rebase_status !== 'blocked') {
      throw new BaseRebaseAttemptError('state_conflict');
    }
    return this.blockedResult(projection, true);
  }

  /**
   * Recovers an ambiguous conflict callback after the terminal batch revoked its
   * Runner token. This is read-only and accepts only that exact revoked lease.
   */
  async replayBlockedContentConflict(
    attemptId: string,
    rawToken: string,
    report: BaseRebaseConflictReport,
    now = new Date(),
  ): Promise<BaseRebaseBlockedResult | null> {
    const parsed = BaseRebaseConflictReportSchema.safeParse(report);
    if (
      !ID_PATTERN.test(attemptId) ||
      rawToken.length === 0 ||
      rawToken.length > 20_000 ||
      /[\0\r\n]/.test(rawToken) ||
      !parsed.success
    ) throw new BaseRebaseAttemptError('invalid_request');
    const tokenDigest = await canonicalSha256(rawToken);
    const replay = await this.db.prepare(
      `SELECT rebase.rebase_id
       FROM base_rebase_attempts AS rebase
       JOIN attempts ON attempts.attempt_id = rebase.rebase_attempt_id
       JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
       WHERE rebase.rebase_attempt_id = ?
         AND rebase.status = 'blocked'
         AND rebase.blocker_reason = 'base_rebase_content_conflict'
         AND attempts.status = 'cancelled'
         AND attempts.version = ? AND attempts.lease_generation = ?
         AND attempt_tokens.token_digest = ?
         AND attempt_tokens.lease_generation = ?
         AND attempt_tokens.revoked_at IS NOT NULL
         AND attempt_tokens.expires_at > ?
       LIMIT 1`,
    ).bind(
      attemptId,
      parsed.data.expectedVersion + 1,
      parsed.data.leaseGeneration + 1,
      tokenDigest,
      parsed.data.leaseGeneration,
      now.toISOString(),
    ).first<{ rebase_id: string }>();
    if (replay === null) return null;
    const projection = await this.resultCandidate(attemptId);
    if (projection === null || projection.rebase_id !== replay.rebase_id) {
      throw new BaseRebaseAttemptError('state_conflict');
    }
    return this.blockedResult(projection, false);
  }

  async complete(
    authorization: RunnerAuthorization,
    report: BaseRebaseCompletionReport,
    now = new Date(),
  ): Promise<BaseRebaseCompletedResult> {
    const parsed = BaseRebaseCompletionReportSchema.safeParse(report);
    if (!parsed.success) throw new BaseRebaseAttemptError('invalid_request');
    const candidate = await this.resultCandidate(authorization.attemptId);
    if (candidate === null) throw new BaseRebaseAttemptError('not_found');
    if (candidate.rebase_status === 'passed') {
      return this.completedResult(candidate, parsed.data, false);
    }
    if (!this.activeResultCandidate(candidate, authorization, parsed.data, now)) {
      throw new BaseRebaseAttemptError('state_conflict');
    }
    const suite = await this.db.prepare(
      `SELECT verification_suites.suite_id
       FROM verification_suites
       JOIN attempt_head_updates
         ON attempt_head_updates.attempt_id = verification_suites.attempt_id
        AND attempt_head_updates.head_sha = verification_suites.head_sha
       WHERE verification_suites.suite_id = ?
         AND verification_suites.attempt_id = ?
         AND verification_suites.plan_id = ?
         AND verification_suites.plan_version = ?
         AND verification_suites.plan_item_id = ?
         AND verification_suites.lease_generation = ?
         AND verification_suites.head_sha = ?
         AND verification_suites.status = 'completed'
         AND attempt_head_updates.parent_sha = ?
         AND attempt_head_updates.branch = ?
         AND NOT EXISTS (
           SELECT 1 FROM verification_suite_commands
           WHERE verification_suite_commands.suite_id = verification_suites.suite_id
             AND verification_suite_commands.result_status <> 'passed'
         )`,
    ).bind(
      parsed.data.suiteId,
      authorization.attemptId,
      candidate.target_plan_id,
      candidate.target_plan_version,
      candidate.plan_item_id,
      authorization.leaseGeneration,
      parsed.data.headSha,
      candidate.source_head_sha,
      candidate.target_branch,
    ).first<{ suite_id: string }>();
    if (suite === null) throw new BaseRebaseAttemptError('state_conflict');
    const nowIso = now.toISOString();
    const updated = await this.db.prepare(
      `UPDATE base_rebase_attempts
       SET status = 'passed', result_head_sha = ?, verification_suite_id = ?,
           completed_at = ?, updated_at = ?
       WHERE rebase_id = ? AND rebase_attempt_id = ? AND status = 'scheduled'
         AND EXISTS (
           SELECT 1 FROM attempts
           JOIN runs ON runs.run_id = attempts.run_id
           JOIN execution_plans AS plans ON plans.plan_id = attempts.plan_id
           JOIN plan_item_progress AS progress
             ON progress.plan_id = attempts.plan_id
            AND progress.item_id = attempts.plan_item_id
           WHERE attempts.attempt_id = ? AND attempts.status = 'running' AND attempts.version = ?
             AND attempts.lease_generation = ? AND attempts.head_sha = ?
             AND attempts.head_branch = ?
             AND runs.state IN ('executing', 'verifying')
             AND runs.active_plan_id = base_rebase_attempts.target_plan_id
             AND runs.active_plan_version = base_rebase_attempts.target_plan_version
             AND plans.status = 'active'
             AND progress.status = 'in_progress'
             AND progress.active_attempt_id = attempts.attempt_id
         )`,
    ).bind(
      parsed.data.headSha,
      parsed.data.suiteId,
      nowIso,
      nowIso,
      candidate.rebase_id,
      authorization.attemptId,
      authorization.attemptId,
      report.expectedVersion,
      report.leaseGeneration,
      parsed.data.headSha,
      candidate.target_branch,
    ).run();
    const projection = await this.resultCandidate(authorization.attemptId);
    if (projection === null) throw new BaseRebaseAttemptError('state_conflict');
    return this.completedResult(projection, parsed.data, updated.meta.changes === 1);
  }

  private async scheduleCandidate(runId: string, now: Date): Promise<ScheduleCandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, tasks.task_id,
              tasks.task_revision, tasks.task_digest,
              tasks.target_repository AS repository,
              tasks.target_base_branch AS base_branch,
              revision.revision_id, revision.prior_plan_id AS source_plan_id,
              revision.prior_plan_version AS source_plan_version,
              source_plan.status AS source_plan_status,
              target_plan.plan_id AS target_plan_id,
              target_plan.plan_version AS target_plan_version,
              target_plan.digest AS target_plan_digest,
              target_item.item_id AS plan_item_id,
              target_progress.version AS progress_version,
              source_attempt.attempt_id AS source_attempt_id,
              source_attempt.status AS source_attempt_status,
              source_attempt.head_branch AS source_branch,
              source_attempt.head_sha AS source_head_sha,
              revision.prior_base_sha AS old_base_sha,
              revision.requested_base_sha AS new_base_sha
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN plan_revisions AS revision
         ON revision.run_id = runs.run_id AND revision.new_plan_id = runs.active_plan_id
       JOIN execution_plans AS source_plan ON source_plan.plan_id = revision.prior_plan_id
       JOIN execution_plans AS target_plan ON target_plan.plan_id = revision.new_plan_id
       JOIN plan_items AS target_item ON target_item.plan_id = target_plan.plan_id
       JOIN plan_items AS source_item
         ON source_item.plan_id = source_plan.plan_id
        AND source_item.item_id = target_item.item_id
       JOIN plan_item_progress AS target_progress
         ON target_progress.plan_id = target_item.plan_id
        AND target_progress.item_id = target_item.item_id
       JOIN plan_item_progress AS source_progress
         ON source_progress.plan_id = source_item.plan_id
        AND source_progress.item_id = source_item.item_id
       JOIN plan_item_verifications AS source_verification
         ON source_verification.plan_id = source_item.plan_id
        AND source_verification.plan_item_id = source_item.item_id
        AND source_verification.status = 'passed'
       JOIN attempts AS source_attempt
         ON source_attempt.attempt_id = source_verification.attempt_id
       JOIN attempt_head_updates AS source_head
         ON source_head.attempt_id = source_attempt.attempt_id
        AND source_head.head_sha = source_verification.head_sha
       WHERE runs.run_id = ? AND runs.state = 'executing'
         AND target_plan.status = 'active' AND source_plan.status = 'superseded'
         AND runs.base_sha = target_plan.base_sha
         AND runs.active_plan_version = target_plan.plan_version
         AND runs.active_plan_digest = target_plan.digest
         AND revision.status = 'activated' AND revision.source_kind = 'base_update'
         AND revision.body_changed = 0 AND revision.base_changed = 1
         AND revision.effects_changed = 0
         AND revision.prior_base_sha = source_plan.base_sha
         AND revision.requested_base_sha = target_plan.base_sha
         AND target_item.kind = 'verification' AND target_item.required = 1
         AND target_progress.status = 'ready'
         AND target_progress.active_attempt_id IS NULL
         AND source_progress.status = 'passed'
         AND source_attempt.status = 'completed'
         AND source_attempt.plan_id = source_plan.plan_id
         AND source_attempt.plan_version = source_plan.plan_version
         AND source_attempt.plan_item_id = source_item.item_id
         AND source_attempt.head_sha = source_head.head_sha
         AND source_attempt.head_branch = source_head.branch
         AND EXISTS (
           SELECT 1 FROM plan_item_effects
           WHERE plan_id = target_item.plan_id AND item_id = target_item.item_id
             AND effect = 'repo_write'
         )
         AND EXISTS (
           SELECT 1 FROM plan_item_evidence_kinds
           WHERE plan_id = target_item.plan_id AND item_id = target_item.item_id
             AND evidence_kind = 'test'
         )
         AND EXISTS (
           SELECT 1 FROM plan_item_command_refs
           WHERE plan_id = target_item.plan_id AND item_id = target_item.item_id
             AND command_ref LIKE 'test:%'
         )
         AND EXISTS (
           SELECT 1 FROM plan_item_command_refs
           WHERE plan_id = target_item.plan_id AND item_id = target_item.item_id
             AND command_ref LIKE 'verify:%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM plan_item_dependencies
           LEFT JOIN plan_item_progress AS dependency
             ON dependency.plan_id = plan_item_dependencies.plan_id
            AND dependency.item_id = plan_item_dependencies.depends_on_item_id
           WHERE plan_item_dependencies.plan_id = target_item.plan_id
             AND plan_item_dependencies.item_id = target_item.item_id
             AND (dependency.status IS NULL OR dependency.status <> 'passed')
         )
         AND NOT EXISTS (
           SELECT 1 FROM base_rebase_attempts
           WHERE revision_id = revision.revision_id
             AND plan_item_id = target_item.item_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM pull_request_publications
           WHERE repository = tasks.target_repository
             AND head_branch = source_attempt.head_branch
         )
         AND EXISTS (
           SELECT 1 FROM approvals
           WHERE approvals.run_id = runs.run_id
             AND approvals.task_revision = tasks.task_revision
             AND approvals.plan_id = target_plan.plan_id
             AND approvals.plan_version = target_plan.plan_version
             AND approvals.plan_digest = target_plan.digest
             AND approvals.base_sha = runs.base_sha
             AND approvals.effect = 'repo_write'
             AND approvals.decision = 'approve' AND approvals.expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM invalidated_approvals
               WHERE invalidated_approvals.approval_id = approvals.approval_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM approvals AS newer
               WHERE newer.run_id = approvals.run_id
                 AND newer.task_revision = approvals.task_revision
                 AND newer.plan_id = approvals.plan_id
                 AND newer.plan_version = approvals.plan_version
                 AND newer.plan_digest = approvals.plan_digest
                 AND newer.base_sha = approvals.base_sha
                 AND newer.effect = approvals.effect
                 AND (newer.created_at > approvals.created_at OR
                      (newer.created_at = approvals.created_at
                       AND newer.approval_id > approvals.approval_id))
             )
         )
       ORDER BY target_item.position, source_verification.created_at DESC
       LIMIT 1`,
    ).bind(runId, now.toISOString()).first<ScheduleCandidateRow>();
  }

  private async existingForRun(runId: string): Promise<ScheduleProjectionRow | null> {
    return await this.db.prepare(
      `SELECT rebase.rebase_id, rebase.rebase_attempt_id, rebase.target_branch,
              rebase.status, attempts.status AS attempt_status,
              attempts.base_sha AS attempt_base_sha,
              attempts.head_sha AS attempt_head_sha,
              attempts.plan_id AS attempt_plan_id,
              attempts.plan_version AS attempt_plan_version,
              attempts.plan_item_id AS attempt_plan_item_id,
              progress.status AS progress_status,
              progress.active_attempt_id, outbox.outbox_id
       FROM base_rebase_attempts AS rebase
       JOIN attempts ON attempts.attempt_id = rebase.rebase_attempt_id
       JOIN runs ON runs.run_id = rebase.run_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = rebase.target_plan_id
        AND progress.item_id = rebase.plan_item_id
       LEFT JOIN outbox
         ON outbox.run_id = rebase.run_id
        AND outbox.payload_ref = 'd1://attempts/' || rebase.rebase_attempt_id
        AND outbox.kind = 'execution_dispatch'
       WHERE rebase.run_id = ? AND rebase.target_plan_id = runs.active_plan_id
       ORDER BY rebase.created_at DESC LIMIT 1`,
    ).bind(runId).first<ScheduleProjectionRow>();
  }

  private async scheduleProjection(rebaseId: string): Promise<ScheduleProjectionRow | null> {
    return await this.db.prepare(
      `SELECT rebase.rebase_id, rebase.rebase_attempt_id, rebase.target_branch,
              rebase.status, attempts.status AS attempt_status,
              attempts.base_sha AS attempt_base_sha,
              attempts.head_sha AS attempt_head_sha,
              attempts.plan_id AS attempt_plan_id,
              attempts.plan_version AS attempt_plan_version,
              attempts.plan_item_id AS attempt_plan_item_id,
              progress.status AS progress_status,
              progress.active_attempt_id, outbox.outbox_id
       FROM base_rebase_attempts AS rebase
       JOIN attempts ON attempts.attempt_id = rebase.rebase_attempt_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = rebase.target_plan_id
        AND progress.item_id = rebase.plan_item_id
       LEFT JOIN outbox
         ON outbox.run_id = rebase.run_id
        AND outbox.payload_ref = 'd1://attempts/' || rebase.rebase_attempt_id
        AND outbox.kind = 'execution_dispatch'
       WHERE rebase.rebase_id = ?`,
    ).bind(rebaseId).first<ScheduleProjectionRow>();
  }

  private scheduleResult(row: ScheduleProjectionRow, created: boolean): BaseRebaseScheduleResult {
    if (
      row.status !== 'scheduled' ||
      !['pending', 'starting', 'running'].includes(row.attempt_status) ||
      row.attempt_head_sha === null ||
      row.attempt_plan_id === null ||
      row.attempt_plan_version === null ||
      row.attempt_plan_item_id === null ||
      row.progress_status !== 'in_progress' ||
      row.active_attempt_id !== row.rebase_attempt_id ||
      row.outbox_id === null
    ) throw new BaseRebaseAttemptError('state_conflict');
    return {
      rebaseId: row.rebase_id,
      attemptId: row.rebase_attempt_id,
      dispatchOutboxId: row.outbox_id,
      created,
    };
  }

  private async resultCandidate(attemptId: string): Promise<ResultCandidateRow | null> {
    return await this.db.prepare(
      `SELECT rebase.rebase_id, rebase.run_id, rebase.revision_id,
              rebase.target_plan_id, rebase.target_plan_version,
              rebase.plan_item_id, rebase.rebase_attempt_id,
              rebase.source_head_sha, rebase.target_branch,
              rebase.status AS rebase_status, rebase.result_head_sha,
              rebase.verification_suite_id, rebase.blocker_reason,
              attempts.mode AS attempt_mode, attempts.status AS attempt_status,
              attempts.version AS attempt_version,
              attempts.lease_generation AS attempt_generation,
              attempts.lease_expires_at AS attempt_lease_expires_at,
              attempts.head_sha AS attempt_head_sha,
              attempts.head_branch AS attempt_head_branch,
              runs.state AS run_state, runs.version AS run_version,
              runs.active_plan_id, runs.active_plan_version,
              plans.status AS plan_status, progress.status AS progress_status,
              progress.active_attempt_id
       FROM base_rebase_attempts AS rebase
       JOIN attempts ON attempts.attempt_id = rebase.rebase_attempt_id
       JOIN runs ON runs.run_id = rebase.run_id
       JOIN execution_plans AS plans ON plans.plan_id = rebase.target_plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = rebase.target_plan_id
        AND progress.item_id = rebase.plan_item_id
       WHERE rebase.rebase_attempt_id = ?`,
    ).bind(attemptId).first<ResultCandidateRow>();
  }

  private activeResultCandidate(
    row: ResultCandidateRow,
    authorization: RunnerAuthorization,
    report: { expectedVersion: number; leaseGeneration: number },
    now: Date,
  ): boolean {
    return authorization.attemptId === row.rebase_attempt_id &&
      authorization.runId === row.run_id &&
      authorization.mode === 'review_fix' &&
      authorization.version === report.expectedVersion &&
      authorization.leaseGeneration === report.leaseGeneration &&
      isExactExecutionToolActions(authorization.scopes) &&
      row.rebase_status === 'scheduled' &&
      row.attempt_mode === 'review_fix' &&
      row.attempt_status === 'running' &&
      row.attempt_version === report.expectedVersion &&
      row.attempt_generation === report.leaseGeneration &&
      row.attempt_lease_expires_at !== null &&
      row.attempt_lease_expires_at > now.toISOString() &&
      (row.run_state === 'executing' || row.run_state === 'verifying') &&
      row.active_plan_id === row.target_plan_id &&
      row.active_plan_version === row.target_plan_version &&
      row.plan_status === 'active' &&
      row.progress_status === 'in_progress' &&
      row.active_attempt_id === row.rebase_attempt_id;
  }

  private blockedResult(row: ResultCandidateRow, created: boolean): BaseRebaseBlockedResult {
    if (
      row.rebase_status !== 'blocked' ||
      row.blocker_reason !== 'base_rebase_content_conflict' ||
      row.run_state !== 'blocked'
    ) throw new BaseRebaseAttemptError('state_conflict');
    return {
      rebaseId: row.rebase_id,
      status: 'blocked',
      reason: 'content_conflict',
      runVersion: row.run_version,
      cancelOutboxId: `cancel_${row.rebase_id}`,
      created,
    };
  }

  private completedResult(
    row: ResultCandidateRow,
    report: BaseRebaseCompletionReport,
    created: boolean,
  ): BaseRebaseCompletedResult {
    if (
      row.rebase_status !== 'passed' ||
      row.result_head_sha !== report.headSha ||
      row.verification_suite_id !== report.suiteId
    ) throw new BaseRebaseAttemptError('state_conflict');
    return {
      rebaseId: row.rebase_id,
      status: 'passed',
      headSha: report.headSha,
      suiteId: report.suiteId,
      created,
    };
  }
}
