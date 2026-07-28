import type { GitHubOidcClaims } from '../auth/github-oidc.js';
import { TEST_ACCEPTANCE_OIDC_AUDIENCE } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export type TestAcceptanceRunnerErrorCode =
  | 'not_found'
  | 'binding_mismatch'
  | 'state_conflict'
  | 'result_conflict';

export class TestAcceptanceRunnerError extends Error {
  constructor(readonly code: TestAcceptanceRunnerErrorCode) {
    super(`test acceptance Runner operation failed: ${code}`);
    this.name = 'TestAcceptanceRunnerError';
  }
}

export interface TestAcceptanceExpectation {
  acceptanceId: string;
  audience: typeof TEST_ACCEPTANCE_OIDC_AUDIENCE;
}

export interface TestAcceptanceContextResult {
  accepted: true;
  attestationId: string;
  disposition: 'created' | 'duplicate';
  acceptanceId: string;
  commandRef: string;
  refSha: string;
  environmentUrl: string;
}

export interface TestAcceptanceReportResult {
  accepted: true;
  acceptanceId: string;
  status: 'passed' | 'failed';
  disposition: 'created' | 'duplicate';
}

interface AcceptanceRow {
  acceptance_id: string;
  repository: string;
  base_branch: string;
  ref_sha: string;
  workflow_path: string;
  environment: string;
  oidc_audience: string;
  command_ref: string;
  environment_url: string;
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

/** OIDC-gated context and result sink for the fixed test acceptance workflow. */
export class TestAcceptanceRunnerStore {
  constructor(private readonly db: D1Database) {}

  async expectation(acceptanceId: string): Promise<TestAcceptanceExpectation> {
    if (!ID_PATTERN.test(acceptanceId)) throw new TestAcceptanceRunnerError('not_found');
    const row = await this.acceptance(acceptanceId);
    if (row === null || row.oidc_audience !== TEST_ACCEPTANCE_OIDC_AUDIENCE) {
      throw new TestAcceptanceRunnerError('not_found');
    }
    return { acceptanceId, audience: TEST_ACCEPTANCE_OIDC_AUDIENCE };
  }

