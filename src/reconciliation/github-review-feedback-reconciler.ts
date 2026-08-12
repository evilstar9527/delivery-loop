import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubReviewFeedbackStore,
  type GitHubReviewFeedbackFact,
  type GitHubReviewFeedbackResult,
} from '../storage/github-review-feedback-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface GitHubReviewFeedbackObservationRequest {
  repository: string;
  number: number;
  headBranch: string;
  baseBranch: string;
}

export interface GitHubReviewFeedbackExternalFactClient {
  observeReviewFeedback(
    request: GitHubReviewFeedbackObservationRequest,
  ): Promise<GitHubReviewFeedbackFact[]>;
}

export interface GitHubReviewFeedbackReconcilerOptions {
  now?: () => Date;
  secrets?: readonly string[];
}

export type GitHubReviewFeedbackReconciliationResult =
  | GitHubReviewFeedbackResult
  | { disposition: 'not_found' | 'no_feedback' };

export interface GitHubReviewFeedbackBatchResult {
  runId: string;
  result: GitHubReviewFeedbackReconciliationResult | { disposition: 'unavailable' };
}

export interface GitHubReviewFeedbackRecoveryResult {
  lostAttemptId: string;
  replacementAttemptId: string;
  created: boolean;
}

export interface GitHubReviewApprovalRecoveryResult {
  recoveryApprovalId: string;
  replacementAttemptId: string;
  created: boolean;
}

interface CandidateRow {
  repository: string;
  github_pr_number: number;
  head_branch: string;
  base_branch: string;
}

/** Restores an exact-head review transition when the GitHub webhook was not delivered. */
export class GitHubReviewFeedbackReconciler {
  private readonly now: () => Date;
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    private readonly client: GitHubReviewFeedbackExternalFactClient,
    options: GitHubReviewFeedbackReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.secrets = [...(options.secrets ?? [])];
  }

  async reconcileRun(runId: string): Promise<GitHubReviewFeedbackReconciliationResult> {
    if (!ID_PATTERN.test(runId)) return { disposition: 'not_found' };
    const candidate = await this.candidate(runId);
    if (candidate === null) return { disposition: 'not_found' };
    const facts = await this.client.observeReviewFeedback({
      repository: candidate.repository,
      number: candidate.github_pr_number,
      headBranch: candidate.head_branch,
      baseBranch: candidate.base_branch,
    });
    if (facts.length === 0) return { disposition: 'no_feedback' };

    const store = new GitHubReviewFeedbackStore(this.db, this.objects, {
      secrets: this.secrets,
    });
    let latest: GitHubReviewFeedbackResult | null = null;
    for (const fact of facts) {
      const payloadDigest = await canonicalSha256(fact);
      const deliveryDigest = await canonicalSha256({
        source: 'github_api',
        repository: fact.repository,
        number: fact.number,
        reviewId: fact.reviewId,
        payloadDigest,
      });
      latest = await store.apply({
        deliveryId: deliveryDigest.slice('sha256:'.length),
        payloadDigest,
        fact,
        receivedAt: this.now().toISOString(),
      });
      if (latest.disposition === 'applied') return latest;
    }
    return latest ?? { disposition: 'no_feedback' };
  }

  async reconcileBatch(limit = 25): Promise<GitHubReviewFeedbackBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('GitHub review feedback reconciliation limit is invalid');
    }
    const candidates = await this.db.prepare(
      `SELECT DISTINCT runs.run_id
       FROM runs
       JOIN pull_request_publications AS publications ON publications.run_id = runs.run_id
       WHERE runs.state = 'pull_request_open'
         AND publications.status = 'verified'
         AND publications.github_pr_number IS NOT NULL
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: GitHubReviewFeedbackBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        results.push({
          runId: candidate.run_id,
          result: await this.reconcileRun(candidate.run_id),
        });
      } catch {
        results.push({ runId: candidate.run_id, result: { disposition: 'unavailable' } });
      }
    }
    return results;
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT publications.repository, publications.github_pr_number,
              publications.head_branch, publications.base_branch
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN pull_request_publications AS publications ON publications.run_id = runs.run_id
       WHERE runs.run_id = ? AND runs.state = 'pull_request_open'
         AND plans.status = 'active' AND publications.status = 'verified'
         AND publications.github_pr_number IS NOT NULL
       ORDER BY publications.updated_at DESC, publications.publication_id DESC LIMIT 1`,
    ).bind(runId).first<CandidateRow>();
  }
}

