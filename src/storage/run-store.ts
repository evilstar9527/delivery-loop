import type { AttemptResultSignalV1 } from '../domain/workflow-event.js';
import {
  assertRunTransition,
  type RunState,
} from '../domain/run.js';
import { verificationPlanItemStep } from '../domain/workflow-replay.js';
import type { DeliveryRunWorkflowParams } from '../workflows/delivery-run-workflow.js';
import {
  AttemptExecutionRouter,
  type AttemptExecutionRoutingOptions,
} from './attempt-execution-router.js';

export interface RunProjection {
  runId: string;
  taskId: string;
  taskRevision: string;
  taskDigest: string;
  baseSha?: string;
  workflowInstanceId: string;
  state: RunState;
  version: number;
  activePlanId?: string;
  activePlanVersion?: number;
  activePlanDigest?: string;
}

export interface AnalysisDispatch {
  attemptId: string;
  outboxId: string;
  payloadRef: string;
}

export interface TerminalVerificationStep {
  planVersion: number;
  planItemId: string;
  stepName: string;
}

interface RunRow {
  run_id: string;
  task_id: string;
  task_revision: string;
  task_digest: string;
  base_sha: string | null;
  workflow_instance_id: string;
  state: RunState;
  version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
}

interface PlanRow {
  plan_id: string;
  run_id: string;
  plan_version: number;
  digest: string;
  status: string;
  created_by_attempt_id: string;
}

export interface VerifiedAnalysisPlan {
  planId: string;
  planVersion: number;
  digest: string;
}

export class RunTransitionConflictError extends Error {
  readonly code = 'run_version_conflict' as const;

  constructor() {
    super('Run state or version changed before the transition was committed');
    this.name = 'RunTransitionConflictError';
  }
}

function toRunProjection(row: RunRow): RunProjection {
  const projection: RunProjection = {
    runId: row.run_id,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    taskDigest: row.task_digest,
    workflowInstanceId: row.workflow_instance_id,
    state: row.state,
    version: row.version,
  };
  if (row.base_sha !== null) projection.baseSha = row.base_sha;
  if (row.active_plan_id !== null) projection.activePlanId = row.active_plan_id;
  if (row.active_plan_version !== null) projection.activePlanVersion = row.active_plan_version;
  if (row.active_plan_digest !== null) projection.activePlanDigest = row.active_plan_digest;
  return projection;
}

function planIdFromRef(payloadRef: string): string {
  const prefix = 'd1://execution-plans/';
  if (!payloadRef.startsWith(prefix)) {
    throw new Error('analysis result payloadRef must reference a D1 execution plan');
  }
  const planId = payloadRef.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(planId)) {
    throw new Error('analysis result payloadRef contains an invalid plan id');
  }
  return planId;
}

/** D1 is the product/query truth; Workflow status is only orchestration diagnostics. */
export class RunStore {
  constructor(
    private readonly db: D1Database,
    private readonly executionRouting?: AttemptExecutionRoutingOptions,
  ) {}

  async getRun(runId: string): Promise<RunProjection | null> {
    const row = await this.db
      .prepare('SELECT * FROM runs WHERE run_id = ?')
      .bind(runId)
      .first<RunRow>();
    return row === null ? null : toRunProjection(row);
  }

  async recordWorkflowStepExecution(
    runId: string,
    stepName: string,
    now: string,
  ): Promise<{ runVersion: number }> {
    if (!/^[a-z][a-z0-9-]{0,127}$/.test(stepName)) {
      throw new Error('invalid stable Workflow step name');
    }
    await this.db
      .prepare(
        `INSERT INTO workflow_step_executions (
           run_id, step_name, run_version, executed_at
         )
         SELECT run_id, ?, version, ? FROM runs WHERE run_id = ?
         ON CONFLICT DO NOTHING`,
      )
      .bind(stepName, now, runId)
      .run();
    const row = await this.db
      .prepare(
        `SELECT run_version FROM workflow_step_executions
         WHERE run_id = ? AND step_name = ?
         ORDER BY run_version DESC LIMIT 1`,
      )
      .bind(runId, stepName)
      .first<{ run_version: number }>();
    if (row === null) throw new Error('Workflow step execution was not persisted');
    return { runVersion: row.run_version };
  }

