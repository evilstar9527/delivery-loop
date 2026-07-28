/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskEnvelope } from '../../src/domain/task.js';
import {
  TaskIntakeStore,
  TaskRevisionConflictError,
} from '../../src/storage/task-intake-store.js';

const BASE_SHA = 'b'.repeat(40);
const NOW = '2026-07-25T04:00:00.000Z';

function taskRevision(args: {
  taskKey: string;
  revision: string;
  event: number;
  description?: string;
}): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: `event-${args.taskKey}-${args.event}`,
    occurredAt: `2026-07-25T04:00:${String(args.event).padStart(2, '0')}.000Z`,
    source: {
      system: 'manual',
      tenantKey: 'tenant-intake-test',
      taskKey: args.taskKey,
      revision: args.revision,
      url: `https://tasks.example.test/${args.taskKey}`,
    },
    actor: { type: 'user', id: 'user-intake-test' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Prevent duplicate delivery',
      description: args.description ?? 'The same source revision must create one delivery run.',
      acceptanceCriteria: ['Only one business run exists for the source revision.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: false,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

async function count(sql: string, ...bindings: string[]): Promise<number> {
  const row = await env.DB_CONTROL.prepare(sql)
    .bind(...bindings)
    .first<{ count: number }>();
  if (row === null) throw new Error('count query returned no row');
  return row.count;
}

function intakeInput(task: TaskEnvelope): {
  task: TaskEnvelope;
  baseSha: string;
  payloadRef: string;
  now: string;
} {
  return {
    task,
    baseSha: BASE_SHA,
    payloadRef: `r2://tasks/${task.source.taskKey}/${task.source.revision}`,
    now: NOW,
  };
}

describe('control-plane migration and transactional Task intake', () => {
  it('applies the migration to an empty D1 database and safely reapplies it', async () => {
    await applyD1Migrations(env.DB_CONTROL, env.TEST_MIGRATIONS);
    await applyD1Migrations(env.DB_CONTROL, env.TEST_MIGRATIONS);

    const requiredTables = await env.DB_CONTROL.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name IN ('tasks', 'runs', 'outbox')
       ORDER BY name`,
    ).all<{ name: string }>();
    expect(requiredTables.results.map((row) => row.name)).toEqual(['outbox', 'runs', 'tasks']);
    expect(await count('SELECT COUNT(*) AS count FROM d1_migrations')).toBe(
      env.TEST_MIGRATIONS.length,
    );
  });

  it('converges 20 concurrent deliveries of one revision to one Task, Run, and outbox', async () => {
    const store = new TaskIntakeStore(env.DB_CONTROL);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, event) =>
        store.acceptTaskRevision(
          intakeInput(taskRevision({ taskKey: 'concurrent', revision: '7', event })),
        ),
      ),
    );
    const first = results[0];
    if (first === undefined) throw new Error('missing intake result');

    expect(new Set(results.map((result) => result.taskId))).toEqual(new Set([first.taskId]));
    expect(new Set(results.map((result) => result.runId))).toEqual(new Set([first.runId]));
    expect(new Set(results.map((result) => result.outboxId))).toEqual(
      new Set([first.outboxId]),
    );
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE source_system = 'manual' AND tenant_key = ?
           AND source_task_key = ? AND task_revision = ?`,
        'tenant-intake-test',
        'concurrent',
        '7',
      ),
    ).toBe(1);

    // Primary-key determinism is not the proof: a different task_id still hits source-revision UNIQUE.
    await expect(
      env.DB_CONTROL.prepare(
        `INSERT INTO tasks
         SELECT ?, source_system, tenant_key, source_task_key, task_revision, source_url,
                task_digest, payload_ref, actor_type, actor_id, target_repository,
                target_base_branch, target_environment, intent_kind, title, priority,
                acceptance_criteria_count, allow_repository_write, allow_test_deploy,
                allow_production_deploy, require_human_approval, created_at, updated_at
         FROM tasks WHERE task_id = ?`,
      )
        .bind('task_forced_duplicate_revision', first.taskId)
        .run(),
    ).rejects.toThrow();
    expect(await count('SELECT COUNT(*) AS count FROM runs WHERE task_id = ?', first.taskId)).toBe(
      1,
    );
    expect(await count('SELECT COUNT(*) AS count FROM outbox WHERE run_id = ?', first.runId)).toBe(
      1,
    );

    const run = await env.DB_CONTROL.prepare(
      `SELECT run_id, workflow_instance_id, state, version
       FROM runs WHERE run_id = ?`,
    )
      .bind(first.runId)
      .first<{
        run_id: string;
        workflow_instance_id: string;
        state: string;
        version: number;
      }>();
    expect(run).toEqual({
      run_id: first.runId,
      workflow_instance_id: first.runId,
      state: 'queued',
      version: 0,
    });
    const outbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id, kind, destination, payload_ref, delivery_state
       FROM outbox WHERE outbox_id = ?`,
    )
      .bind(first.outboxId)
      .first<{
        outbox_id: string;
        kind: string;
        destination: string;
        payload_ref: string;
        delivery_state: string;
      }>();
    expect(outbox).toEqual({
      outbox_id: first.outboxId,
      kind: 'workflow_create',
      destination: 'cloudflare_workflows',
      payload_ref: `d1://runs/${first.runId}`,
      delivery_state: 'pending',
    });

    const nextRevision = await store.acceptTaskRevision(
      intakeInput(taskRevision({ taskKey: 'concurrent', revision: '8', event: 20 })),
    );
    expect(nextRevision.taskId).not.toBe(first.taskId);
    expect(nextRevision.runId).not.toBe(first.runId);
  });

  it('rejects a silent body rewrite under an existing source revision', async () => {
    const store = new TaskIntakeStore(env.DB_CONTROL);
    const original = taskRevision({ taskKey: 'immutable', revision: '3', event: 1 });
    const accepted = await store.acceptTaskRevision(intakeInput(original));

    const changed = taskRevision({
      taskKey: 'immutable',
      revision: '3',
      event: 2,
      description: 'This is different content without a source revision change.',
    });
    await expect(store.acceptTaskRevision(intakeInput(changed))).rejects.toMatchObject({
      name: TaskRevisionConflictError.name,
      code: 'revision_conflict',
    });
    expect(await count('SELECT COUNT(*) AS count FROM runs WHERE task_id = ?', accepted.taskId)).toBe(
      1,
    );
  });

  it('rolls back Task and Run when the workflow-create outbox insert fails', async () => {
    await env.DB_CONTROL.prepare(
      `CREATE TRIGGER force_workflow_create_failure
       BEFORE INSERT ON outbox
       WHEN NEW.kind = 'workflow_create'
       BEGIN
         SELECT RAISE(ABORT, 'forced workflow outbox failure');
       END`,
    ).run();
    const store = new TaskIntakeStore(env.DB_CONTROL);
    const input = intakeInput(taskRevision({ taskKey: 'atomic-rollback', revision: '1', event: 1 }));

    try {
      await expect(
        store.acceptIdempotentTaskRevision(input, {
          scope: 'POST /v1/tasks',
          keyDigest: `sha256:${'3'.repeat(64)}`,
          requestDigest: `sha256:${'4'.repeat(64)}`,
        }),
      ).rejects.toThrow();
    } finally {
      await env.DB_CONTROL.prepare('DROP TRIGGER force_workflow_create_failure').run();
    }

    expect(
      await count(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE tenant_key = ? AND source_task_key = ? AND task_revision = ?`,
        'tenant-intake-test',
        'atomic-rollback',
        '1',
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS count
         FROM runs JOIN tasks ON tasks.task_id = runs.task_id
         WHERE tasks.tenant_key = ? AND tasks.source_task_key = ? AND tasks.task_revision = ?`,
        'tenant-intake-test',
        'atomic-rollback',
        '1',
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS count
         FROM outbox
         JOIN runs ON runs.run_id = outbox.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         WHERE tasks.tenant_key = ? AND tasks.source_task_key = ? AND tasks.task_revision = ?`,
        'tenant-intake-test',
        'atomic-rollback',
        '1',
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM idempotency_keys
         WHERE scope = ? AND key_digest = ?`,
        'POST /v1/tasks',
        `sha256:${'3'.repeat(64)}`,
      ),
    ).toBe(0);
  });
});
