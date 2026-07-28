import { canonicalSha256 } from '../domain/digest.js';
import { SecretScanner } from '../security/redaction.js';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

export interface GitHubReviewFeedbackFact {
  repository: string;
  number: number;
  reviewId: string;
  body: string;
  bodyDigest: string;
  sourceHeadSha: string;
  branch: string;
  baseBranch: string;
  url: string;
  submittedAt: string;
}

export type GitHubReviewFeedbackDisposition = 'applied' | 'duplicate' | 'ignored';

export interface GitHubReviewFeedbackResult {
  disposition: GitHubReviewFeedbackDisposition;
  attemptId?: string;
}

export type GitHubReviewFeedbackErrorCode =
  | 'delivery_conflict'
  | 'review_conflict'
  | 'secret_detected'
  | 'storage_unavailable';

export class GitHubReviewFeedbackError extends Error {
  constructor(readonly code: GitHubReviewFeedbackErrorCode) {
    super(`GitHub review feedback operation failed: ${code}`);
    this.name = 'GitHubReviewFeedbackError';
  }
}

interface ReviewCandidateRow {
  publication_id: string;
  run_id: string;
  run_state: string;
  run_version: number;
  task_revision: string;
  base_sha: string;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
  repository: string;
  base_branch: string;
  head_branch: string;
  github_pr_number: number;
  publication_status: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  prior_attempt_id: string;
  prior_ordinal: number;
  prior_mode: string;
  prior_status: string;
  prior_plan_item_id: string;
  prior_head_sha: string;
  prior_head_branch: string;
  head_update_id: string;
  current_head_sha: string;
  progress_status: string;
  progress_version: number;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
  allow_repository_write: number;
  unresolved_blocker_count: number;
}

interface ApprovalRow {
  approval_id: string;
  decision: string;
  expires_at: string;
  created_at: string;
}

interface DeliveryRow {
  payload_digest: string;
  repository: string;
  github_pr_number: number;
  github_review_id: string;
  reviewed_head_sha: string;
  processing_state: string;
}

interface FeedbackRow {
  feedback_id: string;
  source_delivery_id: string;
  github_review_id: string;
  repository: string;
  github_pr_number: number;
  source_head_sha: string;
  branch: string;
  review_url: string;
  submitted_at: string;
  body_ref: string;
  body_digest: string;
  payload_digest: string;
  review_attempt_id: string | null;
}

interface StoreOptions {
  secrets?: readonly string[];
}

function stableSuffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 52);
}