  async terminalVerificationSteps(runId: string): Promise<TerminalVerificationStep[]> {
    const plan = await this.db.prepare(
      `SELECT runs.state, runs.active_plan_id AS plan_id,
              runs.active_plan_version AS plan_version,
              execution_plans.status AS plan_status,
              execution_plans.plan_version AS stored_plan_version,
              execution_plans.digest AS plan_digest
       FROM runs
       LEFT JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ?`,
    ).bind(runId).first<{
      state: RunState;
      plan_id: string | null;
      plan_version: number | null;
      plan_status: string | null;
      stored_plan_version: number | null;
      plan_digest: string | null;
    }>();
    if (plan === null) throw new Error('terminal Run is unavailable');
    if (plan.state !== 'succeeded') return [];
    const run = await this.getRun(runId);
    if (
      run === null || plan.plan_id === null || plan.plan_version === null ||
      plan.plan_version !== plan.stored_plan_version ||
      run.activePlanDigest !== plan.plan_digest ||
      (plan.plan_status !== 'active' && plan.plan_status !== 'completed')
    ) throw new Error('terminal Run has no replayable Plan');
    const planVersion = plan.plan_version;
    const { results } = await this.db.prepare(
      `SELECT DISTINCT items.item_id
       FROM plan_items AS items
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       JOIN plan_item_verifications AS verification
         ON verification.plan_id = items.plan_id
        AND verification.plan_item_id = items.item_id
        AND verification.status = 'passed'
        AND progress.version = verification.progress_version + 1
       WHERE items.plan_id = ? AND items.kind = 'verification'
         AND progress.status = 'passed'
       ORDER BY items.position, items.item_id
       LIMIT 201`,
    ).bind(plan.plan_id).all<{ item_id: string }>();
    if (results.length > 200) throw new Error('terminal verification step limit exceeded');
    return results.map((item) => ({
      planVersion,
      planItemId: item.item_id,
      stepName: verificationPlanItemStep(planVersion, item.item_id).name,
    }));
  }

  async recordTerminalVerificationStepExecution(
    runId: string,
    planVersion: number,
    planItemId: string,
    now: string,
  ): Promise<{ runVersion: number }> {
    const stepName = verificationPlanItemStep(planVersion, planItemId).name;
    await this.db.prepare(
      `INSERT INTO workflow_step_executions (
         run_id, step_name, run_version, executed_at
       )
       SELECT runs.run_id, ?, runs.version, ?
       FROM runs
       JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items
         ON items.plan_id = execution_plans.plan_id AND items.item_id = ?
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       JOIN plan_item_verifications AS verification
         ON verification.plan_id = items.plan_id
        AND verification.plan_item_id = items.item_id
        AND verification.status = 'passed'
        AND progress.version = verification.progress_version + 1
       WHERE runs.run_id = ? AND runs.state = 'succeeded'
         AND runs.active_plan_version = ?
         AND execution_plans.plan_version = ?
         AND runs.active_plan_digest = execution_plans.digest
         AND execution_plans.status IN ('active', 'completed')
         AND items.kind = 'verification' AND progress.status = 'passed'
       ON CONFLICT DO NOTHING`,
    ).bind(stepName, now, planItemId, runId, planVersion, planVersion).run();
    const row = await this.db.prepare(
      `SELECT executions.run_version
       FROM workflow_step_executions AS executions
       JOIN runs ON runs.run_id = executions.run_id
       WHERE executions.run_id = ? AND executions.step_name = ?
         AND executions.run_version = runs.version`,
    ).bind(runId, stepName).first<{ run_version: number }>();
    if (row === null) throw new Error('terminal verification step was not persisted');
    return { runVersion: row.run_version };
  }

  /** Watt-style D1 CAS: validate the edge, then require exactly one versioned row change. */
  async transition(
    runId: string,
    from: RunState,
    to: RunState,
    expectedVersion: number,
    now: string,
  ): Promise<RunProjection> {
    assertRunTransition(from, to);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new RunTransitionConflictError();
    }
    const result = await this.db
      .prepare(
        `UPDATE runs
         SET state = ?, version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = ? AND version = ?`,
      )
      .bind(to, now, runId, from, expectedVersion)
      .run();
    if (result.meta.changes !== 1) throw new RunTransitionConflictError();

