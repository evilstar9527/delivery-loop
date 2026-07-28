import { TEST_ROLLBACK_WORKFLOW_PATH } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import type {
  GitHubWorkflowRunFact,
  GitHubWorkflowRunStatus,
} from './github-run-observation-store.js';

const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/;
const FACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW_CONCLUSIONS = new Set([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
]);

export interface GitHubTestRollbackWebhookObservation {
  deliveryId: string;
  payloadDigest: string;
  fact: GitHubWorkflowRunFact;
  receivedAt: string;
}

export interface GitHubTestRollbackApiObservation {
  observationId: string;
  factDigest: string;
  fact: GitHubWorkflowRunFact;
  observedAt: string;
}

export type GitHubTestRollbackObservationDisposition = 'applied' | 'duplicate' | 'ignored';
export type GitHubTestRollbackStatusErrorCode =
  | 'observation_conflict'
  | 'runner_result_required'
  | 'state_conflict';

export class GitHubTestRollbackStatusError extends Error {
  constructor(readonly code: GitHubTestRollbackStatusErrorCode) {
    super(`GitHub test rollback status failed: ${code}`);
    this.name = 'GitHubTestRollbackStatusError';
  }
}

interface ObservationRow {
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface ProjectionRow {
  rollback_id: string;
  run_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  attempt_id: string;
  repository: string;
  base_branch: string;
  ref_sha: string;
  workflow_path: string;
  status: string;
  github_run_id: string | null;
  runner_result_digest: string | null;
  runner_status: 'passed' | 'failed' | null;
  runner_exit_code: number | null;
  runner_duration_ms: number | null;
  external_state: GitHubWorkflowRunStatus | null;
  external_conclusion: string | null;
  external_updated_at: string | null;
  evidence_id: string | null;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  attempt_workflow_ref: string | null;
}

interface ProjectionResult {
  disposition: 'applied' | 'ignored';
  rollbackId: string | null;
  reason: string | null;
}

function workflowPathMatches(path: string, branch: string): boolean {
  return path === TEST_ROLLBACK_WORKFLOW_PATH ||
    path === `${TEST_ROLLBACK_WORKFLOW_PATH}@refs/heads/${branch}`;
}

function validFact(fact: GitHubWorkflowRunFact): boolean {
  const completed = fact.status === 'completed';
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fact.repository) &&
    /^[1-9][0-9]{0,31}$/.test(fact.githubRunId) && fact.event === 'workflow_dispatch' &&
    ['requested', 'queued', 'waiting', 'in_progress', 'completed'].includes(fact.status) &&
    ((completed && fact.conclusion !== null && WORKFLOW_CONCLUSIONS.has(fact.conclusion)) ||
      (!completed && fact.conclusion === null)) &&
    /^[a-f0-9]{40}$/.test(fact.headSha) && fact.headBranch.length > 0 &&
    fact.headBranch.length <= 255 && fact.workflowPath.length > 0 &&
    fact.workflowPath.length <= 500 && fact.displayTitle.length > 0 &&
    fact.displayTitle.length <= 300 && fact.runAttempt === 1 &&
    Number.isFinite(Date.parse(fact.externalUpdatedAt));
}

function bindingMatches(row: ProjectionRow, fact: GitHubWorkflowRunFact): boolean {
  return row.repository === fact.repository && row.github_run_id === fact.githubRunId &&
    row.ref_sha === fact.headSha && row.base_branch === fact.headBranch &&
    row.workflow_path === TEST_ROLLBACK_WORKFLOW_PATH &&
    row.attempt_workflow_ref ===
      `${fact.repository}/${TEST_ROLLBACK_WORKFLOW_PATH}@refs/heads/${fact.headBranch}` &&
    workflowPathMatches(fact.workflowPath, fact.headBranch) &&
    fact.displayTitle === `delivery-loop/rollback/${row.rollback_id}` && fact.runAttempt === 1;
}

