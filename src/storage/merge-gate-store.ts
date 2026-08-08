import { z } from 'zod';
import {
  GitHubMergeGateFactSchema,
  type GitHubMergeGateFact,
} from '../domain/github-merge-gate.js';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const EvaluateMergeGateInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  fact: GitHubMergeGateFactSchema,
  observedAt: z.iso.datetime({ offset: true }),
}).strict();

export type MergeGateRejectionReason =
  | 'required_checks_incomplete'
  | 'required_checks_failed'
  | 'review_insufficient'
  | 'base_not_latest'
  | 'head_not_latest'
  | 'approval_required'
  | 'approval_identity_unresolved'
  | 'self_approval_denied'
  | 'policy_unavailable'
  | 'mergeability_unavailable';

export type MergeGateEvaluationResult =
  | {
      disposition: 'ready_to_merge' | 'duplicate';
      decisionId: string;
      observationId: string;
      evaluationId: string;
      runVersion: number;
    }
  | {
      disposition: 'rejected';
      reason: MergeGateRejectionReason;
      observationId: string;
      evaluationId: string;
    };

export type MergeGateErrorCode = 'invalid_request' | 'not_found' | 'state_conflict';

export class MergeGateError extends Error {
  constructor(readonly code: MergeGateErrorCode) {
    super(`merge gate evaluation failed: ${code}`);
    this.name = 'MergeGateError';
  }
}

interface CandidateRow {
  run_id: string;
  run_state: string;
  run_version: number;
  task_revision: string;
  run_base_sha: string;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
  plan_status: string;
  plan_base_sha: string;
  publication_id: string;
  publication_status: string;
  publication_evidence_id: string | null;
  repository: string;
  github_pr_number: number | null;
  head_branch: string;
  publication_head_sha: string;
  base_branch: string;
  current_head_sha: string | null;
  current_head_branch: string | null;
  automated_review_status: string | null;
  incomplete_required_count: number;
  has_merge_effect: number;
}

interface ApprovalRow {
  approval_id: string;
  decision: string;
  expires_at: string;
  created_at: string;
  invalidated: number;
  identity_trusted: number;
  approver_principal: string | null;
  author_principal: string | null;
}

interface DecisionRow {
  decision_id: string;
  observation_id: string;
  evaluation_id: string;
  run_version: number;
}

interface ObservationRow {
  observation_id: string;
  fact_digest: string;
}

/**
 * Persists external merge facts and advances only to ready_to_merge.
 * The actual merge producer is intentionally a later, separately approved effect.
 */
export class MergeGateStore {
  constructor(private readonly db: D1Database) {}

