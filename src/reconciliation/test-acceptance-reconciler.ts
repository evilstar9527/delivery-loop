import {
  PlanItemAttemptError,
  PlanItemAttemptStore,
} from '../storage/plan-item-attempt-store.js';
import {
  TestAcceptanceStore,
  TestAcceptanceStoreError,
} from '../storage/test-acceptance-store.js';

interface CandidateRow {
  run_id: string;
  run_version: number;
  plan_version: number;
  item_id: string;
  progress_version: number;
  repository: string;
}

export interface TestAcceptanceReconciliationResult {
  runId: string;
  planItemId: string;
  disposition: 'scheduled' | 'duplicate' | 'not_ready' | 'unavailable';
}

/** Promotes and schedules only verification Items backed by acceptance:* policy refs. */
export class TestAcceptanceReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
    private readonly allowedRepositories: ReadonlySet<string> | null = null,
  ) {}

  async reconcileBatch(limit = 25): Promise<TestAcceptanceReconciliationResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('test acceptance reconciliation limit must be between 1 and 100');
    }
    const runs = await this.db.prepare(
      `SELECT DISTINCT runs.run_id, runs.version AS run_version, plans.plan_version
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_command_refs AS commands
         ON commands.plan_id = items.plan_id AND commands.item_id = items.item_id
       WHERE runs.state = 'executing' AND plans.status = 'active'
         AND commands.command_ref LIKE 'acceptance:%'
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{
      run_id: string;
      run_version: number;
      plan_version: number;
    }>();
    const itemStore = new PlanItemAttemptStore(this.db);
    for (const run of runs.results) {
      try {
        await itemStore.promoteReadyItems({
          runId: run.run_id,
          expectedRunVersion: run.run_version,
          planVersion: run.plan_version,
        }, this.now());
      } catch (error) {
        if (!(error instanceof PlanItemAttemptError)) throw error;
      }
    }
    const candidates = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, plans.plan_version,
              items.item_id, progress.version AS progress_version,
              tasks.target_repository AS repository
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       JOIN plan_item_command_refs AS commands
         ON commands.plan_id = items.plan_id AND commands.item_id = items.item_id
       WHERE runs.state = 'executing' AND plans.status = 'active'
         AND progress.status = 'ready' AND progress.active_attempt_id IS NULL
         AND commands.command_ref LIKE 'acceptance:%'
       ORDER BY runs.updated_at, items.position, items.item_id LIMIT ?`,
    ).bind(limit).all<CandidateRow>();
    const results: TestAcceptanceReconciliationResult[] = [];
    for (const candidate of candidates.results) {
      if (
        this.allowedRepositories !== null &&
        !this.allowedRepositories.has(candidate.repository)
      ) continue;
      try {
        const scheduled = await new TestAcceptanceStore(this.db).schedule({
          runId: candidate.run_id,
          expectedRunVersion: candidate.run_version,
          planVersion: candidate.plan_version,
          planItemId: candidate.item_id,
          expectedProgressVersion: candidate.progress_version,
        }, this.now());
        results.push({
          runId: candidate.run_id,
          planItemId: candidate.item_id,
          disposition: scheduled.created ? 'scheduled' : 'duplicate',
        });
      } catch (error) {
        if (error instanceof TestAcceptanceStoreError) {
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
