import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import type { ProductionDeploymentTarget } from '../domain/production-deployment.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export const ScheduleProductionDeploymentInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
}).strict();

export type ScheduleProductionDeploymentInput =
  z.infer<typeof ScheduleProductionDeploymentInputSchema>;

export type ProductionDeploymentStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'approval_required'
  | 'policy_denied';

export class ProductionDeploymentStoreError extends Error {
  constructor(readonly code: ProductionDeploymentStoreErrorCode) {
    super(`production deployment scheduling failed: ${code}`);
    this.name = 'ProductionDeploymentStoreError';
  }
}

export interface ProductionDeploymentScheduleResult {
  deploymentId: string;
  outboxId: string;
  attemptId: string;
  runId: string;
  planId: string;
  planVersion: number;
  approvalId: string;
  mergeId: string;
  mergeSha: string;
  environment: 'production';
  created: boolean;
}

interface CandidateRow {
  run_id: string;
  run_version: number;
  run_state: string;
  task_revision: string;
  target_repository: string;
  target_base_branch: string;
  target_environment: string;
  allow_production_deploy: number;
  base_sha: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  merge_id: string;
  merge_sha: string;
  deployment_disposition: string;
  incomplete_required_count: number;
  production_effect_count: number;
}

interface ApprovalRow {
  approval_id: string;
  decision: string;
  expires_at: string;
  merge_id: string;
  merge_sha: string;
  environment: string;
  invalidated: number;
  latest: number;
}

interface ExistingRow {
  deployment_id: string;
  outbox_id: string | null;
  attempt_id: string;
  run_id: string;
  plan_id: string;
  plan_version: number;
  approval_id: string;
  merge_id: string;
  merge_sha: string;
  repository: string;
  workflow_path: string;
  environment: string;
  oidc_audience: string;
  role_ref: string;
}

/** Creates one post-merge production release intent after exact external approval. */
export class ProductionDeploymentStore {
  constructor(private readonly db: D1Database) {}