  async evaluate(rawInput: unknown, now = new Date()): Promise<MergeGateEvaluationResult> {
    const parsed = EvaluateMergeGateInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new MergeGateError('invalid_request');
    const input = parsed.data;
    const existing = await this.existingDecision(input.runId);
    if (existing !== null) return this.decisionResult(existing, 'duplicate');
    const candidate = await this.candidate(input.runId);
    if (candidate === null) {
      const run = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(input.runId).first<{ run_id: string }>();
      throw new MergeGateError(run === null ? 'not_found' : 'state_conflict');
    }
    if (
      candidate.run_version !== input.expectedRunVersion ||
      (candidate.run_state !== 'pull_request_open' && candidate.run_state !== 'awaiting_review') ||
      candidate.plan_status !== 'active' ||
      candidate.plan_base_sha !== candidate.run_base_sha ||
      candidate.publication_status !== 'verified' ||
      candidate.publication_evidence_id === null ||
      candidate.github_pr_number === null ||
      candidate.incomplete_required_count !== 0 ||
      candidate.has_merge_effect !== 1 ||
      input.fact.repository !== candidate.repository ||
      input.fact.number !== candidate.github_pr_number ||
      input.fact.headBranch !== candidate.head_branch ||
      input.fact.baseBranch !== candidate.base_branch
    ) throw new MergeGateError('state_conflict');

    const approval = await this.approval(candidate);
    const reason = this.rejectionReason(candidate, input.fact, approval, now);
    const factDigest = await canonicalSha256(input.fact);
    const observationId = `merge_obs_${this.suffix(await canonicalSha256({
      runId: input.runId,
      runVersion: input.expectedRunVersion,
      publicationId: candidate.publication_id,
      factDigest,
    }), 48)}`;
    await this.recordObservation(candidate, input.fact, factDigest, observationId, input.observedAt);

    const approvalSnapshot = approval === null ? null : {
      id: approval.approval_id,
      decision: approval.decision,
      expiresAt: approval.expires_at,
      createdAt: approval.created_at,
    };
    const evaluationId = `merge_eval_${this.suffix(await canonicalSha256({
      observationId,
      runVersion: input.expectedRunVersion,
      reason,
      approval: approvalSnapshot,
    }), 47)}`;
    if (reason !== null) {
      await this.recordRejectedEvaluation(
        candidate,
        observationId,
        evaluationId,
        approval?.approval_id ?? null,
        reason,
        now,
      );
      return { disposition: 'rejected', reason, observationId, evaluationId };
    }
    if (approval === null) throw new MergeGateError('state_conflict');
    const decisionId = `merge_gate_${this.suffix(await canonicalSha256({
      evaluationId,
      approvalId: approval.approval_id,
      headSha: input.fact.headSha,
      baseSha: input.fact.baseSha,
    }), 47)}`;
    const nowIso = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO merge_gate_evaluations (
           evaluation_id, run_id, run_version, publication_id, observation_id,
           plan_id, plan_version, plan_digest, approval_id, status,
           rejection_reason, created_at
         )
         SELECT ?, runs.run_id, runs.version, ?, ?, plans.plan_id,
                plans.plan_version, plans.digest, ?, 'passed', NULL, ?
         FROM runs
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN trusted_effect_approvals AS approvals ON approvals.approval_id = ?
         WHERE runs.run_id = ? AND runs.version = ?
           AND runs.state IN ('pull_request_open', 'awaiting_review')
           AND runs.base_sha = ?
           AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
           AND plans.status = 'active' AND plans.base_sha = runs.base_sha
           AND approvals.run_id = runs.run_id
           AND approvals.task_revision = ?
           AND approvals.plan_id = plans.plan_id
           AND approvals.plan_version = plans.plan_version
           AND approvals.plan_digest = plans.digest
           AND approvals.base_sha = runs.base_sha
           AND approvals.effect = 'merge' AND approvals.decision = 'approve'
           AND approvals.expires_at > ?
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
           AND EXISTS (
             SELECT 1
             FROM github_merge_gate_observations AS observations
             JOIN pull_request_publications AS publications
               ON publications.publication_id = observations.publication_id
             WHERE observations.observation_id = ?
               AND observations.run_id = runs.run_id
               AND observations.run_version = runs.version
               AND observations.publication_id = ?
               AND observations.repository = publications.repository
               AND observations.github_pr_number = publications.github_pr_number
               AND observations.head_branch = publications.head_branch
               AND observations.base_branch = publications.base_branch
               AND observations.base_sha = runs.base_sha
               AND observations.pull_request_base_sha = observations.base_sha
               AND observations.pull_request_state = 'open'
               AND observations.is_draft = 0
               AND observations.mergeability = 'mergeable'
               AND observations.merge_state IN ('clean', 'unstable')
               AND observations.review_decision = 'approved'
               AND observations.required_approval_count > 0
               AND observations.approved_review_count >= observations.required_approval_count
               AND observations.required_check_count > 0
               AND observations.passed_check_count = observations.required_check_count
               AND observations.pending_check_count = 0
               AND observations.failed_check_count = 0
               AND observations.missing_check_count = 0
               AND publications.status = 'verified'
               AND publications.evidence_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM automated_reviews
                 WHERE automated_reviews.run_id = runs.run_id
                   AND automated_reviews.publication_id = publications.publication_id
                   AND automated_reviews.plan_id = plans.plan_id
                   AND automated_reviews.plan_version = plans.plan_version
                   AND automated_reviews.source_head_sha = observations.head_sha
                   AND automated_reviews.status <> 'approved'
               )
               AND observations.head_sha = (
                 SELECT attempts.head_sha FROM attempts
                 WHERE attempts.run_id = runs.run_id
                   AND attempts.plan_id = plans.plan_id
                   AND attempts.plan_version = plans.plan_version
                   AND attempts.status = 'completed'
                   AND attempts.mode IN ('implement', 'review_fix')
                   AND attempts.head_branch = publications.head_branch
                 ORDER BY attempts.ordinal DESC LIMIT 1
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
               AND EXISTS (
                 SELECT 1 FROM plan_item_effects
                 WHERE plan_item_effects.plan_id = plans.plan_id
                   AND plan_item_effects.effect = 'merge'
               )
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        evaluationId,
        candidate.publication_id,
        observationId,
        approval.approval_id,
        nowIso,
        approval.approval_id,
        candidate.run_id,
        candidate.run_version,
        candidate.run_base_sha,
        candidate.active_plan_version,
        candidate.active_plan_digest,
        candidate.task_revision,
        nowIso,
        observationId,
        candidate.publication_id,
      ),
      this.db.prepare(
        `INSERT INTO merge_gate_decisions (
           decision_id, run_id, run_version, publication_id, observation_id,
           evaluation_id, plan_id, plan_version, plan_digest, approval_id,
           head_sha, base_sha, status, created_at
         )
         SELECT ?, evaluations.run_id, evaluations.run_version,
                evaluations.publication_id, evaluations.observation_id,
                evaluations.evaluation_id, evaluations.plan_id,
                evaluations.plan_version, evaluations.plan_digest,
                evaluations.approval_id, ?, ?, 'passed', ?
         FROM merge_gate_evaluations AS evaluations
         WHERE evaluations.evaluation_id = ? AND evaluations.status = 'passed'
         ON CONFLICT DO NOTHING`,
      ).bind(decisionId, input.fact.headSha, input.fact.baseSha, nowIso, evaluationId),
      this.db.prepare(
        `UPDATE runs SET state = 'ready_to_merge', version = version + 1, updated_at = ?
         WHERE run_id = ? AND version = ?
           AND state IN ('pull_request_open', 'awaiting_review')
           AND base_sha = ? AND active_plan_id = ?
           AND active_plan_version = ? AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM merge_gate_decisions
             WHERE decision_id = ? AND run_id = runs.run_id
               AND run_version = runs.version AND head_sha = ? AND base_sha = runs.base_sha
           )`,
      ).bind(
        nowIso,
        candidate.run_id,
        candidate.run_version,
        candidate.run_base_sha,
        candidate.active_plan_id,
        candidate.active_plan_version,
        candidate.active_plan_digest,
        decisionId,
        input.fact.headSha,
      ),
    ]);
    const persisted = await this.existingDecision(input.runId);
    if (persisted === null) throw new MergeGateError('state_conflict');
    return this.decisionResult(
      persisted,
      results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1
        ? 'ready_to_merge'
        : 'duplicate',
    );
  }

  private rejectionReason(
    candidate: CandidateRow,
    fact: GitHubMergeGateFact,
    approval: ApprovalRow | null,
    now: Date,
  ): MergeGateRejectionReason | null {
    if (fact.baseSha !== candidate.run_base_sha || fact.pullRequestBaseSha !== fact.baseSha) {
      return 'base_not_latest';
    }
    if (
      fact.headSha !== candidate.current_head_sha ||
      fact.headBranch !== candidate.current_head_branch
    ) return 'head_not_latest';
    if (fact.requiredChecks.length === 0 || fact.requiredApprovals <= 0) {
      return 'policy_unavailable';
    }
    if (fact.requiredChecks.some((check) => check.state === 'failed')) {
      return 'required_checks_failed';
    }
    if (fact.requiredChecks.some((check) => check.state === 'missing' || check.state === 'pending')) {
      return 'required_checks_incomplete';
    }
    if (
      fact.reviewDecision !== 'approved' ||
      fact.approvedReviewCount < fact.requiredApprovals
    ) return 'review_insufficient';
    if (
      candidate.automated_review_status !== null &&
      candidate.automated_review_status !== 'approved'
    ) return 'review_insufficient';
    if (
      fact.state !== 'open' || fact.draft || fact.mergeability !== 'mergeable' ||
      (fact.mergeState !== 'clean' && fact.mergeState !== 'unstable')
    ) return 'mergeability_unavailable';
    if (
      approval === null || approval.invalidated === 1 || approval.decision !== 'approve' ||
      !Number.isFinite(Date.parse(approval.expires_at)) ||
      approval.expires_at <= now.toISOString()
    ) return 'approval_required';
    if (
      approval.identity_trusted !== 1 || approval.approver_principal === null ||
      approval.author_principal === null
    ) return 'approval_identity_unresolved';
    if (approval.approver_principal === approval.author_principal) {
      return 'self_approval_denied';
    }
    return null;
  }

  private async recordObservation(
    candidate: CandidateRow,
    fact: GitHubMergeGateFact,
    factDigest: string,
    observationId: string,
    observedAt: string,
  ): Promise<void> {
    const counts = new Map<string, number>([
      ['passed', 0], ['pending', 0], ['failed', 0], ['missing', 0],
    ]);
    for (const check of fact.requiredChecks) {
      counts.set(check.state, (counts.get(check.state) ?? 0) + 1);
    }
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO github_merge_gate_observations (
           observation_id, run_id, run_version, publication_id, fact_digest,
           repository, github_pr_number, head_branch, head_sha, base_branch,
           pull_request_author_login, base_sha, pull_request_base_sha,
           pull_request_state, is_draft,
           mergeability, merge_state, review_decision,
           required_approval_count, approved_review_count,
           required_check_count, passed_check_count, pending_check_count,
           failed_check_count, missing_check_count, policy_digest, checks_digest,
           reviews_digest, external_updated_at, observed_at, created_at
         )
         SELECT ?, runs.run_id, runs.version, publications.publication_id, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?
         FROM runs
         JOIN pull_request_publications AS publications
           ON publications.run_id = runs.run_id
         WHERE runs.run_id = ? AND runs.version = ?
           AND runs.state IN ('pull_request_open', 'awaiting_review')
           AND publications.publication_id = ? AND publications.status = 'verified'
         ON CONFLICT DO NOTHING`,
      ).bind(
        observationId,
        factDigest,
        fact.repository,
        fact.number,
        fact.headBranch,
        fact.headSha,
        fact.baseBranch,
        fact.pullRequestAuthorLogin,
        fact.baseSha,
        fact.pullRequestBaseSha,
        fact.state,
        fact.draft ? 1 : 0,
        fact.mergeability,
        fact.mergeState,
        fact.reviewDecision,
        fact.requiredApprovals,
        fact.approvedReviewCount,
        fact.requiredChecks.length,
        counts.get('passed') ?? 0,
        counts.get('pending') ?? 0,
        counts.get('failed') ?? 0,
        counts.get('missing') ?? 0,
        fact.policyDigest,
        fact.checksDigest,
        fact.reviewsDigest,
        fact.externalUpdatedAt,
        observedAt,
        observedAt,
        candidate.run_id,
        candidate.run_version,
        candidate.publication_id,
      ),
      ...fact.requiredChecks.map((check, position) => this.db.prepare(
        `INSERT INTO github_merge_gate_required_checks (
           observation_id, position, context, integration_id, state
         )
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM github_merge_gate_observations WHERE observation_id = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        observationId,
        position,
        check.context,
        check.integrationId,
        check.state,
        observationId,
      )),
    ];
    await this.db.batch(statements);
    const persisted = await this.db.prepare(
      `SELECT observation_id, fact_digest FROM github_merge_gate_observations
       WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
    if (persisted?.fact_digest !== factDigest) throw new MergeGateError('state_conflict');
    const checks = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM github_merge_gate_required_checks
       WHERE observation_id = ?`,
    ).bind(observationId).first<{ count: number }>();
    if (checks?.count !== fact.requiredChecks.length) throw new MergeGateError('state_conflict');
  }

  private async recordRejectedEvaluation(
    candidate: CandidateRow,
    observationId: string,
    evaluationId: string,
    approvalId: string | null,
    reason: MergeGateRejectionReason,
    now: Date,
  ): Promise<void> {
    await this.db.prepare(
      `INSERT INTO merge_gate_evaluations (
         evaluation_id, run_id, run_version, publication_id, observation_id,
         plan_id, plan_version, plan_digest, approval_id, status,
         rejection_reason, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM github_merge_gate_observations
         WHERE observation_id = ? AND run_id = ? AND run_version = ?
       )
       ON CONFLICT DO NOTHING`,
    ).bind(
      evaluationId,
      candidate.run_id,
      candidate.run_version,
      candidate.publication_id,
      observationId,
      candidate.active_plan_id,
      candidate.active_plan_version,
      candidate.active_plan_digest,
      approvalId,
      reason,
      now.toISOString(),
      observationId,
      candidate.run_id,
      candidate.run_version,
    ).run();
    const persisted = await this.db.prepare(
      `SELECT rejection_reason FROM merge_gate_evaluations WHERE evaluation_id = ?`,
    ).bind(evaluationId).first<{ rejection_reason: string | null }>();
    if (persisted?.rejection_reason !== reason) throw new MergeGateError('state_conflict');
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.task_revision, runs.base_sha AS run_base_sha,
              runs.active_plan_id, runs.active_plan_version,
              runs.active_plan_digest, plans.status AS plan_status,
              plans.base_sha AS plan_base_sha,
              publications.publication_id,
              publications.status AS publication_status,
              publications.evidence_id AS publication_evidence_id,
              publications.repository, publications.github_pr_number,
              publications.head_branch, publications.head_sha AS publication_head_sha,
              publications.base_branch,
              (SELECT attempts.head_sha FROM attempts
               WHERE attempts.run_id = runs.run_id
                 AND attempts.plan_id = plans.plan_id
                 AND attempts.plan_version = plans.plan_version
                 AND attempts.status = 'completed'
                 AND attempts.mode IN ('implement', 'review_fix')
                 AND attempts.head_branch = publications.head_branch
               ORDER BY attempts.ordinal DESC LIMIT 1) AS current_head_sha,
              (SELECT attempts.head_branch FROM attempts
               WHERE attempts.run_id = runs.run_id
                 AND attempts.plan_id = plans.plan_id
                 AND attempts.plan_version = plans.plan_version
                 AND attempts.status = 'completed'
                 AND attempts.mode IN ('implement', 'review_fix')
                 AND attempts.head_branch = publications.head_branch
               ORDER BY attempts.ordinal DESC LIMIT 1) AS current_head_branch,
              (SELECT automated_reviews.status FROM automated_reviews
               WHERE automated_reviews.run_id = runs.run_id
                 AND automated_reviews.publication_id = publications.publication_id
                 AND automated_reviews.plan_id = plans.plan_id
                 AND automated_reviews.plan_version = plans.plan_version
                 AND automated_reviews.source_head_sha = (
                   SELECT attempts.head_sha FROM attempts
                   WHERE attempts.run_id = runs.run_id
                     AND attempts.plan_id = plans.plan_id
                     AND attempts.plan_version = plans.plan_version
                     AND attempts.status = 'completed'
                     AND attempts.mode IN ('implement', 'review_fix')
                     AND attempts.head_branch = publications.head_branch
                   ORDER BY attempts.ordinal DESC LIMIT 1
                 )
               ORDER BY automated_reviews.iteration DESC LIMIT 1)
                AS automated_review_status,
              (SELECT COUNT(*) FROM plan_items
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = plan_items.plan_id
                AND plan_item_progress.item_id = plan_items.item_id
               WHERE plan_items.plan_id = plans.plan_id
                 AND plan_items.required = 1
                 AND plan_item_progress.status <> 'passed') AS incomplete_required_count,
              EXISTS (
                SELECT 1 FROM plan_item_effects
                WHERE plan_item_effects.plan_id = plans.plan_id
                  AND plan_item_effects.effect = 'merge'
              ) AS has_merge_effect
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN pull_request_publications AS publications ON publications.run_id = runs.run_id
       WHERE runs.run_id = ? AND runs.base_sha IS NOT NULL
         AND publications.status = 'verified'
       ORDER BY publications.updated_at DESC, publications.publication_id DESC LIMIT 1`,
    ).bind(runId).first<CandidateRow>();
  }

  private async approval(candidate: CandidateRow): Promise<ApprovalRow | null> {
    return await this.db.prepare(
      `SELECT approval_id, decision, expires_at, created_at,
              EXISTS (
                SELECT 1 FROM invalidated_approvals
                WHERE invalidated_approvals.approval_id = approvals.approval_id
              ) AS invalidated,
              EXISTS (
                SELECT 1 FROM trusted_effect_approvals
                WHERE trusted_effect_approvals.approval_id = approvals.approval_id
              ) AS identity_trusted,
              (SELECT approver_principal FROM identity_bound_approvals
               WHERE identity_bound_approvals.approval_id = approvals.approval_id)
                AS approver_principal,
              (SELECT pull_request_author_principal FROM identity_bound_approvals
               WHERE identity_bound_approvals.approval_id = approvals.approval_id)
                AS author_principal
       FROM approvals
       WHERE run_id = ? AND task_revision = ? AND plan_id = ?
         AND plan_version = ? AND plan_digest = ? AND base_sha = ?
         AND effect = 'merge'
       ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
    ).bind(
      candidate.run_id,
      candidate.task_revision,
      candidate.active_plan_id,
      candidate.active_plan_version,
      candidate.active_plan_digest,
      candidate.run_base_sha,
    ).first<ApprovalRow>();
  }

  private async existingDecision(runId: string): Promise<DecisionRow | null> {
    return await this.db.prepare(
      `SELECT decision_id, observation_id, evaluation_id, run_version
       FROM merge_gate_decisions WHERE run_id = ?
       ORDER BY created_at DESC, decision_id DESC LIMIT 1`,
    ).bind(runId).first<DecisionRow>();
  }

  private decisionResult(
    row: DecisionRow,
    disposition: 'ready_to_merge' | 'duplicate',
  ): Extract<MergeGateEvaluationResult, { disposition: 'ready_to_merge' | 'duplicate' }> {
    return {
      disposition,
      decisionId: row.decision_id,
      observationId: row.observation_id,
      evaluationId: row.evaluation_id,
      runVersion: row.run_version + 1,
    };
  }

  private suffix(digest: string, length: number): string {
    return digest.slice('sha256:'.length, 'sha256:'.length + length);
  }
}
