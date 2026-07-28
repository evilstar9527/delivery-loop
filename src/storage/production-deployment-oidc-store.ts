import type { GitHubOidcClaims } from '../auth/github-oidc.js';
import { PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const GITHUB_RUN_ID_PATTERN = /^[1-9][0-9]{0,31}$/;

export type ProductionDeploymentOidcErrorCode =
  | 'not_found'
  | 'binding_mismatch'
  | 'state_conflict';

export class ProductionDeploymentOidcError extends Error {
  constructor(readonly code: ProductionDeploymentOidcErrorCode) {
    super(`production deployment OIDC attestation failed: ${code}`);
    this.name = 'ProductionDeploymentOidcError';
  }
}

export interface ProductionDeploymentOidcExpectation {
  deploymentId: string;
  audience: typeof PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE;
}

export interface ProductionDeploymentOidcResult {
  accepted: true;
  attestationId: string;
  disposition: 'created' | 'duplicate';
  roleRef: string;
}

interface DeploymentRow {
  deployment_id: string;
  repository: string;
  base_branch: string;
  merge_id: string;
  merge_sha: string;
  workflow_path: string;
  role_ref: string;
  environment: string;
  oidc_audience: string;
  status: string;
  github_deployment_id: string | null;
  run_id: string;
  run_version: number;
  task_revision: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  attempt_id: string;
  approval_id: string;
}

interface AttestationRow {
  attestation_id: string;
  oidc_token_digest: string;
  repository: string;
  workflow_ref: string;
  sha: string;
  github_run_id: string;
  subject: string;
  environment: string;
  audience: string;
}

/** Stores only a JWT digest after exact production Environment/release binding. */
export class ProductionDeploymentOidcStore {
  constructor(private readonly db: D1Database) {}

  async expectation(deploymentId: string): Promise<ProductionDeploymentOidcExpectation> {
    if (!ID_PATTERN.test(deploymentId)) throw new ProductionDeploymentOidcError('not_found');
    const row = await this.deployment(deploymentId);
    if (row === null || row.oidc_audience !== PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE) {
      throw new ProductionDeploymentOidcError('not_found');
    }
    return { deploymentId: row.deployment_id, audience: PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE };
  }

  async attest(
    deploymentId: string,
    oidcToken: string,
    claims: GitHubOidcClaims,
    now = new Date(),
  ): Promise<ProductionDeploymentOidcResult> {
    const deployment = await this.deployment(deploymentId);
    if (deployment === null) throw new ProductionDeploymentOidcError('not_found');
    const workflowRef =
      `${deployment.repository}/${deployment.workflow_path}@refs/heads/${deployment.base_branch}`;
    const subject = `repo:${deployment.repository}:environment:production`;
    if (
      deployment.environment !== 'production' ||
      deployment.oidc_audience !== PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE ||
      deployment.github_deployment_id === null ||
      !['created_unverified', 'in_progress', 'succeeded', 'failed'].includes(deployment.status) ||
      claims.repository !== deployment.repository || claims.workflowRef !== workflowRef ||
      claims.sha !== deployment.merge_sha || claims.subject !== subject ||
      claims.environment !== 'production' || !GITHUB_RUN_ID_PATTERN.test(claims.runId)
    ) throw new ProductionDeploymentOidcError('binding_mismatch');

    const tokenDigest = await canonicalSha256(oidcToken);
    const identity = await canonicalSha256({
      deploymentId,
      mergeId: deployment.merge_id,
      mergeSha: deployment.merge_sha,
      repository: claims.repository,
      workflowRef: claims.workflowRef,
      subject: claims.subject,
      environment: claims.environment,
    });
    const attestationId =
      `production_deploy_attestation_${identity.slice('sha256:'.length, 'sha256:'.length + 40)}`;
    const existing = await this.attestation(deploymentId);
    if (existing !== null) {
      this.assertExisting(existing, deployment, claims, workflowRef, subject);
      return {
        accepted: true,
        attestationId: existing.attestation_id,
        disposition: 'duplicate',
        roleRef: deployment.role_ref,
      };
    }

    const nowIso = now.toISOString();
    await this.db.prepare(
      `INSERT INTO production_deployment_oidc_attestations (
         attestation_id, deployment_id, oidc_token_digest, repository,
         workflow_ref, sha, github_run_id, subject, environment, audience, created_at
       )
       SELECT ?, deployments.deployment_id, ?, deployments.repository, ?,
              deployments.merge_sha, ?, ?, 'production', ?, ?
       FROM production_deployments AS deployments
       JOIN runs ON runs.run_id = deployments.run_id
       JOIN execution_plans AS plans ON plans.plan_id = deployments.plan_id
       JOIN github_merges AS merges ON merges.merge_id = deployments.merge_id
       JOIN attempts ON attempts.attempt_id = deployments.attempt_id
       JOIN trusted_effect_approvals AS approvals
         ON approvals.approval_id = deployments.approval_id
       JOIN production_release_approval_bindings AS release
         ON release.approval_id = approvals.approval_id
       WHERE deployments.deployment_id = ?
         AND deployments.repository = ? AND deployments.merge_sha = ?
         AND deployments.workflow_path = ? AND deployments.environment = 'production'
         AND deployments.oidc_audience = ? AND deployments.github_deployment_id IS NOT NULL
         AND deployments.status IN ('created_unverified', 'in_progress')
         AND runs.run_id = deployments.run_id AND runs.version = deployments.run_version
         AND runs.state = 'deploying' AND runs.task_revision = deployments.task_revision
         AND runs.active_plan_id = deployments.plan_id
         AND runs.active_plan_version = deployments.plan_version
         AND runs.active_plan_digest = deployments.plan_digest
         AND plans.status = 'active'
         AND merges.run_id = runs.run_id AND merges.merge_sha = deployments.merge_sha
         AND merges.run_version + 2 = runs.version
         AND merges.deployment_disposition = 'production'
         AND attempts.status = 'running' AND attempts.mode = 'deploy'
         AND attempts.head_sha = deployments.merge_sha
         AND release.run_id = runs.run_id AND release.task_revision = runs.task_revision
         AND release.plan_id = plans.plan_id AND release.plan_version = plans.plan_version
         AND release.plan_digest = plans.digest AND release.merge_id = merges.merge_id
         AND release.merge_sha = merges.merge_sha AND release.environment = 'production'
         AND approvals.effect = 'production_deploy' AND approvals.decision = 'approve'
         AND approvals.expires_at > ?
       ON CONFLICT DO NOTHING`,
    ).bind(
      attestationId,
      tokenDigest,
      workflowRef,
      claims.runId,
      subject,
      PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE,
      nowIso,
      deploymentId,
      claims.repository,
      claims.sha,
      deployment.workflow_path,
      PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE,
      nowIso,
    ).run();
    const persisted = await this.attestation(deploymentId);
    if (persisted === null) throw new ProductionDeploymentOidcError('state_conflict');
    this.assertExisting(persisted, deployment, claims, workflowRef, subject);
    return {
      accepted: true,
      attestationId: persisted.attestation_id,
      disposition: 'created',
      roleRef: deployment.role_ref,
    };
  }

  private assertExisting(
    existing: AttestationRow,
    deployment: DeploymentRow,
    claims: GitHubOidcClaims,
    workflowRef: string,
    subject: string,
  ): void {
    if (
      existing.repository !== deployment.repository || existing.workflow_ref !== workflowRef ||
      existing.sha !== deployment.merge_sha || existing.github_run_id !== claims.runId ||
      existing.subject !== subject || existing.environment !== 'production' ||
      existing.audience !== PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE
    ) throw new ProductionDeploymentOidcError('state_conflict');
  }

  private async deployment(deploymentId: string): Promise<DeploymentRow | null> {
    return await this.db.prepare(
      `SELECT deployment_id, repository, base_branch, merge_id, merge_sha,
              workflow_path, role_ref, environment, oidc_audience, status,
              github_deployment_id, run_id, run_version, task_revision, plan_id,
              plan_version, plan_digest, attempt_id, approval_id
       FROM production_deployments WHERE deployment_id = ?`,
    ).bind(deploymentId).first<DeploymentRow>();
  }

  private async attestation(deploymentId: string): Promise<AttestationRow | null> {
    return await this.db.prepare(
      `SELECT attestation_id, oidc_token_digest, repository, workflow_ref, sha,
              github_run_id, subject, environment, audience
       FROM production_deployment_oidc_attestations WHERE deployment_id = ?`,
    ).bind(deploymentId).first<AttestationRow>();
  }
}