/** Replaces one lost pre-effect review Attempt while preserving its immutable lineage. */
export class GitHubReviewFeedbackRecoveryReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recoverAttempt(lostAttemptId: string): Promise<GitHubReviewFeedbackRecoveryResult> {
    if (!ID_PATTERN.test(lostAttemptId)) {
      throw new Error('GitHub review feedback recovery Attempt is invalid');
    }
    const identity = await canonicalSha256({
      source: 'review_feedback_pre_effect_recovery',
      lostAttemptId,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 48);
    const replacementAttemptId = `attempt_review_recovery_${suffix}`;
    const outboxId = `dispatch_review_recovery_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, head_branch, head_sha,
           recovered_from_attempt_id, version, lease_generation, created_at, updated_at
         )
         SELECT ?, lost.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = lost.run_id),
                'review_fix', 'pending', lost.base_sha, lost.repository,
                lost.workflow_ref, lost.plan_id, lost.plan_version, lost.plan_item_id,
                progress.version, NULL, lost.head_sha, lost.attempt_id, 0, 0, ?, ?
         FROM attempts AS lost
         JOIN runs ON runs.run_id = lost.run_id
         JOIN execution_plans AS plans ON plans.plan_id = lost.plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = lost.plan_id AND progress.item_id = lost.plan_item_id
         JOIN review_feedback_attempts AS lineage
           ON lineage.review_attempt_id = lost.attempt_id
          AND lineage.source_head_sha = lost.head_sha
         JOIN github_review_feedbacks AS feedback
           ON feedback.feedback_id = lineage.feedback_id
          AND feedback.run_id = lost.run_id
          AND feedback.plan_id = lost.plan_id
          AND feedback.plan_version = lost.plan_version
          AND feedback.plan_item_id = lost.plan_item_id
          AND feedback.source_head_sha = lost.head_sha
         WHERE lost.attempt_id = ? AND lost.mode = 'review_fix' AND lost.status = 'lost'
           AND lost.github_status = 'completed'
           AND lost.github_conclusion IS NOT NULL AND lost.github_conclusion <> 'success'
           AND lost.head_sha IS NOT NULL
           AND (
             runs.state = 'executing'
             OR (
               runs.state = 'blocked'
               AND NOT EXISTS (
                 SELECT 1 FROM run_blockers
                 WHERE run_blockers.run_id = lost.run_id
                   AND run_blockers.resolved_at IS NULL
               )
               AND EXISTS (
                 SELECT 1 FROM run_stuck_incidents AS incident
                 WHERE incident.run_id = lost.run_id
                   AND incident.attempt_id = lost.attempt_id
                   AND incident.state_kind = 'running'
                   AND incident.observed_run_state = 'executing'
                   AND incident.run_version + 1 = runs.version
                   AND incident.action = 'fence_lost_attempt'
                   AND incident.status = 'resolved'
                   AND incident.resolution_code = 'attempt_fenced'
               )
               AND EXISTS (
                 SELECT 1 FROM outbox AS cancel
                 WHERE cancel.run_id = lost.run_id
                   AND cancel.kind = 'workflow_cancel'
                   AND cancel.delivery_state = 'settled'
               )
             )
           )
           AND runs.active_plan_id = lost.plan_id
           AND runs.active_plan_version = lost.plan_version
           AND plans.status = 'active'
           AND progress.status = 'in_progress'
           AND progress.active_attempt_id = lost.attempt_id
           AND progress.protected_path_gate_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM attempt_head_updates WHERE attempt_id = lost.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM verification_suites WHERE attempt_id = lost.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM attempt_failures WHERE attempt_id = lost.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM github_write_credentials
             WHERE attempt_id = lost.attempt_id
               AND status IN ('issuing', 'active', 'revocation_pending', 'revoking')
           )
           AND NOT EXISTS (
             SELECT 1 FROM attempts AS replacement
             WHERE replacement.recovered_from_attempt_id = lost.attempt_id
           )
         ON CONFLICT DO NOTHING`,
      ).bind(replacementAttemptId, nowIso, nowIso, lostAttemptId),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET active_attempt_id = ?, version = version + 1, updated_at = ?
         WHERE status = 'in_progress' AND active_attempt_id = ?
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND recovered_from_attempt_id = ? AND status = 'pending'
               AND attempts.plan_id = plan_item_progress.plan_id
               AND attempts.plan_item_id = plan_item_progress.item_id
           )`,
      ).bind(
        replacementAttemptId,
        nowIso,
        lostAttemptId,
        replacementAttemptId,
        lostAttemptId,
      ),
      this.db.prepare(
        `UPDATE runs
         SET state = 'executing', version = version + 1, updated_at = ?
         WHERE state = 'blocked'
           AND NOT EXISTS (
             SELECT 1 FROM run_blockers
             WHERE run_blockers.run_id = runs.run_id
               AND run_blockers.resolved_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM attempts AS replacement
             JOIN attempts AS lost
               ON lost.attempt_id = replacement.recovered_from_attempt_id
             JOIN run_stuck_incidents AS incident
               ON incident.run_id = lost.run_id
              AND incident.attempt_id = lost.attempt_id
             WHERE replacement.attempt_id = ?
               AND replacement.recovered_from_attempt_id = ?
               AND replacement.run_id = runs.run_id
               AND replacement.status = 'pending'
               AND incident.state_kind = 'running'
               AND incident.observed_run_state = 'executing'
               AND incident.run_version + 1 = runs.version
               AND incident.action = 'fence_lost_attempt'
               AND incident.status = 'resolved'
               AND incident.resolution_code = 'attempt_fenced'
           )
           AND EXISTS (
             SELECT 1 FROM outbox AS cancel
             WHERE cancel.run_id = runs.run_id
               AND cancel.kind = 'workflow_cancel'
               AND cancel.delivery_state = 'settled'
           )`,
      ).bind(nowIso, replacementAttemptId, lostAttemptId),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, replacement.run_id, 'execution_dispatch', 'github_actions',
                ?, ?, 'pending', ?, ?
         FROM attempts AS replacement
         JOIN plan_item_progress AS progress
           ON progress.plan_id = replacement.plan_id
          AND progress.item_id = replacement.plan_item_id
         JOIN runs ON runs.run_id = replacement.run_id
         WHERE replacement.attempt_id = ?
           AND replacement.recovered_from_attempt_id = ?
           AND replacement.mode = 'review_fix' AND replacement.status = 'pending'
           AND progress.status = 'in_progress'
           AND progress.active_attempt_id = replacement.attempt_id
           AND runs.state = 'executing'
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${replacementAttemptId}`,
        `execution-review-recovery:${lostAttemptId}`,
        nowIso,
        nowIso,
        replacementAttemptId,
        lostAttemptId,
      ),
    ]);
    const persisted = await this.db.prepare(
      `SELECT attempt_id FROM attempts
       WHERE attempt_id = ? AND recovered_from_attempt_id = ? AND status = 'pending'`,
    ).bind(replacementAttemptId, lostAttemptId).first<{ attempt_id: string }>();
    if (persisted === null) {
      throw new Error('GitHub review feedback recovery is unavailable');
    }
    return {
      lostAttemptId,
      replacementAttemptId,
      created: results[0]?.meta.changes === 1,
    };
  }

  async reconcileBatch(limit = 5): Promise<GitHubReviewFeedbackRecoveryResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 25) {
      throw new Error('GitHub review feedback recovery limit is invalid');
    }
    const rows = await this.db.prepare(
      `SELECT lost.attempt_id
       FROM attempts AS lost
       JOIN runs ON runs.run_id = lost.run_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = lost.plan_id AND progress.item_id = lost.plan_item_id
       JOIN review_feedback_attempts AS lineage
         ON lineage.review_attempt_id = lost.attempt_id
       WHERE lost.mode = 'review_fix' AND lost.status = 'lost'
         AND lost.github_status = 'completed'
         AND lost.github_conclusion IS NOT NULL AND lost.github_conclusion <> 'success'
         AND (
           runs.state = 'executing'
           OR (
             runs.state = 'blocked'
             AND NOT EXISTS (
               SELECT 1 FROM run_blockers
               WHERE run_blockers.run_id = lost.run_id
                 AND run_blockers.resolved_at IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM run_stuck_incidents AS incident
               WHERE incident.run_id = lost.run_id
                 AND incident.attempt_id = lost.attempt_id
                 AND incident.state_kind = 'running'
                 AND incident.observed_run_state = 'executing'
                 AND incident.run_version + 1 = runs.version
                 AND incident.action = 'fence_lost_attempt'
                 AND incident.status = 'resolved'
                 AND incident.resolution_code = 'attempt_fenced'
             )
             AND EXISTS (
               SELECT 1 FROM outbox AS cancel
               WHERE cancel.run_id = lost.run_id
                 AND cancel.kind = 'workflow_cancel'
                 AND cancel.delivery_state = 'settled'
             )
           )
         )
         AND progress.status = 'in_progress'
         AND progress.active_attempt_id = lost.attempt_id
         AND NOT EXISTS (
           SELECT 1 FROM attempts AS replacement
           WHERE replacement.recovered_from_attempt_id = lost.attempt_id
         )
       ORDER BY lost.updated_at, lost.attempt_id LIMIT ?`,
    ).bind(limit).all<{ attempt_id: string }>();
    const results: GitHubReviewFeedbackRecoveryResult[] = [];
    for (const row of rows.results) {
      try {
        results.push(await this.recoverAttempt(row.attempt_id));
      } catch {
        // A lost Attempt may still be waiting for credential revocation.
      }
    }
    return results;
  }
}