    const run = await this.getRun(runId);
    if (run === null || run.state !== to || run.version !== expectedVersion + 1) {
      throw new RunTransitionConflictError();
    }
    return run;
  }

  /** Idempotently records that this exact Workflow instance owns the queued Run. */
  async registerWorkflow(
    params: DeliveryRunWorkflowParams,
    now: string,
  ): Promise<RunProjection> {
    await this.db
      .prepare(
        `UPDATE runs
         SET state = 'planning', version = version + 1, updated_at = ?
         WHERE run_id = ?
           AND task_id = ?
           AND task_revision = ?
           AND task_digest = ?
           AND workflow_instance_id = ?
           AND state = 'queued'
           AND version = 0`,
      )
      .bind(
        now,
        params.runId,
        params.taskId,
        params.taskRevision,
        params.taskDigest,
        params.runId,
      )
      .run();

    const run = await this.getRun(params.runId);
    if (
      run === null ||
      run.taskId !== params.taskId ||
      run.taskRevision !== params.taskRevision ||
      run.taskDigest !== params.taskDigest ||
      run.workflowInstanceId !== params.runId
    ) {
      throw new Error(`workflow params do not match persisted run ${params.runId}`);
    }
    return run;
  }

  /**
   * D1 batch is the transaction boundary for the attempt and dispatch intent.
   * Stable primary/dedupe keys make both Workflow retry and controlled restart safe.
   */
  async ensureAnalysisDispatch(
    runId: string,
    attemptId: string,
    now: string,
  ): Promise<AnalysisDispatch> {
    const run = await this.getRun(runId);
    if (run === null || run.state !== 'planning' || run.baseSha === undefined) {
      throw new Error(`run ${runId} is not available for analysis dispatch`);
    }
    const existing = await this.db.prepare(
      `SELECT attempts.attempt_id, outbox.outbox_id, outbox.payload_ref
       FROM attempts
       JOIN outbox ON outbox.run_id = attempts.run_id
       WHERE attempts.attempt_id = ? AND attempts.run_id = ?
         AND attempts.mode = 'analysis' AND attempts.status = 'pending'
         AND (
           (outbox.kind = 'agent_execution_start'
             AND outbox.destination = 'agent_executor'
             AND outbox.dedupe_key = 'agent-executor:execution-work-' || attempts.attempt_id)
           OR
           (outbox.kind = 'analysis_dispatch'
             AND outbox.destination = 'github_actions'
             AND outbox.dedupe_key = 'analysis-dispatch:' || attempts.run_id || ':1')
         )`,
    ).bind(attemptId, runId).first<{
      attempt_id: string;
      outbox_id: string;
      payload_ref: string;
    }>();
    if (existing !== null) {
      return {
        attemptId: existing.attempt_id,
        outboxId: existing.outbox_id,
        payloadRef: existing.payload_ref,
      };
    }
    if (this.executionRouting === undefined) {
      throw new Error('executor routing is not configured');
    }
    const target = await this.db
      .prepare(
        `SELECT tasks.target_repository, tasks.target_base_branch, runs.task_digest
         FROM runs JOIN tasks ON tasks.task_id = runs.task_id
         WHERE runs.run_id = ?`,
      )
      .bind(runId)
      .first<{
        target_repository: string;
        target_base_branch: string;
        task_digest: string;
      }>();
    if (target === null) throw new Error(`run ${runId} target is unavailable`);
    const router = new AttemptExecutionRouter(this.db, this.executionRouting);
    const routed = await router.route({
      runId,
      attemptId,
      mode: 'analysis',
      taskDigest: target.task_digest,
      repository: target.target_repository,
      baseSha: run.baseSha,
      checkoutSha: run.baseSha,
      targetBaseBranch: target.target_base_branch,
    });
    const persistence = router.persistenceStatements(routed, now);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO attempts (
             attempt_id, run_id, ordinal, mode, status, base_sha, repository, workflow_ref,
             executor_profile_id, executor_route_version,
             lease_generation, created_at, updated_at
           )
           SELECT ?, ?, 1, 'analysis', 'pending', ?, ?, ?, ?, ?, 0, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM executor_routes
             WHERE route_id = ? AND profile_id = ? AND route_version = ?
               AND repository = ? AND attempt_mode = 'analysis'
               AND execution_role = 'work' AND status = 'active'
           )
           ON CONFLICT(attempt_id) DO NOTHING`,
        )
        .bind(
          attemptId,
          runId,
          run.baseSha,
          target.target_repository,
          routed.attemptWorkflowRef,
          routed.profileId,
          routed.routeVersion,
          now,
          now,
          routed.routeId,
          routed.profileId,
          routed.routeVersion,
          target.target_repository,
        ),
      ...persistence,
    ]);

    const row = await this.db
      .prepare(
        `SELECT outbox.outbox_id, outbox.payload_ref
         FROM outbox
         JOIN attempt_execution_instances AS executions
           ON executions.outbox_id = outbox.outbox_id
         WHERE outbox.dedupe_key = ? AND outbox.run_id = ?
           AND executions.execution_id = ? AND executions.attempt_id = ?`,
      )
      .bind(`agent-executor:${routed.executionId}`, runId, routed.executionId, attemptId)
      .first<{ outbox_id: string; payload_ref: string }>();
    if (row === null) throw new Error(`analysis dispatch was not persisted for ${runId}`);
    return { attemptId, outboxId: row.outbox_id, payloadRef: row.payload_ref };
  }

  /** Validates a reference-only signal, then activates the immutable plan already in D1. */
  async verifyAnalysisPlan(
    signal: AttemptResultSignalV1,
  ): Promise<VerifiedAnalysisPlan> {
    const planId = planIdFromRef(signal.payloadRef);
    const plan = await this.db
      .prepare(
        `SELECT plan_id, run_id, plan_version, digest, status, created_by_attempt_id
         FROM execution_plans
         WHERE plan_id = ? AND run_id = ?`,
      )
      .bind(planId, signal.runId)
      .first<PlanRow>();
    if (
      plan === null ||
      plan.created_by_attempt_id !== signal.attemptId ||
      plan.digest !== signal.digest ||
      (plan.status !== 'validated' && plan.status !== 'active')
    ) {
      throw new Error('analysis result does not match a proposed execution plan');
    }
    return {
      planId: plan.plan_id,
      planVersion: plan.plan_version,
      digest: plan.digest,
    };
  }

  /** Validates a reference-only signal, then activates the immutable plan already in D1. */
  async activateAnalysisPlan(
    signal: AttemptResultSignalV1,
    now: string,
  ): Promise<RunProjection> {
    const verified = await this.verifyAnalysisPlan(signal);
    const plan = await this.db
      .prepare(
        `SELECT plan_id, run_id, plan_version, digest, status, created_by_attempt_id
         FROM execution_plans WHERE plan_id = ? AND run_id = ?`,
      )
      .bind(verified.planId, signal.runId)
      .first<PlanRow>();
    if (plan === null) throw new Error('verified analysis plan disappeared');

    const before = await this.getRun(signal.runId);
    if (before === null) throw new Error(`run ${signal.runId} does not exist`);
    if (
      before.state === 'awaiting_approval' &&
      before.activePlanId === plan.plan_id &&
      before.activePlanVersion === plan.plan_version &&
      before.activePlanDigest === plan.digest
    ) {
      return before;
    }
    if (before.state !== 'planning' || before.activePlanId !== undefined) {
      throw new RunTransitionConflictError();
    }

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE runs
           SET state = 'awaiting_approval',
               active_plan_id = ?,
               active_plan_version = ?,
               active_plan_digest = ?,
               version = version + 1,
               updated_at = ?
           WHERE run_id = ?
             AND state = 'planning'
             AND version = ?
             AND active_plan_id IS NULL`,
        )
        .bind(
          plan.plan_id,
          plan.plan_version,
          plan.digest,
          now,
          signal.runId,
          before.version,
        ),
      this.db
        .prepare(
          `UPDATE execution_plans
           SET status = 'active', updated_at = ?
           WHERE plan_id = ?
             AND status = 'validated'
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE run_id = ?
                 AND state = 'awaiting_approval'
                 AND active_plan_id = ?
                 AND active_plan_version = ?
                 AND active_plan_digest = ?
             )`,
        )
        .bind(
          now,
          plan.plan_id,
          signal.runId,
          plan.plan_id,
          plan.plan_version,
          plan.digest,
        ),
      this.db
        .prepare(
          `UPDATE attempts
           SET status = 'completed', updated_at = ?
           WHERE attempt_id = ?
             AND run_id = ?
             AND status IN ('pending', 'running')
             AND EXISTS (
               SELECT 1 FROM runs
               WHERE run_id = ?
                 AND state = 'awaiting_approval'
                 AND active_plan_id = ?
                 AND active_plan_version = ?
                 AND active_plan_digest = ?
             )`,
        )
        .bind(
          now,
          signal.attemptId,
          signal.runId,
          signal.runId,
          plan.plan_id,
          plan.plan_version,
          plan.digest,
        )
    ]);

    const run = await this.getRun(signal.runId);
    if (
      run === null ||
      run.state !== 'awaiting_approval' ||
      run.activePlanId !== plan.plan_id ||
      run.activePlanVersion !== plan.plan_version ||
      run.activePlanDigest !== plan.digest
    ) {
      throw new Error(`run ${signal.runId} did not activate the referenced plan`);
    }
    return run;
  }
}