  async schedule(
    rawInput: unknown,
    target: ProductionDeploymentTarget,
    now = new Date(),
  ): Promise<ProductionDeploymentScheduleResult> {
    const parsed = ScheduleProductionDeploymentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ProductionDeploymentStoreError('invalid_request');
    const input = parsed.data;
    const candidate = await this.candidate(input);
    if (candidate === null) throw new ProductionDeploymentStoreError('not_found');
    this.assertCandidate(candidate, target);
    const approval = await this.approval(candidate);
    if (
      approval === null || approval.decision !== 'approve' ||
      approval.expires_at <= now.toISOString() || approval.invalidated === 1 ||
      approval.latest !== 1 || approval.merge_id !== candidate.merge_id ||
      approval.merge_sha !== candidate.merge_sha || approval.environment !== 'production'
    ) throw new ProductionDeploymentStoreError('approval_required');

    const identity = await canonicalSha256({
      runId: candidate.run_id,
      runVersion: candidate.run_version,
      taskRevision: candidate.task_revision,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planDigest: candidate.plan_digest,
      mergeId: candidate.merge_id,
      mergeSha: candidate.merge_sha,
      approvalId: approval.approval_id,
      target,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 40);
    const deploymentId = `deployment_production_${suffix}`;
    const attemptId = `attempt_production_deploy_${suffix}`;
    const outboxId = `outbox_production_deploy_${suffix}`;
    const existing = await this.existing(deploymentId);
    if (existing !== null) return this.existingResult(existing, outboxId, target, false);

    const nowIso = now.toISOString();
    const workflowRef =
      `${target.repository}/${target.workflowPath}@refs/heads/${candidate.target_base_branch}`;
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
           repository, workflow_ref, plan_id, plan_version,
           version, lease_generation, created_at, updated_at
         )
         SELECT ?, runs.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = runs.run_id),
                'deploy', 'pending', runs.base_sha, merges.merge_sha,
                tasks.target_repository, ?, plans.plan_id, plans.plan_version,
                0, 0, ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN github_merges AS merges ON merges.run_id = runs.run_id
         JOIN trusted_effect_approvals AS approvals ON approvals.approval_id = ?
         JOIN production_release_approval_bindings AS release
           ON release.approval_id = approvals.approval_id
         WHERE runs.run_id = ? AND runs.version = ? AND runs.state = 'deploying'
           AND runs.task_revision = ? AND runs.active_plan_id = plans.plan_id
           AND runs.active_plan_version = plans.plan_version
           AND runs.active_plan_digest = plans.digest
           AND tasks.target_repository = ? AND tasks.target_environment = 'production'
           AND tasks.allow_production_deploy = 1
           AND plans.plan_version = ? AND plans.digest = ? AND plans.status = 'active'
           AND merges.merge_id = ? AND merges.merge_sha = ?
           AND merges.run_version + 2 = runs.version
           AND merges.plan_id = plans.plan_id AND merges.plan_version = plans.plan_version
           AND merges.plan_digest = plans.digest
           AND merges.deployment_disposition = 'production'
           AND release.run_id = runs.run_id AND release.task_revision = runs.task_revision
           AND release.plan_id = plans.plan_id AND release.plan_version = plans.plan_version
           AND release.plan_digest = plans.digest AND release.merge_id = merges.merge_id
           AND release.merge_sha = merges.merge_sha AND release.environment = 'production'
           AND approvals.effect = 'production_deploy' AND approvals.decision = 'approve'
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
        attemptId,
        workflowRef,
        nowIso,
        nowIso,
        approval.approval_id,
        candidate.run_id,
        candidate.run_version,
        candidate.task_revision,
        target.repository,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.merge_id,
        candidate.merge_sha,
        nowIso,
      ),
      this.db.prepare(
        `INSERT INTO production_deployments (
           deployment_id, run_id, run_version, task_revision, plan_id,
           plan_version, plan_digest, merge_id, merge_sha, attempt_id,
           approval_id, repository, base_branch, workflow_path, environment,
           oidc_audience, role_ref, status, created_at, updated_at
         )
         SELECT ?, runs.run_id, runs.version, runs.task_revision, plans.plan_id,
                plans.plan_version, plans.digest, merges.merge_id, merges.merge_sha,
                attempts.attempt_id, release.approval_id, tasks.target_repository,
                tasks.target_base_branch, ?, 'production', ?, ?, 'scheduled', ?, ?
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = attempts.plan_id
         JOIN github_merges AS merges ON merges.run_id = runs.run_id
         JOIN production_release_approval_bindings AS release ON release.approval_id = ?
         JOIN trusted_effect_approvals AS approvals ON approvals.approval_id = release.approval_id
         WHERE attempts.attempt_id = ? AND attempts.status = 'pending'
           AND attempts.mode = 'deploy' AND attempts.head_sha = merges.merge_sha
           AND runs.run_id = ? AND runs.version = ? AND runs.state = 'deploying'
           AND runs.active_plan_id = plans.plan_id
           AND runs.active_plan_version = plans.plan_version
           AND runs.active_plan_digest = plans.digest AND plans.status = 'active'
           AND merges.merge_id = ? AND merges.merge_sha = ?
           AND merges.run_version + 2 = runs.version
           AND merges.deployment_disposition = 'production'
           AND release.run_id = runs.run_id AND release.task_revision = runs.task_revision
           AND release.plan_id = plans.plan_id AND release.plan_version = plans.plan_version
           AND release.plan_digest = plans.digest AND release.merge_id = merges.merge_id
           AND release.merge_sha = merges.merge_sha AND release.environment = 'production'
           AND approvals.effect = 'production_deploy' AND approvals.decision = 'approve'
           AND approvals.expires_at > ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        deploymentId,
        target.workflowPath,
        target.oidcAudience,
        target.roleRef,
        nowIso,
        nowIso,
        approval.approval_id,
        attemptId,
        candidate.run_id,
        candidate.run_version,
        candidate.merge_id,
        candidate.merge_sha,
        nowIso,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, run_id, 'production_deploy', 'github_production_deployments', ?, ?,
                'pending', ?, ?
         FROM production_deployments
         WHERE deployment_id = ? AND status = 'scheduled'
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://production-deployments/${deploymentId}`,
        `production-deploy:${deploymentId}`,
        nowIso,
        nowIso,
        deploymentId,
      ),
    ]);
    const persisted = await this.existing(deploymentId);
    if (persisted === null) throw new ProductionDeploymentStoreError('state_conflict');
    return this.existingResult(
      persisted,
      outboxId,
      target,
      results[2]?.meta.changes === 1,
    );
  }

  private assertCandidate(
    candidate: CandidateRow,
    target: ProductionDeploymentTarget,
  ): void {
    if (
      candidate.run_state !== 'deploying' ||
      candidate.target_repository !== target.repository ||
      candidate.target_environment !== 'production' ||
      candidate.allow_production_deploy !== 1 || candidate.plan_status !== 'active' ||
      candidate.deployment_disposition !== 'production' ||
      candidate.incomplete_required_count !== 0 || candidate.production_effect_count !== 1
    ) throw new ProductionDeploymentStoreError('policy_denied');
  }

  private async candidate(
    input: ScheduleProductionDeploymentInput,
  ): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, runs.state AS run_state,
              runs.task_revision, tasks.target_repository, tasks.target_base_branch,
              tasks.target_environment, tasks.allow_production_deploy, runs.base_sha,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              plans.status AS plan_status, merges.merge_id, merges.merge_sha,
              merges.deployment_disposition,
              (SELECT COUNT(*) FROM plan_items
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = plan_items.plan_id
                AND plan_item_progress.item_id = plan_items.item_id
               WHERE plan_items.plan_id = plans.plan_id AND plan_items.required = 1
                 AND plan_item_progress.status <> 'passed') AS incomplete_required_count,
              (SELECT COUNT(*) FROM plan_item_effects
               WHERE plan_item_effects.plan_id = plans.plan_id
                 AND plan_item_effects.effect = 'production_deploy')
                AS production_effect_count
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN github_merges AS merges ON merges.run_id = runs.run_id
       WHERE runs.run_id = ? AND runs.version = ? AND runs.state = 'deploying'
         AND plans.plan_version = ? AND plans.status = 'active'
         AND plans.digest = runs.active_plan_digest AND plans.base_sha = runs.base_sha
         AND merges.plan_id = plans.plan_id AND merges.plan_version = plans.plan_version
         AND merges.plan_digest = plans.digest AND merges.run_version + 2 = runs.version`,
    ).bind(
      input.runId,
      input.expectedRunVersion,
      input.planVersion,
    ).first<CandidateRow>();
  }

  private async approval(candidate: CandidateRow): Promise<ApprovalRow | null> {
    return await this.db.prepare(
      `SELECT approvals.approval_id, approvals.decision, approvals.expires_at,
              release.merge_id, release.merge_sha, release.environment,
              EXISTS (
                SELECT 1 FROM invalidated_approvals
                WHERE invalidated_approvals.approval_id = approvals.approval_id
              ) AS invalidated,
              NOT EXISTS (
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
              ) AS latest
       FROM trusted_effect_approvals AS approvals
       JOIN production_release_approval_bindings AS release
         ON release.approval_id = approvals.approval_id
       WHERE approvals.run_id = ? AND approvals.task_revision = ?
         AND approvals.plan_id = ? AND approvals.plan_version = ?
         AND approvals.plan_digest = ? AND approvals.base_sha = ?
         AND approvals.effect = 'production_deploy'
         AND release.merge_id = ? AND release.merge_sha = ?
         AND release.environment = 'production'
       ORDER BY approvals.created_at DESC, approvals.approval_id DESC LIMIT 1`,
    ).bind(
      candidate.run_id,
      candidate.task_revision,
      candidate.plan_id,
      candidate.plan_version,
      candidate.plan_digest,
      candidate.base_sha,
      candidate.merge_id,
      candidate.merge_sha,
    ).first<ApprovalRow>();
  }

  private async existing(deploymentId: string): Promise<ExistingRow | null> {
    return await this.db.prepare(
      `SELECT deployments.deployment_id, deployments.attempt_id,
              deployments.run_id, deployments.plan_id, deployments.plan_version,
              deployments.approval_id, deployments.merge_id, deployments.merge_sha,
              deployments.repository, deployments.workflow_path,
              deployments.environment, deployments.oidc_audience, deployments.role_ref,
              outbox.outbox_id
       FROM production_deployments AS deployments
       LEFT JOIN outbox ON outbox.run_id = deployments.run_id
        AND outbox.kind = 'production_deploy'
        AND outbox.destination = 'github_production_deployments'
        AND outbox.payload_ref = 'd1://production-deployments/' || deployments.deployment_id
       WHERE deployments.deployment_id = ?`,
    ).bind(deploymentId).first<ExistingRow>();
  }

  private existingResult(
    row: ExistingRow,
    outboxId: string,
    target: ProductionDeploymentTarget,
    created: boolean,
  ): ProductionDeploymentScheduleResult {
    if (
      row.outbox_id !== outboxId || row.repository !== target.repository ||
      row.workflow_path !== target.workflowPath || row.environment !== target.environment ||
      row.oidc_audience !== target.oidcAudience || row.role_ref !== target.roleRef
    ) throw new ProductionDeploymentStoreError('state_conflict');
    return {
      deploymentId: row.deployment_id,
      outboxId,
      attemptId: row.attempt_id,
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      approvalId: row.approval_id,
      mergeId: row.merge_id,
      mergeSha: row.merge_sha,
      environment: 'production',
      created,
    };
  }
}
