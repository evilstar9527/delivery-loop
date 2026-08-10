import {
  PlanItemAttemptError,
  PlanItemAttemptStore,
} from '../storage/plan-item-attempt-store.js';
import {
  PlanItemEvidenceVerificationError,
  PlanItemEvidenceVerifier,
} from '../storage/plan-item-evidence-verifier.js';
import {
  PullRequestDraftStore,
  PullRequestDraftStoreError,
} from '../storage/pull-request-draft-store.js';
import {
  PullRequestPublicationError,
  PullRequestPublicationStore,
} from '../storage/pull-request-publication-store.js';

interface RunPlanRow {
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
}

interface ReadyItemRow extends RunPlanRow {
  item_id: string;
  progress_version: number;
}

interface CompletedAttemptRow extends ReadyItemRow {
  attempt_id: string;
  attempt_version: number;
  lease_generation: number;
  head_sha: string;
}

interface FinalizeRow extends RunPlanRow {
  head_sha: string;
}

interface PreparedPublicationRow {
  run_id: string;
  run_version: number;
  draft_id: string;
}

export interface ExecutionProgressReconciliationResult {
  activatedRuns: number;
  scheduledAttempts: number;
  verifiedItems: number;
  preparedDrafts: number;
  scheduledPublications: number;
}

export interface ExecutionObservedCompletionResult {
  verifiedItems: number;
  preparedDrafts: number;
  scheduledPublications: number;
}

export interface ExecutionSchedulingResult {
  activatedRuns: number;
  scheduledAttempts: number;
}

export interface ExecutionFinalizationResult {
  preparedDrafts: number;
  scheduledPublications: number;
}

export interface ExecutionProgressReconcilerOptions {
  now?: () => Date;
}

/**
 * Bounded D1 scheduler/finalizer for the approved code-delivery happy path.
 *
 * Every mutation is independently fenced by the authoritative store it calls.
 * This class only selects candidates; a stale scan can therefore lose a race but
 * cannot create a second Attempt, Evidence decision, Draft, or PR effect intent.
 */
