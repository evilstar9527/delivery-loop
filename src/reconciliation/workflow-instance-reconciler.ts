import { canonicalSha256 } from '../domain/digest.js';
import { expectsActiveWorkflow, type RunState } from '../domain/run.js';
import type { Bindings } from '../env.js';
import type { DeliveryRunWorkflowParams } from '../workflows/delivery-run-workflow.js';

export const WORKFLOW_INSTANCE_PLATFORM_STATUSES = [
  'queued',
  'running',
  'paused',
  'errored',
  'terminated',
  'complete',
  'waiting',
  'waitingForPause',
  'unknown',
] as const;

export type WorkflowInstancePlatformStatus =
  (typeof WORKFLOW_INSTANCE_PLATFORM_STATUSES)[number];

export interface WorkflowInstanceStatusFact {
  status: WorkflowInstancePlatformStatus;
}

export interface WorkflowInstanceFactClient {
  getWorkflowStatus(runId: string): Promise<WorkflowInstanceStatusFact>;
}

export type WorkflowInstanceReconciliationDisposition =
  | 'consistent'
  | 'controlled_replay_pending'
  | 'restart_requested'
  | 'recreate_requested'
  | 'terminate_requested'
  | 'duplicate'
  | 'not_found';

export interface WorkflowInstanceBatchResult {
  runId: string;
  disposition: Exclude<WorkflowInstanceReconciliationDisposition, 'not_found'> | 'unavailable';
}

type ReconciliationAction =
  | 'restart_workflow'
  | 'recreate_workflow'
  | 'terminate_workflow';

interface RunRow {
  run_id: string;
  workflow_instance_id: string;
  state: RunState;
  version: number;
}

interface ObservationRow {
  observation_id: string;
  status: 'open' | 'resolved';
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ACTIVE_PLATFORM_STATUSES = new Set<WorkflowInstancePlatformStatus>([
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingForPause',
]);
const TERMINAL_PLATFORM_STATUSES = new Set<WorkflowInstancePlatformStatus>([
  'errored',
  'terminated',
  'complete',
]);
export { expectsActiveWorkflow } from '../domain/run.js';

function isPlatformActive(status: WorkflowInstancePlatformStatus): boolean {
  return ACTIVE_PLATFORM_STATUSES.has(status);
}

function actionFor(
  runState: RunState,
  platformStatus: WorkflowInstancePlatformStatus,
): ReconciliationAction | null {
  const expectedActive = expectsActiveWorkflow(runState);
  if (expectedActive && platformStatus === 'unknown') return 'recreate_workflow';
  if (expectedActive && TERMINAL_PLATFORM_STATUSES.has(platformStatus)) {
    return 'restart_workflow';
  }
  if (!expectedActive && isPlatformActive(platformStatus)) return 'terminate_workflow';
  return null;
}

function dispositionFor(action: ReconciliationAction): WorkflowInstanceReconciliationDisposition {
  if (action === 'restart_workflow') return 'restart_requested';
  if (action === 'recreate_workflow') return 'recreate_requested';
  return 'terminate_requested';
}

function outboxKind(action: ReconciliationAction): string {
  if (action === 'restart_workflow') return 'workflow_reconcile_restart';
  if (action === 'recreate_workflow') return 'workflow_reconcile_create';
  return 'workflow_reconcile_terminate';
}

/** Worker-binding adapter; raw platform error/output never leaves this boundary. */
export class CloudflareWorkflowStatusClient implements WorkflowInstanceFactClient {
  constructor(private readonly binding: Workflow<DeliveryRunWorkflowParams>) {}

