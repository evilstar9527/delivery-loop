import { canonicalSha256 } from '../domain/digest.js';
import { isExactExecutionToolActions } from '../domain/tool-bridge.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

export type ExecutionHeadErrorCode = 'invalid_request' | 'state_conflict';

export class ExecutionHeadError extends Error {
  constructor(readonly code: ExecutionHeadErrorCode) {
    super(`Execution head update failed: ${code}`);
    this.name = 'ExecutionHeadError';
  }
}

export interface RecordExecutionHeadInput {
  expectedVersion: number;
  leaseGeneration: number;
  parentSha: string;
  headSha: string;
  branch: string;
}

export interface ExecutionHeadResult {
  updateId: string;
  evidenceId: string;
  created: boolean;
  version: number;
  leaseGeneration: number;
  parentSha: string;
  headSha: string;
  branch: string;
}

interface CandidateRow {
  attempt_id: string;
  run_id: string;
  task_id: string;
  mode: string;
  status: string;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  base_sha: string | null;
  head_branch: string | null;
  head_sha: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  run_state: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_status: string | null;
  progress_status: string | null;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
  has_repo_write_effect: number;
  repair_id: string | null;
  review_feedback_id: string | null;
  review_branch: string | null;
  review_source_head_sha: string | null;
  base_rebase_id: string | null;
  base_rebase_source_head_sha: string | null;
  base_rebase_target_branch: string | null;
}

interface ProjectionRow {
  update_id: string;
  evidence_id: string;
  parent_sha: string;
  recorded_head_sha: string;
  branch: string;
  lease_generation: number;
  attempt_version: number;
  attempt_generation: number;
  attempt_mode: string;
  attempt_base_sha: string | null;
  attempt_head_sha: string | null;
  attempt_head_branch: string | null;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

/** One-way CAS from checkout/failure head to the trusted bot commit head. */
export class ExecutionHeadStore {
  constructor(private readonly db: D1Database) {}

