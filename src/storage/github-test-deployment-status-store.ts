import { canonicalSha256 } from '../domain/digest.js';
import {
  PlanItemEvidenceVerificationError,
  PlanItemEvidenceVerifier,
} from './plan-item-evidence-verifier.js';

export type GitHubTestDeploymentState = 'in_progress' | 'success' | 'failure' | 'error';

export interface GitHubTestDeploymentStatusFact {
  repository: string;
  githubDeploymentId: string;
  deploymentId: string;
  sha: string;
  task: 'delivery-loop:test';
  environment: 'test';
  state: GitHubTestDeploymentState;
  environmentUrl: string | null;
  externalUpdatedAt: string;
}

export interface GitHubTestDeploymentStatusDelivery {
  deliveryId: string;
  payloadDigest: string;
  fact: GitHubTestDeploymentStatusFact;
  receivedAt: string;
}

export interface GitHubTestDeploymentStatusApiObservation {
  observationId: string;
  factDigest: string;
  fact: GitHubTestDeploymentStatusFact;
  observedAt: string;
}

export type GitHubTestDeploymentStatusDisposition = 'applied' | 'duplicate' | 'ignored';

export type GitHubTestDeploymentStatusErrorCode =
  | 'delivery_conflict'
  | 'attestation_required'
  | 'state_conflict';

export class GitHubTestDeploymentStatusError extends Error {
  constructor(readonly code: GitHubTestDeploymentStatusErrorCode) {
    super(`GitHub test deployment status failed: ${code}`);
    this.name = 'GitHubTestDeploymentStatusError';
  }
}

interface DeliveryRow {
  payload_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface ObservationRow {
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface ProjectionRow {
  deployment_id: string;
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  attempt_id: string;
  repository: string;
  ref_sha: string;
  environment: string;
  status: string;
  github_deployment_id: string | null;
  external_state: string | null;
  external_url: string | null;
  external_updated_at: string | null;
  evidence_id: string | null;
  progress_status: string;
  progress_version: number;
  progress_active_attempt_id: string | null;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  attested: number;
  provider: 'github_actions' | 'yunxiao_pipeline';
}

function validExternalUrl(value: string | null): boolean {
  if (value === null) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.search === '' && url.hash === '' && value.length <= 2_000;
  } catch {
    return false;
  }
}

function validFact(fact: GitHubTestDeploymentStatusFact): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fact.repository) &&
    /^[1-9][0-9]{0,31}$/.test(fact.githubDeploymentId) &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(fact.deploymentId) &&
    /^[a-f0-9]{40}$/.test(fact.sha) && fact.task === 'delivery-loop:test' &&
    fact.environment === 'test' &&
    ['in_progress', 'success', 'failure', 'error'].includes(fact.state) &&
    validExternalUrl(fact.environmentUrl) &&
    Number.isFinite(Date.parse(fact.externalUpdatedAt));
}

function validDelivery(delivery: GitHubTestDeploymentStatusDelivery): boolean {
  return /^[A-Fa-f0-9-]{16,64}$/.test(delivery.deliveryId) &&
    /^sha256:[a-f0-9]{64}$/.test(delivery.payloadDigest) &&
    validFact(delivery.fact) && Number.isFinite(Date.parse(delivery.receivedAt));
}

function validApiObservation(observation: GitHubTestDeploymentStatusApiObservation): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(observation.observationId) &&
    /^sha256:[a-f0-9]{64}$/.test(observation.factDigest) &&
    validFact(observation.fact) && Number.isFinite(Date.parse(observation.observedAt));
}

function newerThan(current: string | null, incoming: string): boolean {
  const currentTime = current === null ? Number.NEGATIVE_INFINITY : Date.parse(current);
  const incomingTime = Date.parse(incoming);
  return Number.isFinite(incomingTime) && incomingTime > currentTime;
}

function sameFact(row: ProjectionRow, fact: GitHubTestDeploymentStatusFact): boolean {
  return row.external_state === fact.state && row.external_url === fact.environmentUrl &&
    row.external_updated_at === fact.externalUpdatedAt;
}

