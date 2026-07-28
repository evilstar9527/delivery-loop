import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const PromoteReadyItemsInputSchema = z
  .object({
    runId: z.string().regex(IDENTIFIER_PATTERN),
    expectedRunVersion: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
  })
  .strict();

const ClaimReadyItemInputSchema = PromoteReadyItemsInputSchema.extend({
  planItemId: z.string().regex(IDENTIFIER_PATTERN),
  expectedProgressVersion: z.number().int().positive(),
}).strict();

export type PromoteReadyItemsInput = z.infer<typeof PromoteReadyItemsInputSchema>;
export type ClaimReadyItemInput = z.infer<typeof ClaimReadyItemInputSchema>;

export type PlanItemAttemptErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'item_not_ready'
  | 'dependency_incomplete'
  | 'claim_conflict';

export class PlanItemAttemptError extends Error {
  constructor(readonly code: PlanItemAttemptErrorCode) {
    super(`Plan Item Attempt operation failed: ${code}`);
    this.name = 'PlanItemAttemptError';
  }
}

export interface PromoteReadyItemsResult {
  changed: number;
  readyItemIds: string[];
}

export interface PlanItemAttemptClaim {
  attemptId: string;
  runId: string;
  planId: string;
  planVersion: number;
  planItemId: string;
  ordinal: number;
  mode: 'implement' | 'deploy';
  created: boolean;
}

interface ActivePlanRow {
  run_id: string;
  run_state: string;
  run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_id: string;
  plan_version: number;
  plan_status: string;
}

interface ItemClaimContextRow extends ActivePlanRow {
  item_id: string;
  progress_status: string;
  progress_version: number;
  active_attempt_id: string | null;
  base_sha: string | null;
  repository: string;
  base_branch: string;
  has_deploy_effect: number;
}

interface ClaimProjectionRow {
  attempt_id: string;
  run_id: string;
  ordinal: number;
  mode: 'implement' | 'deploy';
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  claimed_progress_version: number;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PlanItemAttemptError('invalid_request');
  return parsed.data;
}

/**
 * D1 scheduler boundary for the first Attempt of a Plan Item.
 *
 * Only the control plane calls this store. Runner APIs have no progress-status field,
 * so an Agent can report an outcome but cannot set ready/skipped/passed itself.
 */
export class PlanItemAttemptStore {
  constructor(private readonly db: D1Database) {}

  async promoteReadyItems(
    rawInput: unknown,
    now = new Date(),
  ): Promise<PromoteReadyItemsResult> {
    const input = parseInput(PromoteReadyItemsInputSchema, rawInput);
    const active = await this.activePlan(input.runId, input.planVersion);
    this.assertActivePlan(active, input.expectedRunVersion);

    const result = await this.db
      .prepare(
        `UPDATE plan_item_progress
         SET status = 'ready', version = version + 1, updated_at = ?
         WHERE plan_id = ?
           AND status = 'pending'
           AND EXISTS (
             SELECT 1
             FROM runs
             JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
             WHERE runs.run_id = ?
               AND runs.state = 'executing'
               AND runs.version = ?
               AND runs.active_plan_id = plan_item_progress.plan_id
               AND runs.active_plan_version = ?
               AND execution_plans.status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM plan_item_dependencies
             LEFT JOIN plan_item_progress AS dependency_progress
               ON dependency_progress.plan_id = plan_item_dependencies.plan_id
              AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
             WHERE plan_item_dependencies.plan_id = plan_item_progress.plan_id
               AND plan_item_dependencies.item_id = plan_item_progress.item_id
               AND (
                 dependency_progress.status IS NULL
                 OR dependency_progress.status <> 'passed'
               )
           )
         RETURNING item_id`,
      )
      .bind(
        now.toISOString(),
        active!.plan_id,
        input.runId,
        input.expectedRunVersion,
        input.planVersion,
      )
      .all<{ item_id: string }>();
    const readyItemIds = result.results.map((row) => row.item_id).sort();
    return { changed: readyItemIds.length, readyItemIds };
  }