  async attest(
    acceptanceId: string,
    oidcToken: string,
    claims: GitHubOidcClaims,
    now = new Date(),
  ): Promise<TestAcceptanceContextResult> {
    const acceptance = await this.acceptance(acceptanceId);
    if (acceptance === null) throw new TestAcceptanceRunnerError('not_found');
    const workflowRef =
      `${acceptance.repository}/${acceptance.workflow_path}@refs/heads/${acceptance.base_branch}`;
    const subject = `repo:${acceptance.repository}:environment:test`;
    this.assertBinding(acceptance, claims, workflowRef, subject, now);
    const oidcTokenDigest = await canonicalSha256(oidcToken);
    const identity = await canonicalSha256({
      acceptanceId,
      repository: claims.repository,
      workflowRef,
      sha: claims.sha,
      runId: claims.runId,
      subject,
      environment: claims.environment,
    });
    const attestationId =
      `test_acceptance_attestation_${identity.slice('sha256:'.length, 'sha256:'.length + 40)}`;
    const existing = await this.attestation(acceptanceId);
    if (existing !== null) {
      this.assertAttestation(existing, acceptance, claims, workflowRef, subject);
      return this.contextResult(existing.attestation_id, acceptance, 'duplicate');
    }
    const nowIso = now.toISOString();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO test_acceptance_oidc_attestations (
           attestation_id, acceptance_id, oidc_token_digest, repository,
           workflow_ref, sha, github_run_id, subject, environment, audience, created_at
         )
         SELECT ?, acceptances.acceptance_id, ?, acceptances.repository, ?,
                acceptances.ref_sha, ?, ?, 'test', ?, ?
         FROM test_acceptances AS acceptances
         JOIN attempts ON attempts.attempt_id = acceptances.attempt_id
         JOIN runs ON runs.run_id = acceptances.run_id
         JOIN execution_plans AS plans ON plans.plan_id = acceptances.plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = acceptances.plan_id
          AND progress.item_id = acceptances.plan_item_id
         WHERE acceptances.acceptance_id = ?
           AND acceptances.status IN ('dispatched', 'running')
           AND acceptances.github_run_id = ?
           AND acceptances.repository = ? AND acceptances.ref_sha = ?
           AND acceptances.workflow_path = ? AND acceptances.environment = 'test'
           AND acceptances.oidc_audience = ?
           AND attempts.status IN ('starting', 'running')
           AND attempts.lease_expires_at > ?
           AND runs.state = 'executing' AND runs.version = acceptances.run_version
           AND runs.active_plan_id = acceptances.plan_id
           AND runs.active_plan_version = acceptances.plan_version
           AND runs.active_plan_digest = acceptances.plan_digest
           AND plans.status = 'active' AND progress.status = 'in_progress'
           AND progress.active_attempt_id = acceptances.attempt_id
         ON CONFLICT DO NOTHING`,
      ).bind(
        attestationId,
        oidcTokenDigest,
        workflowRef,
        claims.runId,
        subject,
        TEST_ACCEPTANCE_OIDC_AUDIENCE,
        nowIso,
        acceptanceId,
        claims.runId,
        claims.repository,
        claims.sha,
        acceptance.workflow_path,
        TEST_ACCEPTANCE_OIDC_AUDIENCE,
        nowIso,
      ),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'running', version = version + 1,
             heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND mode = 'deploy' AND status = 'starting'
           AND version = 1 AND lease_generation = 1 AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM test_acceptance_oidc_attestations
             WHERE acceptance_id = ? AND github_run_id = ?
           )`,
      ).bind(
        nowIso,
        nowIso,
        acceptance.attempt_id,
        nowIso,
        acceptanceId,
        claims.runId,
      ),
      this.db.prepare(
        `UPDATE test_acceptances SET status = 'running', updated_at = ?
         WHERE acceptance_id = ? AND status IN ('dispatched', 'running')
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = test_acceptances.attempt_id AND status = 'running'
           )`,
      ).bind(nowIso, acceptanceId),
    ]);
    const persisted = await this.attestation(acceptanceId);
    const refreshed = await this.acceptance(acceptanceId);
    if (persisted === null || refreshed === null) {
      throw new TestAcceptanceRunnerError('state_conflict');
    }
    this.assertAttestation(persisted, refreshed, claims, workflowRef, subject);
    if (
      persisted.oidc_token_digest !== oidcTokenDigest || refreshed.status !== 'running' ||
      refreshed.attempt_status !== 'running'
    ) throw new TestAcceptanceRunnerError('state_conflict');
    return this.contextResult(persisted.attestation_id, refreshed, 'created');
  }

  async report(
    acceptanceId: string,
    oidcToken: string,
    claims: GitHubOidcClaims,
    input: { exitCode: number; durationMs: number },
    now = new Date(),
  ): Promise<TestAcceptanceReportResult> {
    if (
      !Number.isSafeInteger(input.exitCode) || input.exitCode < 0 || input.exitCode > 255 ||
      !Number.isSafeInteger(input.durationMs) || input.durationMs < 0 ||
      input.durationMs > 3_600_000
    ) throw new TestAcceptanceRunnerError('result_conflict');
    const acceptance = await this.acceptance(acceptanceId);
    if (acceptance === null) throw new TestAcceptanceRunnerError('not_found');
    const workflowRef =
      `${acceptance.repository}/${acceptance.workflow_path}@refs/heads/${acceptance.base_branch}`;
    const subject = `repo:${acceptance.repository}:environment:test`;
    this.assertBinding(acceptance, claims, workflowRef, subject, now);
    const oidcTokenDigest = await canonicalSha256(oidcToken);
    const attestation = await this.attestation(acceptanceId);
    if (attestation === null || attestation.oidc_token_digest !== oidcTokenDigest) {
      throw new TestAcceptanceRunnerError('binding_mismatch');
    }
    this.assertAttestation(attestation, acceptance, claims, workflowRef, subject);
    const status = input.exitCode === 0 ? 'passed' as const : 'failed' as const;
    const resultDigest = await canonicalSha256({
      schemaVersion: '1',
      acceptanceId,
      attemptId: acceptance.attempt_id,
      githubRunId: claims.runId,
      refSha: acceptance.ref_sha,
      commandRef: acceptance.command_ref,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      status,
    });
    if (acceptance.runner_result_digest !== null) {
      if (
        acceptance.runner_result_digest !== resultDigest ||
        acceptance.runner_status !== status ||
        acceptance.runner_exit_code !== input.exitCode ||
        acceptance.runner_duration_ms !== input.durationMs
      ) throw new TestAcceptanceRunnerError('result_conflict');
      return { accepted: true, acceptanceId, status, disposition: 'duplicate' };
    }
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_acceptances
         SET runner_result_digest = ?, runner_status = ?, runner_exit_code = ?,
             runner_duration_ms = ?, updated_at = ?
         WHERE acceptance_id = ? AND status = 'running'
           AND runner_result_digest IS NULL
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = test_acceptances.attempt_id
               AND status = 'running' AND lease_expires_at > ?
           )`,
      ).bind(
        resultDigest,
        status,
        input.exitCode,
        input.durationMs,
        nowIso,
        acceptanceId,
        nowIso,
      ),
      this.db.prepare(
        `UPDATE attempts SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'running' AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM test_acceptances
             WHERE acceptance_id = ? AND runner_result_digest = ?
           )`,
      ).bind(
        leaseExpiresAt,
        nowIso,
        nowIso,
        acceptance.attempt_id,
        nowIso,
        acceptanceId,
        resultDigest,
      ),
    ]);
    const persisted = await this.acceptance(acceptanceId);
    if (
      persisted?.runner_result_digest !== resultDigest ||
      persisted.runner_status !== status
    ) throw new TestAcceptanceRunnerError('state_conflict');
    return { accepted: true, acceptanceId, status, disposition: 'created' };
  }

  private assertBinding(
    acceptance: AcceptanceRow,
    claims: GitHubOidcClaims,
    workflowRef: string,
    subject: string,
    now: Date,
  ): void {
    if (
      acceptance.environment !== 'test' ||
      acceptance.oidc_audience !== TEST_ACCEPTANCE_OIDC_AUDIENCE ||
      acceptance.github_run_id === null ||
      !['dispatched', 'running'].includes(acceptance.status) ||
      !['starting', 'running'].includes(acceptance.attempt_status) ||
      (acceptance.lease_expires_at ?? '') <= now.toISOString() ||
      claims.repository !== acceptance.repository || claims.workflowRef !== workflowRef ||
      claims.sha !== acceptance.ref_sha || claims.runId !== acceptance.github_run_id ||
      claims.subject !== subject || claims.environment !== 'test'
    ) throw new TestAcceptanceRunnerError('binding_mismatch');
  }

  private assertAttestation(
    row: AttestationRow,
    acceptance: AcceptanceRow,
    claims: GitHubOidcClaims,
    workflowRef: string,
    subject: string,
  ): void {
    if (
      row.repository !== acceptance.repository || row.repository !== claims.repository ||
      row.workflow_ref !== workflowRef || row.sha !== acceptance.ref_sha ||
      row.github_run_id !== claims.runId || row.subject !== subject ||
      row.environment !== 'test' || row.audience !== TEST_ACCEPTANCE_OIDC_AUDIENCE
    ) throw new TestAcceptanceRunnerError('state_conflict');
  }

  private contextResult(
    attestationId: string,
    row: AcceptanceRow,
    disposition: 'created' | 'duplicate',
  ): TestAcceptanceContextResult {
    return {
      accepted: true,
      attestationId,
      disposition,
      acceptanceId: row.acceptance_id,
      commandRef: row.command_ref,
      refSha: row.ref_sha,
      environmentUrl: row.environment_url,
    };
  }

  private async acceptance(acceptanceId: string): Promise<AcceptanceRow | null> {
    return await this.db.prepare(
      `SELECT acceptances.acceptance_id, acceptances.repository,
              acceptances.base_branch, acceptances.ref_sha,
              acceptances.workflow_path, acceptances.environment,
              acceptances.oidc_audience, acceptances.command_ref,
              acceptances.environment_url, acceptances.status,
              acceptances.github_run_id, acceptances.runner_result_digest,
              acceptances.runner_status, acceptances.runner_exit_code,
              acceptances.runner_duration_ms, acceptances.attempt_id,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation, attempts.lease_expires_at
       FROM test_acceptances AS acceptances
       JOIN attempts ON attempts.attempt_id = acceptances.attempt_id
       WHERE acceptances.acceptance_id = ?`,
    ).bind(acceptanceId).first<AcceptanceRow>();
  }

  private async attestation(acceptanceId: string): Promise<AttestationRow | null> {
    return await this.db.prepare(
      `SELECT attestation_id, oidc_token_digest, repository, workflow_ref, sha,
              github_run_id, subject, environment, audience
       FROM test_acceptance_oidc_attestations WHERE acceptance_id = ?`,
    ).bind(acceptanceId).first<AttestationRow>();
  }
}