  async record(
    authorization: RunnerAuthorization,
    input: RecordExecutionHeadInput,
    now = new Date(),
  ): Promise<ExecutionHeadResult> {
    if (
      (authorization.mode !== 'implement' && authorization.mode !== 'review_fix') ||
      !isExactExecutionToolActions(authorization.scopes) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !Number.isSafeInteger(input.leaseGeneration) ||
      input.leaseGeneration < 1 ||
      !SHA_PATTERN.test(input.parentSha) ||
      !SHA_PATTERN.test(input.headSha) ||
      input.parentSha === input.headSha ||
      !BRANCH_PATTERN.test(input.branch) ||
      input.branch.includes('..') ||
      input.branch.includes('//')
    ) {
      throw new ExecutionHeadError('invalid_request');
    }
    const existing = await this.projection(authorization.attemptId, input.leaseGeneration);
    if (existing !== null && !this.pendingProjection(existing, input)) {
      return this.existing(existing, input);
    }

    const candidate = await this.candidate(authorization);
    if (candidate === null || !this.candidateMatches(candidate, authorization, input, now)) {
      // A concurrent identical request can move the Attempt after this request observed the
      // immutable update but before it read the candidate. Reconcile once from the authority;
      // mismatched content still fails through existing().
      const converged = await this.projection(authorization.attemptId, input.leaseGeneration);
      if (converged !== null && !this.pendingProjection(converged, input)) {
        return this.existing(converged, input);
      }
      throw new ExecutionHeadError('state_conflict');
    }
    const expectedBranch = candidate.review_feedback_id === null
      ? `agent/${candidate.task_id}/${candidate.attempt_id}`
      : candidate.review_branch;
    if (expectedBranch === null || expectedBranch.length > 240 || input.branch !== expectedBranch) {
      throw new ExecutionHeadError('state_conflict');
    }
    const identity = await canonicalSha256({
      schemaVersion: '1',
      runId: candidate.run_id,
      attemptId: candidate.attempt_id,
      leaseGeneration: input.leaseGeneration,
      parentSha: input.parentSha,
      headSha: input.headSha,
      branch: input.branch,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 56);
    const updateId = `head_${suffix}`;
    const evidenceId = `evidence_commit_${suffix}`;
    const nowIso = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, sha, summary, verification_status, observed_at, created_at
         )
         SELECT ?, attempts.run_id, attempts.attempt_id, attempts.plan_id,
                attempts.plan_version, attempts.plan_item_id,
                'commit', 'passed', ?,
                'Trusted Runner recorded the bot commit head.',
                'unverified', ?, ?
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.mode IN ('implement', 'review_fix')
           AND attempts.status = 'running'
           AND attempts.version = ? AND attempts.lease_generation = ?
           AND attempts.lease_expires_at > ?
           AND COALESCE(attempts.head_sha, attempts.base_sha) = ?
           AND (attempts.mode = 'implement' OR attempts.head_sha IS NOT NULL)
           AND attempts.head_branch IS NULL
           AND runs.state IN ('executing', 'verifying')
           AND runs.active_plan_id = attempts.plan_id
           AND runs.active_plan_version = attempts.plan_version
           AND execution_plans.status = 'active'
           AND plan_item_progress.status = 'in_progress'
           AND plan_item_progress.active_attempt_id = attempts.attempt_id
           AND plan_item_progress.protected_path_gate_id IS NULL
           AND EXISTS (
             SELECT 1 FROM plan_item_effects
             WHERE plan_item_effects.plan_id = attempts.plan_id
               AND plan_item_effects.item_id = attempts.plan_item_id
               AND plan_item_effects.effect = 'repo_write'
           )
           AND (
             attempts.mode = 'implement'
             OR (
               attempts.mode = 'review_fix'
               AND (
                 (
                   EXISTS (
                     SELECT 1 FROM attempt_repairs
                     WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM review_feedback_attempts
                     WHERE review_feedback_attempts.review_attempt_id = attempts.attempt_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM base_rebase_attempts
                     WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                   )
                 )
                 OR (
                   EXISTS (
                     SELECT 1 FROM review_feedback_attempts
                     WHERE review_feedback_attempts.review_attempt_id = attempts.attempt_id
                       AND review_feedback_attempts.branch = ?
                       AND review_feedback_attempts.source_head_sha = attempts.head_sha
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM attempt_repairs
                     WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM base_rebase_attempts
                     WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                   )
                 )
                 OR (
                   EXISTS (
                     SELECT 1 FROM base_rebase_attempts
                     WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                       AND base_rebase_attempts.source_head_sha = attempts.head_sha
                       AND base_rebase_attempts.target_branch = ?
                       AND base_rebase_attempts.status = 'scheduled'
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM attempt_repairs
                     WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM review_feedback_attempts
                     WHERE review_feedback_attempts.review_attempt_id = attempts.attempt_id
                   )
                 )
               )
             )
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        input.headSha,
        nowIso,
        nowIso,
        authorization.attemptId,
        authorization.runId,
        input.expectedVersion,
        input.leaseGeneration,
        nowIso,
        input.parentSha,
        input.branch,
        input.branch,
      ),
      this.db.prepare(
        `INSERT INTO attempt_head_updates (
           update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
           plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
         )
         SELECT ?, ?, attempts.run_id, attempts.attempt_id, attempts.plan_id,
                attempts.plan_version, attempts.plan_item_id,
                attempts.lease_generation,
                COALESCE(attempts.head_sha, attempts.base_sha), ?, ?, ?
         FROM attempts
         JOIN evidence ON evidence.evidence_id = ?
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.status = 'running'
           AND attempts.version = ? AND attempts.lease_generation = ?
           AND attempts.lease_expires_at > ?
           AND COALESCE(attempts.head_sha, attempts.base_sha) = ?
           AND (attempts.mode = 'implement' OR attempts.head_sha IS NOT NULL)
           AND attempts.head_branch IS NULL
           AND evidence.run_id = attempts.run_id
           AND evidence.attempt_id = attempts.attempt_id
           AND evidence.plan_id = attempts.plan_id
           AND evidence.plan_version = attempts.plan_version
           AND evidence.plan_item_id = attempts.plan_item_id
           AND evidence.kind = 'commit' AND evidence.status = 'passed'
           AND evidence.sha = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        updateId,
        evidenceId,
        input.headSha,
        input.branch,
        nowIso,
        evidenceId,
        authorization.attemptId,
        authorization.runId,
        input.expectedVersion,
        input.leaseGeneration,
        nowIso,
        input.parentSha,
        input.headSha,
      ),
      this.db.prepare(
        `UPDATE attempts
         SET head_branch = ?, head_sha = ?, version = version + 1, updated_at = ?
         WHERE attempt_id = ? AND run_id = ?
           AND status = 'running'
           AND version = ? AND lease_generation = ?
           AND lease_expires_at > ?
           AND COALESCE(head_sha, base_sha) = ?
           AND (mode = 'implement' OR head_sha IS NOT NULL)
           AND head_branch IS NULL
           AND EXISTS (
             SELECT 1 FROM attempt_head_updates
             WHERE update_id = ? AND attempt_id = attempts.attempt_id
               AND run_id = attempts.run_id
               AND lease_generation = attempts.lease_generation
               AND parent_sha = COALESCE(attempts.head_sha, attempts.base_sha)
               AND head_sha = ? AND branch = ?
           )`,
      ).bind(
        input.branch,
        input.headSha,
        nowIso,
        authorization.attemptId,
        authorization.runId,
        input.expectedVersion,
        input.leaseGeneration,
        nowIso,
        input.parentSha,
        updateId,
        input.headSha,
        input.branch,
      ),
    ]);
    const projection = await this.projection(authorization.attemptId, input.leaseGeneration);
    if (projection === null) throw new ExecutionHeadError('state_conflict');
    const result = this.existing(projection, input);
    return { ...result, created: results[1]?.meta.changes === 1 };
  }

  private async candidate(authorization: RunnerAuthorization): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.run_id, tasks.task_id, attempts.mode,
              attempts.status, attempts.version, attempts.lease_generation,
              attempts.lease_expires_at, attempts.base_sha,
              attempts.head_branch, attempts.head_sha,
              attempts.plan_id, attempts.plan_version, attempts.plan_item_id,
              runs.state AS run_state, runs.active_plan_id, runs.active_plan_version,
              execution_plans.status AS plan_status,
              plan_item_progress.status AS progress_status,
              plan_item_progress.active_attempt_id,
              plan_item_progress.protected_path_gate_id,
              EXISTS (
                SELECT 1 FROM plan_item_effects
                WHERE plan_item_effects.plan_id = attempts.plan_id
                  AND plan_item_effects.item_id = attempts.plan_item_id
                AND plan_item_effects.effect = 'repo_write'
              ) AS has_repo_write_effect,
              attempt_repairs.repair_id,
              review_feedback_attempts.feedback_id AS review_feedback_id,
              review_feedback_attempts.branch AS review_branch,
              review_feedback_attempts.source_head_sha AS review_source_head_sha,
              base_rebase_attempts.rebase_id AS base_rebase_id,
              base_rebase_attempts.source_head_sha AS base_rebase_source_head_sha,
              base_rebase_attempts.target_branch AS base_rebase_target_branch
       FROM attempts
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
       LEFT JOIN plan_item_progress
         ON plan_item_progress.plan_id = attempts.plan_id
        AND plan_item_progress.item_id = attempts.plan_item_id
       LEFT JOIN attempt_repairs
         ON attempt_repairs.repair_attempt_id = attempts.attempt_id
       LEFT JOIN review_feedback_attempts
         ON review_feedback_attempts.review_attempt_id = attempts.attempt_id
       LEFT JOIN base_rebase_attempts
         ON base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
       WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
    ).bind(authorization.attemptId, authorization.runId).first<CandidateRow>();
  }

  private candidateMatches(
    row: CandidateRow,
    authorization: RunnerAuthorization,
    input: RecordExecutionHeadInput,
    now: Date,
  ): boolean {
    return row.mode === authorization.mode &&
      row.status === 'running' &&
      row.version === authorization.version &&
      row.version === input.expectedVersion &&
      row.lease_generation === authorization.leaseGeneration &&
      row.lease_generation === input.leaseGeneration &&
      row.lease_expires_at !== null &&
      row.lease_expires_at > now.toISOString() &&
      row.head_branch === null &&
      (
        row.head_sha === input.parentSha ||
        (row.mode === 'implement' && row.head_sha === null &&
          row.base_sha === input.parentSha)
      ) &&
      row.plan_id !== null &&
      row.plan_version !== null &&
      row.plan_item_id !== null &&
      (row.run_state === 'executing' || row.run_state === 'verifying') &&
      row.active_plan_id === row.plan_id &&
      row.active_plan_version === row.plan_version &&
      row.plan_status === 'active' &&
      row.progress_status === 'in_progress' &&
      row.active_attempt_id === row.attempt_id &&
      row.protected_path_gate_id === null &&
      row.has_repo_write_effect === 1 &&
      (
        (row.mode === 'implement' && row.repair_id === null &&
          row.review_feedback_id === null && row.base_rebase_id === null) ||
        (
          row.mode === 'review_fix' &&
          Number(row.repair_id !== null) +
            Number(row.review_feedback_id !== null) +
            Number(row.base_rebase_id !== null) === 1 &&
          (
            row.review_feedback_id === null ||
            (row.review_branch !== null &&
             row.review_source_head_sha === input.parentSha)
          ) &&
          (
            row.base_rebase_id === null ||
            (row.base_rebase_source_head_sha === input.parentSha &&
             row.base_rebase_target_branch === input.branch)
          )
        )
      );
  }

  private async projection(
    attemptId: string,
    leaseGeneration: number,
  ): Promise<ProjectionRow | null> {
    return await this.db.prepare(
      `SELECT attempt_head_updates.update_id, attempt_head_updates.evidence_id,
              attempt_head_updates.parent_sha,
              attempt_head_updates.head_sha AS recorded_head_sha,
              attempt_head_updates.branch, attempt_head_updates.lease_generation,
              attempts.version AS attempt_version,
              attempts.lease_generation AS attempt_generation,
              attempts.mode AS attempt_mode,
              attempts.base_sha AS attempt_base_sha,
              attempts.head_sha AS attempt_head_sha,
              attempts.head_branch AS attempt_head_branch
       FROM attempt_head_updates
       JOIN attempts ON attempts.attempt_id = attempt_head_updates.attempt_id
       WHERE attempt_head_updates.attempt_id = ?
         AND attempt_head_updates.lease_generation = ?`,
    ).bind(attemptId, leaseGeneration).first<ProjectionRow>();
  }

  private existing(
    row: ProjectionRow,
    input: RecordExecutionHeadInput,
  ): ExecutionHeadResult {
    if (
      row.parent_sha !== input.parentSha ||
      row.recorded_head_sha !== input.headSha ||
      row.branch !== input.branch ||
      row.lease_generation !== input.leaseGeneration ||
      row.attempt_generation !== input.leaseGeneration ||
      row.attempt_head_sha !== input.headSha ||
      row.attempt_head_branch !== input.branch ||
      (row.attempt_version !== input.expectedVersion + 1 &&
        row.attempt_version !== input.expectedVersion)
    ) {
      throw new ExecutionHeadError('state_conflict');
    }
    return {
      updateId: row.update_id,
      evidenceId: row.evidence_id,
      created: false,
      version: row.attempt_version,
      leaseGeneration: row.attempt_generation,
      parentSha: row.parent_sha,
      headSha: row.recorded_head_sha,
      branch: row.branch,
    };
  }

  private pendingProjection(
    row: ProjectionRow,
    input: RecordExecutionHeadInput,
  ): boolean {
    return row.parent_sha === input.parentSha &&
      row.recorded_head_sha === input.headSha &&
      row.branch === input.branch &&
      row.lease_generation === input.leaseGeneration &&
      row.attempt_generation === input.leaseGeneration &&
      row.attempt_version === input.expectedVersion &&
      (
        row.attempt_head_sha === input.parentSha ||
        (row.attempt_mode === 'implement' && row.attempt_head_sha === null &&
          row.attempt_base_sha === input.parentSha)
      ) &&
      row.attempt_head_branch === null;
  }
}