/** Signed deployment_status projector; a GitHub create response can never produce Evidence. */
export class GitHubTestDeploymentStatusStore {
  constructor(private readonly db: D1Database) {}

  async apply(
    delivery: GitHubTestDeploymentStatusDelivery,
  ): Promise<GitHubTestDeploymentStatusDisposition> {
    if (!validDelivery(delivery)) throw new GitHubTestDeploymentStatusError('state_conflict');
    const existing = await this.delivery(delivery.deliveryId);
    if (existing !== null) {
      if (existing.payload_digest !== delivery.payloadDigest) {
        throw new GitHubTestDeploymentStatusError('delivery_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    } else {
      await this.db.prepare(
        `INSERT INTO github_test_deployment_webhook_deliveries (
           delivery_id, event_type, payload_digest, repository,
           github_deployment_id, processing_state, external_updated_at, received_at
         ) VALUES (?, 'deployment_status', ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        delivery.deliveryId,
        delivery.payloadDigest,
        delivery.fact.repository,
        delivery.fact.githubDeploymentId,
        delivery.fact.externalUpdatedAt,
        delivery.receivedAt,
      ).run();
      const persisted = await this.delivery(delivery.deliveryId);
      if (persisted === null || persisted.payload_digest !== delivery.payloadDigest) {
        throw new GitHubTestDeploymentStatusError('delivery_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }

    return await this.applyFact(
      delivery.fact,
      delivery.receivedAt,
      async (state, reason, deploymentId) => {
        await this.finalize(delivery.deliveryId, state, reason, deploymentId);
      },
    );
  }

  async applyApiObservation(
    observation: GitHubTestDeploymentStatusApiObservation,
  ): Promise<GitHubTestDeploymentStatusDisposition> {
    if (!validApiObservation(observation)) {
      throw new GitHubTestDeploymentStatusError('state_conflict');
    }
    const existing = await this.observation(observation.observationId);
    if (existing !== null) {
      if (existing.fact_digest !== observation.factDigest) {
        throw new GitHubTestDeploymentStatusError('delivery_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    } else {
      await this.db.prepare(
        `INSERT INTO github_test_deployment_status_observations (
           observation_id, source_kind, fact_digest, repository,
           github_deployment_id, processing_state, external_updated_at, observed_at
         ) VALUES (?, 'api', ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        observation.observationId,
        observation.factDigest,
        observation.fact.repository,
        observation.fact.githubDeploymentId,
        observation.fact.externalUpdatedAt,
        observation.observedAt,
      ).run();
      const persisted = await this.observation(observation.observationId);
      if (persisted === null || persisted.fact_digest !== observation.factDigest) {
        throw new GitHubTestDeploymentStatusError('delivery_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }
    return await this.applyFact(
      observation.fact,
      observation.observedAt,
      async (state, reason, deploymentId) => {
        await this.finalizeObservation(
          observation.observationId,
          state,
          reason,
          deploymentId,
          observation.observedAt,
        );
      },
    );
  }

  private async applyFact(
    fact: GitHubTestDeploymentStatusFact,
    observedAt: string,
    finalize: (
      state: 'applied' | 'ignored',
      reason: string | null,
      deploymentId: string | null,
    ) => Promise<void>,
  ): Promise<GitHubTestDeploymentStatusDisposition> {
    let projection = await this.projection(fact.deploymentId);
    if (projection === null || !this.bindingMatches(projection, fact)) {
      await finalize('ignored', 'binding_mismatch', null);
      return 'ignored';
    }
    if (!newerThan(projection.external_updated_at, fact.externalUpdatedAt)) {
      const disposition = sameFact(projection, fact) ? 'applied' : 'ignored';
      await finalize(
        disposition,
        disposition === 'ignored' ? 'stale_external_fact' : null,
        projection.deployment_id,
      );
      return disposition;
    }
    if (fact.state === 'success' && projection.provider === 'github_actions' && projection.attested !== 1) {
      throw new GitHubTestDeploymentStatusError('attestation_required');
    }
    if (fact.state === 'in_progress') {
      await this.applyInProgress(projection, fact, observedAt);
    } else if (fact.state === 'success') {
      await this.applySuccess(projection, fact, observedAt);
    } else {
      await this.applyFailure(projection, fact, observedAt);
    }
    projection = await this.projection(fact.deploymentId);
    if (projection === null || !sameFact(projection, fact)) {
      throw new GitHubTestDeploymentStatusError('state_conflict');
    }
    await finalize('applied', null, projection.deployment_id);
    return 'applied';
  }

  private bindingMatches(
    row: ProjectionRow,
    fact: GitHubTestDeploymentStatusFact,
  ): boolean {
    return row.repository === fact.repository && row.ref_sha === fact.sha &&
      row.environment === 'test' && row.github_deployment_id === fact.githubDeploymentId &&
      fact.task === 'delivery-loop:test' && fact.environment === 'test';
  }

  private async applyInProgress(
    row: ProjectionRow,
    fact: GitHubTestDeploymentStatusFact,
    observedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE test_deployments
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
    fact: GitHubTestDeploymentStatusFact,
    observedAt: string,
  ): Promise<void> {
    const evidenceId = await this.evidenceId(row.deployment_id, 'passed');
    const leaseExpiresAt = new Date(Date.parse(observedAt) + 5 * 60_000).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_deployments
         SET status = 'succeeded', external_state = ?, external_url = ?,
             external_updated_at = ?, observation_version = observation_version + 1,
             updated_at = ?
         WHERE deployment_id = ? AND status IN ('created_unverified', 'in_progress', 'succeeded')
           AND external_updated_at IS ?
           AND EXISTS (
             SELECT 1 FROM test_deployment_oidc_attestations
             WHERE deployment_id = test_deployments.deployment_id
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
           kind, status, sha, external_url, summary, verification_status,
           observed_at, created_at
         )
         SELECT ?, run_id, attempt_id, plan_id, plan_version, plan_item_id,
                'deployment', 'passed', ref_sha, external_url,
                CASE WHEN provider = 'yunxiao_pipeline'
                     THEN 'Verified Yunxiao test deployment succeeded'
                     ELSE 'Signed GitHub test deployment succeeded' END,
                'unverified', ?, ?
         FROM test_deployments
         WHERE deployment_id = ? AND status = 'succeeded'
           AND external_state = 'success' AND external_updated_at = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        fact.externalUpdatedAt,
        observedAt,
        row.deployment_id,
        fact.externalUpdatedAt,
      ),
      this.db.prepare(
        `UPDATE test_deployments SET evidence_id = ?, updated_at = ?
         WHERE deployment_id = ? AND status = 'succeeded'
           AND evidence_id IS NULL
           AND EXISTS (SELECT 1 FROM evidence WHERE evidence_id = ?)`,
      ).bind(evidenceId, observedAt, row.deployment_id, evidenceId),
    ]);
    const refreshed = await this.projection(row.deployment_id);
    if (
      refreshed === null || refreshed.status !== 'succeeded' ||
      refreshed.evidence_id !== evidenceId || refreshed.attempt_status !== 'running'
    ) throw new GitHubTestDeploymentStatusError('state_conflict');
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
        throw new GitHubTestDeploymentStatusError('state_conflict');
      }
      throw error;
    }
  }

  private async applyFailure(
    row: ProjectionRow,
    fact: GitHubTestDeploymentStatusFact,
    observedAt: string,
  ): Promise<void> {
    const evidenceId = await this.evidenceId(row.deployment_id, 'failed');
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_deployments
         SET status = 'failed', external_state = ?, external_url = ?,
             external_updated_at = ?, observation_version = observation_version + 1,
             updated_at = ?
         WHERE deployment_id = ?
           AND status IN ('created_unverified', 'in_progress', 'failed')
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
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, sha, external_url, summary, verification_status,
           observed_at, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, 'deployment', 'failed', ?, ?,
                  CASE WHEN provider = 'yunxiao_pipeline'
                       THEN 'Verified Yunxiao test deployment failed'
                       ELSE 'Signed GitHub test deployment failed' END,
                  'verified', ?, ?
           FROM test_deployments WHERE deployment_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        row.run_id,
        row.attempt_id,
        row.plan_id,
        row.plan_version,
        row.plan_item_id,
        row.ref_sha,
        fact.environmentUrl,
        fact.externalUpdatedAt,
        observedAt,
        row.deployment_id,
      ),
      this.db.prepare(
        `UPDATE test_deployments SET evidence_id = ?, updated_at = ?
         WHERE deployment_id = ? AND status = 'failed'
           AND evidence_id IS NULL
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
             SELECT 1 FROM test_deployments
             WHERE deployment_id = ? AND status = 'failed'
           )`,
      ).bind(
        observedAt,
        row.attempt_id,
        row.attempt_version,
        row.lease_generation,
        row.deployment_id,
      ),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'failed', active_attempt_id = NULL,
             version = version + 1, updated_at = ?
         WHERE plan_id = ? AND item_id = ? AND status = 'in_progress'
           AND version = ? AND active_attempt_id = ?
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND status = 'failed'
           )`,
      ).bind(
        observedAt,
        row.plan_id,
        row.plan_item_id,
        row.progress_version,
        row.attempt_id,
        row.attempt_id,
      ),
    ]);
  }

  private async projection(deploymentId: string): Promise<ProjectionRow | null> {
    return await this.db.prepare(
      `SELECT deployments.deployment_id, deployments.run_id, deployments.run_version,
              deployments.plan_id, deployments.plan_version, deployments.plan_item_id,
              deployments.attempt_id, deployments.repository, deployments.ref_sha,
              deployments.environment, deployments.status,
              deployments.github_deployment_id, deployments.external_state,
              deployments.external_url, deployments.external_updated_at,
              deployments.evidence_id,
              progress.status AS progress_status, progress.version AS progress_version,
              progress.active_attempt_id AS progress_active_attempt_id,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation,
              deployments.provider,
              EXISTS (SELECT 1 FROM test_deployment_oidc_attestations
                      WHERE deployment_id = deployments.deployment_id) AS attested
       FROM test_deployments AS deployments
       JOIN plan_item_progress AS progress
         ON progress.plan_id = deployments.plan_id
        AND progress.item_id = deployments.plan_item_id
       JOIN attempts ON attempts.attempt_id = deployments.attempt_id
       WHERE deployments.deployment_id = ?`,
    ).bind(deploymentId).first<ProjectionRow>();
  }

  private async delivery(deliveryId: string): Promise<DeliveryRow | null> {
    return await this.db.prepare(
      `SELECT payload_digest, processing_state
       FROM github_test_deployment_webhook_deliveries WHERE delivery_id = ?`,
    ).bind(deliveryId).first<DeliveryRow>();
  }

  private async observation(observationId: string): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT fact_digest, processing_state
       FROM github_test_deployment_status_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
  }

  private async finalize(
    deliveryId: string,
    state: 'applied' | 'ignored',
    reason: string | null,
    deploymentId: string | null,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE github_test_deployment_webhook_deliveries
       SET processing_state = ?, ignore_reason = ?, deployment_id = ?, processed_at = ?
       WHERE delivery_id = ? AND processing_state = 'received'`,
    ).bind(state, reason, deploymentId, new Date().toISOString(), deliveryId).run();
  }

  private async finalizeObservation(
    observationId: string,
    state: 'applied' | 'ignored',
    reason: string | null,
    deploymentId: string | null,
    processedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE github_test_deployment_status_observations
       SET processing_state = ?, ignore_reason = ?, deployment_id = ?, processed_at = ?
       WHERE observation_id = ? AND processing_state = 'received'`,
    ).bind(state, reason, deploymentId, processedAt, observationId).run();
  }

  private async evidenceId(deploymentId: string, status: 'passed' | 'failed'): Promise<string> {
    const digest = await canonicalSha256({ deploymentId, status });
    return `evidence_test_deploy_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async doneWhenPositions(planId: string, itemId: string): Promise<number[]> {
    const rows = await this.db.prepare(
      `SELECT position FROM plan_item_done_when
       WHERE plan_id = ? AND item_id = ? ORDER BY position`,
    ).bind(planId, itemId).all<{ position: number }>();
    if (rows.results.length === 0) throw new GitHubTestDeploymentStatusError('state_conflict');
    return rows.results.map((row) => row.position);
  }
}
