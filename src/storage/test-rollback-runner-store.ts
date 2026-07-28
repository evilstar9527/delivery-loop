import type { GitHubOidcClaims } from '../auth/github-oidc.js';
import { TEST_ROLLBACK_OIDC_AUDIENCE } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import type { TestRollbackSourceKind } from '../domain/test-rollback.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export type TestRollbackRunnerErrorCode =
  | 'not_found'
  | 'binding_mismatch'
  | 'state_conflict'
  | 'result_conflict';

export class TestRollbackRunnerError extends Error {
  constructor(readonly code: TestRollbackRunnerErrorCode) {
    super(`test rollback Runner operation failed: ${code}`);
    this.name = 'TestRollbackRunnerError';
  }
}

export interface TestRollbackExpectation {
  rollbackId: string;
  audience: typeof TEST_ROLLBACK_OIDC_AUDIENCE;
}

export interface TestRollbackContextResult {
  accepted: true;
  attestationId: string;
  disposition: 'created' | 'duplicate';
  rollbackId: string;
  sourceKind: TestRollbackSourceKind;
  refSha: string;
  roleRef: string;
  policyDigest: string;
  contractDigest: string;
}

export interface TestRollbackReportResult {
  accepted: true;
  rollbackId: string;
  status: 'passed' | 'failed';
  disposition: 'created' | 'duplicate';
}

interface RollbackRow {
  rollback_id: string;
  source_kind: TestRollbackSourceKind;
  repository: string;
  base_branch: string;
  ref_sha: string;
  workflow_path: string;
  environment: string;
  oidc_audience: string;
  role_ref: string;
  policy_digest: string;
  contract_digest: string;
  status: string;
  github_run_id: string | null;
  runner_result_digest: string | null;
  runner_status: 'passed' | 'failed' | null;
  runner_exit_code: number | null;
  runner_duration_ms: number | null;
  attempt_id: string;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  run_state: string;
  run_version: number;
  current_run_version: number;
  plan_status: string;
  contract_declared: number;
  source_valid: number;
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

/** OIDC-gated context/result sink for the dedicated test rollback workflow. */
export class TestRollbackRunnerStore {
  constructor(private readonly db: D1Database) {}

  async expectation(rollbackId: string): Promise<TestRollbackExpectation> {
    if (!ID_PATTERN.test(rollbackId)) throw new TestRollbackRunnerError('not_found');
    const row = await this.rollback(rollbackId);
    if (row === null || row.oidc_audience !== TEST_ROLLBACK_OIDC_AUDIENCE) {
      throw new TestRollbackRunnerError('not_found');
    }
    return { rollbackId, audience: TEST_ROLLBACK_OIDC_AUDIENCE };
  }

