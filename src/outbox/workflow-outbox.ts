import type { AttemptResultSignalV1 } from '../domain/workflow-event.js';
import type { WorkflowRestartTarget } from '../domain/workflow-replay.js';
import {
  WorkflowReplayError,
  WorkflowReplayStore,
} from '../storage/workflow-replay-store.js';
import type { DeliveryRunWorkflowParams } from '../workflows/delivery-run-workflow.js';
import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type OutboxEffectOutcome,
  type FencedOutboxProcessorOptions,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
} from './fenced-outbox.js';

export interface WorkflowEffectClient {
  ensureRun(params: DeliveryRunWorkflowParams): Promise<'created' | 'existing'>;
  terminateRun(runId: string): Promise<void>;
  sendEvent(
    runId: string,
    workflowEventType: string,
    payload: AttemptResultSignalV1,
  ): Promise<void>;
  restartRun?(
    runId: string,
    target: WorkflowRestartTarget,
  ): Promise<'restarted' | 'existing'>;
  restartRunForReconciliation?(runId: string): Promise<'restarted' | 'existing'>;
}

export type { WorkflowRestartTarget } from '../domain/workflow-replay.js';

export class CloudflareWorkflowEffectClient implements WorkflowEffectClient {
  constructor(private readonly binding: Workflow<DeliveryRunWorkflowParams>) {}

  async ensureRun(params: DeliveryRunWorkflowParams): Promise<'created' | 'existing'> {
    try {
      await this.binding.create({ id: params.runId, params });
      return 'created';
    } catch (createError) {
      try {
        const instance = await this.binding.get(params.runId);
        const status = await instance.status();
        if (status.status !== 'unknown') return 'existing';
      } catch {
        // Preserve the original create failure; reconciliation itself was inconclusive.
      }
      throw createError;
    }
  }

  async sendEvent(
    runId: string,
    workflowEventType: string,
    payload: AttemptResultSignalV1,
  ): Promise<void> {
    const instance = await this.binding.get(runId);
    await instance.sendEvent({ type: workflowEventType, payload });
  }

  async terminateRun(runId: string): Promise<void> {
    const instance = await this.binding.get(runId);
    const status = await instance.status();
    if (
      status.status === 'unknown' ||
      status.status === 'terminated' ||
      status.status === 'complete'
    ) {
      return;
    }
    await instance.terminate();
  }

  async restartRun(
    runId: string,
    target: WorkflowRestartTarget,
  ): Promise<'restarted' | 'existing'> {
    const instance = await this.binding.get(runId);
    const before = await instance.status();
    if (
      before.status !== 'complete' &&
      before.status !== 'errored' &&
      before.status !== 'terminated'
    ) {
      throw new Error('Workflow instance is not in a replayable terminal state');
    }
    try {
      await instance.restart({
        from: { name: target.name, type: target.type, count: target.count },
      });
      return 'restarted';
    } catch (restartError) {
      try {
        const after = await instance.status();
        if (
          after.status === 'queued' ||
          after.status === 'running' ||
          after.status === 'waiting'
        ) {
          return 'existing';
        }
      } catch {
        // Preserve the restart error when external reconciliation is inconclusive.
      }
      throw restartError;
    }
  }

  async restartRunForReconciliation(runId: string): Promise<'restarted' | 'existing'> {
    const instance = await this.binding.get(runId);
    const before = await instance.status();
    if (
      before.status === 'queued' || before.status === 'running' ||
      before.status === 'paused' || before.status === 'waiting' ||
      before.status === 'waitingForPause'
    ) return 'existing';
    if (
      before.status !== 'complete' && before.status !== 'errored' &&
      before.status !== 'terminated'
    ) throw new Error('Workflow instance is not in a reconcilable terminal state');
    try {
      await instance.restart();
      return 'restarted';
    } catch (restartError) {
      try {
        const after = await instance.status();
        if (
          after.status === 'queued' || after.status === 'running' ||
          after.status === 'paused' || after.status === 'waiting' ||
          after.status === 'waitingForPause'
        ) return 'existing';
      } catch {
        // Preserve the restart error when status reconciliation is inconclusive.
      }
      throw restartError;
    }
  }
}

export type WorkflowOutboxDeliveryResult = OutboxDeliveryResult;

export interface WorkflowOutboxMessage {
  outboxId: string;
}

