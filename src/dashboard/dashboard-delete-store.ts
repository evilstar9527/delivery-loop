import type { Bindings } from '../env.js';
import {
  AttemptLifecycleError,
  AttemptLifecycleStore,
} from '../storage/attempt-lifecycle-store.js';
import {
  cloudflareSandboxEffectsFromEnv,
} from '../executor/plugins/cloudflare-sandbox/cloudflare-sandbox-runtime.js';

/**
 * Board-level task removal.
 *
 * A run cannot be deleted: 77 tables carry a foreign key to `runs(run_id)` and
 * ten of them do not cascade, so SQLite rejects the DELETE, and correlation
 * queries plus pilot evidence verifiers are anchored on the run row. "Delete"
 * therefore means *cancel the run and hide it from the board*, which keeps the
 * lineage auditable and is reversible by removing the dismissal row.
 *
 * Cancellation itself is delegated to `AttemptLifecycleStore.cancelRun`, which
 * already revokes Attempt tokens, fences the old lease generation, settles
 * undelivered dispatch outbox rows and enqueues the single `workflow_cancel`.
 */

/** A live container attached to a run at the moment the delete was requested. */
export interface DeleteBlockingSandbox {
  runId: string;
  sandboxId: string;
  executionId: string;
  role: string;
}

export type DeleteRunStatus =
  /** Run cancelled (when it was still live) and hidden from the board. */
  | 'deleted'
  /** Live containers exist and the caller did not authorise destroying them. */
  | 'sandbox_active'
  | 'not_found'
  /** The run is in a state that must not be interrupted, e.g. merging. */
  | 'conflict';

export interface DeleteRunOutcome {
  runId: string;
  status: DeleteRunStatus;
  sandboxes: DeleteBlockingSandbox[];
  /** Containers actually destroyed by this call. */
  terminatedSandboxes: string[];
}

/** Run states that are already over: hide them without attempting a cancel. */
const TERMINAL_RUN_STATES = new Set(['succeeded', 'cancelled']);

interface RunStateRow {
  run_id: string;
  state: string;
  version: number;
}

interface SandboxRow {
  run_id: string;
  provider_external_id: string;
  execution_id: string;
  execution_role: string;
}

export class DashboardDeleteStore {
  constructor(
    private readonly db: D1Database,
    private readonly env: Pick<
      Bindings,
      'AGENT_EXECUTOR' | 'AGENT_EXECUTOR_URL' | 'AGENT_EXECUTOR_CONTROL_TOKEN' |
      'AGENT_EXECUTOR_CALLBACK_TOKEN'
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Live containers for the given runs. Mirrors the board's own definition of
   * an active sandbox: a starting/running execution that has a provider handle.
   */
  async activeSandboxes(runIds: readonly string[]): Promise<DeleteBlockingSandbox[]> {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => '?').join(', ');
    const rows = await this.db.prepare(
      `SELECT attempts.run_id, execution.provider_external_id,
              execution.execution_id, execution.execution_role
       FROM attempt_execution_instances AS execution
       JOIN attempts ON attempts.attempt_id = execution.attempt_id
       WHERE attempts.run_id IN (${placeholders})
         AND execution.status IN ('starting', 'running')
         AND execution.provider_external_id IS NOT NULL
       ORDER BY execution.execution_id`,
    ).bind(...runIds).all<SandboxRow>();
    return rows.results.map((row) => ({
      runId: row.run_id,
      sandboxId: row.provider_external_id,
      executionId: row.execution_id,
      role: row.execution_role,
    }));
  }

  async deleteRun(runId: string, cascadeSandboxes: boolean): Promise<DeleteRunOutcome> {
    const run = await this.db
      .prepare('SELECT run_id, state, version FROM runs WHERE run_id = ?')
      .bind(runId)
      .first<RunStateRow>();
    if (run === null) {
      return { runId, status: 'not_found', sandboxes: [], terminatedSandboxes: [] };
    }

    const sandboxes = await this.activeSandboxes([runId]);
    if (sandboxes.length > 0 && !cascadeSandboxes) {
      // Refuse before changing anything: the operator has to see that live
      // containers would be destroyed and say so explicitly.
      return { runId, status: 'sandbox_active', sandboxes, terminatedSandboxes: [] };
    }

    if (!TERMINAL_RUN_STATES.has(run.state)) {
      try {
        await new AttemptLifecycleStore(this.db).cancelRun(runId, run.version, this.now());
      } catch (error) {
        if (!(error instanceof AttemptLifecycleError)) throw error;
        // A run that is merging/deploying, or whose Attempt already reported a
        // result, must not be interrupted or silently hidden mid-effect.
        return { runId, status: 'conflict', sandboxes, terminatedSandboxes: [] };
      }
    }

    await this.db.prepare(
      `INSERT INTO dashboard_dismissals (run_id, dismissed_at, reason)
       VALUES (?, ?, 'operator_delete')
       ON CONFLICT DO NOTHING`,
    ).bind(runId, this.now().toISOString()).run();

    // Destroy containers only after the cancel above revoked their tokens and
    // bumped the lease generation, so a runner racing its own teardown cannot
    // write once more with still-valid credentials.
    const terminatedSandboxes = sandboxes.length === 0
      ? []
      : await this.terminateSandboxes(sandboxes);
    return { runId, status: 'deleted', sandboxes, terminatedSandboxes };
  }

  private async terminateSandboxes(
    sandboxes: readonly DeleteBlockingSandbox[],
  ): Promise<string[]> {
    // Resolving the executor transport can throw on partially configured
    // environments: AGENT_EXECUTOR_URL ships as a plain var while the control
    // token is a secret, so a deployment holding only the var raises rather
    // than returning null. The run is already cancelled and dismissed by now,
    // so an unreachable executor must leave the removal successful and the
    // container reapable, never fail the request.
    let effects;
    try {
      effects = cloudflareSandboxEffectsFromEnv(this.env);
    } catch {
      return [];
    }
    const origin = this.env.AGENT_EXECUTOR_URL;
    if (effects === null || origin === undefined) return [];
    const terminated: string[] = [];
    for (const sandbox of sandboxes) {
      try {
        await effects.cancelSandbox(origin, sandbox.sandboxId, 'run_cancelled');
        terminated.push(sandbox.sandboxId);
      } catch {
        // The run is already cancelled and hidden; a container that refuses to
        // die stays visible in the board's sandbox list so it can be reaped.
      }
    }
    return terminated;
  }
}
