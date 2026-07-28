import {
  BaseRebaseAttemptError,
  BaseRebaseAttemptStore,
} from '../storage/base-rebase-attempt-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export type BaseRebaseAttemptReconciliationDisposition =
  | 'scheduled'
  | 'duplicate'
  | 'not_found';

export interface BaseRebaseAttemptReconcilerOptions {
  now?: () => Date;
}

/** Finds an approved base-only Plan revision and creates its one replay Attempt/outbox. */
export class BaseRebaseAttemptReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    options: BaseRebaseAttemptReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileRun(runId: string): Promise<BaseRebaseAttemptReconciliationDisposition> {
    if (!ID_PATTERN.test(runId)) return 'not_found';
    try {
      const result = await new BaseRebaseAttemptStore(this.db).schedule(runId, this.now());
      return result.created ? 'scheduled' : 'duplicate';
    } catch (error) {
      if (
        error instanceof BaseRebaseAttemptError &&
        (error.code === 'not_found' || error.code === 'state_conflict')
      ) return 'not_found';
      throw error;
    }
  }

  async reconcileBatch(limit = 25): Promise<Array<{
    runId: string;
    disposition: BaseRebaseAttemptReconciliationDisposition | 'unavailable';
  }>> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('base rebase reconciliation limit must be between 1 and 100');
    }
    const candidates = await this.db.prepare(
      `SELECT DISTINCT runs.run_id
       FROM runs
       JOIN plan_revisions
         ON plan_revisions.run_id = runs.run_id
        AND plan_revisions.new_plan_id = runs.active_plan_id
       WHERE runs.state = 'executing'
         AND plan_revisions.status = 'activated'
         AND plan_revisions.source_kind = 'base_update'
         AND plan_revisions.body_changed = 0
         AND plan_revisions.base_changed = 1
         AND plan_revisions.effects_changed = 0
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: Array<{
      runId: string;
      disposition: BaseRebaseAttemptReconciliationDisposition | 'unavailable';
    }> = [];
    for (const candidate of candidates.results) {
      try {
        results.push({
          runId: candidate.run_id,
          disposition: await this.reconcileRun(candidate.run_id),
        });
      } catch {
        results.push({ runId: candidate.run_id, disposition: 'unavailable' });
      }
    }
    return results;
  }
}