  async claimReadyItem(
    rawInput: unknown,
    now = new Date(),
  ): Promise<PlanItemAttemptClaim> {
    const input = parseInput(ClaimReadyItemInputSchema, rawInput);
    const context = await this.itemContext(input);
    if (context === null) throw new PlanItemAttemptError('not_found');
    this.assertActivePlan(context, input.expectedRunVersion);
    if (context.base_sha === null) throw new PlanItemAttemptError('state_conflict');

    const attemptId = await this.claimAttemptId(context.plan_id, input);
    const existing = await this.existingClaim(attemptId, input);
    if (existing !== null) return this.claimResult(existing, false);

    if (
      context.progress_status !== 'ready' ||
      context.progress_version !== input.expectedProgressVersion ||
      context.active_attempt_id !== null
    ) {
      throw new PlanItemAttemptError('item_not_ready');
    }
    if (await this.hasIncompleteDependency(context.plan_id, input.planItemId)) {
      throw new PlanItemAttemptError('dependency_incomplete');
    }

    const mode = context.has_deploy_effect === 1 ? 'deploy' : 'implement';
    const workflowRef = `${context.repository}/.github/workflows/delivery-agent.yml@refs/heads/${context.base_branch}`;
    const nowIso = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO attempts (
             attempt_id, run_id, ordinal, mode, status, base_sha, repository,
             workflow_ref, plan_id, plan_version, plan_item_id,
             claimed_progress_version, version, lease_generation, created_at, updated_at
           )
           SELECT ?, runs.run_id,
                  (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                   FROM attempts AS existing WHERE existing.run_id = runs.run_id),
                  ?, 'pending', runs.base_sha, tasks.target_repository, ?,
                  execution_plans.plan_id, execution_plans.plan_version,
                  plan_items.item_id, ?, 0, 0, ?, ?
           FROM runs
           JOIN tasks ON tasks.task_id = runs.task_id
           JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
           JOIN plan_items ON plan_items.plan_id = execution_plans.plan_id
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_items.plan_id
            AND plan_item_progress.item_id = plan_items.item_id
           WHERE runs.run_id = ?
             AND runs.state = 'executing'
             AND runs.version = ?
             AND runs.active_plan_version = ?
             AND execution_plans.status = 'active'
             AND plan_items.item_id = ?
             AND plan_item_progress.status = 'ready'
             AND plan_item_progress.version = ?
             AND plan_item_progress.active_attempt_id IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM plan_item_dependencies
               LEFT JOIN plan_item_progress AS dependency_progress
                 ON dependency_progress.plan_id = plan_item_dependencies.plan_id
                AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
               WHERE plan_item_dependencies.plan_id = plan_items.plan_id
                 AND plan_item_dependencies.item_id = plan_items.item_id
                 AND (
                   dependency_progress.status IS NULL
                   OR dependency_progress.status <> 'passed'
                 )
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          attemptId,
          mode,
          workflowRef,
          input.expectedProgressVersion,
          nowIso,
          nowIso,
          input.runId,
          input.expectedRunVersion,
          input.planVersion,
          input.planItemId,
          input.expectedProgressVersion,
        ),
      this.db
        .prepare(
          `UPDATE plan_item_progress
           SET status = 'in_progress', active_attempt_id = ?,
               version = version + 1, updated_at = ?
           WHERE plan_id = ? AND item_id = ?
             AND status = 'ready' AND version = ?
             AND active_attempt_id IS NULL
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = ?
                 AND run_id = ?
                 AND plan_id = plan_item_progress.plan_id
                 AND plan_version = ?
                 AND plan_item_id = plan_item_progress.item_id
                 AND claimed_progress_version = ?
                 AND status = 'pending'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM plan_item_dependencies
               LEFT JOIN plan_item_progress AS dependency_progress
                 ON dependency_progress.plan_id = plan_item_dependencies.plan_id
                AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
               WHERE plan_item_dependencies.plan_id = plan_item_progress.plan_id
                 AND plan_item_dependencies.item_id = plan_item_progress.item_id
                 AND (
                   dependency_progress.status IS NULL
                   OR dependency_progress.status <> 'passed'
                 )
             )`,
        )
        .bind(
          attemptId,
          nowIso,
          context.plan_id,
          input.planItemId,
          input.expectedProgressVersion,
          attemptId,
          input.runId,
          input.planVersion,
          input.expectedProgressVersion,
        ),
    ]);

    const claimed = await this.existingClaim(attemptId, input);
    if (claimed === null) throw new PlanItemAttemptError('claim_conflict');
    return this.claimResult(claimed, results[0]?.meta.changes === 1);
  }

  private async activePlan(runId: string, planVersion: number): Promise<ActivePlanRow | null> {
    return await this.db
      .prepare(
        `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
                runs.active_plan_id, runs.active_plan_version,
                execution_plans.plan_id, execution_plans.plan_version,
                execution_plans.status AS plan_status
         FROM runs
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         WHERE runs.run_id = ? AND execution_plans.plan_version = ?`,
      )
      .bind(runId, planVersion)
      .first<ActivePlanRow>();
  }

  private async itemContext(input: ClaimReadyItemInput): Promise<ItemClaimContextRow | null> {
    return await this.db
      .prepare(
        `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
                runs.active_plan_id, runs.active_plan_version, runs.base_sha,
                execution_plans.plan_id, execution_plans.plan_version,
                execution_plans.status AS plan_status, plan_items.item_id,
                plan_item_progress.status AS progress_status,
                plan_item_progress.version AS progress_version,
                plan_item_progress.active_attempt_id,
                tasks.target_repository AS repository,
                tasks.target_base_branch AS base_branch,
                EXISTS (
                  SELECT 1 FROM plan_item_effects
                  WHERE plan_item_effects.plan_id = plan_items.plan_id
                    AND plan_item_effects.item_id = plan_items.item_id
                    AND plan_item_effects.effect IN ('test_deploy', 'production_deploy')
                ) AS has_deploy_effect
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         JOIN plan_items ON plan_items.plan_id = execution_plans.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = plan_items.plan_id
          AND plan_item_progress.item_id = plan_items.item_id
         WHERE runs.run_id = ?
           AND execution_plans.plan_version = ?
           AND plan_items.item_id = ?`,
      )
      .bind(input.runId, input.planVersion, input.planItemId)
      .first<ItemClaimContextRow>();
  }

  private assertActivePlan(
    active: ActivePlanRow | null,
    expectedRunVersion: number,
  ): asserts active is ActivePlanRow {
    if (active === null) throw new PlanItemAttemptError('not_found');
    if (
      active.run_state !== 'executing' ||
      active.run_version !== expectedRunVersion ||
      active.active_plan_id !== active.plan_id ||
      active.active_plan_version !== active.plan_version ||
      active.plan_status !== 'active'
    ) {
      throw new PlanItemAttemptError('state_conflict');
    }
  }

  private async hasIncompleteDependency(planId: string, itemId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM plan_item_dependencies
         LEFT JOIN plan_item_progress AS dependency_progress
           ON dependency_progress.plan_id = plan_item_dependencies.plan_id
          AND dependency_progress.item_id = plan_item_dependencies.depends_on_item_id
         WHERE plan_item_dependencies.plan_id = ?
           AND plan_item_dependencies.item_id = ?
           AND (
             dependency_progress.status IS NULL
             OR dependency_progress.status <> 'passed'
           )`,
      )
      .bind(planId, itemId)
      .first<{ count: number }>();
    return row === null || row.count > 0;
  }

  private async claimAttemptId(
    planId: string,
    input: ClaimReadyItemInput,
  ): Promise<string> {
    const digest = await canonicalSha256({
      runId: input.runId,
      planId,
      planVersion: input.planVersion,
      planItemId: input.planItemId,
      progressVersion: input.expectedProgressVersion,
    });
    return `attempt_item_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async existingClaim(
    attemptId: string,
    input: ClaimReadyItemInput,
  ): Promise<ClaimProjectionRow | null> {
    return await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.ordinal, attempts.mode,
                attempts.plan_id, attempts.plan_version, attempts.plan_item_id,
                attempts.claimed_progress_version
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ?
           AND attempts.run_id = ?
           AND attempts.plan_version = ?
           AND attempts.plan_item_id = ?
           AND attempts.claimed_progress_version = ?
           AND attempts.status = 'pending'
           AND runs.state = 'executing'
           AND runs.version = ?
           AND runs.active_plan_id = attempts.plan_id
           AND runs.active_plan_version = attempts.plan_version
           AND execution_plans.status = 'active'
           AND plan_item_progress.status = 'in_progress'
           AND plan_item_progress.active_attempt_id = attempts.attempt_id`,
      )
      .bind(
        attemptId,
        input.runId,
        input.planVersion,
        input.planItemId,
        input.expectedProgressVersion,
        input.expectedRunVersion,
      )
      .first<ClaimProjectionRow>();
  }

  private claimResult(row: ClaimProjectionRow, created: boolean): PlanItemAttemptClaim {
    return {
      attemptId: row.attempt_id,
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      planItemId: row.plan_item_id,
      ordinal: row.ordinal,
      mode: row.mode,
      created,
    };
  }
}
