import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export const SchedulePullRequestPublicationInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  draftId: z.string().regex(ID_PATTERN),
}).strict();

export const SchedulePullRequestPublicationRequestBodySchema =
  SchedulePullRequestPublicationInputSchema.omit({ runId: true });

export type SchedulePullRequestPublicationInput = z.infer<
  typeof SchedulePullRequestPublicationInputSchema
>;

export type PullRequestPublicationErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'approval_required';

export class PullRequestPublicationError extends Error {
  constructor(readonly code: PullRequestPublicationErrorCode) {
    super(`pull request publication scheduling failed: ${code}`);
    this.name = 'PullRequestPublicationError';
  }
}

export interface PullRequestPublicationResult {
  publicationId: string;
  outboxId: string;
  runId: string;
  draftId: string;
  status: 'pending' | 'created_unverified' | 'verified';
  created: boolean;
}

interface DraftCandidateRow {
  draft_id: string;
  draft_run_id: string;
  draft_run_version: number;
  task_id: string;
  task_revision: string;
  task_digest: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  attempt_id: string;
  head_update_id: string;
  head_sha: string;
  branch: string;
  body_digest: string;
  draft_status: string;
  run_state: string;
  current_run_version: number;
  run_task_digest: string;
  run_base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  repository: string;
  base_branch: string;
  task_title: string;
  allow_repository_write: number;
  plan_status: string;
  plan_base_sha: string;
  attempt_status: string;
  attempt_mode: string;
  attempt_head_sha: string | null;
  attempt_head_branch: string | null;
  incomplete_required_count: number;
  protected_gate_count: number;
  newer_attempt_count: number;
  has_repo_write_effect: number;
}

interface ApprovalRow {
  approval_id: string;
  decision: string;
  expires_at: string;
}

interface PublicationRow {
  publication_id: string;
  run_id: string;
  draft_id: string;
  status: PullRequestPublicationResult['status'];
  outbox_id: string;
}

/** Creates one durable GitHub PR effect intent without trusting any caller-authored PR fact. */
export class PullRequestPublicationStore {
  constructor(private readonly db: D1Database) {}