  async getWorkflowStatus(runId: string): Promise<WorkflowInstanceStatusFact> {
    if (!ID_PATTERN.test(runId)) throw new Error('Workflow instance ID is invalid');
    try {
      const instance = await this.binding.get(runId);
      const result = await instance.status();
      if (!(WORKFLOW_INSTANCE_PLATFORM_STATUSES as readonly string[]).includes(result.status)) {
        return { status: 'unknown' };
      }
      return { status: result.status };
    } catch {
      return { status: 'unknown' };
    }
  }
}

/** Reconciles orchestration liveness without treating Workflow as business truth. */
export class WorkflowInstanceReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly client: WorkflowInstanceFactClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileRun(runId: string): Promise<WorkflowInstanceReconciliationDisposition> {
    if (!ID_PATTERN.test(runId)) return 'not_found';
    const run = await this.run(runId);
    if (run === null || run.workflow_instance_id !== run.run_id) return 'not_found';
    const observedAt = this.now().toISOString();
    const fact = await this.client.getWorkflowStatus(run.workflow_instance_id);
    const factDigest = await canonicalSha256({
      workflowInstanceId: run.workflow_instance_id,
      status: fact.status,
    });
    await this.recordScan(run, fact.status, factDigest, observedAt);
    await this.resolveAdvanced(run, observedAt);
    const action = actionFor(run.state, fact.status);
    if (action === null) {
      await this.resolveOpen(run, fact.status, observedAt);
      return 'consistent';
    }
    if (
      (action === 'restart_workflow' || action === 'recreate_workflow') &&
      await this.controlledReplayPending(run.run_id)
    ) {
      return 'controlled_replay_pending';
    }
    const identity = await canonicalSha256({
      runId: run.run_id,
      runVersion: run.version,
      d1State: run.state,
      platformStatus: fact.status,
      action,
      factDigest,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 48);
    const observationId = `workflow_reconciliation_${suffix}`;
    const existing = await this.observation(observationId);
    if (existing !== null) return 'duplicate';
    const repairOutboxId = `outbox_workflow_reconciliation_${suffix}`;
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO workflow_instance_reconciliation_observations (
           observation_id, run_id, run_version, d1_state, platform_status,
           fact_digest, action, status, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        observationId,
        run.run_id,
        run.version,
        run.state,
        fact.status,
        factDigest,
        action,
        observedAt,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) SELECT ?, run_id, ?, 'cloudflare_workflows',
                  'd1://workflow-instance-reconciliations/' || observation_id,
                  ?, 'pending', ?, ?
           FROM workflow_instance_reconciliation_observations
          WHERE observation_id = ?
         ON CONFLICT(dedupe_key) DO NOTHING`,
      ).bind(
        repairOutboxId,
        outboxKind(action),
        `workflow-reconciliation:${observationId}`,
        observedAt,
        observedAt,
        observationId,
      ),
      this.db.prepare(
        `UPDATE workflow_instance_reconciliation_observations
         SET repair_outbox_id = ?
         WHERE observation_id = ? AND repair_outbox_id IS NULL`,
      ).bind(repairOutboxId, observationId),
    ]);
    if (results[0]?.meta.changes !== 1) return 'duplicate';
    const persisted = await this.observation(observationId);
    if (persisted === null) throw new Error('Workflow reconciliation was not persisted');
    return dispositionFor(action);
  }

  async reconcileBatch(limit = 25): Promise<WorkflowInstanceBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Workflow instance reconciliation limit is invalid');
    }
    const candidates = await this.db.prepare(
      `SELECT runs.run_id
       FROM runs
       LEFT JOIN workflow_instance_reconciliation_state AS state
         ON state.run_id = runs.run_id
       ORDER BY COALESCE(state.checked_at, ''), runs.updated_at, runs.run_id
       LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: WorkflowInstanceBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        const disposition = await this.reconcileRun(candidate.run_id);
        if (disposition !== 'not_found') {
          results.push({ runId: candidate.run_id, disposition });
        }
      } catch {
        results.push({ runId: candidate.run_id, disposition: 'unavailable' });
      }
    }
    return results;
  }

  private async recordScan(
    run: RunRow,
    platformStatus: WorkflowInstancePlatformStatus,
    factDigest: string,
    checkedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `INSERT INTO workflow_instance_reconciliation_state (
         run_id, run_version, d1_state, platform_status,
         fact_digest, checked_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         run_version = excluded.run_version,
         d1_state = excluded.d1_state,
         platform_status = excluded.platform_status,
         fact_digest = excluded.fact_digest,
         checked_at = excluded.checked_at,
         updated_at = excluded.updated_at`,
    ).bind(
      run.run_id,
      run.version,
      run.state,
      platformStatus,
      factDigest,
      checkedAt,
      checkedAt,
    ).run();
  }

  private async resolveOpen(
    run: RunRow,
    platformStatus: WorkflowInstancePlatformStatus,
    resolvedAt: string,
  ): Promise<void> {
    const resolution = expectsActiveWorkflow(run.state) && isPlatformActive(platformStatus)
      ? 'workflow_active'
      : 'workflow_inactive';
    await this.db.prepare(
      `UPDATE workflow_instance_reconciliation_observations
       SET status = 'resolved', resolved_at = ?, resolution_code = ?
       WHERE run_id = ? AND status = 'open'`,
    ).bind(resolvedAt, resolution, run.run_id).run();
  }

  private async resolveAdvanced(run: RunRow, resolvedAt: string): Promise<void> {
    await this.db.prepare(
      `UPDATE workflow_instance_reconciliation_observations
       SET status = 'resolved', resolved_at = ?, resolution_code = 'run_advanced'
       WHERE run_id = ? AND status = 'open' AND run_version <> ?`,
    ).bind(resolvedAt, run.run_id, run.version).run();
  }

  private async controlledReplayPending(runId: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS present FROM outbox
       WHERE run_id = ? AND kind = 'workflow_replay'
         AND delivery_state IN ('pending', 'delivering') LIMIT 1`,
    ).bind(runId).first<{ present: number }>();
    return row !== null;
  }

  private async run(runId: string): Promise<RunRow | null> {
    return await this.db.prepare(
      `SELECT run_id, workflow_instance_id, state, version
       FROM runs WHERE run_id = ?`,
    ).bind(runId).first<RunRow>();
  }

  private async observation(observationId: string): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT observation_id, status
       FROM workflow_instance_reconciliation_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
  }
}

export async function reconcileWorkflowInstancesFromEnv(
  env: Bindings,
): Promise<WorkflowInstanceBatchResult[]> {
  return await new WorkflowInstanceReconciler(
    env.DB_CONTROL,
    new CloudflareWorkflowStatusClient(env.DELIVERY_RUN),
  ).reconcileBatch(25);
}