export type RelayDestination =
  | 'cloudflare_workflows'
  | 'github_actions'
  | 'github_api'
  | 'github_deployments'
  | 'github_production_deployments'
  | 'github_acceptance'
  | 'github_test_rollback'
  | 'feishu_cards';

/** Cron relay for every implemented destination; duplicate Queue messages are D1-fenced. */
export class WorkflowOutboxRelay {
  constructor(
    private readonly db: D1Database,
    private readonly queue: Queue<WorkflowOutboxMessage>,
    private readonly destinations: readonly RelayDestination[] = ['cloudflare_workflows'],
  ) {
    if (
      destinations.length === 0 ||
      new Set(destinations).size !== destinations.length
    ) {
      throw new Error('outbox relay destinations must be unique and non-empty');
    }
  }

  async relay(limit = 100, now = new Date()): Promise<number> {
    return await this.relayDestinations(this.destinations, limit, now);
  }

  async relayDestination(
    destination: RelayDestination,
    limit = 100,
    now = new Date(),
  ): Promise<number> {
    if (!this.destinations.includes(destination)) return 0;
    return await this.relayDestinations([destination], limit, now);
  }

  private async relayDestinations(
    destinations: readonly RelayDestination[],
    limit: number,
    now: Date,
  ): Promise<number> {
    const placeholders = destinations.map(() => '?').join(', ');
    const { results } = await this.db
      .prepare(
        `SELECT outbox_id
         FROM outbox
         WHERE destination IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM outbox_dead_letters
             WHERE outbox_dead_letters.outbox_id = outbox.outbox_id
               AND outbox_dead_letters.status = 'open'
           )
           AND (
             delivery_state = 'pending'
             OR (
               delivery_state = 'delivering'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?
             )
           )
         ORDER BY created_at, outbox_id
         LIMIT ?`,
      )
      .bind(...destinations, now.toISOString(), Math.max(1, Math.min(limit, 100)))
      .all<{ outbox_id: string }>();
    if (results.length === 0) return 0;
    await this.queue.sendBatch(
      results.map((row) => ({ body: { outboxId: row.outbox_id } })),
    );
    return results.length;
  }
}

type WorkflowOutboxProcessorOptions = Omit<
  FencedOutboxProcessorOptions,
  'unavailableErrorCode'
>;

interface RunCreateRow {
  run_id: string;
  task_id: string;
  task_revision: string;
  task_digest: string;
  base_sha: string | null;
}

interface SignalRow {
  signal_id: string;
  run_id: string;
  event_id: string;
  workflow_event_type: string;
  signal_type: 'attempt_completed';
  attempt_id: string;
  sequence: number;
  payload_ref: string;
  digest: string;
  occurred_at: string;
  run_state: string;
  active_plan_id: string | null;
  active_plan_digest: string | null;
  attempt_status: string | null;
  result_event_id: string | null;
  result_sequence: number | null;
  result_payload_ref: string | null;
  result_digest: string | null;
  signal_plan_id: string | null;
  signal_plan_run_id: string | null;
  signal_plan_digest: string | null;
  signal_plan_status: string | null;
  signal_plan_creator_attempt_id: string | null;
}

