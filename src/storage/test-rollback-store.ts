import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  TestRollbackTargetSchema,
  type TestRollbackSourceKind,
  type TestRollbackTarget,
} from '../domain/test-rollback.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const ScheduleTestRollbackInputSchema = z.object({
  sourceKind: z.enum(['deployment_failure', 'acceptance_failure']),
  sourceId: z.string().regex(ID_PATTERN),
  sourceEvidenceId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
}).strict();

export type ScheduleTestRollbackInput = z.infer<typeof ScheduleTestRollbackInputSchema>;

export type TestRollbackNoContractDisposition =
  | 'not_declared'
  | 'policy_missing'
  | 'policy_invalid';

export type TestRollbackStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'policy_denied';

export class TestRollbackStoreError extends Error {
  constructor(readonly code: TestRollbackStoreErrorCode) {
    super(`test rollback scheduling failed: ${code}`);
    this.name = 'TestRollbackStoreError';
  }
}

export interface TestRollbackCandidate {
  sourceKind: TestRollbackSourceKind;
  sourceId: string;
  sourceEvidenceId: string;
  runId: string;
  runVersion: number;
  repository: string;
  refSha: string;
}

export interface TestRollbackScheduleResult {
  rollbackId: string;
  sourceKind: TestRollbackSourceKind;
  sourceId: string;
  sourceEvidenceId: string;
  deploymentId: string;
  attemptId: string;
  outboxId: string;
  runId: string;
  refSha: string;
  roleRef: string;
  created: boolean;
}

interface CandidateRow {
  source_kind: TestRollbackSourceKind;
  source_id: string;
  source_evidence_id: string;
  source_status: string;
  source_external_state: string | null;
  source_evidence_kind: string;
  source_evidence_status: string;
  source_evidence_verification: string;
  source_evidence_sha: string | null;
  failed_attempt_id: string;
  failed_attempt_status: string;
  deployment_id: string;
  deployment_status: string;
  deployment_evidence_status: string | null;
  deployment_evidence_verification: string | null;
  approval_id: string;
  run_id: string;
  run_state: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  plan_item_id: string;
  progress_status: string;
  progress_version: number;
  progress_active_attempt_id: string | null;
  repository: string;
  base_branch: string;
  base_sha: string;
  ref_sha: string;
  target_environment: string;
  allow_test_deploy: number;
}

interface ExistingRow {
  rollback_id: string;
  source_kind: TestRollbackSourceKind;
  source_id: string;
  source_evidence_id: string;
  deployment_id: string;
  attempt_id: string;
  run_id: string;
  ref_sha: string;
  role_ref: string;
  policy_digest: string;
  contract_digest: string;
  workflow_path: string;
  oidc_audience: string;
  outbox_id: string | null;
}

interface ContractObservationRow {
  observation_id: string;
  source_evidence_id: string;
  repository: string;
  ref_sha: string;
  disposition: string;
  policy_digest: string | null;
  contract_digest: string | null;
  workflow_path: string | null;
  oidc_audience: string | null;
  role_ref: string | null;
}

/** Owns immutable failure lineage, repository-contract observation, and rollback intent. */
export class TestRollbackStore {
  constructor(private readonly db: D1Database) {}