function safeFact(fact: GitHubReviewFeedbackFact): boolean {
  if (
    !REPOSITORY_PATTERN.test(fact.repository) ||
    !Number.isSafeInteger(fact.number) ||
    fact.number <= 0 ||
    !/^[0-9]+$/.test(fact.reviewId) ||
    fact.body.trim().length === 0 ||
    new TextEncoder().encode(fact.body).length > 65_536 ||
    !DIGEST_PATTERN.test(fact.bodyDigest) ||
    !SHA_PATTERN.test(fact.sourceHeadSha) ||
    !BRANCH_PATTERN.test(fact.branch) ||
    fact.branch.includes('..') ||
    fact.branch.includes('//') ||
    fact.baseBranch.length === 0 ||
    fact.baseBranch.length > 240 ||
    !Number.isFinite(Date.parse(fact.submittedAt))
  ) return false;
  try {
    const url = new URL(fact.url);
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/**
 * Persists an exact-head review as private R2 data and atomically reopens one
 * verified Plan Item into a same-PR review_fix Attempt.
 */
export class GitHubReviewFeedbackStore {
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    options: StoreOptions = {},
  ) {
    this.secrets = [...(options.secrets ?? [])];
  }

  async apply(input: {
    deliveryId: string;
    payloadDigest: string;
    fact: GitHubReviewFeedbackFact;
    receivedAt: string;
  }): Promise<GitHubReviewFeedbackResult> {
    if (
      !/^[A-Fa-f0-9-]{16,64}$/.test(input.deliveryId) ||
      !DIGEST_PATTERN.test(input.payloadDigest) ||
      !safeFact(input.fact) ||
      !Number.isFinite(Date.parse(input.receivedAt)) ||
      await canonicalSha256(input.fact.body) !== input.fact.bodyDigest
    ) {
      throw new GitHubReviewFeedbackError('review_conflict');
    }
    if (new SecretScanner({ secrets: this.secrets }).scanText(input.fact.body).length > 0) {
      throw new GitHubReviewFeedbackError('secret_detected');
    }

    const delivery = await this.delivery(input.deliveryId);
    if (delivery !== null) {
      this.assertDelivery(delivery, input);
      return { disposition: 'duplicate' };
    }
    const existing = await this.feedback(input.fact.reviewId);
    if (existing !== null) {
      this.assertFeedback(existing, input);
      await this.recordDuplicateDelivery(input, existing.feedback_id, input.receivedAt);
      return { disposition: 'duplicate', ...(existing.review_attempt_id === null
        ? {}
        : { attemptId: existing.review_attempt_id }) };
    }

    const candidate = await this.candidate(input.fact.repository, input.fact.number);
    if (candidate === null || !this.candidateEligible(candidate, input.fact)) {
      await this.recordIgnoredDelivery(
        input,
        candidate?.publication_id ?? null,
        candidate !== null && candidate.current_head_sha !== input.fact.sourceHeadSha
          ? 'stale_head'
          : 'publication_not_eligible',
      );
      return { disposition: 'ignored' };
    }
    const approval = await this.approval(candidate);
    if (
      approval === null ||
      approval.decision !== 'approve' ||
      approval.expires_at <= input.receivedAt
    ) {
      await this.recordIgnoredDelivery(input, candidate.publication_id, 'approval_inactive');
      return { disposition: 'ignored' };
    }

    const identity = await canonicalSha256({
      schemaVersion: '1',
      repository: input.fact.repository,
      githubPrNumber: input.fact.number,
      githubReviewId: input.fact.reviewId,
    });
    const suffix = stableSuffix(identity);
    const feedbackId = `review_feedback_${suffix}`;
    const attemptId = `attempt_review_${suffix}`;
    const outboxId = `dispatch_review_${suffix}`;
    const objectKey =
      `review-feedback/${feedbackId}/${input.fact.bodyDigest.slice('sha256:'.length)}.json`;
    const bodyRef = `r2://${objectKey}`;
    const payload = {
      schemaVersion: '1' as const,
      reviewId: input.fact.reviewId,
      body: input.fact.body,
      bodyDigest: input.fact.bodyDigest,
      sourceHeadSha: input.fact.sourceHeadSha,
      branch: input.fact.branch,
      url: input.fact.url,
      submittedAt: input.fact.submittedAt,
    };
    try {
      await this.objects.put(objectKey, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          schemaVersion: '1',
          feedbackId,
          bodyDigest: input.fact.bodyDigest,
          sourceHeadSha: input.fact.sourceHeadSha,
        },
      });
    } catch {
      throw new GitHubReviewFeedbackError('storage_unavailable');
    }

    const nowIso = new Date(input.receivedAt).toISOString();
    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO github_review_webhook_deliveries (
             delivery_id, event_type, payload_digest, repository,
             github_pr_number, github_review_id, publication_id,
             reviewed_head_sha, processing_state, received_at
           ) VALUES (?, 'pull_request_review', ?, ?, ?, ?, ?, ?, 'received', ?)
           ON CONFLICT DO NOTHING`,
        ).bind(
          input.deliveryId,
          input.payloadDigest,
          input.fact.repository,
          input.fact.number,
          input.fact.reviewId,
          candidate.publication_id,
          input.fact.sourceHeadSha,
          nowIso,
        ),
        this.db.prepare(
          `INSERT INTO github_review_feedbacks (
             feedback_id, source_delivery_id, github_review_id, publication_id,
             run_id, expected_run_version, plan_id, plan_version, plan_item_id, prior_attempt_id,
             repository, github_pr_number, source_head_sha, branch, review_url,
             submitted_at, body_ref, body_digest, payload_digest, created_at
           )
           SELECT ?, ?, ?, publications.publication_id, runs.run_id, runs.version + 2,
                  plans.plan_id, plans.plan_version, progress.item_id,
                  prior.attempt_id, publications.repository,
                  publications.github_pr_number, head_updates.head_sha,
                  head_updates.branch, ?, ?, ?, ?, ?, ?
           FROM pull_request_publications AS publications
           JOIN runs ON runs.run_id = publications.run_id
           JOIN tasks ON tasks.task_id = runs.task_id
           JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
           JOIN attempts AS prior ON prior.attempt_id = ?
           JOIN attempt_head_updates AS head_updates
             ON head_updates.update_id = ?
            AND head_updates.attempt_id = prior.attempt_id
           JOIN plan_item_progress AS progress
             ON progress.plan_id = prior.plan_id
            AND progress.item_id = prior.plan_item_id
           JOIN approvals ON approvals.approval_id = ?
           WHERE publications.publication_id = ?
             AND publications.status = 'verified'
             AND publications.repository = ?
             AND publications.github_pr_number = ?
             AND publications.base_branch = ?
             AND publications.head_branch = ?
             AND runs.state = 'pull_request_open' AND runs.version = ?
             AND runs.active_plan_id = prior.plan_id
             AND runs.active_plan_version = prior.plan_version
             AND runs.active_plan_digest = plans.digest
             AND plans.status = 'active'
             AND prior.run_id = runs.run_id
             AND prior.mode IN ('implement', 'review_fix')
             AND prior.status = 'completed'
             AND prior.head_sha = ? AND prior.head_branch = ?
             AND head_updates.head_sha = ? AND head_updates.branch = ?
             AND progress.status = 'passed' AND progress.version = ?
             AND progress.active_attempt_id IS NULL
             AND progress.protected_path_gate_id IS NULL
             AND tasks.allow_repository_write = 1
             AND approvals.run_id = runs.run_id
             AND approvals.task_revision = runs.task_revision
             AND approvals.plan_id = plans.plan_id
             AND approvals.plan_version = plans.plan_version
             AND approvals.plan_digest = plans.digest
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
                 AND (
                   newer.created_at > approvals.created_at OR
                   (newer.created_at = approvals.created_at
                    AND newer.approval_id > approvals.approval_id)
                 )
             )
             AND NOT EXISTS (
               SELECT 1 FROM run_blockers
               WHERE run_blockers.run_id = runs.run_id
                 AND run_blockers.resolved_at IS NULL
             )
           ON CONFLICT DO NOTHING`,
        ).bind(
          feedbackId,
          input.deliveryId,
          input.fact.reviewId,
          input.fact.url,
          input.fact.submittedAt,
          bodyRef,
          input.fact.bodyDigest,
          input.payloadDigest,
          nowIso,
          candidate.prior_attempt_id,
          candidate.head_update_id,
          approval.approval_id,
          candidate.publication_id,
          input.fact.repository,
          input.fact.number,
          input.fact.baseBranch,
          input.fact.branch,
          candidate.run_version,
          input.fact.sourceHeadSha,
          input.fact.branch,
          input.fact.sourceHeadSha,
          input.fact.branch,
          candidate.progress_version,
          nowIso,
        ),
        this.db.prepare(
          `UPDATE runs SET state = 'awaiting_review', version = version + 1, updated_at = ?
           WHERE run_id = ? AND state = 'pull_request_open' AND version = ?
             AND EXISTS (
               SELECT 1 FROM github_review_feedbacks
               WHERE feedback_id = ? AND source_delivery_id = ?
                 AND run_id = runs.run_id
             )`,
        ).bind(nowIso, candidate.run_id, candidate.run_version, feedbackId, input.deliveryId),
        this.db.prepare(
          `INSERT INTO attempts (
             attempt_id, run_id, ordinal, mode, status, base_sha, repository,
             workflow_ref, plan_id, plan_version, plan_item_id,
             claimed_progress_version, head_branch, head_sha,
             version, lease_generation, created_at, updated_at
           )
           SELECT ?, prior.run_id,
                  (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                   FROM attempts AS existing WHERE existing.run_id = prior.run_id),
                  'review_fix', 'pending', prior.base_sha, prior.repository,
                  prior.workflow_ref, prior.plan_id, prior.plan_version,
                  prior.plan_item_id, progress.version, NULL,
                  feedback.source_head_sha, 0, 0, ?, ?
           FROM github_review_feedbacks AS feedback
           JOIN attempts AS prior ON prior.attempt_id = feedback.prior_attempt_id
           JOIN runs ON runs.run_id = feedback.run_id
           JOIN execution_plans AS plans ON plans.plan_id = feedback.plan_id
           JOIN plan_item_progress AS progress
             ON progress.plan_id = feedback.plan_id
            AND progress.item_id = feedback.plan_item_id
           WHERE feedback.feedback_id = ?
             AND feedback.source_delivery_id = ?
             AND runs.state = 'awaiting_review' AND runs.version = ?
             AND runs.active_plan_id = feedback.plan_id
             AND runs.active_plan_version = feedback.plan_version
             AND plans.status = 'active'
             AND prior.status = 'completed'
             AND prior.head_sha = feedback.source_head_sha
             AND prior.head_branch = feedback.branch
             AND progress.status = 'passed' AND progress.version = ?
             AND progress.active_attempt_id IS NULL
             AND progress.protected_path_gate_id IS NULL
           ON CONFLICT DO NOTHING`,
        ).bind(
          attemptId,
          nowIso,
          nowIso,
          feedbackId,
          input.deliveryId,
          candidate.run_version + 1,
          candidate.progress_version,
        ),
        this.db.prepare(
          `INSERT INTO review_feedback_attempts (
             feedback_id, review_attempt_id, prior_attempt_id,
             branch, source_head_sha, created_at
           )
           SELECT feedback.feedback_id, review_attempt.attempt_id,
                  feedback.prior_attempt_id, feedback.branch,
                  feedback.source_head_sha, ?
           FROM github_review_feedbacks AS feedback
           JOIN attempts AS review_attempt ON review_attempt.attempt_id = ?
           WHERE feedback.feedback_id = ?
             AND feedback.source_delivery_id = ?
             AND review_attempt.run_id = feedback.run_id
             AND review_attempt.plan_id = feedback.plan_id
             AND review_attempt.plan_version = feedback.plan_version
             AND review_attempt.plan_item_id = feedback.plan_item_id
             AND review_attempt.mode = 'review_fix'
             AND review_attempt.status = 'pending'
             AND review_attempt.head_sha = feedback.source_head_sha
             AND review_attempt.head_branch IS NULL
           ON CONFLICT DO NOTHING`,
        ).bind(nowIso, attemptId, feedbackId, input.deliveryId),
        this.db.prepare(
          `UPDATE plan_item_progress
           SET status = 'in_progress', active_attempt_id = ?,
               version = version + 1, updated_at = ?
           WHERE plan_id = ? AND item_id = ?
             AND status = 'passed' AND version = ?
             AND active_attempt_id IS NULL AND protected_path_gate_id IS NULL
             AND EXISTS (
               SELECT 1 FROM review_feedback_attempts
               WHERE feedback_id = ? AND review_attempt_id = ?
             )`,
        ).bind(
          attemptId,
          nowIso,
          candidate.plan_id,
          candidate.prior_plan_item_id,
          candidate.progress_version,
          feedbackId,
          attemptId,
        ),
        this.db.prepare(
          `UPDATE runs SET state = 'executing', version = version + 1, updated_at = ?
           WHERE run_id = ? AND state = 'awaiting_review' AND version = ?
             AND EXISTS (
               SELECT 1
               FROM review_feedback_attempts
               JOIN github_review_feedbacks
                 ON github_review_feedbacks.feedback_id = review_feedback_attempts.feedback_id
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = github_review_feedbacks.plan_id
                AND plan_item_progress.item_id = github_review_feedbacks.plan_item_id
               WHERE review_feedback_attempts.feedback_id = ?
                 AND review_feedback_attempts.review_attempt_id = ?
                 AND github_review_feedbacks.run_id = runs.run_id
                 AND plan_item_progress.status = 'in_progress'
                 AND plan_item_progress.active_attempt_id = ?
             )`,
        ).bind(
          nowIso,
          candidate.run_id,
          candidate.run_version + 1,
          feedbackId,
          attemptId,
          attemptId,
        ),
        this.db.prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, feedback.run_id, 'execution_dispatch', 'github_actions',
                  ?, ?, 'pending', ?, ?
           FROM github_review_feedbacks AS feedback
           JOIN review_feedback_attempts
             ON review_feedback_attempts.feedback_id = feedback.feedback_id
            AND review_feedback_attempts.review_attempt_id = ?
           JOIN runs ON runs.run_id = feedback.run_id
           JOIN plan_item_progress AS progress
             ON progress.plan_id = feedback.plan_id
            AND progress.item_id = feedback.plan_item_id
           WHERE feedback.feedback_id = ?
             AND runs.state = 'executing' AND runs.version = ?
             AND progress.status = 'in_progress'
             AND progress.active_attempt_id = ?
           ON CONFLICT DO NOTHING`,
        ).bind(
          outboxId,
          `d1://attempts/${attemptId}`,
          `execution-review:${feedbackId}`,
          nowIso,
          nowIso,
          attemptId,
          feedbackId,
          candidate.run_version + 2,
          attemptId,
        ),
        this.db.prepare(
          `UPDATE github_review_webhook_deliveries
           SET processing_state = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM github_review_feedbacks
                   WHERE source_delivery_id = github_review_webhook_deliveries.delivery_id
                 ) THEN 'applied'
                 ELSE 'ignored'
               END,
               ignore_reason = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM github_review_feedbacks
                   WHERE source_delivery_id = github_review_webhook_deliveries.delivery_id
                 ) THEN NULL
                 WHEN EXISTS (
                   SELECT 1 FROM github_review_feedbacks
                   WHERE github_review_id = github_review_webhook_deliveries.github_review_id
                 ) THEN 'duplicate_review'
                 ELSE 'state_conflict'
               END,
               processed_at = ?
           WHERE delivery_id = ? AND payload_digest = ?`,
        ).bind(nowIso, input.deliveryId, input.payloadDigest),
      ]);
    } catch {
      // R2 and D1 cannot share a transaction. The key is digest-addressed, so
      // keep it for reconciliation rather than deleting an object that a
      // concurrent identical delivery may already reference.
      throw new GitHubReviewFeedbackError('review_conflict');
    }

    const persisted = await this.feedback(input.fact.reviewId);
    if (persisted === null) {
      await this.safeDelete(objectKey);
      return { disposition: 'ignored' };
    }
    try {
      this.assertFeedback(persisted, input);
    } catch (error) {
      if (persisted.body_ref !== bodyRef) await this.safeDelete(objectKey);
      throw error;
    }
    if (persisted.body_ref !== bodyRef) {
      await this.safeDelete(objectKey);
      throw new GitHubReviewFeedbackError('review_conflict');
    }
    const disposition = persisted.source_delivery_id === input.deliveryId
      ? 'applied' as const
      : 'duplicate' as const;
    return {
      disposition,
      ...(persisted.review_attempt_id === null ? {} : { attemptId: persisted.review_attempt_id }),
    };
  }

  private async delivery(deliveryId: string): Promise<DeliveryRow | null> {
    return await this.db.prepare(
      `SELECT payload_digest, repository, github_pr_number, github_review_id,
              reviewed_head_sha, processing_state
       FROM github_review_webhook_deliveries WHERE delivery_id = ?`,
    ).bind(deliveryId).first<DeliveryRow>();
  }

  private assertDelivery(
    row: DeliveryRow,
    input: { payloadDigest: string; fact: GitHubReviewFeedbackFact },
  ): void {
    if (
      row.payload_digest !== input.payloadDigest ||
      row.repository !== input.fact.repository ||
      row.github_pr_number !== input.fact.number ||
      row.github_review_id !== input.fact.reviewId ||
      row.reviewed_head_sha !== input.fact.sourceHeadSha
    ) throw new GitHubReviewFeedbackError('delivery_conflict');
  }

  private async feedback(reviewId: string): Promise<FeedbackRow | null> {
    return await this.db.prepare(
      `SELECT feedback.feedback_id, feedback.source_delivery_id,
              feedback.github_review_id, feedback.repository,
              feedback.github_pr_number, feedback.source_head_sha,
              feedback.branch, feedback.review_url, feedback.submitted_at,
              feedback.body_ref, feedback.body_digest, feedback.payload_digest,
              lineage.review_attempt_id
       FROM github_review_feedbacks AS feedback
       LEFT JOIN review_feedback_attempts AS lineage
         ON lineage.feedback_id = feedback.feedback_id
       WHERE feedback.github_review_id = ?`,
    ).bind(reviewId).first<FeedbackRow>();
  }

  private assertFeedback(
    row: FeedbackRow,
    input: { payloadDigest: string; fact: GitHubReviewFeedbackFact },
  ): void {
    if (
      row.github_review_id !== input.fact.reviewId ||
      row.repository !== input.fact.repository ||
      row.github_pr_number !== input.fact.number ||
      row.source_head_sha !== input.fact.sourceHeadSha ||
      row.branch !== input.fact.branch ||
      row.review_url !== input.fact.url ||
      row.submitted_at !== input.fact.submittedAt ||
      row.body_digest !== input.fact.bodyDigest
    ) throw new GitHubReviewFeedbackError('review_conflict');
  }

  private async candidate(repository: string, number: number): Promise<ReviewCandidateRow | null> {
    return await this.db.prepare(
      `SELECT publications.publication_id, runs.run_id,
              runs.state AS run_state, runs.version AS run_version,
              runs.task_revision, runs.base_sha, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              publications.repository, publications.base_branch,
              publications.head_branch, publications.github_pr_number,
              publications.status AS publication_status,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              plans.status AS plan_status,
              prior.attempt_id AS prior_attempt_id,
              prior.ordinal AS prior_ordinal, prior.mode AS prior_mode,
              prior.status AS prior_status,
              prior.plan_item_id AS prior_plan_item_id,
              prior.head_sha AS prior_head_sha,
              prior.head_branch AS prior_head_branch,
              head_updates.update_id AS head_update_id,
              head_updates.head_sha AS current_head_sha,
              progress.status AS progress_status,
              progress.version AS progress_version,
              progress.active_attempt_id, progress.protected_path_gate_id,
              tasks.allow_repository_write,
              (SELECT COUNT(*) FROM run_blockers
               WHERE run_blockers.run_id = runs.run_id
                 AND run_blockers.resolved_at IS NULL) AS unresolved_blocker_count
       FROM pull_request_publications AS publications
       JOIN runs ON runs.run_id = publications.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN attempt_head_updates AS head_updates
         ON head_updates.update_id = (
           SELECT candidate_updates.update_id
           FROM attempt_head_updates AS candidate_updates
           JOIN attempts AS candidate_attempt
             ON candidate_attempt.attempt_id = candidate_updates.attempt_id
           WHERE candidate_updates.run_id = runs.run_id
             AND candidate_updates.plan_id = plans.plan_id
             AND candidate_updates.branch = publications.head_branch
           ORDER BY candidate_attempt.ordinal DESC, candidate_updates.created_at DESC
           LIMIT 1
         )
       JOIN attempts AS prior ON prior.attempt_id = head_updates.attempt_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = prior.plan_id
        AND progress.item_id = prior.plan_item_id
       WHERE publications.repository = ?
         AND publications.github_pr_number = ?
         AND publications.status = 'verified'`,
    ).bind(repository, number).first<ReviewCandidateRow>();
  }

  private candidateEligible(row: ReviewCandidateRow, fact: GitHubReviewFeedbackFact): boolean {
    return row.publication_status === 'verified' &&
      row.repository === fact.repository &&
      row.github_pr_number === fact.number &&
      row.base_branch === fact.baseBranch &&
      row.head_branch === fact.branch &&
      row.run_state === 'pull_request_open' &&
      row.base_sha !== null &&
      row.active_plan_id === row.plan_id &&
      row.active_plan_version === row.plan_version &&
      row.active_plan_digest === row.plan_digest &&
      row.plan_status === 'active' &&
      (row.prior_mode === 'implement' || row.prior_mode === 'review_fix') &&
      row.prior_status === 'completed' &&
      row.prior_head_sha === fact.sourceHeadSha &&
      row.prior_head_branch === fact.branch &&
      row.current_head_sha === fact.sourceHeadSha &&
      row.progress_status === 'passed' &&
      row.active_attempt_id === null &&
      row.protected_path_gate_id === null &&
      row.allow_repository_write === 1 &&
      row.unresolved_blocker_count === 0;
  }

  private async approval(candidate: ReviewCandidateRow): Promise<ApprovalRow | null> {
    return await this.db.prepare(
      `SELECT approval_id, decision, expires_at, created_at
       FROM approvals
       WHERE run_id = ? AND task_revision = ? AND plan_id = ?
         AND plan_version = ? AND plan_digest = ? AND base_sha = ?
         AND effect = 'repo_write'
         AND NOT EXISTS (
           SELECT 1 FROM invalidated_approvals
           WHERE invalidated_approvals.approval_id = approvals.approval_id
         )
       ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
    ).bind(
      candidate.run_id,
      candidate.task_revision,
      candidate.plan_id,
      candidate.plan_version,
      candidate.plan_digest,
      candidate.base_sha,
    ).first<ApprovalRow>();
  }

  private async recordIgnoredDelivery(
    input: { deliveryId: string; payloadDigest: string; fact: GitHubReviewFeedbackFact; receivedAt: string },
    publicationId: string | null,
    reason: string,
  ): Promise<void> {
    const result = await this.db.prepare(
      `INSERT INTO github_review_webhook_deliveries (
         delivery_id, event_type, payload_digest, repository,
         github_pr_number, github_review_id, publication_id,
         reviewed_head_sha, processing_state, ignore_reason,
         received_at, processed_at
       ) VALUES (?, 'pull_request_review', ?, ?, ?, ?, ?, ?, 'ignored', ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      input.deliveryId,
      input.payloadDigest,
      input.fact.repository,
      input.fact.number,
      input.fact.reviewId,
      publicationId,
      input.fact.sourceHeadSha,
      reason,
      input.receivedAt,
      input.receivedAt,
    ).run();
    if (result.meta.changes !== 1) {
      const existing = await this.delivery(input.deliveryId);
      if (existing === null) throw new GitHubReviewFeedbackError('delivery_conflict');
      this.assertDelivery(existing, input);
    }
  }

  private async recordDuplicateDelivery(
    input: { deliveryId: string; payloadDigest: string; fact: GitHubReviewFeedbackFact },
    feedbackId: string,
    receivedAt: string,
  ): Promise<void> {
    const publication = await this.db.prepare(
      'SELECT publication_id FROM github_review_feedbacks WHERE feedback_id = ?',
    ).bind(feedbackId).first<{ publication_id: string }>();
    await this.recordIgnoredDelivery(
      { ...input, receivedAt },
      publication?.publication_id ?? null,
      'duplicate_review',
    );
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.objects.delete(key);
    } catch {
      // A losing, digest-addressed object is harmless and must not mask the D1 result.
    }
  }
}