export class ExecutionProgressReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly taskObjects: R2Bucket,
    options: ExecutionProgressReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileBatch(limit = 25): Promise<ExecutionProgressReconciliationResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('execution progress reconciliation limit must be between 1 and 100');
    }
    const scheduling = await this.reconcileScheduling(limit);
    const completed = await this.reconcileObservedCompletions(limit);
    return {
      ...scheduling,
      ...completed,
    };
  }

  async reconcileScheduling(limit = 25): Promise<ExecutionSchedulingResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('execution progress reconciliation limit must be between 1 and 100');
    }
    const activatedRuns = await this.activateApprovedRuns(limit);
    const scheduledAttempts = await this.reconcileReadyAttempts(limit);
    return { activatedRuns, scheduledAttempts };
  }

  async reconcileReadyAttempts(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('execution progress reconciliation limit must be between 1 and 100');
    }
    return await this.scheduleInitialAttempts(limit);
  }

  async reconcileObservedCompletions(
    limit = 25,
  ): Promise<ExecutionObservedCompletionResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('execution progress reconciliation limit must be between 1 and 100');
    }
    const verifiedItems = await this.verifyCompletedAttempts(limit);
    const finalized = await this.reconcileFinalizations(limit);
    return { verifiedItems, ...finalized };
  }

  async reconcileFinalizations(limit = 25): Promise<ExecutionFinalizationResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('execution progress reconciliation limit must be between 1 and 100');
    }
    return await this.finalizePullRequests(limit);
  }

  async reconcilePreparedPublications(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('execution progress reconciliation limit must be between 1 and 100');
    }
    const now = this.now();
    const candidates = await this.db.prepare(
      `SELECT drafts.run_id, runs.version AS run_version, drafts.draft_id
       FROM pull_request_drafts AS drafts
       JOIN runs ON runs.run_id = drafts.run_id
       JOIN tasks ON tasks.task_id = drafts.task_id
       JOIN execution_plans AS plans ON plans.plan_id = drafts.plan_id
       JOIN attempts ON attempts.attempt_id = drafts.attempt_id
       WHERE drafts.status = 'prepared'
         AND NOT EXISTS (
           SELECT 1 FROM pull_request_publications AS publications
           WHERE publications.draft_id = drafts.draft_id
         )
         AND runs.state = 'verifying'
         AND runs.version = drafts.run_version
         AND runs.task_digest = drafts.task_digest
         AND tasks.task_revision = drafts.task_revision
         AND tasks.task_digest = drafts.task_digest
         AND tasks.allow_repository_write = 1
         AND runs.active_plan_id = drafts.plan_id
         AND runs.active_plan_version = drafts.plan_version
         AND runs.active_plan_digest = drafts.plan_digest
         AND plans.plan_version = drafts.plan_version
         AND plans.digest = drafts.plan_digest
         AND plans.base_sha = runs.base_sha
         AND plans.status = 'active'
         AND attempts.status = 'completed'
         AND attempts.mode IN ('implement', 'review_fix')
         AND attempts.head_sha = drafts.head_sha
         AND attempts.head_branch = drafts.branch
         AND drafts.branch = 'agent/' || drafts.task_id || '/' || drafts.attempt_id
         AND NOT EXISTS (
           SELECT 1 FROM plan_items
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_items.plan_id
            AND plan_item_progress.item_id = plan_items.item_id
           WHERE plan_items.plan_id = plans.plan_id
             AND plan_items.required = 1
             AND plan_item_progress.status <> 'passed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM plan_item_progress
           WHERE plan_item_progress.plan_id = plans.plan_id
             AND plan_item_progress.protected_path_gate_id IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM attempts AS newer
           WHERE newer.run_id = runs.run_id
             AND newer.mode IN ('implement', 'review_fix')
             AND newer.ordinal > attempts.ordinal
         )
         AND EXISTS (
           SELECT 1 FROM plan_item_effects
           WHERE plan_item_effects.plan_id = plans.plan_id
             AND plan_item_effects.effect = 'repo_write'
         )
         AND EXISTS (
           SELECT 1 FROM trusted_effect_approvals AS approval
           WHERE approval.run_id = runs.run_id
             AND approval.task_revision = drafts.task_revision
             AND approval.plan_id = drafts.plan_id
             AND approval.plan_version = drafts.plan_version
             AND approval.plan_digest = drafts.plan_digest
             AND approval.base_sha = plans.base_sha
             AND approval.effect = 'repo_write'
             AND approval.decision = 'approve'
             AND approval.expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM invalidated_approvals
               WHERE invalidated_approvals.approval_id = approval.approval_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM approvals AS rejection
               WHERE rejection.run_id = approval.run_id
                 AND rejection.task_revision = approval.task_revision
                 AND rejection.plan_id = approval.plan_id
                 AND rejection.plan_version = approval.plan_version
                 AND rejection.plan_digest = approval.plan_digest
                 AND rejection.base_sha = approval.base_sha
                 AND rejection.effect = approval.effect
                 AND rejection.decision = 'reject'
                 AND rejection.created_at >= approval.created_at
             )
         )
       ORDER BY drafts.created_at, drafts.draft_id LIMIT ?`,
    ).bind(now.toISOString(), limit).all<PreparedPublicationRow>();
    let handled = 0;
    for (const candidate of candidates.results) {
      try {
        await new PullRequestPublicationStore(this.db).schedule({
          runId: candidate.run_id,
          expectedRunVersion: candidate.run_version,
          draftId: candidate.draft_id,
        }, now);
        handled += 1;
      } catch (error) {
        if (!(error instanceof PullRequestPublicationError)) throw error;
      }
    }
    return handled;
  }

  private async activateApprovedRuns(limit: number): Promise<number> {
    const nowIso = this.now().toISOString();
    const candidates = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.state = 'awaiting_approval'
         AND runs.base_sha IS NOT NULL
         AND runs.active_plan_version = plans.plan_version
         AND runs.active_plan_digest = plans.digest
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
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{ run_id: string; run_version: number }>();
    let activated = 0;
    for (const candidate of candidates.results) {
      const result = await this.db.prepare(
        `UPDATE runs
         SET state = 'executing', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'awaiting_approval' AND version = ?
           AND EXISTS (
             SELECT 1
             FROM tasks
             JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
             WHERE tasks.task_id = runs.task_id
               AND tasks.allow_repository_write = 1
               AND runs.base_sha = plans.base_sha
               AND runs.active_plan_version = plans.plan_version
               AND runs.active_plan_digest = plans.digest
               AND plans.status = 'active'
               AND EXISTS (
                 SELECT 1 FROM plan_item_effects
                 WHERE plan_item_effects.plan_id = plans.plan_id
                   AND plan_item_effects.effect = 'repo_write'
               )
               AND EXISTS (
                 SELECT 1 FROM trusted_effect_approvals AS approval
                 WHERE approval.run_id = runs.run_id
                   AND approval.task_revision = runs.task_revision
                   AND approval.plan_id = plans.plan_id
                   AND approval.plan_version = plans.plan_version
                   AND approval.plan_digest = plans.digest
                   AND approval.base_sha = plans.base_sha
                   AND approval.effect = 'repo_write'
                   AND approval.decision = 'approve'
                   AND approval.expires_at > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM invalidated_approvals
                     WHERE invalidated_approvals.approval_id = approval.approval_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM approvals AS rejection
                     WHERE rejection.run_id = approval.run_id
                       AND rejection.task_revision = approval.task_revision
                       AND rejection.plan_id = approval.plan_id
                       AND rejection.plan_version = approval.plan_version
                       AND rejection.plan_digest = approval.plan_digest
                       AND rejection.base_sha = approval.base_sha
                       AND rejection.effect = approval.effect
                       AND rejection.decision = 'reject'
                       AND rejection.created_at >= approval.created_at
                   )
               )
           )`,
      ).bind(nowIso, candidate.run_id, candidate.run_version, nowIso).run();
      if (result.meta.changes === 1) activated += 1;
    }
    return activated;
  }

  private async scheduleInitialAttempts(limit: number): Promise<number> {
    const now = this.now();
    const runs = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.state = 'executing'
         AND runs.active_plan_version = plans.plan_version
         AND runs.active_plan_digest = plans.digest
         AND plans.status = 'active'
         AND tasks.allow_repository_write = 1
         AND EXISTS (
           SELECT 1
           FROM plan_items AS candidate_items
           JOIN plan_item_progress AS candidate_progress
             ON candidate_progress.plan_id = candidate_items.plan_id
            AND candidate_progress.item_id = candidate_items.item_id
           WHERE candidate_items.plan_id = plans.plan_id
             AND candidate_items.kind = 'change'
             AND candidate_items.required = 1
             AND candidate_progress.status IN ('pending', 'ready')
             AND candidate_progress.active_attempt_id IS NULL
             AND EXISTS (
               SELECT 1 FROM plan_item_effects
               WHERE plan_item_effects.plan_id = candidate_items.plan_id
                 AND plan_item_effects.item_id = candidate_items.item_id
                 AND plan_item_effects.effect = 'repo_write'
             )
             AND NOT EXISTS (
               SELECT 1 FROM plan_item_effects
               WHERE plan_item_effects.plan_id = candidate_items.plan_id
                 AND plan_item_effects.item_id = candidate_items.item_id
                 AND plan_item_effects.effect IN ('test_deploy', 'production_deploy')
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_command_refs
               WHERE plan_item_command_refs.plan_id = candidate_items.plan_id
                 AND plan_item_command_refs.item_id = candidate_items.item_id
                 AND plan_item_command_refs.command_ref LIKE 'test:%'
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_command_refs
               WHERE plan_item_command_refs.plan_id = candidate_items.plan_id
                 AND plan_item_command_refs.item_id = candidate_items.item_id
                 AND plan_item_command_refs.command_ref LIKE 'verify:%'
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = candidate_items.plan_id
                 AND plan_item_evidence_kinds.item_id = candidate_items.item_id
                 AND plan_item_evidence_kinds.evidence_kind = 'commit'
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = candidate_items.plan_id
                 AND plan_item_evidence_kinds.item_id = candidate_items.item_id
                 AND plan_item_evidence_kinds.evidence_kind = 'test'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM plan_item_dependencies
               LEFT JOIN plan_item_progress AS dependency_progress
                 ON dependency_progress.plan_id = plan_item_dependencies.plan_id
                AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
               WHERE plan_item_dependencies.plan_id = candidate_items.plan_id
                 AND plan_item_dependencies.item_id = candidate_items.item_id
                 AND (
                   dependency_progress.status IS NULL
                   OR dependency_progress.status <> 'passed'
                 )
             )
         )
         AND EXISTS (
           SELECT 1 FROM trusted_effect_approvals AS approval
           WHERE approval.run_id = runs.run_id
             AND approval.task_revision = runs.task_revision
             AND approval.plan_id = plans.plan_id
             AND approval.plan_version = plans.plan_version
             AND approval.plan_digest = plans.digest
             AND approval.base_sha = plans.base_sha
             AND approval.effect = 'repo_write'
             AND approval.decision = 'approve'
             AND approval.expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM invalidated_approvals
               WHERE invalidated_approvals.approval_id = approval.approval_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM approvals AS rejection
               WHERE rejection.run_id = approval.run_id
                 AND rejection.task_revision = approval.task_revision
                 AND rejection.plan_id = approval.plan_id
                 AND rejection.plan_version = approval.plan_version
                 AND rejection.plan_digest = approval.plan_digest
                 AND rejection.base_sha = approval.base_sha
                 AND rejection.effect = approval.effect
                 AND rejection.decision = 'reject'
                 AND rejection.created_at >= approval.created_at
             )
         )
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(now.toISOString(), limit).all<RunPlanRow>();
    let scheduled = 0;
    const store = new PlanItemAttemptStore(this.db);
    for (const run of runs.results) {
      try {
        await store.promoteReadyItems({
          runId: run.run_id,
          expectedRunVersion: run.run_version,
          planVersion: run.plan_version,
        }, now);
        const item = await this.db.prepare(
          `SELECT runs.run_id, runs.version AS run_version,
                  plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
                  items.item_id, progress.version AS progress_version
           FROM runs
           JOIN tasks ON tasks.task_id = runs.task_id
           JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
           JOIN plan_items AS items ON items.plan_id = plans.plan_id
           JOIN plan_item_progress AS progress
             ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
           WHERE runs.run_id = ? AND runs.version = ? AND runs.state = 'executing'
             AND plans.plan_version = ? AND plans.status = 'active'
             AND items.kind = 'change' AND items.required = 1
             AND progress.status = 'ready' AND progress.active_attempt_id IS NULL
             AND tasks.allow_repository_write = 1
             AND EXISTS (
               SELECT 1 FROM plan_item_effects
               WHERE plan_item_effects.plan_id = items.plan_id
                 AND plan_item_effects.item_id = items.item_id
                 AND plan_item_effects.effect = 'repo_write'
             )
             AND NOT EXISTS (
               SELECT 1 FROM plan_item_effects
               WHERE plan_item_effects.plan_id = items.plan_id
                 AND plan_item_effects.item_id = items.item_id
                 AND plan_item_effects.effect IN ('test_deploy', 'production_deploy')
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_command_refs
               WHERE plan_item_command_refs.plan_id = items.plan_id
                 AND plan_item_command_refs.item_id = items.item_id
                 AND plan_item_command_refs.command_ref LIKE 'test:%'
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_command_refs
               WHERE plan_item_command_refs.plan_id = items.plan_id
                 AND plan_item_command_refs.item_id = items.item_id
                 AND plan_item_command_refs.command_ref LIKE 'verify:%'
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = items.plan_id
                 AND plan_item_evidence_kinds.item_id = items.item_id
                 AND plan_item_evidence_kinds.evidence_kind = 'commit'
             )
             AND EXISTS (
               SELECT 1 FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = items.plan_id
                 AND plan_item_evidence_kinds.item_id = items.item_id
                 AND plan_item_evidence_kinds.evidence_kind = 'test'
             )
           ORDER BY items.position, items.item_id LIMIT 1`,
        ).bind(run.run_id, run.run_version, run.plan_version).first<ReadyItemRow>();
        if (item === null) continue;
        const claim = await store.claimReadyItem({
          runId: item.run_id,
          expectedRunVersion: item.run_version,
          planVersion: item.plan_version,
          planItemId: item.item_id,
          expectedProgressVersion: item.progress_version,
        }, now);
        if (claim.created) scheduled += 1;
      } catch (error) {
        if (!(error instanceof PlanItemAttemptError)) throw error;
      }
    }
    return scheduled;
  }

  private async verifyCompletedAttempts(limit: number): Promise<number> {
    const candidates = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              items.item_id, progress.version AS progress_version,
              attempts.attempt_id, attempts.version AS attempt_version,
              attempts.lease_generation, attempts.head_sha
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       JOIN attempts ON attempts.attempt_id = progress.active_attempt_id
       WHERE runs.state IN ('executing', 'verifying')
         AND runs.active_plan_version = plans.plan_version
         AND runs.active_plan_digest = plans.digest
         AND plans.status = 'active'
         AND items.required = 1 AND progress.status = 'in_progress'
         AND attempts.status = 'running'
         AND attempts.mode IN ('implement', 'review_fix')
         AND attempts.github_status = 'completed'
         AND attempts.github_conclusion = 'success'
         AND attempts.head_sha IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM verification_suites
           WHERE verification_suites.attempt_id = attempts.attempt_id
             AND verification_suites.plan_id = plans.plan_id
             AND verification_suites.plan_item_id = items.item_id
             AND verification_suites.head_sha = attempts.head_sha
             AND verification_suites.status = 'completed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM plan_item_verifications
           WHERE plan_item_verifications.plan_id = plans.plan_id
             AND plan_item_verifications.plan_item_id = items.item_id
             AND plan_item_verifications.status = 'passed'
         )
       ORDER BY attempts.updated_at, attempts.attempt_id LIMIT ?`,
    ).bind(limit).all<CompletedAttemptRow>();
    let verified = 0;
    for (const candidate of candidates.results) {
      const [doneWhen, evidence] = await Promise.all([
        this.db.prepare(
          `SELECT position FROM plan_item_done_when
           WHERE plan_id = ? AND item_id = ? ORDER BY position`,
        ).bind(candidate.plan_id, candidate.item_id).all<{ position: number }>(),
        this.db.prepare(
          `SELECT evidence_id FROM evidence
           WHERE run_id = ? AND attempt_id = ? AND plan_id = ?
             AND plan_version = ? AND plan_item_id = ?
             AND sha = ? AND status = 'passed'
             AND verification_status IN ('unverified', 'verified')
           ORDER BY kind, command_ref, evidence_id`,
        ).bind(
          candidate.run_id,
          candidate.attempt_id,
          candidate.plan_id,
          candidate.plan_version,
          candidate.item_id,
          candidate.head_sha,
        ).all<{ evidence_id: string }>(),
      ]);
      if (doneWhen.results.length === 0 || evidence.results.length === 0) continue;
      try {
        const result = await new PlanItemEvidenceVerifier(this.db).verify({
          runId: candidate.run_id,
          expectedRunVersion: candidate.run_version,
          planVersion: candidate.plan_version,
          planItemId: candidate.item_id,
          expectedProgressVersion: candidate.progress_version,
          attemptId: candidate.attempt_id,
          expectedAttemptVersion: candidate.attempt_version,
          leaseGeneration: candidate.lease_generation,
          headSha: candidate.head_sha,
          doneWhenEvidence: doneWhen.results.map((entry) => ({
            position: entry.position,
            evidenceIds: evidence.results.map((row) => row.evidence_id),
          })),
        }, this.now());
        if (result.created) verified += 1;
      } catch (error) {
        if (!(error instanceof PlanItemEvidenceVerificationError)) throw error;
      }
    }
    return verified;
  }

  private async finalizePullRequests(limit: number): Promise<{
    preparedDrafts: number;
    scheduledPublications: number;
  }> {
    const now = this.now();
    const ready = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              latest.head_sha
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN attempt_head_updates AS latest ON latest.update_id = (
         SELECT candidate.update_id FROM attempt_head_updates AS candidate
         JOIN attempts ON attempts.attempt_id = candidate.attempt_id
         WHERE candidate.run_id = runs.run_id
           AND candidate.plan_id = plans.plan_id
           AND attempts.status = 'completed'
           AND attempts.mode IN ('implement', 'review_fix')
         ORDER BY attempts.ordinal DESC, candidate.created_at DESC LIMIT 1
       )
       WHERE runs.state IN ('executing', 'verifying')
         AND runs.active_plan_version = plans.plan_version
         AND runs.active_plan_digest = plans.digest
         AND plans.status = 'active'
         AND EXISTS (
           SELECT 1 FROM plan_items
           WHERE plan_items.plan_id = plans.plan_id AND plan_items.required = 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM plan_items
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_items.plan_id
            AND plan_item_progress.item_id = plan_items.item_id
           WHERE plan_items.plan_id = plans.plan_id
             AND plan_items.required = 1
             AND plan_item_progress.status <> 'passed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM automated_review_fix_attempts
           WHERE automated_review_fix_attempts.fix_attempt_id = latest.attempt_id
         )
         AND EXISTS (
           SELECT 1 FROM trusted_effect_approvals AS approval
           WHERE approval.run_id = runs.run_id
             AND approval.task_revision = runs.task_revision
             AND approval.plan_id = plans.plan_id
             AND approval.plan_version = plans.plan_version
             AND approval.plan_digest = plans.digest
             AND approval.base_sha = plans.base_sha
             AND approval.effect = 'repo_write'
             AND approval.decision = 'approve'
             AND approval.expires_at > ?
             AND NOT EXISTS (
               SELECT 1 FROM invalidated_approvals
               WHERE invalidated_approvals.approval_id = approval.approval_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM approvals AS rejection
               WHERE rejection.run_id = approval.run_id
                 AND rejection.task_revision = approval.task_revision
                 AND rejection.plan_id = approval.plan_id
                 AND rejection.plan_version = approval.plan_version
                 AND rejection.plan_digest = approval.plan_digest
                 AND rejection.base_sha = approval.base_sha
                 AND rejection.effect = approval.effect
                 AND rejection.decision = 'reject'
                 AND rejection.created_at >= approval.created_at
             )
         )
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(now.toISOString(), limit).all<FinalizeRow>();
    let preparedDrafts = 0;
    let scheduledPublications = 0;
    for (const candidate of ready.results) {
      let runVersion = candidate.run_version;
      if (await this.transitionToVerifying(candidate, now)) runVersion += 1;
      try {
        const draft = await new PullRequestDraftStore(
          this.db,
          this.taskObjects,
        ).prepare({
          runId: candidate.run_id,
          expectedRunVersion: runVersion,
          planVersion: candidate.plan_version,
          planDigest: candidate.plan_digest,
          headSha: candidate.head_sha,
        }, now);
        if (draft.created) preparedDrafts += 1;
        const publication = await new PullRequestPublicationStore(this.db).schedule({
          runId: candidate.run_id,
          expectedRunVersion: runVersion,
          draftId: draft.draftId,
        }, now);
        if (publication.created) scheduledPublications += 1;
      } catch (error) {
        if (
          !(error instanceof PullRequestDraftStoreError) &&
          !(error instanceof PullRequestPublicationError)
        ) throw error;
      }
    }
    return { preparedDrafts, scheduledPublications };
  }

  private async transitionToVerifying(candidate: FinalizeRow, now: Date): Promise<boolean> {
    if (candidate.run_version < 0) return false;
    const result = await this.db.prepare(
      `UPDATE runs SET state = 'verifying', version = version + 1, updated_at = ?
       WHERE run_id = ? AND state = 'executing' AND version = ?
         AND active_plan_id = ? AND active_plan_version = ? AND active_plan_digest = ?
         AND NOT EXISTS (
           SELECT 1 FROM plan_items
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_items.plan_id
            AND plan_item_progress.item_id = plan_items.item_id
           WHERE plan_items.plan_id = ? AND plan_items.required = 1
             AND plan_item_progress.status <> 'passed'
         )`,
    ).bind(
      now.toISOString(),
      candidate.run_id,
      candidate.run_version,
      candidate.plan_id,
      candidate.plan_version,
      candidate.plan_digest,
      candidate.plan_id,
    ).run();
    if (result.meta.changes === 1) return true;
    const current = await this.db.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(candidate.run_id).first<{ state: string; version: number }>();
    return current?.state === 'verifying' && current.version === candidate.run_version + 1;
  }
}
