import type { GitHubOidcClaims } from '../auth/github-oidc.js';
import { TEST_DEPLOYMENT_OIDC_AUDIENCE } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const GITHUB_RUN_ID_PATTERN = /^[1-9][0-9]{0,31}$/;

export type TestDeploymentOidcErrorCode =
  | 'not_found'
  | 'binding_mismatch'
  | 'state_conflict';

export class TestDeploymentOidcError extends Error {
  constructor(readonly code: TestDeploymentOidcErrorCode) {
    super(`test deployment OIDC attestation failed: ${code}`);
    this.name = 'TestDeploymentOidcError';
  }
}

export interface TestDeploymentOidcExpectation {
  deploymentId: string;
  audience: typeof TEST_DEPLOYMENT_OIDC_AUDIENCE;
}

export interface TestDeploymentOidcResult {
  accepted: true;
  attestationId: string;
  disposition: 'created' | 'duplicate';
  roleRef: string;
}

interface DeploymentRow {
  deployment_id: string;
  repository: string;
  base_branch: string;
  ref_sha: string;
  workflow_path: string;
  role_ref: string;
  environment: string;
  oidc_audience: string;
  status: string;
  github_deployment_id: string | null;
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_item_id: string;
  attempt_id: string;
}

interface AttestationRow {
  attestation_id: string;
  deployment_id: string;
  oidc_token_digest: string;
  repository: string;
  workflow_ref: string;
  sha: string;
  github_run_id: string;
  subject: string;
  environment: string;
  audience: string;
}

/** Persists only a digest after GitHub JWT verification and exact Environment binding. */
export class TestDeploymentOidcStore {
  constructor(private readonly db: D1Database) {}

  async expectation(deploymentId: string): Promise<TestDeploymentOidcExpectation> {
    if (!ID_PATTERN.test(deploymentId)) throw new TestDeploymentOidcError('not_found');
    const row = await this.deployment(deploymentId);
    if (row === null || row.oidc_audience !== TEST_DEPLOYMENT_OIDC_AUDIENCE) {
      throw new TestDeploymentOidcError('not_found');
    }
    return { deploymentId: row.deployment_id, audience: TEST_DEPLOYMENT_OIDC_AUDIENCE };
  }

  async attest(
    deploymentId: string,
    oidcToken: string,
    claims: GitHubOidcClaims,
    now = new Date(),
  ): Promise<TestDeploymentOidcResult> {
    const deployment = await this.deployment(deploymentId);
    if (deployment === null) throw new TestDeploymentOidcError('not_found');
    const workflowRef =
      `${deployment.repository}/${deployment.workflow_path}@refs/heads/${deployment.base_branch}`;
    const subject = `repo:${deployment.repository}:environment:test`;
    if (
      deployment.environment !== 'test' ||
      deployment.oidc_audience !== TEST_DEPLOYMENT_OIDC_AUDIENCE ||
      deployment.github_deployment_id === null ||
      !['created_unverified', 'in_progress', 'succeeded', 'failed'].includes(deployment.status) ||
      claims.repository !== deployment.repository || claims.workflowRef !== workflowRef ||
      claims.sha !== deployment.ref_sha || claims.subject !== subject ||
      claims.environment !== 'test' || !GITHUB_RUN_ID_PATTERN.test(claims.runId)
    ) throw new TestDeploymentOidcError('binding_mismatch');

    const tokenDigest = await canonicalSha256(oidcToken);
    const identity = await canonicalSha256({
      deploymentId,
      repository: claims.repository,
      workflowRef: claims.workflowRef,
      sha: claims.sha,
      subject: claims.subject,
      environment: claims.environment,
    });
    const attestationId =
      `test_deploy_attestation_${identity.slice('sha256:'.length, 'sha256:'.length + 40)}`;
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
      `INSERT INTO test_deployment_oidc_attestations (
         attestation_id, deployment_id, oidc_token_digest, repository,
         workflow_ref, sha, github_run_id, subject, environment, audience, created_at
       )
       SELECT ?, deployments.deployment_id, ?, deployments.repository, ?,
              deployments.ref_sha, ?, ?, 'test', ?, ?
       FROM test_deployments AS deployments
       JOIN runs ON runs.run_id = deployments.run_id
       JOIN execution_plans AS plans ON plans.plan_id = deployments.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = deployments.plan_id
        AND progress.item_id = deployments.plan_item_id
       JOIN attempts ON attempts.attempt_id = deployments.attempt_id
       WHERE deployments.deployment_id = ?
         AND deployments.repository = ? AND deployments.ref_sha = ?
         AND deployments.workflow_path = ? AND deployments.environment = 'test'
         AND deployments.oidc_audience = ? AND deployments.github_deployment_id IS NOT NULL
         AND deployments.status IN ('created_unverified', 'in_progress')
         AND runs.run_id = deployments.run_id AND runs.version = deployments.run_version
         AND runs.state = 'executing' AND runs.active_plan_id = deployments.plan_id
         AND runs.active_plan_version = deployments.plan_version
         AND runs.active_plan_digest = deployments.plan_digest
         AND plans.status = 'active'
         AND progress.status = 'in_progress'
         AND progress.active_attempt_id = deployments.attempt_id
         AND attempts.status = 'running' AND attempts.mode = 'deploy'
       ON CONFLICT DO NOTHING`,
    ).bind(
      attestationId,
      tokenDigest,
      workflowRef,
      claims.runId,
      subject,
      TEST_DEPLOYMENT_OIDC_AUDIENCE,
      nowIso,
      deploymentId,
      deployment.repository,
      deployment.ref_sha,
      deployment.workflow_path,
      TEST_DEPLOYMENT_OIDC_AUDIENCE,
    ).run();
    const persisted = await this.attestation(deploymentId);
    if (persisted === null) throw new TestDeploymentOidcError('state_conflict');
    this.assertExisting(persisted, deployment, claims, workflowRef, subject);
    if (persisted.oidc_token_digest !== tokenDigest) {
      throw new TestDeploymentOidcError('state_conflict');
    }
    return {
      accepted: true,
      attestationId: persisted.attestation_id,
      disposition: 'created',
      roleRef: deployment.role_ref,
    };
  }

  private async deployment(deploymentId: string): Promise<DeploymentRow | null> {
    return await this.db.prepare(
      `SELECT deployment_id, repository, base_branch, ref_sha, workflow_path, role_ref,
              environment, oidc_audience, status, github_deployment_id,
              run_id, run_version, plan_id, plan_version, plan_digest,
              plan_item_id, attempt_id
       FROM test_deployments WHERE deployment_id = ?`,
    ).bind(deploymentId).first<DeploymentRow>();
  }

  private async attestation(deploymentId: string): Promise<AttestationRow | null> {
    return await this.db.prepare(
      `SELECT attestation_id, deployment_id, oidc_token_digest, repository,
              workflow_ref, sha, github_run_id, subject, environment, audience
       FROM test_deployment_oidc_attestations WHERE deployment_id = ?`,
    ).bind(deploymentId).first<AttestationRow>();
  }

  private assertExisting(
    row: AttestationRow,
    deployment: DeploymentRow,
    claims: GitHubOidcClaims,
    workflowRef: string,
    subject: string,
  ): void {
    if (
      row.deployment_id !== deployment.deployment_id ||
      row.repository !== claims.repository || row.workflow_ref !== workflowRef ||
      row.sha !== claims.sha || row.github_run_id !== claims.runId ||
      row.subject !== subject || row.environment !== 'test' ||
      row.audience !== TEST_DEPLOYMENT_OIDC_AUDIENCE
    ) throw new TestDeploymentOidcError('state_conflict');
  }
}
