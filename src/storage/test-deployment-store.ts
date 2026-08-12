import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import type { TestDeploymentTarget } from '../domain/test-deployment.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export const ScheduleTestDeploymentInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  planItemId: z.string().regex(ID_PATTERN),
  expectedProgressVersion: z.number().int().positive(),
}).strict();

export type ScheduleTestDeploymentInput = z.infer<typeof ScheduleTestDeploymentInputSchema>;

export type TestDeploymentStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'approval_required'
  | 'policy_denied';

export class TestDeploymentStoreError extends Error {
  constructor(readonly code: TestDeploymentStoreErrorCode) {
    super(`test deployment scheduling failed: ${code}`);
    this.name = 'TestDeploymentStoreError';
  }
}

export interface TestDeploymentScheduleResult {
  deploymentId: string;
  outboxId: string;
  attemptId: string;
  runId: string;
  planId: string;
  planVersion: number;
  planItemId: string;
  approvalId: string;
  refSha: string;
  environment: 'test';
  created: boolean;
}

interface CandidateRow {
  run_id: string;
  run_state: string;
  run_version: number;
  task_revision: string;
  target_repository: string;
  target_base_branch: string;
  target_environment: string;
  allow_test_deploy: number;
  base_sha: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  item_id: string;
  item_kind: string;
  item_required: number;
  progress_status: string;
  progress_version: number;
  active_attempt_id: string | null;
  dependency_incomplete_count: number;
  forbidden_effect_count: number;
  has_test_deploy_effect: number;
  command_ref_count: number;
  has_deployment_evidence_kind: number;
  has_deployment_external_fact: number;
  done_when_count: number;
  ref_sha: string | null;
  ref_branch: string | null;
  ref_verified: number;
}

interface ApprovalRow {
  approval_id: string;
  decision: string;
  expires_at: string;
  invalidated: number;
  trusted: number;
}

interface ExistingRow {
  deployment_id: string;
  outbox_id: string | null;
  attempt_id: string;
  run_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  approval_id: string;
  ref_sha: string;
  repository: string;
  workflow_path: string;
  environment: string;
  oidc_audience: string;
  role_ref: string;
  provider: 'github_actions' | 'yunxiao_pipeline';
  provider_pipeline_id: string | null;
  provider_repository_url: string | null;
  provider_source_ref: string | null;
}

/** Atomically claims one deployment-only Plan Item and records its durable effect intent. */
export class TestDeploymentStore {
  constructor(private readonly db: D1Database) {}