function sameFact(row: ProjectionRow, fact: GitHubWorkflowRunFact): boolean {
  return row.external_state === fact.status && row.external_conclusion === fact.conclusion &&
    row.external_updated_at === fact.externalUpdatedAt;
}

function isNewer(current: string | null, incoming: string): boolean {
  const currentTime = current === null ? Number.NEGATIVE_INFINITY : Date.parse(current);
  const incomingTime = Date.parse(incoming);
  return Number.isFinite(incomingTime) && incomingTime > currentTime;
}

function actionsRunUrl(repository: string, githubRunId: string): string {
  return `https://github.com/${repository}/actions/runs/${githubRunId}`;
}

/** Finalizes rollback only from the conjunction of Runner and GitHub workflow facts. */
export class GitHubTestRollbackStatusStore {
  constructor(private readonly db: D1Database) {}

  async applyWebhook(
    observation: GitHubTestRollbackWebhookObservation,
  ): Promise<GitHubTestRollbackObservationDisposition> {
    return await this.apply({
      observationId: `webhook_${observation.deliveryId}`,
      sourceKind: 'webhook',
      factDigest: observation.payloadDigest,
      fact: observation.fact,
      observedAt: observation.receivedAt,
    });
  }

  async applyApiObservation(
    observation: GitHubTestRollbackApiObservation,
  ): Promise<GitHubTestRollbackObservationDisposition> {
    return await this.apply({
      observationId: observation.observationId,
      sourceKind: 'api',
      factDigest: observation.factDigest,
      fact: observation.fact,
      observedAt: observation.observedAt,
    });
  }

