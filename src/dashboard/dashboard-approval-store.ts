import { canonicalSha256 } from '../domain/digest.js';

/**
 * Operator-triggered approval of the pre-execution `repo_write` gate from the
 * dashboard.
 *
 * A run in `awaiting_approval` is gated solely on the `repo_write` effect, which
 * flows through the non-identity-bound arm of the `trusted_effect_approvals`
 * view. So a plain `approvals` row (effect='repo_write', decision='approve')
 * with a matching key and a future `expires_at` is what the
 * execution-progress reconciler needs to advance the run to `executing`. This
 * store never touches merge / production_deploy (those stay identity-bound and
 * gate later states) and never writes the run state itself — the reconciler
 * does, on its own schedule.
 *
 * Safety: the plan key (plan_id, plan_version, plan_digest, base_sha,
 * task_revision) is read from the live DB, never from the caller, and the
 * INSERT is guarded on the same live run/plan state so a concurrent change
 * makes it a no-op. The approval_id/nonce_digest are deterministic over the
 * key, so repeated clicks are idempotent.
 */

/** How long an operator approval stays valid before the reconciler must consume it. */
const APPROVAL_TTL_MS = 60 * 60_000;

/** Principal recorded as the approver. repo_write has no separation check. */
const OPERATOR_ACTOR = 'operator:dashboard';

export type DashboardApprovalResult =
  | { status: 'approved'; runId: string; approvalId: string; created: boolean }
  | { status: 'not_approvable'; runId: string };

interface CandidateRow {
  run_id: string;
  run_version: number;
  task_revision: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  base_sha: string;
}

export class DashboardApprovalStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Approve the repo_write gate for a run that is currently awaiting approval.
   * Returns `not_approvable` when the run is not an eligible awaiting_approval
   * candidate (wrong state, plan not active, no repo_write effect, repository
   * writes not allowed, or a pending review-approval recovery).
   */
  async approve(runId: string, now: Date): Promise<DashboardApprovalResult> {
    const candidate = await this.candidate(runId);
    if (candidate === null) return { status: 'not_approvable', runId };

    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    const key = {
      runId: candidate.run_id,
      taskRevision: candidate.task_revision,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planDigest: candidate.plan_digest,
      baseSha: candidate.base_sha,
      effect: 'repo_write',
      decision: 'approve',
    };
    const approvalId = `approval_dashboard_${(await canonicalSha256(key)).slice('sha256:'.length, 'sha256:'.length + 44)}`;
    const nonceDigest = await canonicalSha256({ approvalId, kind: 'dashboard_repo_write' });

    // Guarded INSERT...SELECT: only lands while the run is still an eligible
    // awaiting_approval candidate for this exact plan key. ON CONFLICT keeps
    // repeated clicks idempotent (deterministic approval_id + nonce_digest).
    const result = await this.db.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       )
       SELECT ?, runs.run_id, runs.task_revision, plans.plan_id,
              plans.plan_version, plans.digest, plans.base_sha,
              'repo_write', ?, 'approve', ?, ?, ?
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ? AND runs.version = ?
         AND runs.state = 'awaiting_approval'
         AND runs.base_sha IS NOT NULL
         AND runs.task_revision = ?
         AND runs.active_plan_version = plans.plan_version
         AND runs.active_plan_digest = plans.digest
         AND plans.plan_id = ? AND plans.plan_version = ?
         AND plans.digest = ? AND plans.base_sha = ?
         AND runs.base_sha = plans.base_sha
         AND plans.status = 'active'
         AND tasks.allow_repository_write = 1
         AND EXISTS (
           SELECT 1 FROM plan_item_effects
           WHERE plan_item_effects.plan_id = plans.plan_id
             AND plan_item_effects.effect = 'repo_write'
         )
         AND NOT EXISTS (
           SELECT 1 FROM review_approval_recovery_approvals AS recovery
           WHERE recovery.run_id = runs.run_id
             AND NOT EXISTS (
               SELECT 1 FROM review_approval_recoveries
               WHERE review_approval_recoveries.recovery_approval_id =
                     recovery.recovery_approval_id
             )
         )
       ON CONFLICT DO NOTHING`,
    ).bind(
      approvalId,
      OPERATOR_ACTOR,
      nonceDigest,
      expiresAt,
      nowIso,
      candidate.run_id,
      candidate.run_version,
      candidate.task_revision,
      candidate.plan_id,
      candidate.plan_version,
      candidate.plan_digest,
      candidate.base_sha,
    ).run();

    if (result.meta.changes === 1) {
      return { status: 'approved', runId: candidate.run_id, approvalId, created: true };
    }
    // No insert: either a concurrent change invalidated the candidate, or the
    // approval already exists. Treat a pre-existing approval as success.
    const existing = await this.db.prepare(
      `SELECT approval_id FROM approvals WHERE approval_id = ?`,
    ).bind(approvalId).first<{ approval_id: string }>();
    if (existing !== null) {
      return { status: 'approved', runId: candidate.run_id, approvalId, created: false };
    }
    return { status: 'not_approvable', runId };
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, runs.task_revision,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              plans.base_sha
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ? AND runs.state = 'awaiting_approval'
         AND runs.base_sha IS NOT NULL
         AND runs.active_plan_version = plans.plan_version
         AND runs.active_plan_digest = plans.digest
         AND runs.base_sha = plans.base_sha
         AND plans.status = 'active'
         AND tasks.allow_repository_write = 1
         AND EXISTS (
           SELECT 1 FROM plan_item_effects
           WHERE plan_item_effects.plan_id = plans.plan_id
             AND plan_item_effects.effect = 'repo_write'
         )`,
    ).bind(runId).first<CandidateRow>();
  }
}