  async schedule(
    rawInput: unknown,
    target: TestDeploymentTarget,
    now = new Date(),
  ): Promise<TestDeploymentScheduleResult> {
    const parsed = ScheduleTestDeploymentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new TestDeploymentStoreError('invalid_request');
    const input = parsed.data;
    const candidate = await this.candidate(input);
    if (candidate === null) throw new TestDeploymentStoreError('not_found');
    this.assertCandidate(candidate, input, target);
    const approval = await this.approval(candidate);
    if (
      approval === null || approval.decision !== 'approve' || approval.invalidated === 1 ||
      approval.trusted !== 1 || approval.expires_at <= now.toISOString()
    ) throw new TestDeploymentStoreError('approval_required');
    if (candidate.ref_sha === null) throw new TestDeploymentStoreError('state_conflict');

    const identity = await canonicalSha256({
      runId: candidate.run_id,
      runVersion: candidate.run_version,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planDigest: candidate.plan_digest,
      planItemId: candidate.item_id,
      progressVersion: candidate.progress_version,
      approvalId: approval.approval_id,
      refSha: candidate.ref_sha,
      target,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 40);
    const deploymentId = `deployment_test_${suffix}`;
    const attemptId = `attempt_test_deploy_${suffix}`;
    const outboxId = `outbox_test_deploy_${suffix}`;
    const existing = await this.existing(deploymentId);
    if (existing !== null) {
      return this.existingResult(existing, outboxId, target, false);
    }

    const nowIso = now.toISOString();
    const workflowRef =
      `${target.repository}/${target.workflowPath}@refs/heads/${candidate.target_base_branch}`;
    const results = await this.db.batch([
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
                plans.plan_id, plans.plan_version, items.item_id, ?, 0, 0, ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN plan_items AS items ON items.plan_id = plans.plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
         WHERE runs.run_id = ? AND runs.version = ? AND runs.state = 'executing'
           AND tasks.allow_test_deploy = 1 AND tasks.target_environment = 'test'
           AND tasks.target_repository = ? AND plans.plan_version = ?
           AND plans.status = 'active' AND plans.digest = ? AND plans.base_sha = runs.base_sha
           AND items.item_id = ? AND items.kind = 'delivery' AND items.required = 1
           AND progress.status = 'ready' AND progress.version = ?
           AND progress.active_attempt_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM plan_item_dependencies
             LEFT JOIN plan_item_progress AS dependency_progress
               ON dependency_progress.plan_id = plan_item_dependencies.plan_id
              AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
             WHERE plan_item_dependencies.plan_id = items.plan_id
               AND plan_item_dependencies.item_id = items.item_id
               AND (dependency_progress.status IS NULL OR dependency_progress.status <> 'passed')
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        attemptId,
        candidate.ref_sha,
        workflowRef,
        candidate.progress_version,
        nowIso,
        nowIso,
        candidate.run_id,
        candidate.run_version,
        target.repository,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.item_id,
        candidate.progress_version,
      ),
      this.db.prepare(
        `UPDATE plan_item_progress
         SET status = 'in_progress', active_attempt_id = ?,
             version = version + 1, updated_at = ?
         WHERE plan_id = ? AND item_id = ? AND status = 'ready' AND version = ?
           AND active_attempt_id IS NULL
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND run_id = ? AND mode = 'deploy'
               AND status = 'pending' AND plan_id = plan_item_progress.plan_id
               AND plan_version = ? AND plan_item_id = plan_item_progress.item_id
           )`,
      ).bind(
        attemptId,
        nowIso,
        candidate.plan_id,
        candidate.item_id,
        candidate.progress_version,
        attemptId,
        candidate.run_id,
        candidate.plan_version,
      ),
      this.db.prepare(
        `INSERT INTO test_deployments (
           deployment_id, run_id, run_version, plan_id, plan_version, plan_digest,
           plan_item_id, attempt_id, approval_id, repository, base_branch,
           base_sha, ref_sha, workflow_path, environment, oidc_audience,
           role_ref, provider, provider_pipeline_id, provider_repository_url,
           provider_source_ref, status, created_at, updated_at
         )
         SELECT ?, runs.run_id, runs.version, plans.plan_id, plans.plan_version,
                plans.digest, items.item_id, attempts.attempt_id, approvals.approval_id,
                tasks.target_repository, tasks.target_base_branch, runs.base_sha,
                attempts.head_sha, ?, 'test', ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = attempts.plan_id
         JOIN plan_items AS items
           ON items.plan_id = attempts.plan_id AND items.item_id = attempts.plan_item_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
         JOIN trusted_effect_approvals AS approvals ON approvals.approval_id = ?
         WHERE attempts.attempt_id = ? AND attempts.mode = 'deploy'
           AND attempts.status = 'pending' AND attempts.head_sha = ?
           AND runs.run_id = ? AND runs.version = ? AND runs.state = 'executing'
           AND runs.active_plan_id = plans.plan_id AND runs.active_plan_version = plans.plan_version
           AND runs.active_plan_digest = plans.digest AND plans.status = 'active'
           AND progress.status = 'in_progress' AND progress.active_attempt_id = attempts.attempt_id
           AND approvals.run_id = runs.run_id AND approvals.task_revision = runs.task_revision
           AND approvals.plan_id = plans.plan_id AND approvals.plan_version = plans.plan_version
           AND approvals.plan_digest = plans.digest AND approvals.base_sha = runs.base_sha
           AND approvals.effect = 'test_deploy' AND approvals.decision = 'approve'
           AND approvals.expires_at > ?
           AND NOT EXISTS (
             SELECT 1 FROM invalidated_approvals
             WHERE invalidated_approvals.approval_id = approvals.approval_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM approvals AS newer
             WHERE newer.run_id = approvals.run_id
               AND newer.task_revision = approvals.task_revision
               AND newer.plan_id = approvals.plan_id
               AND newer.plan_version = approvals.plan_version
               AND newer.plan_digest = approvals.plan_digest
               AND newer.base_sha = approvals.base_sha
               AND newer.effect = approvals.effect
               AND (newer.created_at > approvals.created_at OR
                    (newer.created_at = approvals.created_at
                     AND newer.approval_id > approvals.approval_id))
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        deploymentId,
        target.workflowPath,
        target.oidcAudience,
        target.roleRef,
        target.provider,
        target.pipelineId ?? null,
        target.repositoryUrl ?? null,
        candidate.ref_branch,
        nowIso,
        nowIso,
        approval.approval_id,
        attemptId,
        candidate.ref_sha,
        candidate.run_id,
        candidate.run_version,
        nowIso,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, run_id, 'test_deploy',
                CASE WHEN provider = 'yunxiao_pipeline' THEN 'yunxiao_pipelines'
                     ELSE 'github_deployments' END, ?, ?,
                'pending', ?, ?
         FROM test_deployments WHERE deployment_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://test-deployments/${deploymentId}`,
        `test-deploy:${deploymentId}`,
        nowIso,
        nowIso,
        deploymentId,
      ),
    ]);
    const persisted = await this.existing(deploymentId);
    if (persisted === null || persisted.outbox_id === null) {
      throw new TestDeploymentStoreError('state_conflict');
    }
    return this.existingResult(
      persisted,
      outboxId,
      target,
      results[2]?.meta.changes === 1 && results[3]?.meta.changes === 1,
    );
  }

