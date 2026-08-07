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
           AND runs.state = 'executing'
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
         AND runs.state = 'executing'
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