/** Resumes one approval-expired review fix without entering initial scheduling. */
export class GitHubReviewApprovalRecoveryReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recover(recoveryApprovalId: string): Promise<GitHubReviewApprovalRecoveryResult> {
    if (!ID_PATTERN.test(recoveryApprovalId)) {
      throw new Error('GitHub review approval recovery request is invalid');
    }
    const identity = await canonicalSha256({
      source: 'review_approval_recovery',
      recoveryApprovalId,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 48);
    const replacementAttemptId = `attempt_review_approval_recovery_${suffix}`;
    const recoveryId = `review_approval_recovery_${suffix}`;
    const outboxId = `dispatch_review_approval_recovery_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, head_branch, head_sha,
           recovered_from_attempt_id, version, lease_generation, created_at, updated_at
         )
         SELECT ?, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'review_fix', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, failed.plan_id, failed.plan_version,
                failed.plan_item_id, progress.version, NULL, failed.head_sha,
                recovery.root_review_attempt_id, 0, 0, ?, ?
         FROM review_approval_recovery_approvals AS recovery
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
           AND failed.mode = 'review_fix'
           AND failed.plan_item_id = recovery.plan_item_id
           AND failed.head_sha IS NOT NULL
           AND (
             (
               recovery.source_kind = 'failed_dependency'
               AND EXISTS (
                 SELECT 1 FROM review_feedback_attempts AS review_lineage
                 JOIN github_review_feedbacks AS feedback
                   ON feedback.feedback_id = review_lineage.feedback_id
                 WHERE review_lineage.review_attempt_id = recovery.root_review_attempt_id
                   AND feedback.run_id = recovery.run_id
                   AND feedback.plan_id = recovery.plan_id
                   AND feedback.plan_version = recovery.plan_version
                   AND feedback.plan_item_id = recovery.plan_item_id
                   AND feedback.source_head_sha = failed.head_sha
               )
               AND failed.status = 'failed'
               AND EXISTS (
                 SELECT 1 FROM attempt_failures
                 WHERE attempt_failures.attempt_id = failed.attempt_id
                   AND attempt_failures.failure_class = 'tool_error'
                   AND attempt_failures.failure_code = 'tool_unavailable'
                   AND attempt_failures.failure_site = 'external_reconciliation'
                   AND attempt_failures.needed_human_input = 'resolve_external_dependency'
               )
               AND EXISTS (
                 SELECT 1 FROM run_blockers
                 WHERE run_blockers.run_id = recovery.run_id
                   AND run_blockers.reason = 'external_dependency'
                   AND run_blockers.resolved_at IS NOT NULL
                   AND run_blockers.resolution_code = 'repo_write_reapproved'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM github_write_credentials
                 WHERE github_write_credentials.attempt_id = failed.attempt_id
               )
             )
             OR
             (
               recovery.source_kind = 'lost_pre_effect'
               AND EXISTS (
                 SELECT 1 FROM review_feedback_attempts AS review_lineage
                 JOIN github_review_feedbacks AS feedback
                   ON feedback.feedback_id = review_lineage.feedback_id
                 WHERE review_lineage.review_attempt_id = recovery.root_review_attempt_id
                   AND feedback.run_id = recovery.run_id
                   AND feedback.plan_id = recovery.plan_id
                   AND feedback.plan_version = recovery.plan_version
                   AND feedback.plan_item_id = recovery.plan_item_id
                   AND feedback.source_head_sha = failed.head_sha
               )
               AND failed.status = 'lost'
               AND failed.github_status = 'completed'
               AND failed.github_conclusion IS NOT NULL
               AND failed.github_conclusion <> 'success'
               AND EXISTS (
                 SELECT 1 FROM review_approval_recoveries AS prior_recovery
                 WHERE prior_recovery.replacement_attempt_id = failed.attempt_id
                   AND prior_recovery.root_review_attempt_id =
                       recovery.root_review_attempt_id
               )
               AND (
                 SELECT COUNT(*) FROM github_write_credentials
                 WHERE github_write_credentials.attempt_id = failed.attempt_id
               ) = 1
               AND EXISTS (
                 SELECT 1 FROM github_write_credentials
                 WHERE github_write_credentials.attempt_id = failed.attempt_id
                   AND github_write_credentials.status IN ('revoked', 'expired')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM attempt_failures
                 WHERE attempt_failures.attempt_id = failed.attempt_id
               )
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
             )
             OR
             (
               recovery.source_kind = 'automated_fix_failed_pre_effect'
               AND failed.status = 'failed'
               AND failed.recovered_from_attempt_id IS NULL
               AND EXISTS (
                 SELECT 1 FROM attempt_failures AS failure
                 WHERE failure.attempt_id = failed.attempt_id
                   AND failure.failure_class = 'unknown'
                   AND failure.failure_code = 'unknown_failure'
                   AND failure.failure_site = 'external_reconciliation'
                   AND failure.needed_human_input = 'manual_investigation'
               )
               AND EXISTS (
                 SELECT 1
                 FROM automated_review_fix_attempts AS fixes
                 JOIN automated_reviews AS review ON review.review_id = fixes.review_id
                 JOIN pull_request_publications AS publication
                   ON publication.publication_id = review.publication_id
                 WHERE fixes.fix_attempt_id = failed.attempt_id
                   AND review.status = 'changes_requested'
                   AND review.run_id = recovery.run_id
                   AND review.plan_id = recovery.plan_id
                   AND review.plan_version = recovery.plan_version
                   AND review.plan_item_id = recovery.plan_item_id
                   AND review.repository = failed.repository
                   AND review.source_head_sha = failed.head_sha
                   AND fixes.source_head_sha = review.source_head_sha
                   AND fixes.branch = review.branch
                   AND publication.status = 'verified'
                   AND publication.run_id = recovery.run_id
                   AND publication.repository = review.repository
                   AND publication.github_pr_number = review.github_pr_number
                   AND publication.base_branch = review.base_branch
                   AND publication.head_branch = review.branch
                   AND publication.head_sha = review.source_head_sha
                   AND review.source_head_sha = (
                     SELECT updates.head_sha
                     FROM attempt_head_updates AS updates
                     JOIN attempts AS head_attempt
                       ON head_attempt.attempt_id = updates.attempt_id
                     WHERE updates.run_id = recovery.run_id
                       AND updates.plan_id = recovery.plan_id
                       AND updates.branch = review.branch
                     ORDER BY head_attempt.ordinal DESC, updates.created_at DESC LIMIT 1
                   )
               )
               AND (
                 SELECT COUNT(*) FROM github_write_credentials
                 WHERE github_write_credentials.attempt_id = failed.attempt_id
               ) = 1
               AND EXISTS (
                 SELECT 1 FROM github_write_credentials
                 WHERE github_write_credentials.attempt_id = failed.attempt_id
                   AND github_write_credentials.status IN ('revoked', 'expired')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM attempts AS replacement
                 WHERE replacement.recovered_from_attempt_id = failed.attempt_id
               )
             )
           )
           AND (
             recovery.source_kind = 'automated_fix_failed_pre_effect'
             OR EXISTS (
               SELECT 1 FROM outbox AS cancel
               WHERE cancel.run_id = recovery.run_id
                 AND cancel.kind = 'workflow_cancel'
                 AND cancel.delivery_state = 'settled'
             )
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
             SELECT 1 FROM approvals AS rejection
             WHERE rejection.run_id = approval.run_id
               AND rejection.plan_id = approval.plan_id
               AND rejection.plan_version = approval.plan_version
               AND rejection.plan_digest = approval.plan_digest
               AND rejection.base_sha = approval.base_sha
               AND rejection.effect = approval.effect
               AND rejection.decision = 'reject'
               AND rejection.created_at >= approval.created_at
           )
           AND NOT EXISTS (
             SELECT 1 FROM attempt_head_updates
             WHERE attempt_head_updates.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM verification_suites
             WHERE verification_suites.attempt_id = failed.attempt_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM evidence
             WHERE evidence.attempt_id = failed.attempt_id
               AND evidence.kind IN ('commit', 'test')
           )
           AND NOT EXISTS (
             SELECT 1 FROM review_approval_recoveries
             WHERE review_approval_recoveries.recovery_approval_id =
                   recovery.recovery_approval_id
           )
         ON CONFLICT DO NOTHING`,
      ).bind(replacementAttemptId, nowIso, nowIso, nowIso, recoveryApprovalId),
      this.db.prepare(
        `INSERT INTO review_approval_recoveries (
           recovery_id, recovery_approval_id, run_id, plan_id, plan_version,
           plan_item_id, failed_attempt_id, root_review_attempt_id, approval_id,
           replacement_attempt_id, created_at, source_kind
         )
         SELECT ?, recovery.recovery_approval_id, recovery.run_id, recovery.plan_id,
                recovery.plan_version, recovery.plan_item_id,
                recovery.failed_attempt_id, recovery.root_review_attempt_id,
                recovery.approval_id, replacement.attempt_id, ?, recovery.source_kind
         FROM review_approval_recovery_approvals AS recovery
         JOIN attempts AS replacement
           ON replacement.attempt_id = ?
          AND replacement.run_id = recovery.run_id
          AND replacement.plan_id = recovery.plan_id
          AND replacement.plan_version = recovery.plan_version
          AND replacement.plan_item_id = recovery.plan_item_id
          AND replacement.recovered_from_attempt_id = recovery.root_review_attempt_id
          AND replacement.mode = 'review_fix' AND replacement.status = 'pending'
         WHERE recovery.recovery_approval_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(recoveryId, nowIso, replacementAttemptId, recoveryApprovalId),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'in_progress', active_attempt_id = ?,
             version = version + 1, updated_at = ?
         WHERE status = 'ready' AND active_attempt_id IS NULL
           AND EXISTS (
             SELECT 1 FROM review_approval_recoveries
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
             SELECT 1 FROM review_approval_recoveries
             JOIN plan_item_progress
               ON plan_item_progress.plan_id = review_approval_recoveries.plan_id
              AND plan_item_progress.item_id = review_approval_recoveries.plan_item_id
             WHERE review_approval_recoveries.recovery_id = ?
               AND review_approval_recoveries.run_id = runs.run_id
               AND review_approval_recoveries.replacement_attempt_id = ?
               AND plan_item_progress.status = 'in_progress'
               AND plan_item_progress.active_attempt_id = ?
           )`,
      ).bind(nowIso, recoveryId, replacementAttemptId, replacementAttemptId),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, recovery.run_id, 'execution_dispatch', 'github_actions',
                ?, ?, 'pending', ?, ?
         FROM review_approval_recoveries AS recovery
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
        `execution-review-approval-recovery:${recoveryApprovalId}`,
        nowIso,
        nowIso,
        recoveryId,
        replacementAttemptId,
      ),
    ]);
    const persisted = await this.db.prepare(
      `SELECT replacement_attempt_id FROM review_approval_recoveries
       WHERE recovery_approval_id = ?`,
    ).bind(recoveryApprovalId).first<{ replacement_attempt_id: string }>();
    if (persisted === null || persisted.replacement_attempt_id !== replacementAttemptId) {
      throw new Error('GitHub review approval recovery is unavailable');
    }
    return {
      recoveryApprovalId,
      replacementAttemptId,
      created: results[1]?.meta.changes === 1,
    };
  }

  async reconcileBatch(limit = 5): Promise<GitHubReviewApprovalRecoveryResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 25) {
      throw new Error('GitHub review approval recovery limit is invalid');
    }
    const rows = await this.db.prepare(
      `SELECT recovery.recovery_approval_id
       FROM review_approval_recovery_approvals AS recovery
       JOIN runs ON runs.run_id = recovery.run_id
       WHERE runs.state = 'awaiting_approval'
         AND NOT EXISTS (
           SELECT 1 FROM review_approval_recoveries
           WHERE review_approval_recoveries.recovery_approval_id =
                 recovery.recovery_approval_id
         )
       ORDER BY recovery.created_at, recovery.recovery_approval_id LIMIT ?`,
    ).bind(limit).all<{ recovery_approval_id: string }>();
    const results: GitHubReviewApprovalRecoveryResult[] = [];
    for (const row of rows.results) {
      try {
        results.push(await this.recover(row.recovery_approval_id));
      } catch {
        // The approval may have expired or another reconciler may have won.
      }
    }
    return results;
  }
}