  private assertCandidate(
    candidate: CandidateRow,
    input: ScheduleTestDeploymentInput,
    target: TestDeploymentTarget,
  ): void {
    if (
      candidate.run_state !== 'executing' || candidate.run_version !== input.expectedRunVersion ||
      candidate.plan_version !== input.planVersion || candidate.plan_status !== 'active' ||
      candidate.item_id !== input.planItemId || candidate.item_kind !== 'delivery' ||
      candidate.item_required !== 1 || candidate.progress_status !== 'ready' ||
      candidate.progress_version !== input.expectedProgressVersion ||
      candidate.active_attempt_id !== null || candidate.target_repository !== target.repository ||
      candidate.target_environment !== 'test' || candidate.allow_test_deploy !== 1 ||
      candidate.dependency_incomplete_count !== 0 || candidate.forbidden_effect_count !== 0 ||
      candidate.has_test_deploy_effect !== 1 || candidate.command_ref_count !== 0 ||
      candidate.has_deployment_evidence_kind !== 1 ||
      candidate.has_deployment_external_fact !== 1 || candidate.done_when_count < 1 ||
      candidate.ref_sha === null || candidate.ref_verified !== 1 ||
      (target.provider === 'yunxiao_pipeline' && candidate.ref_branch === null)
    ) throw new TestDeploymentStoreError('policy_denied');
  }