  private async apply(input: {
    observationId: string;
    sourceKind: 'webhook' | 'api';
    factDigest: string;
    fact: GitHubWorkflowRunFact;
    observedAt: string;
  }): Promise<GitHubTestRollbackObservationDisposition> {
    if (
      !OBSERVATION_ID_PATTERN.test(input.observationId) ||
      !FACT_DIGEST_PATTERN.test(input.factDigest) || !validFact(input.fact) ||
      !Number.isFinite(Date.parse(input.observedAt))
    ) throw new GitHubTestRollbackStatusError('state_conflict');
    const existing = await this.observation(input.observationId);
    if (existing !== null) {
      if (existing.fact_digest !== input.factDigest) {
        throw new GitHubTestRollbackStatusError('observation_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    } else {
      await this.db.prepare(
        `INSERT INTO github_test_rollback_observations (
           observation_id, source_kind, fact_digest, repository, github_run_id,
           processing_state, external_updated_at, observed_at
         ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.observationId,
        input.sourceKind,
        input.factDigest,
        input.fact.repository,
        input.fact.githubRunId,
        input.fact.externalUpdatedAt,
        input.observedAt,
      ).run();
      const persisted = await this.observation(input.observationId);
      if (persisted === null || persisted.fact_digest !== input.factDigest) {
        throw new GitHubTestRollbackStatusError('observation_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }

    const projection = await this.projectFact(input.fact, input.observedAt);
    await this.finalize(input.observationId, input.factDigest, projection, input.observedAt);
    return projection.disposition;
  }

  private async projectFact(
    fact: GitHubWorkflowRunFact,
    observedAt: string,
  ): Promise<ProjectionResult> {
    let row = await this.projection(fact.githubRunId);
    if (row === null || !bindingMatches(row, fact)) {
      return { disposition: 'ignored', rollbackId: null, reason: 'binding_mismatch' };
    }
    if (sameFact(row, fact)) {
      if (
        fact.status !== 'completed' || row.status === 'failed' ||
        (row.status === 'succeeded' && row.evidence_id !== null)
      ) return { disposition: 'applied', rollbackId: row.rollback_id, reason: null };
    } else {
      if (!isNewer(row.external_updated_at, fact.externalUpdatedAt)) {
        return {
          disposition: 'ignored',
          rollbackId: row.rollback_id,
          reason: 'stale_external_fact',
        };
      }
      if (
        row.external_state === 'completed' || row.status === 'succeeded' ||
        row.status === 'failed'
      ) {
        return {
          disposition: 'ignored',
          rollbackId: row.rollback_id,
          reason: 'terminal_fact_conflict',
        };
      }
      await this.projectExternalFact(row, fact, observedAt);
      row = await this.projection(fact.githubRunId);
      if (row === null || !bindingMatches(row, fact) || !sameFact(row, fact)) {
        throw new GitHubTestRollbackStatusError('state_conflict');
      }
    }
    if (fact.status !== 'completed') {
      return { disposition: 'applied', rollbackId: row.rollback_id, reason: null };
    }
    if (fact.conclusion === 'success' && row.runner_result_digest === null) {
      throw new GitHubTestRollbackStatusError('runner_result_required');
    }
    const passed = fact.conclusion === 'success' && row.runner_status === 'passed' &&
      row.runner_exit_code === 0 && row.runner_duration_ms !== null;
    if (passed) await this.applySuccess(row, fact, observedAt);
    else await this.applyFailure(row, fact, observedAt);
    const persisted = await this.projection(fact.githubRunId);
    if (
      persisted === null || !sameFact(persisted, fact) ||
      (passed && (persisted.status !== 'succeeded' || persisted.evidence_id === null)) ||
      (!passed && (persisted.status !== 'failed' || persisted.evidence_id === null))
    ) throw new GitHubTestRollbackStatusError('state_conflict');
    return { disposition: 'applied', rollbackId: row.rollback_id, reason: null };
  }

  private async projectExternalFact(
    row: ProjectionRow,
    fact: GitHubWorkflowRunFact,
    observedAt: string,
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_rollbacks
         SET external_state = ?, external_conclusion = ?, external_updated_at = ?,
             observation_version = observation_version + 1, updated_at = ?
         WHERE rollback_id = ? AND status IN ('dispatched', 'running')
           AND external_updated_at IS ?`,
      ).bind(
        fact.status,
        fact.conclusion,
        fact.externalUpdatedAt,
        observedAt,
        row.rollback_id,
        row.external_updated_at,
      ),
      this.db.prepare(
        `UPDATE attempts
         SET github_status = ?, github_conclusion = ?, github_observed_at = ?,
             github_external_updated_at = ?,
             github_observation_version = github_observation_version + 1
         WHERE attempt_id = ? AND github_run_id = ?
           AND github_external_updated_at IS ?`,
      ).bind(
        fact.status,
        fact.conclusion,
        observedAt,
        fact.externalUpdatedAt,
        row.attempt_id,
        fact.githubRunId,
        row.external_updated_at,
      ),
    ]);
  }

  private async applySuccess(
    row: ProjectionRow,
    fact: GitHubWorkflowRunFact,
    observedAt: string,
  ): Promise<void> {
    if (row.runner_exit_code !== 0 || row.runner_duration_ms === null) {
      throw new GitHubTestRollbackStatusError('state_conflict');
    }
    const evidenceId = await this.evidenceId(row.rollback_id, 'passed');
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, exit_code, duration_ms, sha, external_url, summary,
           verification_status, observed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'deployment', 'passed', 0, ?, ?, ?,
                   'Signed automatic test rollback workflow succeeded',
                   'verified', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        row.run_id,
        row.attempt_id,
        row.plan_id,
        row.plan_version,
        row.plan_item_id,
        row.runner_duration_ms,
        row.ref_sha,
        actionsRunUrl(row.repository, fact.githubRunId),
        fact.externalUpdatedAt,
        observedAt,
      ),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'completed', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND mode = 'deploy' AND status = 'running'
           AND version = ? AND lease_generation = ?`,
      ).bind(observedAt, row.attempt_id, row.attempt_version, row.lease_generation),
      this.db.prepare(
        `UPDATE test_rollbacks
         SET status = 'succeeded', evidence_id = ?, updated_at = ?
         WHERE rollback_id = ? AND status IN ('dispatched', 'running', 'succeeded')
           AND external_state = 'completed' AND external_conclusion = 'success'
           AND runner_status = 'passed' AND runner_exit_code = 0
           AND (evidence_id IS NULL OR evidence_id = ?)
           AND EXISTS (
             SELECT 1 FROM evidence WHERE evidence_id = ?
               AND status = 'passed' AND verification_status = 'verified'
           )`,
      ).bind(evidenceId, observedAt, row.rollback_id, evidenceId, evidenceId),
    ]);
  }

  private async applyFailure(
    row: ProjectionRow,
    fact: GitHubWorkflowRunFact,
    observedAt: string,
  ): Promise<void> {
    const evidenceId = await this.evidenceId(row.rollback_id, 'failed');
    const resultAvailable = row.runner_result_digest !== null;
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, exit_code, duration_ms, sha, external_url, summary,
           verification_status, observed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'deployment', 'failed', ?, ?, ?, ?, ?,
                   'verified', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        row.run_id,
        row.attempt_id,
        row.plan_id,
        row.plan_version,
        row.plan_item_id,
        resultAvailable ? row.runner_exit_code : null,
        resultAvailable ? row.runner_duration_ms : null,
        row.ref_sha,
        actionsRunUrl(row.repository, fact.githubRunId),
        fact.conclusion === 'success'
          ? 'Runner result conflicted with signed automatic test rollback success'
          : 'Signed automatic test rollback workflow failed',
        fact.externalUpdatedAt,
        observedAt,
      ),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'failed', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND mode = 'deploy' AND status IN ('starting', 'running')
           AND version = ? AND lease_generation = ?`,
      ).bind(observedAt, row.attempt_id, row.attempt_version, row.lease_generation),
      this.db.prepare(
        `UPDATE test_rollbacks
         SET status = 'failed', evidence_id = ?, updated_at = ?
         WHERE rollback_id = ? AND status IN ('dispatched', 'running', 'failed')
           AND external_state = 'completed'
           AND (evidence_id IS NULL OR evidence_id = ?)
           AND EXISTS (SELECT 1 FROM evidence WHERE evidence_id = ?)`,
      ).bind(evidenceId, observedAt, row.rollback_id, evidenceId, evidenceId),
    ]);
  }

  private async projection(githubRunId: string): Promise<ProjectionRow | null> {
    return await this.db.prepare(
      `SELECT rollbacks.rollback_id, rollbacks.run_id, rollbacks.plan_id,
              rollbacks.plan_version, rollbacks.plan_item_id, rollbacks.attempt_id,
              rollbacks.repository, rollbacks.base_branch, rollbacks.ref_sha,
              rollbacks.workflow_path, rollbacks.status, rollbacks.github_run_id,
              rollbacks.runner_result_digest, rollbacks.runner_status,
              rollbacks.runner_exit_code, rollbacks.runner_duration_ms,
              rollbacks.external_state, rollbacks.external_conclusion,
              rollbacks.external_updated_at, rollbacks.evidence_id,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation, attempts.workflow_ref AS attempt_workflow_ref
       FROM test_rollbacks AS rollbacks
       JOIN attempts ON attempts.attempt_id = rollbacks.attempt_id
       WHERE rollbacks.github_run_id = ?`,
    ).bind(githubRunId).first<ProjectionRow>();
  }

  private async observation(observationId: string): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT fact_digest, processing_state
       FROM github_test_rollback_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
  }

  private async finalize(
    observationId: string,
    factDigest: string,
    projection: ProjectionResult,
    observedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE github_test_rollback_observations
       SET processing_state = ?, rollback_id = ?, ignore_reason = ?, processed_at = ?
       WHERE observation_id = ? AND fact_digest = ? AND processing_state = 'received'`,
    ).bind(
      projection.disposition,
      projection.rollbackId,
      projection.reason,
      observedAt,
      observationId,
      factDigest,
    ).run();
  }

  private async evidenceId(
    rollbackId: string,
    status: 'passed' | 'failed',
  ): Promise<string> {
    const digest = await canonicalSha256({ rollbackId, status });
    return `evidence_test_rollback_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }
}

