import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const BLOCKABLE_STATES = new Set([
  'awaiting_approval',
  'executing',
  'verifying',
  'pull_request_open',
  'awaiting_review',
  'ready_to_merge',
  'blocked',
]);

export const GitHubBaseConflictFactSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  beforeSha: z.string().regex(SHA_PATTERN),
  afterSha: z.string().regex(SHA_PATTERN),
  relationship: z.enum(['behind', 'diverged', 'identical']),
  aheadBy: z.number().int().nonnegative(),
  behindBy: z.number().int().nonnegative(),
  mergeBaseSha: z.string().regex(SHA_PATTERN),
  referenceDigest: z.string().regex(DIGEST_PATTERN),
  comparisonDigest: z.string().regex(DIGEST_PATTERN),
}).strict().refine(
  (value) => value.beforeSha !== value.afterSha &&
    !value.baseBranch.includes('..') &&
    !value.baseBranch.includes('//'),
  { message: 'GitHub base conflict binding is invalid' },
);

export const BlockGitHubBaseConflictInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  fact: GitHubBaseConflictFactSchema,
  observedAt: z.iso.datetime({ offset: true }),
}).strict();

export type GitHubBaseConflictFact = z.infer<typeof GitHubBaseConflictFactSchema>;
export type BlockGitHubBaseConflictInput = z.infer<typeof BlockGitHubBaseConflictInputSchema>;

export type GitHubBaseConflictErrorCode = 'invalid_request' | 'not_found' | 'state_conflict';

export class GitHubBaseConflictError extends Error {
  constructor(readonly code: GitHubBaseConflictErrorCode) {
    super(`GitHub base conflict operation failed: ${code}`);
    this.name = 'GitHubBaseConflictError';
  }
}

export interface GitHubBaseConflictResult {
  conflictId: string;
  cancelOutboxId: string;
  created: boolean;
  runVersion: number;
}

interface ConflictCandidateRow {
  run_id: string;
  run_state: string;
  run_version: number;
  run_base_sha: string;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
  plan_status: string;
  plan_base_sha: string;
  repository: string;
  base_branch: string;
}

interface ConflictProjectionRow {
  conflict_id: string;
  run_id: string;
  expected_run_version: number;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  repository: string;
  base_branch: string;
  before_sha: string;
  after_sha: string;
  relationship: string;
  ahead_by: number;
  behind_by: number;
  merge_base_sha: string;
  reference_digest: string;
  comparison_digest: string;
  source_digest: string;
  run_state: string;
  run_version: number;
  run_base_sha: string;
  plan_status: string;
  cancel_outbox_id: string | null;
}

function stableSuffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 56);
}

/** Atomically converts one immutable non-fast-forward fact into a safe human blocker. */
export class GitHubBaseConflictStore {
  constructor(private readonly db: D1Database) {}