  private async candidate(input: ScheduleTestDeploymentInput): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.task_revision, tasks.target_repository, tasks.target_base_branch,
              tasks.target_environment, tasks.allow_test_deploy, runs.base_sha,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              plans.status AS plan_status, items.item_id, items.kind AS item_kind,
              items.required AS item_required, progress.status AS progress_status,
              progress.version AS progress_version, progress.active_attempt_id,
              (SELECT COUNT(*) FROM plan_item_dependencies
               LEFT JOIN plan_item_progress AS dependency_progress
                 ON dependency_progress.plan_id = plan_item_dependencies.plan_id
                AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
               WHERE plan_item_dependencies.plan_id = items.plan_id
                 AND plan_item_dependencies.item_id = items.item_id
                 AND (dependency_progress.status IS NULL OR dependency_progress.status <> 'passed'))
                AS dependency_incomplete_count,
              (SELECT COUNT(*) FROM plan_item_effects
               WHERE plan_item_effects.plan_id = items.plan_id
                 AND plan_item_effects.item_id = items.item_id
                 AND plan_item_effects.effect IN ('repo_write', 'merge', 'production_deploy'))
                AS forbidden_effect_count,
              EXISTS (SELECT 1 FROM plan_item_effects
               WHERE plan_item_effects.plan_id = items.plan_id
                 AND plan_item_effects.item_id = items.item_id
                 AND plan_item_effects.effect = 'test_deploy') AS has_test_deploy_effect,
              (SELECT COUNT(*) FROM plan_item_command_refs
               WHERE plan_item_command_refs.plan_id = items.plan_id
                 AND plan_item_command_refs.item_id = items.item_id) AS command_ref_count,
              EXISTS (SELECT 1 FROM plan_item_evidence_kinds
               WHERE plan_item_evidence_kinds.plan_id = items.plan_id
                 AND plan_item_evidence_kinds.item_id = items.item_id
                 AND plan_item_evidence_kinds.evidence_kind = 'deployment')
                AS has_deployment_evidence_kind,
              EXISTS (SELECT 1 FROM plan_item_external_facts
               WHERE plan_item_external_facts.plan_id = items.plan_id
                 AND plan_item_external_facts.item_id = items.item_id
                 AND plan_item_external_facts.external_fact = 'deployment')
                AS has_deployment_external_fact,
              (SELECT COUNT(*) FROM plan_item_done_when
               WHERE plan_item_done_when.plan_id = items.plan_id
                 AND plan_item_done_when.item_id = items.item_id) AS done_when_count,
              (SELECT attempts.head_sha FROM attempts
               WHERE attempts.run_id = runs.run_id AND attempts.plan_id = plans.plan_id
                 AND attempts.plan_version = plans.plan_version
                 AND attempts.mode IN ('implement', 'review_fix')
                 AND attempts.status = 'completed' AND attempts.head_sha IS NOT NULL
               ORDER BY attempts.ordinal DESC LIMIT 1) AS ref_sha,
              (SELECT attempts.head_branch FROM attempts
               WHERE attempts.run_id = runs.run_id AND attempts.plan_id = plans.plan_id
                 AND attempts.plan_version = plans.plan_version
                 AND attempts.mode IN ('implement', 'review_fix')
                 AND attempts.status = 'completed' AND attempts.head_sha IS NOT NULL
               ORDER BY attempts.ordinal DESC LIMIT 1) AS ref_branch,
              EXISTS (
                SELECT 1 FROM plan_item_verifications
                WHERE plan_item_verifications.run_id = runs.run_id
                  AND plan_item_verifications.plan_id = plans.plan_id
                  AND plan_item_verifications.head_sha = (
                    SELECT attempts.head_sha FROM attempts
                    WHERE attempts.run_id = runs.run_id AND attempts.plan_id = plans.plan_id
                      AND attempts.plan_version = plans.plan_version
                      AND attempts.mode IN ('implement', 'review_fix')
                      AND attempts.status = 'completed' AND attempts.head_sha IS NOT NULL
                    ORDER BY attempts.ordinal DESC LIMIT 1
                  )
                  AND plan_item_verifications.status = 'passed'
              ) AS ref_verified
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       WHERE runs.run_id = ? AND plans.plan_version = ? AND items.item_id = ?`,
    ).bind(input.runId, input.planVersion, input.planItemId).first<CandidateRow>();
  }

  private async approval(candidate: CandidateRow): Promise<ApprovalRow | null> {
    return await this.db.prepare(
      `SELECT approvals.approval_id, approvals.decision, approvals.expires_at,
              EXISTS (SELECT 1 FROM invalidated_approvals
                      WHERE invalidated_approvals.approval_id = approvals.approval_id)
                AS invalidated,
              EXISTS (SELECT 1 FROM trusted_effect_approvals
                      WHERE trusted_effect_approvals.approval_id = approvals.approval_id)
                AS trusted
       FROM approvals
       WHERE approvals.run_id = ? AND approvals.task_revision = ?
         AND approvals.plan_id = ? AND approvals.plan_version = ?
         AND approvals.plan_digest = ? AND approvals.base_sha = ?
         AND approvals.effect = 'test_deploy'
       ORDER BY approvals.created_at DESC, approvals.approval_id DESC LIMIT 1`,
    ).bind(
      candidate.run_id,
      candidate.task_revision,
      candidate.plan_id,
      candidate.plan_version,
      candidate.plan_digest,
      candidate.base_sha,
    ).first<ApprovalRow>();
  }

  private async existing(deploymentId: string): Promise<ExistingRow | null> {
    return await this.db.prepare(
      `SELECT deployments.deployment_id, deployments.attempt_id, deployments.run_id,
              deployments.plan_id, deployments.plan_version, deployments.plan_item_id,
              deployments.approval_id, deployments.ref_sha, deployments.repository,
              deployments.workflow_path, deployments.environment,
              deployments.oidc_audience, deployments.role_ref,
              deployments.provider, deployments.provider_pipeline_id,
              deployments.provider_repository_url, deployments.provider_source_ref,
              outbox.outbox_id
       FROM test_deployments AS deployments
       LEFT JOIN outbox
         ON outbox.payload_ref = 'd1://test-deployments/' || deployments.deployment_id
        AND outbox.kind = 'test_deploy'
        AND outbox.destination IN ('github_deployments', 'yunxiao_pipelines')
       WHERE deployments.deployment_id = ?`,
    ).bind(deploymentId).first<ExistingRow>();
  }

  private existingResult(
    row: ExistingRow,
    expectedOutboxId: string,
    target: TestDeploymentTarget,
    created: boolean,
  ): TestDeploymentScheduleResult {
    if (
      row.outbox_id !== expectedOutboxId || row.repository !== target.repository ||
      row.workflow_path !== target.workflowPath || row.environment !== target.environment ||
      row.oidc_audience !== target.oidcAudience || row.role_ref !== target.roleRef ||
      row.provider !== target.provider || row.provider_pipeline_id !== (target.pipelineId ?? null)
      || row.provider_repository_url !== (target.repositoryUrl ?? null)
      || (target.provider === 'yunxiao_pipeline' && row.provider_source_ref === null)
    ) throw new TestDeploymentStoreError('state_conflict');
    return {
      deploymentId: row.deployment_id,
      outboxId: row.outbox_id,
      attemptId: row.attempt_id,
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      planItemId: row.plan_item_id,
      approvalId: row.approval_id,
      refSha: row.ref_sha,
      environment: 'test',
      created,
    };
  }
}