  async attest(
    rollbackId: string,
    oidcToken: string,
    claims: GitHubOidcClaims,
    now = new Date(),
  ): Promise<TestRollbackContextResult> {
    const rollback = await this.rollback(rollbackId);
    if (rollback === null) throw new TestRollbackRunnerError('not_found');
    const workflowRef =
      `${rollback.repository}/${rollback.workflow_path}@refs/heads/${rollback.base_branch}`;
    const subject = `repo:${rollback.repository}:environment:test`;
    this.assertBinding(rollback, claims, workflowRef, subject, now);
    const oidcTokenDigest = await canonicalSha256(oidcToken);
    const identity = await canonicalSha256({
      rollbackId,
      repository: claims.repository,
      workflowRef,
      sha: claims.sha,
      runId: claims.runId,
      subject,
      environment: claims.environment,
    });
    const attestationId =
      `test_rollback_attestation_${identity.slice('sha256:'.length, 'sha256:'.length + 40)}`;
    const existing = await this.attestation(rollbackId);
    if (existing !== null) {
      this.assertAttestation(existing, rollback, claims, workflowRef, subject);
      return this.contextResult(existing.attestation_id, rollback, 'duplicate');
    }
    const nowIso = now.toISOString();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO test_rollback_oidc_attestations (
           attestation_id, rollback_id, oidc_token_digest, repository,
           workflow_ref, sha, github_run_id, subject, environment, audience, created_at
         )
         SELECT ?, rollbacks.rollback_id, ?, rollbacks.repository, ?, rollbacks.ref_sha,
                ?, ?, 'test', ?, ?
         FROM test_rollbacks AS rollbacks
         JOIN attempts ON attempts.attempt_id = rollbacks.attempt_id
         JOIN runs ON runs.run_id = rollbacks.run_id
         JOIN execution_plans AS plans ON plans.plan_id = rollbacks.plan_id
         JOIN test_rollback_contract_observations AS observations
           ON observations.observation_id = rollbacks.contract_observation_id
         WHERE rollbacks.rollback_id = ?
           AND rollbacks.status IN ('dispatched', 'running')
           AND rollbacks.github_run_id = ? AND rollbacks.repository = ?
           AND rollbacks.ref_sha = ? AND rollbacks.workflow_path = ?
           AND rollbacks.environment = 'test' AND rollbacks.oidc_audience = ?
           AND attempts.status IN ('starting', 'running')
           AND attempts.lease_expires_at > ?
           AND runs.state IN ('executing', 'blocked')
           AND runs.version = rollbacks.run_version
           AND runs.active_plan_id = rollbacks.plan_id
           AND runs.active_plan_version = rollbacks.plan_version
           AND runs.active_plan_digest = rollbacks.plan_digest
           AND plans.status IN ('active', 'blocked')
           AND observations.disposition = 'declared'
           AND observations.policy_digest = rollbacks.policy_digest
           AND observations.contract_digest = rollbacks.contract_digest
         ON CONFLICT DO NOTHING`,
      ).bind(
        attestationId,
        oidcTokenDigest,
        workflowRef,
        claims.runId,
        subject,
        TEST_ROLLBACK_OIDC_AUDIENCE,
        nowIso,
        rollbackId,
        claims.runId,
        claims.repository,
        claims.sha,
        rollback.workflow_path,
        TEST_ROLLBACK_OIDC_AUDIENCE,
        nowIso,
      ),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'running', version = version + 1,
             heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND mode = 'deploy' AND status = 'starting'
           AND version = 1 AND lease_generation = 1 AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM test_rollback_oidc_attestations
             WHERE rollback_id = ? AND github_run_id = ?
           )`,
      ).bind(nowIso, nowIso, rollback.attempt_id, nowIso, rollbackId, claims.runId),
      this.db.prepare(
        `UPDATE test_rollbacks SET status = 'running', updated_at = ?
         WHERE rollback_id = ? AND status IN ('dispatched', 'running')
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = test_rollbacks.attempt_id AND status = 'running'
           )`,
      ).bind(nowIso, rollbackId),
    ]);
    const persisted = await this.attestation(rollbackId);
    const refreshed = await this.rollback(rollbackId);
    if (persisted === null || refreshed === null) {
      throw new TestRollbackRunnerError('state_conflict');
    }
    this.assertAttestation(persisted, refreshed, claims, workflowRef, subject);
    if (
      persisted.oidc_token_digest !== oidcTokenDigest || refreshed.status !== 'running' ||
      refreshed.attempt_status !== 'running'
    ) throw new TestRollbackRunnerError('state_conflict');
    return this.contextResult(persisted.attestation_id, refreshed, 'created');
  }

  async report(
    rollbackId: string,
    oidcToken: string,
    claims: GitHubOidcClaims,
    input: { exitCode: number; durationMs: number },
    now = new Date(),
  ): Promise<TestRollbackReportResult> {
    if (
      !Number.isSafeInteger(input.exitCode) || input.exitCode < 0 || input.exitCode > 255 ||
      !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 ||
      input.durationMs > 3_600_000
    ) throw new TestRollbackRunnerError('result_conflict');
    const rollback = await this.rollback(rollbackId);
    if (rollback === null) throw new TestRollbackRunnerError('not_found');
    const workflowRef =
      `${rollback.repository}/${rollback.workflow_path}@refs/heads/${rollback.base_branch}`;
    const subject = `repo:${rollback.repository}:environment:test`;
    this.assertBinding(rollback, claims, workflowRef, subject, now);
    const oidcTokenDigest = await canonicalSha256(oidcToken);
    const attestation = await this.attestation(rollbackId);
    if (attestation === null || attestation.oidc_token_digest !== oidcTokenDigest) {
      throw new TestRollbackRunnerError('binding_mismatch');
    }
    this.assertAttestation(attestation, rollback, claims, workflowRef, subject);
    const status = input.exitCode === 0 ? 'passed' as const : 'failed' as const;
    const resultDigest = await canonicalSha256({
      schemaVersion: '1',
      rollbackId,
      sourceKind: rollback.source_kind,
      attemptId: rollback.attempt_id,
      githubRunId: claims.runId,
      refSha: rollback.ref_sha,
      policyDigest: rollback.policy_digest,
      contractDigest: rollback.contract_digest,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      status,
    });
    if (rollback.runner_result_digest !== null) {
      if (
        rollback.runner_result_digest !== resultDigest || rollback.runner_status !== status ||
        rollback.runner_exit_code !== input.exitCode ||
        rollback.runner_duration_ms !== input.durationMs
      ) throw new TestRollbackRunnerError('result_conflict');
      return { accepted: true, rollbackId, status, disposition: 'duplicate' };
    }
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_rollbacks
         SET runner_result_digest = ?, runner_status = ?, runner_exit_code = ?,
             runner_duration_ms = ?, updated_at = ?
         WHERE rollback_id = ? AND status = 'running'
           AND runner_result_digest IS NULL
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = test_rollbacks.attempt_id
               AND status = 'running' AND lease_expires_at > ?
           )`,
      ).bind(
        resultDigest,
        status,
        input.exitCode,
        input.durationMs,
        nowIso,
        rollbackId,
        nowIso,
      ),
      this.db.prepare(
        `UPDATE attempts SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'running' AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM test_rollbacks
             WHERE rollback_id = ? AND runner_result_digest = ?
           )`,
      ).bind(
        leaseExpiresAt,
        nowIso,
        nowIso,
        rollback.attempt_id,
        nowIso,
        rollbackId,
        resultDigest,
      ),
    ]);
    const persisted = await this.rollback(rollbackId);
    if (
      persisted?.runner_result_digest !== resultDigest || persisted.runner_status !== status
    ) throw new TestRollbackRunnerError('state_conflict');
    return { accepted: true, rollbackId, status, disposition: 'created' };
  }

  private assertBinding(
    rollback: RollbackRow,
    claims: GitHubOidcClaims,
    workflowRef: string,
    subject: string,
    now: Date,
  ): void {
    if (
      rollback.environment !== 'test' ||
      rollback.oidc_audience !== TEST_ROLLBACK_OIDC_AUDIENCE ||
      rollback.github_run_id === null || !['dispatched', 'running'].includes(rollback.status) ||
      !['starting', 'running'].includes(rollback.attempt_status) ||
      (rollback.lease_expires_at ?? '') <= now.toISOString() ||
      !['executing', 'blocked'].includes(rollback.run_state) ||
      rollback.current_run_version !== rollback.run_version ||
      !['active', 'blocked'].includes(rollback.plan_status) ||
      rollback.contract_declared !== 1 || rollback.source_valid !== 1 ||
      claims.repository !== rollback.repository || claims.workflowRef !== workflowRef ||
      claims.sha !== rollback.ref_sha || claims.runId !== rollback.github_run_id ||
      claims.subject !== subject || claims.environment !== 'test'
    ) throw new TestRollbackRunnerError('binding_mismatch');
  }

  private assertAttestation(
    row: AttestationRow,
    rollback: RollbackRow,
    claims: GitHubOidcClaims,
    workflowRef: string,
    subject: string,
  ): void {
    if (
      row.repository !== rollback.repository || row.repository !== claims.repository ||
      row.workflow_ref !== workflowRef || row.sha !== rollback.ref_sha ||
      row.github_run_id !== claims.runId || row.subject !== subject ||
      row.environment !== 'test' || row.audience !== TEST_ROLLBACK_OIDC_AUDIENCE
    ) throw new TestRollbackRunnerError('state_conflict');
  }

  private contextResult(
    attestationId: string,
    row: RollbackRow,
    disposition: 'created' | 'duplicate',
  ): TestRollbackContextResult {
    return {
      accepted: true,
      attestationId,
      disposition,
      rollbackId: row.rollback_id,
      sourceKind: row.source_kind,
      refSha: row.ref_sha,
      roleRef: row.role_ref,
      policyDigest: row.policy_digest,
      contractDigest: row.contract_digest,
    };
  }

  private async rollback(rollbackId: string): Promise<RollbackRow | null> {
    return await this.db.prepare(
      `SELECT rollbacks.rollback_id, rollbacks.source_kind, rollbacks.repository,
              rollbacks.base_branch, rollbacks.ref_sha, rollbacks.workflow_path,
              rollbacks.environment, rollbacks.oidc_audience, rollbacks.role_ref,
              rollbacks.policy_digest, rollbacks.contract_digest, rollbacks.status,
              rollbacks.github_run_id, rollbacks.runner_result_digest,
              rollbacks.runner_status, rollbacks.runner_exit_code,
              rollbacks.runner_duration_ms, rollbacks.attempt_id,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation, attempts.lease_expires_at,
              runs.state AS run_state, rollbacks.run_version,
              runs.version AS current_run_version, plans.status AS plan_status,
              EXISTS (
                SELECT 1 FROM test_rollback_contract_observations AS observations
                WHERE observations.observation_id = rollbacks.contract_observation_id
                  AND observations.disposition = 'declared'
                  AND observations.policy_digest = rollbacks.policy_digest
                  AND observations.contract_digest = rollbacks.contract_digest
              ) AS contract_declared,
              CASE rollbacks.source_kind
                WHEN 'deployment_failure' THEN EXISTS (
                  SELECT 1 FROM test_deployments AS source
                  JOIN evidence ON evidence.evidence_id = source.evidence_id
                  JOIN attempts AS failed ON failed.attempt_id = source.attempt_id
                  WHERE source.deployment_id = rollbacks.source_id
                    AND source.evidence_id = rollbacks.source_evidence_id
                    AND source.status = 'failed'
                    AND source.external_state IN ('failure', 'error')
                    AND evidence.status = 'failed'
                    AND evidence.verification_status = 'verified'
                    AND failed.status = 'failed'
                )
                WHEN 'acceptance_failure' THEN EXISTS (
                  SELECT 1 FROM test_acceptances AS source
                  JOIN evidence ON evidence.evidence_id = source.evidence_id
                  JOIN attempts AS failed ON failed.attempt_id = source.attempt_id
                  JOIN test_deployments AS deployment
                    ON deployment.deployment_id = source.deployment_id
                  JOIN evidence AS deployment_evidence
                    ON deployment_evidence.evidence_id = deployment.evidence_id
                  WHERE source.acceptance_id = rollbacks.source_id
                    AND source.evidence_id = rollbacks.source_evidence_id
                    AND source.status = 'failed' AND source.external_state = 'completed'
                    AND evidence.status = 'failed'
                    AND evidence.verification_status = 'verified'
                    AND failed.status = 'failed' AND deployment.status = 'succeeded'
                    AND deployment_evidence.status = 'passed'
                    AND deployment_evidence.verification_status = 'verified'
                )
                ELSE 0
              END AS source_valid
       FROM test_rollbacks AS rollbacks
       JOIN attempts ON attempts.attempt_id = rollbacks.attempt_id
       JOIN runs ON runs.run_id = rollbacks.run_id
       JOIN execution_plans AS plans ON plans.plan_id = rollbacks.plan_id
       WHERE rollbacks.rollback_id = ?`,
    ).bind(rollbackId).first<RollbackRow>();
  }

  private async attestation(rollbackId: string): Promise<AttestationRow | null> {
    return await this.db.prepare(
      `SELECT attestation_id, oidc_token_digest, repository, workflow_ref, sha,
              github_run_id, subject, environment, audience
       FROM test_rollback_oidc_attestations WHERE rollback_id = ?`,
    ).bind(rollbackId).first<AttestationRow>();
  }
}