  async block(
    rawInput: unknown,
    now = new Date(),
  ): Promise<GitHubBaseConflictResult> {
    const parsed = BlockGitHubBaseConflictInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new GitHubBaseConflictError('invalid_request');
    const input = parsed.data;
    const sourceDigest = await canonicalSha256(input.fact);
    const identity = await canonicalSha256({
      schemaVersion: '1',
      runId: input.runId,
      expectedRunVersion: input.expectedRunVersion,
      sourceDigest,
    });
    const suffix = stableSuffix(identity);
    const conflictId = `github_base_conflict_${suffix}`;
    const cancelOutboxId = `cancel_base_conflict_${suffix}`;
    const existing = await this.projection(conflictId);
    if (existing !== null) {
      return this.result(existing, input, sourceDigest, cancelOutboxId, false);
    }

    const candidate = await this.candidate(input.runId);
    if (candidate === null) {
      const run = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(input.runId).first<{ run_id: string }>();
      throw new GitHubBaseConflictError(run === null ? 'not_found' : 'state_conflict');
    }
    if (
      !BLOCKABLE_STATES.has(candidate.run_state) ||
      candidate.run_version !== input.expectedRunVersion ||
      candidate.run_base_sha !== input.fact.beforeSha ||
      candidate.active_plan_id.length === 0 ||
      candidate.active_plan_version <= 0 ||
      candidate.active_plan_digest.length === 0 ||
      candidate.plan_status !== 'active' ||
      candidate.plan_base_sha !== candidate.run_base_sha ||
      candidate.repository !== input.fact.repository ||
      candidate.base_branch !== input.fact.baseBranch
    ) throw new GitHubBaseConflictError('state_conflict');

    const nowIso = now.toISOString();
    const observedAt = new Date(input.observedAt).toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO github_base_conflicts (
           conflict_id, run_id, expected_run_version, prior_plan_id,
           prior_plan_version, prior_plan_digest, repository, base_branch,
           before_sha, after_sha, relationship, ahead_by, behind_by,
           merge_base_sha, reference_digest, comparison_digest, source_digest,
           blocker_reason, needed_human_input, observed_at, created_at
         )
         SELECT ?, runs.run_id, runs.version, runs.active_plan_id,
                runs.active_plan_version, runs.active_plan_digest,
                tasks.target_repository, tasks.target_base_branch, runs.base_sha,
                ?, ?, ?, ?, ?, ?, ?, ?, 'base_history_diverged',
                'manual_rebase', ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         WHERE runs.run_id = ? AND runs.state = ? AND runs.version = ?
           AND runs.base_sha = ? AND runs.active_plan_id = ?
           AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
           AND tasks.target_repository = ? AND tasks.target_base_branch = ?
           AND plans.status = 'active' AND plans.base_sha = runs.base_sha
         ON CONFLICT DO NOTHING`,
      ).bind(
        conflictId,
        input.fact.afterSha,
        input.fact.relationship,
        input.fact.aheadBy,
        input.fact.behindBy,
        input.fact.mergeBaseSha,
        input.fact.referenceDigest,
        input.fact.comparisonDigest,
        sourceDigest,
        observedAt,
        nowIso,
        input.runId,
        candidate.run_state,
        input.expectedRunVersion,
        input.fact.beforeSha,
        candidate.active_plan_id,
        candidate.active_plan_version,
        candidate.active_plan_digest,
        input.fact.repository,
        input.fact.baseBranch,
      ),
      this.db.prepare(
        `INSERT INTO base_conflict_approval_invalidations (
           approval_id, conflict_id, reason, invalidated_at
         )
         SELECT approvals.approval_id, conflict.conflict_id,
                'base_history_diverged', ?
         FROM github_base_conflicts AS conflict
         JOIN approvals ON approvals.run_id = conflict.run_id
          AND approvals.plan_id = conflict.prior_plan_id
          AND approvals.plan_version = conflict.prior_plan_version
          AND approvals.plan_digest = conflict.prior_plan_digest
         WHERE conflict.conflict_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(nowIso, conflictId),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'cancelled', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE run_id = ? AND plan_id = ?
           AND status IN ('pending', 'starting', 'running', 'cancel_requested')
           AND EXISTS (
             SELECT 1 FROM github_base_conflicts
             WHERE conflict_id = ? AND prior_plan_id = attempts.plan_id
           )`,
      ).bind(nowIso, input.runId, candidate.active_plan_id, conflictId),
      this.db.prepare(
        `UPDATE attempt_tokens SET revoked_at = ?
         WHERE revoked_at IS NULL AND attempt_id IN (
           SELECT attempt_id FROM attempts
           WHERE run_id = ? AND plan_id = ? AND status = 'cancelled'
             AND updated_at = ?
         )`,
      ).bind(nowIso, input.runId, candidate.active_plan_id, nowIso),
      this.db.prepare(
        `UPDATE github_write_credentials
         SET status = 'revocation_pending', updated_at = ?
         WHERE run_id = ? AND plan_id = ? AND status IN ('issuing', 'active')
           AND EXISTS (
             SELECT 1 FROM github_base_conflicts WHERE conflict_id = ?
           )`,
      ).bind(nowIso, input.runId, candidate.active_plan_id, conflictId),
      this.db.prepare(
        `UPDATE protected_path_change_gates
         SET status = 'superseded', updated_at = ?
         WHERE run_id = ? AND plan_id = ?
           AND status IN ('awaiting_approval', 'approved')
           AND EXISTS (
             SELECT 1 FROM github_base_conflicts WHERE conflict_id = ?
           )`,
      ).bind(nowIso, input.runId, candidate.active_plan_id, conflictId),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'blocked', active_attempt_id = NULL,
             version = version + 1, updated_at = ?
         WHERE plan_id = ? AND status IN ('ready', 'in_progress', 'failed')
           AND EXISTS (
             SELECT 1 FROM github_base_conflicts WHERE conflict_id = ?
           )`,
      ).bind(nowIso, candidate.active_plan_id, conflictId),
      this.db.prepare(
        `UPDATE outbox
         SET delivery_state = 'settled', lease_token = NULL,
             lease_expires_at = NULL, last_error_code = 'base_history_diverged',
             updated_at = ?
         WHERE run_id = ?
           AND kind IN ('analysis_dispatch', 'execution_dispatch', 'pull_request')
           AND delivery_state IN ('pending', 'delivering')
           AND EXISTS (
             SELECT 1 FROM github_base_conflicts WHERE conflict_id = ?
           )`,
      ).bind(nowIso, input.runId, conflictId),
      this.db.prepare(
        `UPDATE execution_plans SET status = 'blocked', updated_at = ?
         WHERE plan_id = ? AND run_id = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM github_base_conflicts
             WHERE conflict_id = ? AND prior_plan_id = execution_plans.plan_id
           )`,
      ).bind(nowIso, candidate.active_plan_id, input.runId, conflictId),
      this.db.prepare(
        `UPDATE runs
         SET state = 'blocked', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = ? AND version = ? AND base_sha = ?
           AND active_plan_id = ? AND active_plan_version = ?
           AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM github_base_conflicts
             WHERE conflict_id = ? AND prior_plan_id = runs.active_plan_id
           )`,
      ).bind(
        nowIso,
        input.runId,
        candidate.run_state,
        input.expectedRunVersion,
        input.fact.beforeSha,
        candidate.active_plan_id,
        candidate.active_plan_version,
        candidate.active_plan_digest,
        conflictId,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, ?, 'workflow_cancel', 'cloudflare_workflows', ?, ?,
                'pending', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM runs
           JOIN github_base_conflicts AS conflict ON conflict.run_id = runs.run_id
           WHERE conflict.conflict_id = ? AND runs.state = 'blocked'
             AND runs.version = conflict.expected_run_version + 1
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        cancelOutboxId,
        input.runId,
        `d1://runs/${input.runId}`,
        `workflow-cancel:${input.runId}`,
        nowIso,
        nowIso,
        conflictId,
      ),
    ]);
    const projection = await this.projection(conflictId);
    if (projection === null) throw new GitHubBaseConflictError('state_conflict');
    return this.result(
      projection,
      input,
      sourceDigest,
      cancelOutboxId,
      results[0]?.meta.changes === 1,
    );
  }

  private async candidate(runId: string): Promise<ConflictCandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha AS run_base_sha, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              plans.status AS plan_status, plans.base_sha AS plan_base_sha,
              tasks.target_repository AS repository,
              tasks.target_base_branch AS base_branch
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ? AND runs.base_sha IS NOT NULL`,
    ).bind(runId).first<ConflictCandidateRow>();
  }

  private async projection(conflictId: string): Promise<ConflictProjectionRow | null> {
    return await this.db.prepare(
      `SELECT conflict.conflict_id, conflict.run_id, conflict.expected_run_version,
              conflict.prior_plan_id, conflict.prior_plan_version,
              conflict.prior_plan_digest, conflict.repository, conflict.base_branch,
              conflict.before_sha, conflict.after_sha, conflict.relationship,
              conflict.ahead_by, conflict.behind_by, conflict.merge_base_sha,
              conflict.reference_digest, conflict.comparison_digest,
              conflict.source_digest, runs.state AS run_state,
              runs.version AS run_version, runs.base_sha AS run_base_sha,
              plans.status AS plan_status, cancel.outbox_id AS cancel_outbox_id
       FROM github_base_conflicts AS conflict
       JOIN runs ON runs.run_id = conflict.run_id
       JOIN execution_plans AS plans ON plans.plan_id = conflict.prior_plan_id
       LEFT JOIN outbox AS cancel
         ON cancel.run_id = conflict.run_id AND cancel.kind = 'workflow_cancel'
        AND cancel.dedupe_key = 'workflow-cancel:' || conflict.run_id
       WHERE conflict.conflict_id = ?`,
    ).bind(conflictId).first<ConflictProjectionRow>();
  }

  private result(
    row: ConflictProjectionRow,
    input: BlockGitHubBaseConflictInput,
    sourceDigest: string,
    cancelOutboxId: string,
    created: boolean,
  ): GitHubBaseConflictResult {
    if (
      row.run_id !== input.runId ||
      row.expected_run_version !== input.expectedRunVersion ||
      row.repository !== input.fact.repository ||
      row.base_branch !== input.fact.baseBranch ||
      row.before_sha !== input.fact.beforeSha ||
      row.after_sha !== input.fact.afterSha ||
      row.relationship !== input.fact.relationship ||
      row.ahead_by !== input.fact.aheadBy ||
      row.behind_by !== input.fact.behindBy ||
      row.merge_base_sha !== input.fact.mergeBaseSha ||
      row.reference_digest !== input.fact.referenceDigest ||
      row.comparison_digest !== input.fact.comparisonDigest ||
      row.source_digest !== sourceDigest ||
      row.run_state !== 'blocked' ||
      row.run_version !== input.expectedRunVersion + 1 ||
      row.run_base_sha !== input.fact.beforeSha ||
      row.plan_status !== 'blocked' ||
      row.cancel_outbox_id !== cancelOutboxId
    ) throw new GitHubBaseConflictError('state_conflict');
    return {
      conflictId: row.conflict_id,
      cancelOutboxId,
      created,
      runVersion: row.run_version,
    };
  }
}