  async schedule(
    rawInput: unknown,
    now = new Date(),
  ): Promise<PullRequestPublicationResult> {
    const parsed = SchedulePullRequestPublicationInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PullRequestPublicationError('invalid_request');
    const input = parsed.data;
    const existing = await this.existing(input.runId, input.draftId);
    if (existing !== null) return this.result(existing, false);
    const candidate = await this.candidate(input.runId, input.draftId);
    if (candidate === null) {
      const run = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(input.runId)
        .first<{ run_id: string }>();
      throw new PullRequestPublicationError(run === null ? 'not_found' : 'state_conflict');
    }
    this.assertCandidate(candidate, input);
    const approval = await this.approval(candidate);
    if (
      approval === null ||
      approval.decision !== 'approve' ||
      !Number.isFinite(Date.parse(approval.expires_at)) ||
      approval.expires_at <= now.toISOString()
    ) {
      throw new PullRequestPublicationError('approval_required');
    }
    const identity = await canonicalSha256({
      runId: input.runId,
      draftId: candidate.draft_id,
      runVersion: input.expectedRunVersion,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      headSha: candidate.head_sha,
      bodyDigest: candidate.body_digest,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 52);
    const publicationId = `pr_pub_${suffix}`;
    const outboxId = `outbox_pr_${suffix}`;
    // Title from the task summary (the bug/feature description) rather than the
    // opaque task id. Fall back to the id if the task somehow has no title, and
    // bound the length so the 256-char cap below never trips on long summaries.
    const summary = candidate.task_title.trim().length > 0
      ? candidate.task_title.trim()
      : candidate.task_id;
    const title = summary.length > 200 ? `${summary.slice(0, 197)}...` : summary;
    if (title.length > 256) throw new PullRequestPublicationError('state_conflict');
    const nowIso = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO pull_request_publications (
           publication_id, run_id, run_version, draft_id, approval_id,
           repository, base_branch, head_branch, head_sha, title, body_digest,
           status, created_at, updated_at
         )
         SELECT ?, runs.run_id, runs.version, pull_request_drafts.draft_id, ?,
                tasks.target_repository, tasks.target_base_branch,
                pull_request_drafts.branch, pull_request_drafts.head_sha, ?,
                pull_request_drafts.body_digest, 'pending', ?, ?
         FROM pull_request_drafts
         JOIN runs ON runs.run_id = pull_request_drafts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans ON execution_plans.plan_id = pull_request_drafts.plan_id
         WHERE pull_request_drafts.draft_id = ? AND runs.run_id = ?
           AND runs.state = 'verifying' AND runs.version = ?
           AND pull_request_drafts.run_version = runs.version
           AND pull_request_drafts.status = 'prepared'
           AND runs.active_plan_id = pull_request_drafts.plan_id
           AND runs.active_plan_version = pull_request_drafts.plan_version
           AND runs.active_plan_digest = pull_request_drafts.plan_digest
           AND execution_plans.status = 'active'
         ON CONFLICT DO NOTHING`,
      ).bind(
        publicationId,
        approval.approval_id,
        title,
        nowIso,
        nowIso,
        candidate.draft_id,
        candidate.draft_run_id,
        input.expectedRunVersion,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, run_id, 'pull_request', 'github_api', ?, ?, 'pending', ?, ?
         FROM pull_request_publications WHERE publication_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://pull-request-publications/${publicationId}`,
        `pull-request:${publicationId}`,
        nowIso,
        nowIso,
        publicationId,
      ),
    ]);
    const persisted = await this.existing(input.runId, input.draftId);
    if (persisted === null || persisted.publication_id !== publicationId) {
      throw new PullRequestPublicationError('state_conflict');
    }
    const outbox = await this.db.prepare(
      `SELECT outbox_id FROM outbox
       WHERE run_id = ? AND kind = 'pull_request' AND dedupe_key = ?`,
    ).bind(input.runId, `pull-request:${publicationId}`).first<{ outbox_id: string }>();
    if (outbox?.outbox_id !== outboxId) throw new PullRequestPublicationError('state_conflict');
    return {
      ...this.result(persisted, results[0]?.meta.changes === 1),
      outboxId,
    };
  }

  private result(row: PublicationRow, created: boolean): PullRequestPublicationResult {
    return {
      publicationId: row.publication_id,
      outboxId: row.outbox_id,
      runId: row.run_id,
      draftId: row.draft_id,
      status: row.status,
      created,
    };
  }

  private async existing(runId: string, draftId: string): Promise<PublicationRow | null> {
    return await this.db.prepare(
      `SELECT pull_request_publications.publication_id,
              pull_request_publications.run_id,
              pull_request_publications.draft_id,
              pull_request_publications.status,
              outbox.outbox_id
       FROM pull_request_publications
       JOIN outbox
         ON outbox.run_id = pull_request_publications.run_id
        AND outbox.kind = 'pull_request'
        AND outbox.dedupe_key = 'pull-request:' || pull_request_publications.publication_id
       WHERE pull_request_publications.run_id = ?
         AND pull_request_publications.draft_id = ?`,
    ).bind(runId, draftId).first<PublicationRow>();
  }

  private async candidate(runId: string, draftId: string): Promise<DraftCandidateRow | null> {
    return await this.db.prepare(
      `SELECT pull_request_drafts.draft_id,
              pull_request_drafts.run_id AS draft_run_id,
              pull_request_drafts.run_version AS draft_run_version,
              pull_request_drafts.task_id, pull_request_drafts.task_revision,
              pull_request_drafts.task_digest, pull_request_drafts.plan_id,
              pull_request_drafts.plan_version, pull_request_drafts.plan_digest,
              pull_request_drafts.attempt_id, pull_request_drafts.head_update_id,
              pull_request_drafts.head_sha, pull_request_drafts.branch,
              pull_request_drafts.body_digest,
              pull_request_drafts.status AS draft_status,
              runs.state AS run_state, runs.version AS current_run_version,
              runs.task_digest AS run_task_digest, runs.base_sha AS run_base_sha,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              tasks.target_repository AS repository,
              tasks.target_base_branch AS base_branch,
              tasks.title AS task_title,
              tasks.allow_repository_write,
              execution_plans.status AS plan_status,
              execution_plans.base_sha AS plan_base_sha,
              attempts.status AS attempt_status, attempts.mode AS attempt_mode,
              attempts.head_sha AS attempt_head_sha,
              attempts.head_branch AS attempt_head_branch,
              (SELECT COUNT(*) FROM plan_items
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = plan_items.plan_id
                AND plan_item_progress.item_id = plan_items.item_id
               WHERE plan_items.plan_id = execution_plans.plan_id
                 AND plan_items.required = 1
                 AND plan_item_progress.status <> 'passed') AS incomplete_required_count,
              (SELECT COUNT(*) FROM plan_item_progress
               WHERE plan_item_progress.plan_id = execution_plans.plan_id
                 AND plan_item_progress.protected_path_gate_id IS NOT NULL) AS protected_gate_count,
              (SELECT COUNT(*) FROM attempts AS newer
               WHERE newer.run_id = runs.run_id
                 AND newer.mode IN ('implement', 'review_fix')
                 AND newer.ordinal > attempts.ordinal) AS newer_attempt_count,
              CASE WHEN EXISTS (
                SELECT 1 FROM plan_item_effects
                WHERE plan_item_effects.plan_id = execution_plans.plan_id
                  AND plan_item_effects.effect = 'repo_write'
              ) THEN 1 ELSE 0 END AS has_repo_write_effect
       FROM pull_request_drafts
       JOIN runs ON runs.run_id = pull_request_drafts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans ON execution_plans.plan_id = pull_request_drafts.plan_id
       JOIN attempts ON attempts.attempt_id = pull_request_drafts.attempt_id
       WHERE pull_request_drafts.draft_id = ? AND pull_request_drafts.run_id = ?`,
    ).bind(draftId, runId).first<DraftCandidateRow>();
  }

  private assertCandidate(
    candidate: DraftCandidateRow,
    input: SchedulePullRequestPublicationInput,
  ): void {
    if (
      candidate.draft_run_id !== input.runId ||
      candidate.draft_run_version !== input.expectedRunVersion ||
      candidate.current_run_version !== input.expectedRunVersion ||
      candidate.draft_status !== 'prepared' ||
      candidate.run_state !== 'verifying' ||
      candidate.run_base_sha === null ||
      candidate.task_digest !== candidate.run_task_digest ||
      candidate.active_plan_id !== candidate.plan_id ||
      candidate.active_plan_version !== candidate.plan_version ||
      candidate.active_plan_digest !== candidate.plan_digest ||
      candidate.plan_status !== 'active' ||
      candidate.plan_base_sha !== candidate.run_base_sha ||
      candidate.attempt_status !== 'completed' ||
      (candidate.attempt_mode !== 'implement' && candidate.attempt_mode !== 'review_fix') ||
      candidate.attempt_head_sha !== candidate.head_sha ||
      candidate.attempt_head_branch !== candidate.branch ||
      candidate.branch !== `agent/${candidate.task_id}/${candidate.attempt_id}` ||
      candidate.allow_repository_write !== 1 ||
      candidate.has_repo_write_effect !== 1 ||
      candidate.incomplete_required_count !== 0 ||
      candidate.protected_gate_count !== 0 ||
      candidate.newer_attempt_count !== 0
    ) throw new PullRequestPublicationError('state_conflict');
  }

  private async approval(candidate: DraftCandidateRow): Promise<ApprovalRow | null> {
    return await this.db.prepare(
      `SELECT approval_id, decision, expires_at
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
      candidate.draft_run_id,
      candidate.task_revision,
      candidate.plan_id,
      candidate.plan_version,
      candidate.plan_digest,
      candidate.plan_base_sha,
    ).first<ApprovalRow>();
  }
}
