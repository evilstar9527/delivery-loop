import { TEST_ACCEPTANCE_WORKFLOW_PATH } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import type {
  GitHubWorkflowRunFact,
  GitHubWorkflowRunStatus,
} from './github-run-observation-store.js';
import {
  PlanItemEvidenceVerificationError,
  PlanItemEvidenceVerifier,
} from './plan-item-evidence-verifier.js';

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

export interface GitHubTestAcceptanceWebhookObservation {
  deliveryId: string;
  payloadDigest: string;
  fact: GitHubWorkflowRunFact;
  receivedAt: string;
}

export interface GitHubTestAcceptanceApiObservation {
  observationId: string;
  factDigest: string;
  fact: GitHubWorkflowRunFact;
  observedAt: string;
}

export type GitHubTestAcceptanceObservationDisposition =
  | 'applied'
  | 'duplicate'
  | 'ignored';

export type GitHubTestAcceptanceStatusErrorCode =
  | 'observation_conflict'
  | 'runner_result_required'
  | 'state_conflict';

export class GitHubTestAcceptanceStatusError extends Error {
  constructor(readonly code: GitHubTestAcceptanceStatusErrorCode) {
    super(`GitHub test acceptance status failed: ${code}`);
    this.name = 'GitHubTestAcceptanceStatusError';
  }
}

interface ObservationRow {
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface ProjectionRow {
  acceptance_id: string;
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  attempt_id: string;
  repository: string;
  base_branch: string;
  ref_sha: string;
  workflow_path: string;
  command_ref: string;
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
  progress_status: string;
  progress_version: number;
  progress_active_attempt_id: string | null;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  attempt_workflow_ref: string | null;
}

interface ProjectionResult {
  disposition: 'applied' | 'ignored';
  acceptanceId: string | null;
  reason: string | null;
}

function workflowPathMatches(path: string, branch: string): boolean {
  return path === TEST_ACCEPTANCE_WORKFLOW_PATH ||
    path === `${TEST_ACCEPTANCE_WORKFLOW_PATH}@refs/heads/${branch}`;
}

function validFact(fact: GitHubWorkflowRunFact): boolean {
  const completed = fact.status === 'completed';
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fact.repository) &&
    /^[1-9][0-9]{0,31}$/.test(fact.githubRunId) &&
    fact.event === 'workflow_dispatch' &&
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
    row.workflow_path === TEST_ACCEPTANCE_WORKFLOW_PATH &&
    row.attempt_workflow_ref ===
      `${fact.repository}/${TEST_ACCEPTANCE_WORKFLOW_PATH}@refs/heads/${fact.headBranch}` &&
    workflowPathMatches(fact.workflowPath, fact.headBranch) &&
    fact.displayTitle === `delivery-loop/acceptance/${row.acceptance_id}` &&
    fact.runAttempt === 1;
}

