import type { TestDeploymentTarget } from '../domain/test-deployment.js';
import {
  PlanItemAttemptError,
  PlanItemAttemptStore,
} from '../storage/plan-item-attempt-store.js';
import {
  TestDeploymentStore,
  TestDeploymentStoreError,
} from '../storage/test-deployment-store.js';

export type TestDeploymentReconciliationDisposition =
  | 'scheduled'
  | 'duplicate'
  | 'not_ready'
  | 'unconfigured';

interface CandidateRow {
  run_id: string;
  run_version: number;
  plan_version: number;
  item_id: string;
  progress_version: number;
  repository: string;
}

/** Replays pending/ready deployment Items into one durable D1 intent before GitHub I/O. */
export class TestDeploymentReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly targets: ReadonlyMap<string, TestDeploymentTarget>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileBatch(limit = 25): Promise<Array<{
    runId: string;
    planItemId: string;
    disposition: TestDeploymentReconciliationDisposition | 'unavailable';
  }>> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('test deployment reconciliation limit must be between 1 and 100');
    }
    const runs = await this.db.prepare(
      `SELECT DISTINCT runs.run_id, runs.version AS run_version,
              plans.plan_version
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_effects AS effects
         ON effects.plan_id = items.plan_id AND effects.item_id = items.item_id
       WHERE runs.state = 'executing' AND plans.status = 'active'
         AND effects.effect = 'test_deploy'
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{
      run_id: string;
      run_version: number;
      plan_version: number;
    }>();
    const attempts = new PlanItemAttemptStore(this.db);
    for (const run of runs.results) {
      try {
        await attempts.promoteReadyItems({
          runId: run.run_id,
          expectedRunVersion: run.run_version,
          planVersion: run.plan_version,
        }, this.now());
      } catch (error) {
        if (!(error instanceof PlanItemAttemptError)) throw error;
      }
    }
    const candidates = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version,
              plans.plan_version, items.item_id,
              progress.version AS progress_version,
              tasks.target_repository AS repository
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       JOIN plan_item_effects AS effects
         ON effects.plan_id = items.plan_id AND effects.item_id = items.item_id
       WHERE runs.state = 'executing' AND plans.status = 'active'
         AND progress.status = 'ready' AND progress.active_attempt_id IS NULL
         AND effects.effect = 'test_deploy'
       ORDER BY runs.updated_at, items.position, items.item_id LIMIT ?`,
    ).bind(limit).all<CandidateRow>();
    const results: Array<{
      runId: string;
      planItemId: string;
      disposition: TestDeploymentReconciliationDisposition | 'unavailable';
    }> = [];
    for (const candidate of candidates.results) {
      const target = this.targets.get(candidate.repository);
      if (target === undefined) {
        results.push({
          runId: candidate.run_id,
          planItemId: candidate.item_id,
          disposition: 'unconfigured',
        });
        continue;
      }
      try {
        const scheduled = await new TestDeploymentStore(this.db).schedule({
          runId: candidate.run_id,
          expectedRunVersion: candidate.run_version,
          planVersion: candidate.plan_version,
          planItemId: candidate.item_id,
          expectedProgressVersion: candidate.progress_version,
        }, target, this.now());
        results.push({
          runId: candidate.run_id,
          planItemId: candidate.item_id,
          disposition: scheduled.created ? 'scheduled' : 'duplicate',
        });
      } catch (error) {
        if (error instanceof TestDeploymentStoreError) {
          results.push({
            runId: candidate.run_id,
            planItemId: candidate.item_id,
            disposition: error.code === 'not_found' || error.code === 'state_conflict'
              ? 'not_ready'
              : 'unavailable',
          });
          continue;
        }
        throw error;
      }
    }
    return results;
  }
}
