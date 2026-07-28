import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubProductionDeploymentStatusFactSchema,
  type GitHubProductionDeploymentStatusFact,
} from '../domain/production-deployment-status.js';

const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface GitHubProductionDeploymentWebhookObservation {
  deliveryId: string;
  payloadDigest: string;
  fact: GitHubProductionDeploymentStatusFact;
  receivedAt: string;
}

export interface GitHubProductionDeploymentApiObservation {
  observationId: string;
  factDigest: string;
  fact: GitHubProductionDeploymentStatusFact;
  observedAt: string;
}

export type GitHubProductionDeploymentStatusDisposition =
  | 'applied'
  | 'duplicate'
  | 'ignored';

export type GitHubProductionDeploymentStatusErrorCode =
  | 'observation_conflict'
  | 'attestation_required'
  | 'state_conflict';

export class GitHubProductionDeploymentStatusError extends Error {
  constructor(readonly code: GitHubProductionDeploymentStatusErrorCode) {
    super(`GitHub production deployment status failed: ${code}`);
    this.name = 'GitHubProductionDeploymentStatusError';
  }
}

interface ObservationRow {
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface ProjectionRow {
  deployment_id: string;
  run_id: string;
  run_version: number;
  task_revision: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  merge_id: string;
  merge_sha: string;
  attempt_id: string;
  approval_id: string;
  repository: string;
  environment: string;
  status: string;
  github_deployment_id: string | null;
  external_state: string | null;
  external_url: string | null;
  external_updated_at: string | null;
  evidence_id: string | null;
  run_state: string;
  run_current_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_status: string;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  merge_run_version: number;
  merge_plan_id: string;
  merge_plan_version: number;
  merge_plan_digest: string;
  merge_disposition: string;
  release_task_revision: string;
  release_merge_id: string;
  release_merge_sha: string;
  release_environment: string;
  attested: number;
}

interface ProjectionResult {
  disposition: 'applied' | 'ignored';
  deploymentId: string | null;
  reason: string | null;
}

function newerThan(current: string | null, incoming: string): boolean {
  return Date.parse(incoming) >
    (current === null ? Number.NEGATIVE_INFINITY : Date.parse(current));
}

function sameFact(
  row: ProjectionRow,
  fact: GitHubProductionDeploymentStatusFact,
): boolean {
  return row.external_state === fact.state && row.external_url === fact.environmentUrl &&
    row.external_updated_at === fact.externalUpdatedAt;
}

/** Projects only GitHub-observed production statuses; Runner output is not an input. */
export class GitHubProductionDeploymentStatusStore {
  constructor(private readonly db: D1Database) {}

  async applyWebhook(
    observation: GitHubProductionDeploymentWebhookObservation,
  ): Promise<GitHubProductionDeploymentStatusDisposition> {
    return await this.apply({
      observationId: `webhook_${observation.deliveryId}`,
      sourceKind: 'webhook',
      factDigest: observation.payloadDigest,
      fact: observation.fact,
      observedAt: observation.receivedAt,
    });
  }