function factAlreadyProjected(row: ProjectionRow, fact: GitHubWorkflowRunFact): boolean {
  return row.external_state === fact.status &&
    row.external_conclusion === fact.conclusion &&
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

/**
 * Projects signed/API-reconciled workflow facts for post-deployment acceptance.
 * A Runner result alone never closes the Item, and deployment success never creates
 * acceptance Evidence.
 */
export class GitHubTestAcceptanceStatusStore {
  constructor(private readonly db: D1Database) {}

  async applyWebhook(
    observation: GitHubTestAcceptanceWebhookObservation,
  ): Promise<GitHubTestAcceptanceObservationDisposition> {
    return await this.apply({
      observationId: `webhook_${observation.deliveryId}`,
      sourceKind: 'webhook',
      factDigest: observation.payloadDigest,
      fact: observation.fact,
      observedAt: observation.receivedAt,
    });
  }

  async applyApiObservation(
    observation: GitHubTestAcceptanceApiObservation,
  ): Promise<GitHubTestAcceptanceObservationDisposition> {
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
  }): Promise<GitHubTestAcceptanceObservationDisposition> {
    if (
      !OBSERVATION_ID_PATTERN.test(input.observationId) ||
      !FACT_DIGEST_PATTERN.test(input.factDigest) || !validFact(input.fact) ||
      !Number.isFinite(Date.parse(input.observedAt))
    ) throw new GitHubTestAcceptanceStatusError('state_conflict');
    const existing = await this.observation(input.observationId);
    if (existing !== null) {
      if (existing.fact_digest !== input.factDigest) {
        throw new GitHubTestAcceptanceStatusError('observation_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    } else {
      await this.db.prepare(
        `INSERT INTO github_test_acceptance_observations (
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
        throw new GitHubTestAcceptanceStatusError('observation_conflict');
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
      return { disposition: 'ignored', acceptanceId: null, reason: 'binding_mismatch' };
    }
    if (factAlreadyProjected(row, fact)) {
      if (
        fact.status !== 'completed' || row.status === 'failed' ||
        (row.status === 'passed' && row.evidence_id !== null)
      ) {
        return { disposition: 'applied', acceptanceId: row.acceptance_id, reason: null };
      }
      // Resume a partially projected terminal fact after a transient verifier race.
    } else {
      if (!isNewer(row.external_updated_at, fact.externalUpdatedAt)) {
        return {
          disposition: 'ignored',
          acceptanceId: row.acceptance_id,
          reason: 'stale_external_fact',
        };
      }
      if (row.external_state === 'completed' || row.status === 'passed' || row.status === 'failed') {
        return {
          disposition: 'ignored',
          acceptanceId: row.acceptance_id,
          reason: 'terminal_fact_conflict',
        };
      }
      await this.projectExternalFact(row, fact, observedAt);
      row = await this.projection(fact.githubRunId);
      if (row === null || !bindingMatches(row, fact) || !factAlreadyProjected(row, fact)) {
        throw new GitHubTestAcceptanceStatusError('state_conflict');
      }
    }

    if (fact.status !== 'completed') {
      return { disposition: 'applied', acceptanceId: row.acceptance_id, reason: null };
    }
    if (fact.conclusion === 'success' && row.runner_result_digest === null) {
      throw new GitHubTestAcceptanceStatusError('runner_result_required');
    }
    const passed = fact.conclusion === 'success' && row.runner_status === 'passed' &&
      row.runner_exit_code === 0 && row.runner_duration_ms !== null;
    if (passed) await this.applySuccess(row, fact, observedAt);
    else await this.applyFailure(row, fact, observedAt);
    const persisted = await this.projection(fact.githubRunId);
    if (
      persisted === null || !factAlreadyProjected(persisted, fact) ||
      (passed && (persisted.status !== 'passed' || persisted.evidence_id === null)) ||
      (!passed && (persisted.status !== 'failed' || persisted.evidence_id === null))
    ) throw new GitHubTestAcceptanceStatusError('state_conflict');
    return { disposition: 'applied', acceptanceId: row.acceptance_id, reason: null };
  }

  private async projectExternalFact(
    row: ProjectionRow,
    fact: GitHubWorkflowRunFact,
    observedAt: string,
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_acceptances
         SET external_state = ?, external_conclusion = ?, external_updated_at = ?,
             observation_version = observation_version + 1, updated_at = ?
         WHERE acceptance_id = ? AND status IN ('dispatched', 'running')
           AND external_updated_at IS ?`,
      ).bind(
        fact.status,
        fact.conclusion,
        fact.externalUpdatedAt,
        observedAt,
        row.acceptance_id,
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
      throw new GitHubTestAcceptanceStatusError('state_conflict');
    }
    const evidenceId = await this.evidenceId(row.acceptance_id, 'passed');
    const externalUrl = actionsRunUrl(row.repository, fact.githubRunId);
    const leaseExpiresAt = new Date(Date.parse(observedAt) + 5 * 60_000).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE attempts SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND mode = 'deploy' AND status = 'running'
           AND version = ? AND lease_generation = ?`,
      ).bind(
        leaseExpiresAt,
        observedAt,
        observedAt,
        row.attempt_id,
        row.attempt_version,
        row.lease_generation,
      ),
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, command_ref, exit_code, duration_ms, sha, external_url,
           summary, verification_status, observed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'test', 'passed', ?, 0, ?, ?, ?,
                   'Signed post-deployment acceptance workflow succeeded',
                   'unverified', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        row.run_id,
        row.attempt_id,
        row.plan_id,
        row.plan_version,
        row.plan_item_id,
        row.command_ref,
        row.runner_duration_ms,
        row.ref_sha,
        externalUrl,
        fact.externalUpdatedAt,
        observedAt,
      ),
    ]);
    const refreshed = await this.projection(fact.githubRunId);
    if (refreshed === null || refreshed.attempt_status !== 'running') {
      throw new GitHubTestAcceptanceStatusError('state_conflict');
    }
    const doneWhen = await this.doneWhenPositions(row.plan_id, row.plan_item_id);
    try {
      await new PlanItemEvidenceVerifier(this.db).verify({
        runId: row.run_id,
        expectedRunVersion: row.run_version,
        planVersion: row.plan_version,
        planItemId: row.plan_item_id,
        expectedProgressVersion: refreshed.progress_version,
        attemptId: row.attempt_id,
        expectedAttemptVersion: refreshed.attempt_version,
        leaseGeneration: refreshed.lease_generation,
        headSha: row.ref_sha,
        doneWhenEvidence: doneWhen.map((position) => ({
          position,
          evidenceIds: [evidenceId],
        })),
      }, new Date(observedAt));
    } catch (error) {
      if (error instanceof PlanItemEvidenceVerificationError) {
        throw new GitHubTestAcceptanceStatusError('state_conflict');
      }
      throw error;
    }
    await this.db.prepare(
      `UPDATE test_acceptances SET status = 'passed', evidence_id = ?, updated_at = ?
       WHERE acceptance_id = ? AND status IN ('dispatched', 'running', 'passed')
         AND external_state = 'completed' AND external_conclusion = 'success'
         AND runner_status = 'passed' AND runner_exit_code = 0
         AND (evidence_id IS NULL OR evidence_id = ?)
         AND EXISTS (
           SELECT 1 FROM evidence WHERE evidence_id = ?
             AND status = 'passed' AND verification_status = 'verified'
         )`,
    ).bind(evidenceId, observedAt, row.acceptance_id, evidenceId, evidenceId).run();
  }

  private async applyFailure(
    row: ProjectionRow,
    fact: GitHubWorkflowRunFact,
    observedAt: string,
  ): Promise<void> {
    const evidenceId = await this.evidenceId(row.acceptance_id, 'failed');
    const externalUrl = actionsRunUrl(row.repository, fact.githubRunId);
    const resultAvailable = row.runner_result_digest !== null;
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, command_ref, exit_code, duration_ms, sha, external_url,
           summary, verification_status, observed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'test', 'failed', ?, ?, ?, ?, ?, ?,
                   'verified', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        row.run_id,
        row.attempt_id,
        row.plan_id,
        row.plan_version,
        row.plan_item_id,
        resultAvailable ? row.command_ref : null,
        resultAvailable ? row.runner_exit_code : null,
        resultAvailable ? row.runner_duration_ms : null,
        row.ref_sha,
        externalUrl,
        fact.conclusion === 'success'
          ? 'Runner result conflicted with signed acceptance workflow success'
          : 'Signed post-deployment acceptance workflow failed',
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
      ).bind(
        observedAt,
        row.attempt_id,
        row.attempt_version,
        row.lease_generation,
      ),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'failed', active_attempt_id = NULL,
             version = version + 1, updated_at = ?
         WHERE plan_id = ? AND item_id = ? AND status = 'in_progress'
           AND version = ? AND active_attempt_id = ?`,
      ).bind(
        observedAt,
        row.plan_id,
        row.plan_item_id,
        row.progress_version,
        row.attempt_id,
      ),
      this.db.prepare(
        `UPDATE test_acceptances
         SET status = 'failed', evidence_id = ?, updated_at = ?
         WHERE acceptance_id = ? AND status IN ('dispatched', 'running', 'failed')
           AND external_state = 'completed'
           AND (evidence_id IS NULL OR evidence_id = ?)
           AND EXISTS (SELECT 1 FROM evidence WHERE evidence_id = ?)`,
      ).bind(evidenceId, observedAt, row.acceptance_id, evidenceId, evidenceId),
    ]);
  }

  private async projection(githubRunId: string): Promise<ProjectionRow | null> {
    return await this.db.prepare(
      `SELECT acceptances.acceptance_id, acceptances.run_id,
              acceptances.run_version, acceptances.plan_id,
              acceptances.plan_version, acceptances.plan_item_id,
              acceptances.attempt_id, acceptances.repository,
              acceptances.base_branch, acceptances.ref_sha,
              acceptances.workflow_path, acceptances.command_ref,
              acceptances.status, acceptances.github_run_id,
              acceptances.runner_result_digest, acceptances.runner_status,
              acceptances.runner_exit_code, acceptances.runner_duration_ms,
              acceptances.external_state, acceptances.external_conclusion,
              acceptances.external_updated_at, acceptances.evidence_id,
              progress.status AS progress_status,
              progress.version AS progress_version,
              progress.active_attempt_id AS progress_active_attempt_id,
              attempts.status AS attempt_status,
              attempts.version AS attempt_version,
              attempts.lease_generation, attempts.lease_expires_at,
              attempts.workflow_ref AS attempt_workflow_ref
       FROM test_acceptances AS acceptances
       JOIN plan_item_progress AS progress
         ON progress.plan_id = acceptances.plan_id
        AND progress.item_id = acceptances.plan_item_id
       JOIN attempts ON attempts.attempt_id = acceptances.attempt_id
       WHERE acceptances.github_run_id = ?`,
    ).bind(githubRunId).first<ProjectionRow>();
  }

  private async observation(observationId: string): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT fact_digest, processing_state
       FROM github_test_acceptance_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
  }

  private async finalize(
    observationId: string,
    factDigest: string,
    projection: ProjectionResult,
    observedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE github_test_acceptance_observations
       SET processing_state = ?, acceptance_id = ?, ignore_reason = ?, processed_at = ?
       WHERE observation_id = ? AND fact_digest = ? AND processing_state = 'received'`,
    ).bind(
      projection.disposition,
      projection.acceptanceId,
      projection.reason,
      observedAt,
      observationId,
      factDigest,
    ).run();
  }

  private async evidenceId(
    acceptanceId: string,
    status: 'passed' | 'failed',
  ): Promise<string> {
    const digest = await canonicalSha256({ acceptanceId, status });
    return `evidence_test_acceptance_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async doneWhenPositions(planId: string, itemId: string): Promise<number[]> {
    const rows = await this.db.prepare(
      `SELECT position FROM plan_item_done_when
       WHERE plan_id = ? AND item_id = ? ORDER BY position`,
    ).bind(planId, itemId).all<{ position: number }>();
    if (rows.results.length === 0) {
      throw new GitHubTestAcceptanceStatusError('state_conflict');
    }
    return rows.results.map((entry) => entry.position);
  }
}