  async candidates(limit = 25): Promise<TestRollbackCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('test rollback candidate limit must be between 1 and 100');
    }
    const rows = await this.db.prepare(
      `SELECT 'deployment_failure' AS source_kind,
              deployments.deployment_id AS source_id,
              deployments.evidence_id AS source_evidence_id,
              deployments.run_id, runs.version AS run_version,
              deployments.repository, deployments.ref_sha,
              deployments.updated_at AS source_updated_at
       FROM test_deployments AS deployments
       JOIN evidence ON evidence.evidence_id = deployments.evidence_id
       JOIN attempts ON attempts.attempt_id = deployments.attempt_id
       JOIN runs ON runs.run_id = deployments.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       WHERE deployments.status = 'failed'
         AND deployments.external_state IN ('failure', 'error')
         AND evidence.kind = 'deployment' AND evidence.status = 'failed'
         AND evidence.verification_status = 'verified'
         AND attempts.status = 'failed'
         AND runs.state IN ('executing', 'blocked')
         AND tasks.target_environment = 'test' AND tasks.allow_test_deploy = 1
         AND NOT EXISTS (
           SELECT 1 FROM test_rollbacks
           WHERE source_kind = 'deployment_failure'
             AND source_id = deployments.deployment_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM test_rollback_contract_observations
           WHERE source_kind = 'deployment_failure'
             AND source_id = deployments.deployment_id
             AND disposition <> 'declared'
         )
       UNION ALL
       SELECT 'acceptance_failure' AS source_kind,
              acceptances.acceptance_id AS source_id,
              acceptances.evidence_id AS source_evidence_id,
              acceptances.run_id, runs.version AS run_version,
              acceptances.repository, acceptances.ref_sha,
              acceptances.updated_at AS source_updated_at
       FROM test_acceptances AS acceptances
       JOIN evidence ON evidence.evidence_id = acceptances.evidence_id
       JOIN attempts ON attempts.attempt_id = acceptances.attempt_id
       JOIN test_deployments AS deployments
         ON deployments.deployment_id = acceptances.deployment_id
       JOIN evidence AS deployment_evidence
         ON deployment_evidence.evidence_id = deployments.evidence_id
       JOIN runs ON runs.run_id = acceptances.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       WHERE acceptances.status = 'failed' AND acceptances.external_state = 'completed'
         AND evidence.kind = 'test' AND evidence.status = 'failed'
         AND evidence.verification_status = 'verified'
         AND attempts.status = 'failed'
         AND deployments.status = 'succeeded'
         AND deployment_evidence.kind = 'deployment'
         AND deployment_evidence.status = 'passed'
         AND deployment_evidence.verification_status = 'verified'
         AND runs.state IN ('executing', 'blocked')
         AND tasks.target_environment = 'test' AND tasks.allow_test_deploy = 1
         AND NOT EXISTS (
           SELECT 1 FROM test_rollbacks
           WHERE source_kind = 'acceptance_failure'
             AND source_id = acceptances.acceptance_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM test_rollback_contract_observations
           WHERE source_kind = 'acceptance_failure'
             AND source_id = acceptances.acceptance_id
             AND disposition <> 'declared'
         )
       ORDER BY source_updated_at, source_id LIMIT ?`,
    ).bind(limit).all<{
      source_kind: TestRollbackSourceKind;
      source_id: string;
      source_evidence_id: string;
      run_id: string;
      run_version: number;
      repository: string;
      ref_sha: string;
    }>();
    return rows.results.map((row) => ({
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      sourceEvidenceId: row.source_evidence_id,
      runId: row.run_id,
      runVersion: row.run_version,
      repository: row.repository,
      refSha: row.ref_sha,
    }));
  }

  async recordNoContract(
    rawInput: unknown,
    disposition: TestRollbackNoContractDisposition,
    policyDigest: string | null,
    now = new Date(),
  ): Promise<'created' | 'duplicate'> {
    const input = this.input(rawInput);
    if (policyDigest !== null && !DIGEST_PATTERN.test(policyDigest)) {
      throw new TestRollbackStoreError('invalid_request');
    }
    const candidate = await this.candidate(input.sourceKind, input.sourceId);
    if (candidate === null) throw new TestRollbackStoreError('not_found');
    this.assertCandidate(candidate, input);
    const observationId = await this.observationId(candidate);
    const existing = await this.contractObservation(input.sourceKind, input.sourceId);
    if (existing !== null) {
      if (
        existing.observation_id !== observationId ||
        existing.source_evidence_id !== candidate.source_evidence_id ||
        existing.repository !== candidate.repository || existing.ref_sha !== candidate.ref_sha ||
        existing.disposition !== disposition || existing.policy_digest !== policyDigest
      ) throw new TestRollbackStoreError('state_conflict');
      return 'duplicate';
    }
    await this.db.prepare(
      `INSERT INTO test_rollback_contract_observations (
         observation_id, source_kind, source_id, source_evidence_id,
         repository, ref_sha, disposition, policy_digest, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      observationId,
      candidate.source_kind,
      candidate.source_id,
      candidate.source_evidence_id,
      candidate.repository,
      candidate.ref_sha,
      disposition,
      policyDigest,
      now.toISOString(),
    ).run();
    const persisted = await this.contractObservation(input.sourceKind, input.sourceId);
    if (persisted?.observation_id !== observationId || persisted.disposition !== disposition) {
      throw new TestRollbackStoreError('state_conflict');
    }
    return 'created';
  }

  async schedule(
    rawInput: unknown,
    rawTarget: unknown,
    now = new Date(),
  ): Promise<TestRollbackScheduleResult> {
    const input = this.input(rawInput);
    const targetResult = TestRollbackTargetSchema.safeParse(rawTarget);
    if (!targetResult.success) throw new TestRollbackStoreError('invalid_request');
    const target = targetResult.data;
    const candidate = await this.candidate(input.sourceKind, input.sourceId);
    if (candidate === null) throw new TestRollbackStoreError('not_found');
    this.assertCandidate(candidate, input);
    if (
      target.sourceKind !== candidate.source_kind ||
      target.repository !== candidate.repository
    ) throw new TestRollbackStoreError('policy_denied');

    const identity = await canonicalSha256({
      sourceKind: candidate.source_kind,
      sourceId: candidate.source_id,
      sourceEvidenceId: candidate.source_evidence_id,
      failedAttemptId: candidate.failed_attempt_id,
      deploymentId: candidate.deployment_id,
      runId: candidate.run_id,
      runVersion: candidate.run_version,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planDigest: candidate.plan_digest,
      planItemId: candidate.plan_item_id,
      refSha: candidate.ref_sha,
      target,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 40);
    const rollbackId = `rollback_test_${suffix}`;
    const attemptId = `attempt_test_rollback_${suffix}`;
    const outboxId = `outbox_test_rollback_${suffix}`;
    const observationId = await this.observationId(candidate);
    const existing = await this.existing(rollbackId);
    if (existing !== null) return this.result(existing, outboxId, target, false);

    const nowIso = now.toISOString();
    const workflowRef =
      `${candidate.repository}/${target.workflowPath}@refs/heads/${candidate.base_branch}`;
    const sourceGuard = candidate.source_kind === 'deployment_failure'
      ? `EXISTS (
           SELECT 1 FROM test_deployments AS source
           JOIN evidence ON evidence.evidence_id = source.evidence_id
           JOIN attempts AS failed ON failed.attempt_id = source.attempt_id
           WHERE source.deployment_id = '${candidate.source_id}'
             AND source.evidence_id = '${candidate.source_evidence_id}'
             AND source.status = 'failed' AND source.external_state IN ('failure', 'error')
             AND evidence.kind = 'deployment' AND evidence.status = 'failed'
             AND evidence.verification_status = 'verified' AND failed.status = 'failed'
         )`
      : `EXISTS (
           SELECT 1 FROM test_acceptances AS source
           JOIN evidence ON evidence.evidence_id = source.evidence_id
           JOIN attempts AS failed ON failed.attempt_id = source.attempt_id
           JOIN test_deployments AS deployment ON deployment.deployment_id = source.deployment_id
           JOIN evidence AS deployment_evidence ON deployment_evidence.evidence_id = deployment.evidence_id
           WHERE source.acceptance_id = '${candidate.source_id}'
             AND source.evidence_id = '${candidate.source_evidence_id}'
             AND source.status = 'failed' AND source.external_state = 'completed'
             AND evidence.kind = 'test' AND evidence.status = 'failed'
             AND evidence.verification_status = 'verified' AND failed.status = 'failed'
             AND deployment.status = 'succeeded'
             AND deployment_evidence.kind = 'deployment'
             AND deployment_evidence.status = 'passed'
             AND deployment_evidence.verification_status = 'verified'
         )`;
    // source_id/evidence_id passed the strict ID pattern before interpolation.
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO test_rollback_contract_observations (
           observation_id, source_kind, source_id, source_evidence_id,
           repository, ref_sha, disposition, policy_digest, contract_digest,
           workflow_path, environment, oidc_audience, role_ref, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'declared', ?, ?, ?, 'test', ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        observationId,
        candidate.source_kind,
        candidate.source_id,
        candidate.source_evidence_id,
        candidate.repository,
        candidate.ref_sha,
        target.policyDigest,
        target.contractDigest,
        target.workflowPath,
        target.oidcAudience,
        target.roleRef,
        nowIso,
      ),
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
           repository, workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, version, lease_generation, created_at, updated_at
         )
         SELECT ?, runs.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = runs.run_id),
                'deploy', 'pending', runs.base_sha, ?, tasks.target_repository, ?,
                plans.plan_id, plans.plan_version, ?, ?, 0, 0, ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         WHERE runs.run_id = ? AND runs.version = ?
           AND runs.state IN ('executing', 'blocked')
           AND tasks.target_environment = 'test' AND tasks.allow_test_deploy = 1
           AND tasks.target_repository = ?
           AND plans.plan_id = ? AND plans.plan_version = ? AND plans.digest = ?
           AND plans.status IN ('active', 'blocked') AND ${sourceGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        attemptId,
        candidate.ref_sha,
        workflowRef,
        candidate.plan_item_id,
        candidate.progress_version,
        nowIso,
        nowIso,
        candidate.run_id,
        candidate.run_version,
        candidate.repository,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
      ),
      this.db.prepare(
        `INSERT INTO test_rollbacks (
           rollback_id, source_kind, source_id, source_evidence_id,
           failed_attempt_id, deployment_id, approval_id, contract_observation_id,
           run_id, run_version, plan_id, plan_version, plan_digest, plan_item_id,
           attempt_id, repository, base_branch, base_sha, ref_sha, policy_digest,
           contract_digest, workflow_path, environment, oidc_audience, role_ref,
           status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, observations.observation_id,
                runs.run_id, runs.version, ?, ?, ?, ?, attempts.attempt_id,
                ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?, 'scheduled', ?, ?
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN test_rollback_contract_observations AS observations
           ON observations.source_kind = ? AND observations.source_id = ?
         WHERE attempts.attempt_id = ? AND attempts.status = 'pending'
           AND attempts.mode = 'deploy' AND runs.run_id = ? AND runs.version = ?
           AND observations.disposition = 'declared'
           AND observations.source_evidence_id = ?
           AND observations.policy_digest = ? AND observations.contract_digest = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        rollbackId,
        candidate.source_kind,
        candidate.source_id,
        candidate.source_evidence_id,
        candidate.failed_attempt_id,
        candidate.deployment_id,
        candidate.approval_id,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.plan_item_id,
        candidate.repository,
        candidate.base_branch,
        candidate.base_sha,
        candidate.ref_sha,
        target.policyDigest,
        target.contractDigest,
        target.workflowPath,
        target.oidcAudience,
        target.roleRef,
        nowIso,
        nowIso,
        candidate.source_kind,
        candidate.source_id,
        attemptId,
        candidate.run_id,
        candidate.run_version,
        candidate.source_evidence_id,
        target.policyDigest,
        target.contractDigest,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, run_id, 'test_rollback_dispatch', 'github_test_rollback', ?, ?,
                'pending', ?, ?
         FROM test_rollbacks WHERE rollback_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://test-rollbacks/${rollbackId}`,
        `test-rollback:${rollbackId}`,
        nowIso,
        nowIso,
        rollbackId,
      ),
    ]);
    const observation = await this.contractObservation(input.sourceKind, input.sourceId);
    if (
      observation?.observation_id !== observationId ||
      observation.disposition !== 'declared' ||
      observation.contract_digest !== target.contractDigest
    ) throw new TestRollbackStoreError('state_conflict');
    const persisted = await this.existing(rollbackId);
    if (persisted === null || persisted.outbox_id === null) {
      throw new TestRollbackStoreError('state_conflict');
    }
    return this.result(
      persisted,
      outboxId,
      target,
      results[2]?.meta.changes === 1 && results[3]?.meta.changes === 1,
    );
  }

  private input(rawInput: unknown): ScheduleTestRollbackInput {
    const parsed = ScheduleTestRollbackInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new TestRollbackStoreError('invalid_request');
    return parsed.data;
  }

  private assertCandidate(row: CandidateRow, input: ScheduleTestRollbackInput): void {
    const sourceFactValid = row.source_kind === 'deployment_failure'
      ? row.source_status === 'failed' &&
        ['failure', 'error'].includes(row.source_external_state ?? '') &&
        row.source_evidence_kind === 'deployment'
      : row.source_status === 'failed' && row.source_external_state === 'completed' &&
        row.source_evidence_kind === 'test' && row.deployment_status === 'succeeded' &&
        row.deployment_evidence_status === 'passed' &&
        row.deployment_evidence_verification === 'verified';
    if (
      row.source_kind !== input.sourceKind || row.source_id !== input.sourceId ||
      row.source_evidence_id !== input.sourceEvidenceId ||
      row.run_version !== input.expectedRunVersion || !sourceFactValid ||
      row.source_evidence_status !== 'failed' ||
      row.source_evidence_verification !== 'verified' ||
      row.source_evidence_sha !== row.ref_sha || row.failed_attempt_status !== 'failed' ||
      !['executing', 'blocked'].includes(row.run_state) ||
      !['active', 'blocked'].includes(row.plan_status) ||
      row.progress_status !== 'failed' || row.progress_active_attempt_id !== null ||
      row.target_environment !== 'test' || row.allow_test_deploy !== 1
    ) throw new TestRollbackStoreError('policy_denied');
  }

  private async candidate(
    sourceKind: TestRollbackSourceKind,
    sourceId: string,
  ): Promise<CandidateRow | null> {
    if (sourceKind === 'deployment_failure') {
      return await this.db.prepare(
        `SELECT 'deployment_failure' AS source_kind,
                deployments.deployment_id AS source_id,
                deployments.evidence_id AS source_evidence_id,
                deployments.status AS source_status,
                deployments.external_state AS source_external_state,
                evidence.kind AS source_evidence_kind,
                evidence.status AS source_evidence_status,
                evidence.verification_status AS source_evidence_verification,
                evidence.sha AS source_evidence_sha,
                deployments.attempt_id AS failed_attempt_id,
                failed.status AS failed_attempt_status,
                deployments.deployment_id, deployments.status AS deployment_status,
                evidence.status AS deployment_evidence_status,
                evidence.verification_status AS deployment_evidence_verification,
                deployments.approval_id, runs.run_id, runs.state AS run_state,
                runs.version AS run_version, plans.plan_id, plans.plan_version,
                plans.digest AS plan_digest, plans.status AS plan_status,
                deployments.plan_item_id, progress.status AS progress_status,
                progress.version AS progress_version,
                progress.active_attempt_id AS progress_active_attempt_id,
                deployments.repository, deployments.base_branch, deployments.base_sha,
                deployments.ref_sha, tasks.target_environment, tasks.allow_test_deploy
         FROM test_deployments AS deployments
         JOIN evidence ON evidence.evidence_id = deployments.evidence_id
         JOIN attempts AS failed ON failed.attempt_id = deployments.attempt_id
         JOIN runs ON runs.run_id = deployments.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = deployments.plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = deployments.plan_id
          AND progress.item_id = deployments.plan_item_id
         WHERE deployments.deployment_id = ?`,
      ).bind(sourceId).first<CandidateRow>();
    }
    return await this.db.prepare(
      `SELECT 'acceptance_failure' AS source_kind,
              acceptances.acceptance_id AS source_id,
              acceptances.evidence_id AS source_evidence_id,
              acceptances.status AS source_status,
              acceptances.external_state AS source_external_state,
              evidence.kind AS source_evidence_kind,
              evidence.status AS source_evidence_status,
              evidence.verification_status AS source_evidence_verification,
              evidence.sha AS source_evidence_sha,
              acceptances.attempt_id AS failed_attempt_id,
              failed.status AS failed_attempt_status,
              deployments.deployment_id, deployments.status AS deployment_status,
              deployment_evidence.status AS deployment_evidence_status,
              deployment_evidence.verification_status AS deployment_evidence_verification,
              deployments.approval_id, runs.run_id, runs.state AS run_state,
              runs.version AS run_version, plans.plan_id, plans.plan_version,
              plans.digest AS plan_digest, plans.status AS plan_status,
              acceptances.plan_item_id, progress.status AS progress_status,
              progress.version AS progress_version,
              progress.active_attempt_id AS progress_active_attempt_id,
              acceptances.repository, acceptances.base_branch, acceptances.base_sha,
              acceptances.ref_sha, tasks.target_environment, tasks.allow_test_deploy
       FROM test_acceptances AS acceptances
       JOIN evidence ON evidence.evidence_id = acceptances.evidence_id
       JOIN attempts AS failed ON failed.attempt_id = acceptances.attempt_id
       JOIN test_deployments AS deployments
         ON deployments.deployment_id = acceptances.deployment_id
       JOIN evidence AS deployment_evidence
         ON deployment_evidence.evidence_id = deployments.evidence_id
       JOIN runs ON runs.run_id = acceptances.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = acceptances.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = acceptances.plan_id
        AND progress.item_id = acceptances.plan_item_id
       WHERE acceptances.acceptance_id = ?`,
    ).bind(sourceId).first<CandidateRow>();
  }

  private async observationId(row: CandidateRow): Promise<string> {
    const digest = await canonicalSha256({
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      sourceEvidenceId: row.source_evidence_id,
      repository: row.repository,
      refSha: row.ref_sha,
    });
    return `rollback_contract_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async contractObservation(
    sourceKind: TestRollbackSourceKind,
    sourceId: string,
  ): Promise<ContractObservationRow | null> {
    return await this.db.prepare(
      `SELECT observation_id, source_evidence_id, repository, ref_sha,
              disposition, policy_digest, contract_digest, workflow_path,
              oidc_audience, role_ref
       FROM test_rollback_contract_observations
       WHERE source_kind = ? AND source_id = ?`,
    ).bind(sourceKind, sourceId).first<ContractObservationRow>();
  }

  private async existing(rollbackId: string): Promise<ExistingRow | null> {
    return await this.db.prepare(
      `SELECT rollbacks.rollback_id, rollbacks.source_kind, rollbacks.source_id,
              rollbacks.source_evidence_id, rollbacks.deployment_id,
              rollbacks.attempt_id, rollbacks.run_id, rollbacks.ref_sha,
              rollbacks.role_ref, rollbacks.policy_digest,
              rollbacks.contract_digest, rollbacks.workflow_path,
              rollbacks.oidc_audience, outbox.outbox_id
       FROM test_rollbacks AS rollbacks
       LEFT JOIN outbox
         ON outbox.payload_ref = 'd1://test-rollbacks/' || rollbacks.rollback_id
        AND outbox.kind = 'test_rollback_dispatch'
        AND outbox.destination = 'github_test_rollback'
       WHERE rollbacks.rollback_id = ?`,
    ).bind(rollbackId).first<ExistingRow>();
  }

  private result(
    row: ExistingRow,
    expectedOutboxId: string,
    target: TestRollbackTarget,
    created: boolean,
  ): TestRollbackScheduleResult {
    if (
      row.outbox_id !== expectedOutboxId || row.source_kind !== target.sourceKind ||
      row.role_ref !== target.roleRef || row.policy_digest !== target.policyDigest ||
      row.contract_digest !== target.contractDigest ||
      row.workflow_path !== target.workflowPath || row.oidc_audience !== target.oidcAudience
    ) throw new TestRollbackStoreError('state_conflict');
    return {
      rollbackId: row.rollback_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      sourceEvidenceId: row.source_evidence_id,
      deploymentId: row.deployment_id,
      attemptId: row.attempt_id,
      outboxId: row.outbox_id,
      runId: row.run_id,
      refSha: row.ref_sha,
      roleRef: row.role_ref,
      created,
    };
  }
}

