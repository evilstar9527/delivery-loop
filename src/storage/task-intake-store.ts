import { z } from 'zod';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
  type TaskEnvelope,
} from '../domain/task.js';

const TaskIntakeInputSchema = z
  .object({
    task: TaskEnvelopeSchema,
    baseSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    payloadRef: z.string().min(1).max(500).regex(/^r2:\/\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/),
    now: z.iso.datetime({ offset: true }),
  })
  .strict();

export interface TaskIntakeInput {
  task: TaskEnvelope;
  baseSha?: string;
  payloadRef: string;
  now: string;
}

const TaskIdempotencyInputSchema = z
  .object({
    scope: z.string().min(1).max(100),
    keyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export interface TaskIdempotencyInput {
  scope: string;
  keyDigest: string;
  requestDigest: string;
}

export interface TaskIntakeResult {
  taskId: string;
  runId: string;
  outboxId: string;
  taskDigest: string;
  baseSha?: string;
  runState: string;
  outboxState: string;
}

export class TaskRevisionConflictError extends Error {
  readonly code = 'revision_conflict' as const;

  constructor() {
    super('source task revision already exists with different immutable content');
    this.name = 'TaskRevisionConflictError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict' as const;

  constructor() {
    super('Idempotency-Key was already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class TaskIntakePersistenceError extends Error {
  constructor(readonly code: 'identity_collision' | 'incomplete_projection') {
    super(`Task intake persistence failed: ${code}`);
    this.name = 'TaskIntakePersistenceError';
  }
}

interface IntakeProjectionRow {
  task_id: string;
  task_digest: string;
  run_id: string;
  base_sha: string | null;
  run_state: string;
  outbox_id: string;
  outbox_state: string;
}

interface IdempotencyRow {
  request_digest: string;
  task_id: string;
  run_id: string;
  outbox_id: string;
}

/** D1 adapter for the single atomic Task revision → Run → workflow-create intent boundary. */
export class TaskIntakeStore {
  constructor(private readonly db: D1Database) {}

  async acceptTaskRevision(input: TaskIntakeInput): Promise<TaskIntakeResult> {
    return await this.accept(input);
  }

  async acceptIdempotentTaskRevision(
    input: TaskIntakeInput,
    idempotency: TaskIdempotencyInput,
  ): Promise<TaskIntakeResult> {
    return await this.accept(input, TaskIdempotencyInputSchema.parse(idempotency));
  }

  private async accept(
    input: TaskIntakeInput,
    idempotency?: TaskIdempotencyInput,
  ): Promise<TaskIntakeResult> {
    const parsed = TaskIntakeInputSchema.parse(input);
    const { task, baseSha, payloadRef, now } = parsed;
    const ids = await taskRevisionIds(task);
    const digest = await taskRevisionDigest(task);
    const repository = `${task.target.owner}/${task.target.repo}`;

    const guardSql =
      idempotency === undefined
        ? ''
        : `AND EXISTS (
             SELECT 1 FROM idempotency_keys
             WHERE scope = ? AND key_digest = ? AND request_digest = ?
           )`;
    const guardBindings =
      idempotency === undefined
        ? []
        : [idempotency.scope, idempotency.keyDigest, idempotency.requestDigest];
    const statements: D1PreparedStatement[] = [];
    if (idempotency !== undefined) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO idempotency_keys (
               scope, key_digest, request_digest, task_id, run_id, outbox_id,
               response_status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 202, ?, ?)
             ON CONFLICT(scope, key_digest) DO NOTHING`,
          )
          .bind(
            idempotency.scope,
            idempotency.keyDigest,
            idempotency.requestDigest,
            ids.taskId,
            ids.runId,
            ids.workflowCreateOutboxId,
            now,
            now,
          ),
      );
    }

    statements.push(
      this.db
        .prepare(
          `INSERT INTO tasks (
             task_id, source_system, tenant_key, source_task_key, task_revision, source_url,
             task_digest, payload_ref, actor_type, actor_id, target_repository,
             target_base_branch, target_environment, intent_kind, title, priority,
             acceptance_criteria_count, allow_repository_write, allow_test_deploy,
             allow_production_deploy, require_human_approval, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE 1 = 1 ${guardSql}
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          ids.taskId,
          task.source.system,
          task.source.tenantKey,
          task.source.taskKey,
          task.source.revision,
          task.source.url ?? null,
          digest,
          payloadRef,
          task.actor.type,
          task.actor.id,
          repository,
          task.target.baseBranch,
          task.target.environment,
          task.intent.kind,
          task.intent.title,
          task.intent.priority,
          task.intent.acceptanceCriteria.length,
          task.policy.allowRepositoryWrite ? 1 : 0,
          task.policy.allowTestDeploy ? 1 : 0,
          task.policy.allowProductionDeploy ? 1 : 0,
          task.policy.requireHumanApproval ? 1 : 0,
          now,
          now,
          ...guardBindings,
        ),
      this.db
        .prepare(
          `INSERT INTO runs (
             run_id, task_id, task_revision, task_digest, base_sha, workflow_instance_id,
             state, version, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?
           WHERE 1 = 1 ${guardSql}
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          ids.runId,
          ids.taskId,
          task.source.revision,
          digest,
          baseSha ?? null,
          ids.runId,
          now,
          now,
          ...guardBindings,
        ),
      this.db
        .prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, ?, 'workflow_create', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
           WHERE 1 = 1 ${guardSql}
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          ids.workflowCreateOutboxId,
          ids.runId,
          `d1://runs/${ids.runId}`,
          `workflow-create:${ids.runId}`,
          now,
          now,
          ...guardBindings,
        ),
    );

    // Cloudflare D1 batch is transactional: reservation, Task, Run, and outbox share a commit.
    await this.db.batch(statements);

    if (idempotency !== undefined) {
      const reservation = await this.db
        .prepare(
          `SELECT request_digest, task_id, run_id, outbox_id
           FROM idempotency_keys
           WHERE scope = ? AND key_digest = ?`,
        )
        .bind(idempotency.scope, idempotency.keyDigest)
        .first<IdempotencyRow>();
      if (reservation === null) {
        throw new TaskIntakePersistenceError('incomplete_projection');
      }
      if (
        reservation.request_digest !== idempotency.requestDigest ||
        reservation.task_id !== ids.taskId ||
        reservation.run_id !== ids.runId ||
        reservation.outbox_id !== ids.workflowCreateOutboxId
      ) {
        throw new IdempotencyConflictError();
      }
    }

    const row = await this.db
      .prepare(
        `SELECT
           tasks.task_id,
           tasks.task_digest,
           runs.run_id,
           runs.base_sha,
           runs.state AS run_state,
           outbox.outbox_id,
           outbox.delivery_state AS outbox_state
         FROM tasks
         JOIN runs ON runs.task_id = tasks.task_id
         JOIN outbox ON outbox.run_id = runs.run_id AND outbox.kind = 'workflow_create'
         WHERE tasks.source_system = ?
           AND tasks.tenant_key = ?
           AND tasks.source_task_key = ?
           AND tasks.task_revision = ?`,
      )
      .bind(
        task.source.system,
        task.source.tenantKey,
        task.source.taskKey,
        task.source.revision,
      )
      .first<IntakeProjectionRow>();
    if (row === null) throw new TaskIntakePersistenceError('identity_collision');
    if (
      row.task_id !== ids.taskId ||
      row.run_id !== ids.runId ||
      row.outbox_id !== ids.workflowCreateOutboxId
    ) {
      throw new TaskIntakePersistenceError('incomplete_projection');
    }
    if (row.task_digest !== digest) throw new TaskRevisionConflictError();

    const result: TaskIntakeResult = {
      taskId: row.task_id,
      runId: row.run_id,
      outboxId: row.outbox_id,
      taskDigest: row.task_digest,
      runState: row.run_state,
      outboxState: row.outbox_state,
    };
    if (row.base_sha !== null) result.baseSha = row.base_sha;
    return result;
  }
}
