import type { ProductionDeploymentTarget } from '../domain/production-deployment.js';
import {
  ProductionDeploymentStore,
  ProductionDeploymentStoreError,
} from '../storage/production-deployment-store.js';

export type ProductionDeploymentReconciliationDisposition =
  | 'scheduled'
  | 'duplicate'
  | 'not_ready'
  | 'unconfigured'
  | 'unavailable';

interface CandidateRow {
  run_id: string;
  run_version: number;
  plan_version: number;
  repository: string;
}

/** Turns merged production Runs into one durable, approval-bound deployment intent. */
export class ProductionDeploymentReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly targets: ReadonlyMap<string, ProductionDeploymentTarget>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileBatch(limit = 25): Promise<Array<{
    runId: string;
    disposition: ProductionDeploymentReconciliationDisposition;
  }>> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('production deployment reconciliation limit must be between 1 and 100');
    }
    const candidates = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version,
              plans.plan_version, tasks.target_repository AS repository
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN github_merges AS merges ON merges.run_id = runs.run_id
       WHERE runs.state = 'deploying' AND plans.status = 'active'
         AND tasks.target_environment = 'production'
         AND tasks.allow_production_deploy = 1
         AND merges.deployment_disposition = 'production'
         AND merges.plan_id = plans.plan_id
         AND merges.plan_version = plans.plan_version
         AND merges.plan_digest = plans.digest
         AND merges.run_version + 2 = runs.version
         AND EXISTS (
           SELECT 1 FROM plan_item_effects
           WHERE plan_item_effects.plan_id = plans.plan_id
             AND plan_item_effects.effect = 'production_deploy'
         )
         AND NOT EXISTS (
           SELECT 1 FROM production_deployments
           WHERE production_deployments.run_id = runs.run_id
         )
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<CandidateRow>();
    const results: Array<{
      runId: string;
      disposition: ProductionDeploymentReconciliationDisposition;
    }> = [];
    for (const candidate of candidates.results) {
      const target = this.targets.get(candidate.repository);
      if (target === undefined) {
        results.push({ runId: candidate.run_id, disposition: 'unconfigured' });
        continue;
      }
      try {
        const scheduled = await new ProductionDeploymentStore(this.db).schedule({
          runId: candidate.run_id,
          expectedRunVersion: candidate.run_version,
          planVersion: candidate.plan_version,
        }, target, this.now());
        results.push({
          runId: candidate.run_id,
          disposition: scheduled.created ? 'scheduled' : 'duplicate',
        });
      } catch (error) {
        if (error instanceof ProductionDeploymentStoreError) {
          results.push({
            runId: candidate.run_id,
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