export class WorkflowOutboxProcessor {
  private readonly fenced: FencedOutboxProcessor;
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly effects: WorkflowEffectClient,
    options: WorkflowOutboxProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fenced = new FencedOutboxProcessor(
      db,
      'cloudflare_workflows',
      async (outbox) => await this.perform(outbox),
      { ...options, unavailableErrorCode: 'workflow_unavailable' },
    );
  }

  async deliver(outboxId: string): Promise<WorkflowOutboxDeliveryResult> {
    return await this.fenced.deliver(outboxId);
  }

  async drain(limit = 25): Promise<WorkflowOutboxDeliveryResult[]> {
    return await this.fenced.drain(limit);
  }

  /**
   * Prioritizes a new Run's root Workflow without letting older cancellation
   * or signal effects consume the scheduled invocation first. The selected
   * outbox still goes through the shared lease and effect fencing in deliver().
   */
  async drainCreates(limit = 1): Promise<WorkflowOutboxDeliveryResult[]> {
    const nowIso = this.now().toISOString();
    const { results } = await this.db.prepare(
      `SELECT outbox.outbox_id
       FROM outbox
       JOIN runs ON runs.run_id = outbox.run_id
       WHERE outbox.destination = 'cloudflare_workflows'
         AND outbox.kind = 'workflow_create'
         AND runs.state = 'queued'
         AND runs.base_sha IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM outbox_dead_letters
           WHERE outbox_dead_letters.outbox_id = outbox.outbox_id
             AND outbox_dead_letters.status = 'open'
         )
         AND (
           outbox.delivery_state = 'pending'
           OR (
             outbox.delivery_state = 'delivering'
             AND outbox.lease_expires_at IS NOT NULL
             AND outbox.lease_expires_at <= ?
           )
         )
       ORDER BY outbox.created_at, outbox.outbox_id
       LIMIT ?`,
    ).bind(nowIso, Math.max(1, Math.min(limit, 100)))
      .all<{ outbox_id: string }>();
    const deliveries: WorkflowOutboxDeliveryResult[] = [];
    for (const row of results) deliveries.push(await this.deliver(row.outbox_id));
    return deliveries;
  }

  private async perform(
    outbox: FencedOutboxRecord,
  ): Promise<OutboxEffectOutcome | void> {
    switch (outbox.kind) {
      case 'workflow_create':
        await this.createRun(outbox.runId);
        return;
      case 'workflow_signal':
        return await this.sendSignal(outbox);
      case 'workflow_cancel':
        return await this.cancelRun(outbox);
      case 'workflow_pause':
        return await this.pauseRun(outbox);
      case 'workflow_replay':
        return await this.replayRun(outbox);
      case 'workflow_reconcile_create':
      case 'workflow_reconcile_restart':
      case 'workflow_reconcile_terminate':
        return await this.repairWorkflowInstance(outbox);
      default:
        throw new OutboxEffectError('unsupported_outbox_kind');
    }
  }

  private async createRun(runId: string): Promise<void> {
    const run = await this.db
      .prepare(
        `SELECT run_id, task_id, task_revision, task_digest, base_sha
         FROM runs WHERE run_id = ?`,
      )
      .bind(runId)
      .first<RunCreateRow>();
    if (run === null) throw new OutboxEffectError('run_missing');
    if (run.base_sha === null) throw new OutboxEffectError('base_sha_unresolved');
    await this.effects.ensureRun({
      schemaVersion: '1',
      runId: run.run_id,
      taskId: run.task_id,
      taskRevision: run.task_revision,
      taskDigest: run.task_digest,
    });
  }

  private async sendSignal(
    outbox: FencedOutboxRecord,
  ): Promise<OutboxEffectOutcome | void> {
    const prefix = 'd1://workflow-signals/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('signal_ref_invalid');
    }
    const signalId = outbox.payloadRef.slice(prefix.length);
    const row = await this.db
      .prepare(
        `SELECT workflow_signals.*,
                runs.state AS run_state,
                runs.active_plan_id,
                runs.active_plan_digest,
                attempts.status AS attempt_status,
                attempts.result_event_id,
                attempts.result_sequence,
                attempts.result_payload_ref,
                attempts.result_digest,
                signal_plan.plan_id AS signal_plan_id,
                signal_plan.run_id AS signal_plan_run_id,
                signal_plan.digest AS signal_plan_digest,
                signal_plan.status AS signal_plan_status,
                signal_plan.created_by_attempt_id AS signal_plan_creator_attempt_id
         FROM workflow_signals
         JOIN runs ON runs.run_id = workflow_signals.run_id
         LEFT JOIN attempts
           ON attempts.attempt_id = workflow_signals.attempt_id
          AND attempts.run_id = workflow_signals.run_id
         LEFT JOIN execution_plans AS signal_plan
           ON workflow_signals.payload_ref = 'd1://execution-plans/' || signal_plan.plan_id
         WHERE workflow_signals.signal_id = ?
           AND workflow_signals.run_id = ?`,
      )
      .bind(signalId, outbox.runId)
      .first<SignalRow>();
    if (row === null) throw new OutboxEffectError('signal_missing');
    const settledCode = this.signalSettledCode(row);
    if (settledCode !== null) return { settledCode };
    await this.effects.sendEvent(row.run_id, row.workflow_event_type, {
      schemaVersion: '1',
      eventId: row.event_id,
      runId: row.run_id,
      type: row.signal_type,
      attemptId: row.attempt_id,
      sequence: row.sequence,
      payloadRef: row.payload_ref,
      digest: row.digest,
      occurredAt: row.occurred_at,
    });
  }

  private signalSettledCode(signal: SignalRow): string | null {
    if (signal.run_state === 'cancelled') return 'run_cancelled';
    if (signal.attempt_status === null) return 'signal_binding_invalid';
    if (signal.attempt_status === 'cancelled') return 'attempt_cancelled';
    if (signal.attempt_status === 'lost') return 'attempt_lost';

    const resultMatches =
      signal.result_event_id === signal.event_id &&
      signal.result_sequence === signal.sequence &&
      signal.result_payload_ref === signal.payload_ref &&
      signal.result_digest === signal.digest;
    const planMatches =
      signal.signal_plan_id !== null &&
      signal.signal_plan_run_id === signal.run_id &&
      signal.signal_plan_digest === signal.digest &&
      signal.signal_plan_creator_attempt_id === signal.attempt_id &&
      (signal.signal_plan_status === 'validated' || signal.signal_plan_status === 'active');
    if (
      signal.run_state === 'awaiting_approval' &&
      signal.attempt_status === 'completed' &&
      signal.active_plan_id !== null &&
      signal.payload_ref === `d1://execution-plans/${signal.active_plan_id}` &&
      signal.active_plan_digest === signal.digest &&
      resultMatches &&
      planMatches
    ) {
      return 'already_applied';
    }
    if (signal.run_state === 'blocked') return 'run_blocked';
    if (signal.run_state !== 'planning') return 'stale_run_state';
    if (signal.attempt_status !== 'running') return 'stale_attempt_state';
    return resultMatches && planMatches ? null : 'signal_binding_invalid';
  }

  private async cancelRun(
    outbox: FencedOutboxRecord,
  ): Promise<OutboxEffectOutcome | void> {
    if (outbox.payloadRef !== `d1://runs/${outbox.runId}`) {
      throw new OutboxEffectError('run_cancel_ref_invalid');
    }
    const run = await this.db
      .prepare('SELECT state FROM runs WHERE run_id = ?')
      .bind(outbox.runId)
      .first<{ state: string }>();
    if (run === null) throw new OutboxEffectError('run_missing');
    if (run.state !== 'cancelled' && run.state !== 'blocked') {
      return { settledCode: 'stale_run_state' };
    }
    await this.effects.terminateRun(outbox.runId);
  }

  private async pauseRun(
    outbox: FencedOutboxRecord,
  ): Promise<OutboxEffectOutcome | void> {
    const prefix = 'd1://protected-path-gates/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('workflow_pause_ref_invalid');
    }
    const gateId = outbox.payloadRef.slice(prefix.length);
    const gate = await this.db
      .prepare(
        `SELECT protected_path_change_gates.status AS gate_status,
                runs.state AS run_state, attempts.status AS attempt_status
         FROM protected_path_change_gates
         JOIN runs ON runs.run_id = protected_path_change_gates.run_id
         JOIN attempts ON attempts.attempt_id = protected_path_change_gates.attempt_id
         WHERE protected_path_change_gates.gate_id = ?
           AND protected_path_change_gates.run_id = ?`,
      )
      .bind(gateId, outbox.runId)
      .first<{ gate_status: string; run_state: string; attempt_status: string }>();
    if (gate === null) {
      throw new OutboxEffectError('workflow_pause_binding_invalid');
    }
    if (gate.run_state === 'cancelled') return { settledCode: 'run_cancelled' };
    if (gate.gate_status !== 'awaiting_approval') {
      return { settledCode: `protected_path_${gate.gate_status}` };
    }
    if (gate.run_state !== 'awaiting_approval' || gate.attempt_status !== 'cancelled') {
      throw new OutboxEffectError('workflow_pause_binding_invalid');
    }
    await this.effects.terminateRun(outbox.runId);
  }

  private async replayRun(
    outbox: FencedOutboxRecord,
  ): Promise<OutboxEffectOutcome | void> {
    const prefix = 'd1://workflow-replays/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('replay_ref_invalid');
    }
    const replayId = outbox.payloadRef.slice(prefix.length);
    const store = new WorkflowReplayStore(this.db);
    let decision;
    try {
      decision = await store.prepareDelivery(replayId, this.now());
    } catch (error) {
      if (error instanceof WorkflowReplayError) {
        throw new OutboxEffectError(`replay_${error.code}`);
      }
      throw error;
    }
    if (decision.kind === 'settle') {
      return { settledCode: decision.settledCode };
    }
    if (this.effects.restartRun === undefined) {
      throw new OutboxEffectError('workflow_replay_unsupported');
    }
    await this.effects.restartRun(outbox.runId, decision.target);
    try {
      await store.markRestartObserved(replayId, this.now());
    } catch (error) {
      if (error instanceof WorkflowReplayError) {
        throw new OutboxEffectError(`replay_${error.code}`);
      }
      throw error;
    }
  }

  private async repairWorkflowInstance(
    outbox: FencedOutboxRecord,
  ): Promise<OutboxEffectOutcome | void> {
    const prefix = 'd1://workflow-instance-reconciliations/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('workflow_reconciliation_ref_invalid');
    }
    const observationId = outbox.payloadRef.slice(prefix.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(observationId)) {
      throw new OutboxEffectError('workflow_reconciliation_ref_invalid');
    }
    const repair = await this.db.prepare(
      `SELECT observations.run_id, observations.run_version,
              observations.d1_state, observations.action,
              observations.status AS observation_status,
              observations.repair_outbox_id,
              runs.state AS current_run_state, runs.version AS current_run_version,
              runs.task_id, runs.task_revision, runs.task_digest, runs.base_sha
       FROM workflow_instance_reconciliation_observations AS observations
       JOIN runs ON runs.run_id = observations.run_id
       WHERE observations.observation_id = ? AND observations.run_id = ?`,
    ).bind(observationId, outbox.runId).first<{
      run_id: string;
      run_version: number;
      d1_state: string;
      action: 'restart_workflow' | 'recreate_workflow' | 'terminate_workflow';
      observation_status: 'open' | 'resolved';
      repair_outbox_id: string | null;
      current_run_state: string;
      current_run_version: number;
      task_id: string;
      task_revision: string;
      task_digest: string;
      base_sha: string | null;
    }>();
    if (repair === null || repair.repair_outbox_id !== outbox.outboxId) {
      throw new OutboxEffectError('workflow_reconciliation_binding_invalid');
    }
    const expectedKind = repair.action === 'restart_workflow'
      ? 'workflow_reconcile_restart'
      : repair.action === 'recreate_workflow'
        ? 'workflow_reconcile_create'
        : 'workflow_reconcile_terminate';
    if (outbox.kind !== expectedKind) {
      throw new OutboxEffectError('workflow_reconciliation_binding_invalid');
    }
    if (
      repair.observation_status !== 'open' ||
      repair.current_run_state !== repair.d1_state ||
      repair.current_run_version !== repair.run_version ||
      (repair.action === 'terminate_workflow'
        ? !['blocked', 'failed', 'succeeded', 'cancelled'].includes(repair.current_run_state)
        : ['blocked', 'failed', 'succeeded', 'cancelled'].includes(repair.current_run_state))
    ) return { settledCode: 'workflow_reconciliation_stale' };
    if (
      repair.base_sha === null &&
      (repair.action === 'recreate_workflow' || repair.action === 'restart_workflow')
    ) throw new OutboxEffectError('base_sha_unresolved');

    if (repair.action === 'recreate_workflow') {
      await this.effects.ensureRun({
        schemaVersion: '1',
        runId: repair.run_id,
        taskId: repair.task_id,
        taskRevision: repair.task_revision,
        taskDigest: repair.task_digest,
      });
    } else if (repair.action === 'restart_workflow') {
      if (this.effects.restartRunForReconciliation === undefined) {
        throw new OutboxEffectError('workflow_reconciliation_restart_unsupported');
      }
      await this.effects.restartRunForReconciliation(repair.run_id);
    } else {
      await this.effects.terminateRun(repair.run_id);
    }
    await this.db.prepare(
      `UPDATE workflow_instance_reconciliation_observations
       SET repair_observed_at = ?
       WHERE observation_id = ? AND status = 'open'
         AND repair_outbox_id = ? AND repair_observed_at IS NULL`,
    ).bind(this.now().toISOString(), observationId, outbox.outboxId).run();
  }
}