  async applyApiObservation(
    observation: GitHubProductionDeploymentApiObservation,
  ): Promise<GitHubProductionDeploymentStatusDisposition> {
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
    fact: GitHubProductionDeploymentStatusFact;
    observedAt: string;
  }): Promise<GitHubProductionDeploymentStatusDisposition> {
    const parsed = GitHubProductionDeploymentStatusFactSchema.safeParse(input.fact);
    if (
      !OBSERVATION_ID_PATTERN.test(input.observationId) ||
      !DIGEST_PATTERN.test(input.factDigest) || !parsed.success ||
      !Number.isFinite(Date.parse(input.observedAt))
    ) throw new GitHubProductionDeploymentStatusError('state_conflict');
    const existing = await this.observation(input.observationId);
    if (existing !== null) {
      if (existing.fact_digest !== input.factDigest) {
        throw new GitHubProductionDeploymentStatusError('observation_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    } else {
      await this.db.prepare(
        `INSERT INTO production_deployment_status_observations (
           observation_id, source_kind, fact_digest, repository,
           github_deployment_id, processing_state, external_updated_at, observed_at
         ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.observationId,
        input.sourceKind,
        input.factDigest,
        parsed.data.repository,
        parsed.data.githubDeploymentId,
        parsed.data.externalUpdatedAt,
        input.observedAt,
      ).run();
      const persisted = await this.observation(input.observationId);
      if (persisted === null || persisted.fact_digest !== input.factDigest) {
        throw new GitHubProductionDeploymentStatusError('observation_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }

    const projection = await this.project(parsed.data, input.observedAt);
    await this.finalize(input.observationId, input.factDigest, projection, input.observedAt);
    return projection.disposition;
  }

  private async project(
    fact: GitHubProductionDeploymentStatusFact,
    observedAt: string,
  ): Promise<ProjectionResult> {
    let row = await this.projection(fact.deploymentId);
    if (row === null || !this.bindingMatches(row, fact)) {
      return { disposition: 'ignored', deploymentId: null, reason: 'binding_mismatch' };
    }
    if (row.status === 'succeeded' || row.status === 'failed') {
      return sameFact(row, fact)
        ? { disposition: 'applied', deploymentId: row.deployment_id, reason: null }
        : {
            disposition: 'ignored',
            deploymentId: row.deployment_id,
            reason: 'terminal_already_observed',
          };
    }
    if (!newerThan(row.external_updated_at, fact.externalUpdatedAt)) {
      return sameFact(row, fact)
        ? { disposition: 'applied', deploymentId: row.deployment_id, reason: null }
        : {
            disposition: 'ignored',
            deploymentId: row.deployment_id,
            reason: 'stale_external_fact',
          };
    }
    if (!this.activeBindingMatches(row)) {
      return {
        disposition: 'ignored',
        deploymentId: row.deployment_id,
        reason: 'binding_mismatch',
      };
    }
    if (fact.state === 'success' && row.attested !== 1) {
      throw new GitHubProductionDeploymentStatusError('attestation_required');
    }
    if (fact.state === 'in_progress') {
      await this.applyInProgress(row, fact, observedAt);
    } else if (fact.state === 'success') {
      await this.applySuccess(row, fact, observedAt);
    } else {
      await this.applyFailure(row, fact, observedAt);
    }
    row = await this.projection(fact.deploymentId);
    if (row === null || !sameFact(row, fact)) {
      throw new GitHubProductionDeploymentStatusError('state_conflict');
    }
    return { disposition: 'applied', deploymentId: row.deployment_id, reason: null };
  }

  private bindingMatches(
    row: ProjectionRow,
    fact: GitHubProductionDeploymentStatusFact,
  ): boolean {
    return row.repository === fact.repository && row.merge_sha === fact.sha &&
      row.environment === 'production' &&
      row.github_deployment_id === fact.githubDeploymentId &&
      fact.task === 'delivery-loop:production' && fact.environment === 'production' &&
      row.merge_run_version + 2 === row.run_version &&
      row.merge_plan_id === row.plan_id && row.merge_plan_version === row.plan_version &&
      row.merge_plan_digest === row.plan_digest && row.merge_disposition === 'production' &&
      row.release_task_revision === row.task_revision &&
      row.release_merge_id === row.merge_id && row.release_merge_sha === row.merge_sha &&
      row.release_environment === 'production';
  }

  private activeBindingMatches(row: ProjectionRow): boolean {
    return row.run_state === 'deploying' && row.run_current_version === row.run_version &&
      row.active_plan_id === row.plan_id && row.active_plan_version === row.plan_version &&
      row.active_plan_digest === row.plan_digest && row.plan_status === 'active' &&
      row.attempt_status === 'running';
  }

  private async applyInProgress(
    row: ProjectionRow,
    fact: GitHubProductionDeploymentStatusFact,
    observedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE production_deployments
       SET status = 'in_progress', external_state = ?, external_url = ?,
           external_updated_at = ?, observation_version = observation_version + 1,
           updated_at = ?
       WHERE deployment_id = ? AND status IN ('created_unverified', 'in_progress')
         AND external_updated_at IS ?`,
    ).bind(
      fact.state,
      fact.environmentUrl,
      fact.externalUpdatedAt,
      observedAt,
      row.deployment_id,
      row.external_updated_at,
    ).run();
  }

  private async applySuccess(
    row: ProjectionRow,
    fact: GitHubProductionDeploymentStatusFact,
    observedAt: string,
  ): Promise<void> {
    const evidenceId = await this.evidenceId(row.deployment_id, 'passed');
    const factDigest = await canonicalSha256(fact);
    await this.db.batch([
      this.db.prepare(
        `UPDATE production_deployments
         SET status = 'succeeded', external_state = ?, external_url = ?,
             external_updated_at = ?, observation_version = observation_version + 1,
             updated_at = ?
         WHERE deployment_id = ? AND status IN ('created_unverified', 'in_progress')
           AND external_updated_at IS ?
           AND EXISTS (
             SELECT 1 FROM production_deployment_oidc_attestations
             WHERE deployment_id = production_deployments.deployment_id
           )`,
      ).bind(
        fact.state,
        fact.environmentUrl,
        fact.externalUpdatedAt,
        observedAt,
        row.deployment_id,
        row.external_updated_at,
      ),
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version,
           kind, status, sha, external_url, artifact_digest, summary,
           verification_status, observed_at, created_at
         )
         SELECT ?, run_id, attempt_id, plan_id, plan_version,
                'deployment', 'passed', merge_sha, external_url, ?,
                'GitHub production deployment succeeded', 'verified', ?, ?
         FROM production_deployments
         WHERE deployment_id = ? AND status = 'succeeded'
           AND external_state = 'success' AND external_updated_at = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        factDigest,
        fact.externalUpdatedAt,
        observedAt,
        row.deployment_id,
        fact.externalUpdatedAt,
      ),
      this.db.prepare(
        `UPDATE production_deployments SET evidence_id = ?, updated_at = ?
         WHERE deployment_id = ? AND status = 'succeeded' AND evidence_id IS NULL
           AND EXISTS (SELECT 1 FROM evidence WHERE evidence_id = ?)`,
      ).bind(evidenceId, observedAt, row.deployment_id, evidenceId),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'completed', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND mode = 'deploy' AND status = 'running'
           AND version = ? AND lease_generation = ?
           AND EXISTS (
             SELECT 1 FROM production_deployments
             WHERE deployment_id = ? AND status = 'succeeded' AND evidence_id = ?
           )`,
      ).bind(
        observedAt,
        row.attempt_id,
        row.attempt_version,
        row.lease_generation,
        row.deployment_id,
        evidenceId,
      ),
      this.db.prepare(
        `UPDATE runs SET state = 'succeeded', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'deploying' AND version = ?
           AND task_revision = ? AND active_plan_id = ?
           AND active_plan_version = ? AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM production_deployments
             WHERE deployment_id = ? AND run_id = runs.run_id
               AND run_version = runs.version AND status = 'succeeded'
               AND evidence_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND run_id = runs.run_id AND status = 'completed'
           )`,
      ).bind(
        observedAt,
        row.run_id,
        row.run_version,
        row.task_revision,
        row.plan_id,
        row.plan_version,
        row.plan_digest,
        row.deployment_id,
        evidenceId,
        row.attempt_id,
      ),
      this.db.prepare(
        `UPDATE execution_plans SET status = 'completed', updated_at = ?
         WHERE plan_id = ? AND run_id = ? AND plan_version = ?
           AND digest = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE run_id = ? AND state = 'succeeded' AND version = ?
               AND active_plan_id = execution_plans.plan_id
           )`,
      ).bind(
        observedAt,
        row.plan_id,
        row.run_id,
        row.plan_version,
        row.plan_digest,
        row.run_id,
        row.run_version + 1,
      ),
    ]);
    const refreshed = await this.projection(row.deployment_id);
    if (
      refreshed === null || refreshed.status !== 'succeeded' ||
      refreshed.evidence_id !== evidenceId || refreshed.attempt_status !== 'completed' ||
      refreshed.run_state !== 'succeeded' || refreshed.plan_status !== 'completed'
    ) throw new GitHubProductionDeploymentStatusError('state_conflict');
  }

  private async applyFailure(
    row: ProjectionRow,
    fact: GitHubProductionDeploymentStatusFact,
    observedAt: string,
  ): Promise<void> {
    const evidenceId = await this.evidenceId(row.deployment_id, 'failed');
    const factDigest = await canonicalSha256(fact);
    await this.db.batch([
      this.db.prepare(
        `UPDATE production_deployments
         SET status = 'failed', external_state = ?, external_url = ?,
             external_updated_at = ?, observation_version = observation_version + 1,
             updated_at = ?
         WHERE deployment_id = ? AND status IN ('created_unverified', 'in_progress')
           AND external_updated_at IS ?`,
      ).bind(
        fact.state,
        fact.environmentUrl,
        fact.externalUpdatedAt,
        observedAt,
        row.deployment_id,
        row.external_updated_at,
      ),
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version,
           kind, status, sha, external_url, artifact_digest, summary,
           verification_status, observed_at, created_at
         )
         SELECT ?, run_id, attempt_id, plan_id, plan_version,
                'deployment', 'failed', merge_sha, external_url, ?,
                'GitHub production deployment failed', 'verified', ?, ?
         FROM production_deployments
         WHERE deployment_id = ? AND status = 'failed'
           AND external_state IN ('failure', 'error') AND external_updated_at = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        factDigest,
        fact.externalUpdatedAt,
        observedAt,
        row.deployment_id,
        fact.externalUpdatedAt,
      ),
      this.db.prepare(
        `UPDATE production_deployments SET evidence_id = ?, updated_at = ?
         WHERE deployment_id = ? AND status = 'failed' AND evidence_id IS NULL
           AND EXISTS (SELECT 1 FROM evidence WHERE evidence_id = ?)`,
      ).bind(evidenceId, observedAt, row.deployment_id, evidenceId),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'failed', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND mode = 'deploy' AND status = 'running'
           AND version = ? AND lease_generation = ?
           AND EXISTS (
             SELECT 1 FROM production_deployments
             WHERE deployment_id = ? AND status = 'failed' AND evidence_id = ?
           )`,
      ).bind(
        observedAt,
        row.attempt_id,
        row.attempt_version,
        row.lease_generation,
        row.deployment_id,
        evidenceId,
      ),
      this.db.prepare(
        `UPDATE runs SET state = 'failed', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'deploying' AND version = ?
           AND task_revision = ? AND active_plan_id = ?
           AND active_plan_version = ? AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM production_deployments
             WHERE deployment_id = ? AND run_id = runs.run_id
               AND run_version = runs.version AND status = 'failed' AND evidence_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND run_id = runs.run_id AND status = 'failed'
           )`,
      ).bind(
        observedAt,
        row.run_id,
        row.run_version,
        row.task_revision,
        row.plan_id,
        row.plan_version,
        row.plan_digest,
        row.deployment_id,
        evidenceId,
        row.attempt_id,
      ),
    ]);
    const refreshed = await this.projection(row.deployment_id);
    if (
      refreshed === null || refreshed.status !== 'failed' ||
      refreshed.evidence_id !== evidenceId || refreshed.attempt_status !== 'failed' ||
      refreshed.run_state !== 'failed'
    ) throw new GitHubProductionDeploymentStatusError('state_conflict');
  }

  private async projection(deploymentId: string): Promise<ProjectionRow | null> {
    return await this.db.prepare(
      `SELECT deployments.deployment_id, deployments.run_id, deployments.run_version,
              deployments.task_revision, deployments.plan_id, deployments.plan_version,
              deployments.plan_digest, deployments.merge_id, deployments.merge_sha,
              deployments.attempt_id, deployments.approval_id,
              deployments.repository, deployments.environment, deployments.status,
              deployments.github_deployment_id, deployments.external_state,
              deployments.external_url, deployments.external_updated_at,
              deployments.evidence_id,
              runs.state AS run_state, runs.version AS run_current_version,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              plans.status AS plan_status, attempts.status AS attempt_status,
              attempts.version AS attempt_version,
              attempts.lease_generation,
              merges.run_version AS merge_run_version,
              merges.plan_id AS merge_plan_id,
              merges.plan_version AS merge_plan_version,
              merges.plan_digest AS merge_plan_digest,
              merges.deployment_disposition AS merge_disposition,
              release.task_revision AS release_task_revision,
              release.merge_id AS release_merge_id,
              release.merge_sha AS release_merge_sha,
              release.environment AS release_environment,
              EXISTS (
                SELECT 1 FROM production_deployment_oidc_attestations
                WHERE deployment_id = deployments.deployment_id
              ) AS attested
       FROM production_deployments AS deployments
       JOIN runs ON runs.run_id = deployments.run_id
       JOIN execution_plans AS plans ON plans.plan_id = deployments.plan_id
       JOIN attempts ON attempts.attempt_id = deployments.attempt_id
       JOIN github_merges AS merges ON merges.merge_id = deployments.merge_id
       JOIN production_release_approval_bindings AS release
         ON release.approval_id = deployments.approval_id
       WHERE deployments.deployment_id = ?`,
    ).bind(deploymentId).first<ProjectionRow>();
  }

  private async observation(observationId: string): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT fact_digest, processing_state
       FROM production_deployment_status_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
  }

  private async finalize(
    observationId: string,
    factDigest: string,
    projection: ProjectionResult,
    observedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE production_deployment_status_observations
       SET processing_state = ?, deployment_id = ?, ignore_reason = ?, processed_at = ?
       WHERE observation_id = ? AND fact_digest = ? AND processing_state = 'received'`,
    ).bind(
      projection.disposition,
      projection.deploymentId,
      projection.reason,
      observedAt,
      observationId,
      factDigest,
    ).run();
  }

  private async evidenceId(
    deploymentId: string,
    status: 'passed' | 'failed',
  ): Promise<string> {
    const digest = await canonicalSha256({ deploymentId, status });
    return `evidence_production_deploy_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }
}
