/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CorrelationLogger,
  type CorrelationLogRecord,
} from '../../src/observability/correlation-log.js';
import { CorrelationQueryStore } from '../../src/storage/correlation-query-store.js';

const TOKEN = 'test-task-intake-token';
const TASK_ID = 'task-correlation-query';
const RUN_ID = 'run-correlation-query';
const ATTEMPT_ID = 'attempt-correlation-query';
const TRACE_ID = 'tooltrace_correlation_query';
const GITHUB_RUN_ID = '987654321';
const NOW = '2026-07-26T08:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(40);

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM tool_call_traces'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seed(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'correlation', ?, 'revision-1', ?,
                 'r2://tasks/correlation-query', 'system', 'control-plane',
                 'example/delivery-target', 'main', 'none', 'bug',
                 'Correlation query', 'p1', 1, 0, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 1, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, DIGEST, SHA, RUN_ID, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, github_status, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 'in_progress', 1, 1, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, SHA, GITHUB_RUN_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES (?, ?, ?, 'repo/read', 'repo.read', 'read', 42, 'success', ?)`,
    ).bind(TRACE_ID, RUN_ID, ATTEMPT_ID, NOW),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('delivery correlation query and structured logs', () => {
  it('resolves task, run, attempt, GitHub run, and trace identifiers to one safe projection', async () => {
    const store = new CorrelationQueryStore(env.DB_CONTROL);
    for (const lookup of [
      { kind: 'task', id: TASK_ID },
      { kind: 'run', id: RUN_ID },
      { kind: 'attempt', id: ATTEMPT_ID },
      { kind: 'github_run', id: GITHUB_RUN_ID },
      { kind: 'trace', id: TRACE_ID },
    ] as const) {
      await expect(store.resolve(lookup)).resolves.toMatchObject({
        schemaVersion: '1',
        correlationId: RUN_ID,
        task: { id: TASK_ID },
        run: { id: RUN_ID },
        attempts: [{ id: ATTEMPT_ID, githubRunId: GITHUB_RUN_ID }],
        githubRuns: [{ kind: 'agent', id: GITHUB_RUN_ID, attemptId: ATTEMPT_ID }],
        traces: [{ id: TRACE_ID, attemptId: ATTEMPT_ID, resultCategory: 'success' }],
      });
    }
    const linkResults = await Promise.all([
      'correlation_links_identity',
      'correlation_links_trace_pr',
    ].map(async (view) => await env.DB_CONTROL.prepare(
      `SELECT identifier_kind, identifier_scope, identifier_value, correlation_id
       FROM ${view}`,
    ).all<Record<string, unknown>>()));
    expect(linkResults.flatMap((result) => result.results).sort((left, right) =>
      String(left.identifier_kind).localeCompare(String(right.identifier_kind)),
    )).toEqual([
      {
        identifier_kind: 'attempt',
        identifier_scope: '',
        identifier_value: ATTEMPT_ID,
        correlation_id: RUN_ID,
      },
      {
        identifier_kind: 'github_run',
        identifier_scope: '',
        identifier_value: GITHUB_RUN_ID,
        correlation_id: RUN_ID,
      },
      {
        identifier_kind: 'run',
        identifier_scope: '',
        identifier_value: RUN_ID,
        correlation_id: RUN_ID,
      },
      {
        identifier_kind: 'task',
        identifier_scope: '',
        identifier_value: TASK_ID,
        correlation_id: RUN_ID,
      },
      {
        identifier_kind: 'trace',
        identifier_scope: '',
        identifier_value: TRACE_ID,
        correlation_id: RUN_ID,
      },
    ]);
  });

  it('serves an authenticated strict query and rejects ambiguous or malformed identifiers', async () => {
    const ok = await SELF.fetch(
      `https://delivery-loop.test/v1/correlations?kind=trace&id=${TRACE_ID}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({
      correlationId: RUN_ID,
      matchedBy: { kind: 'trace', id: TRACE_ID },
    });
    const unauthenticated = await SELF.fetch(
      `https://delivery-loop.test/v1/correlations?kind=run&id=${RUN_ID}`,
    );
    expect(unauthenticated.status).toBe(401);
    const ambiguous = await SELF.fetch(
      'https://delivery-loop.test/v1/correlations?kind=github_pr&id=42',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(ambiguous.status).toBe(400);
    const extra = await SELF.fetch(
      `https://delivery-loop.test/v1/correlations?kind=run&id=${RUN_ID}&raw=CANARY_RAW_QUERY`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(extra.status).toBe(400);
    expect(await extra.text()).not.toContain('CANARY_RAW_QUERY');
  });

  it('emits one searchable allowlisted log record without URLs, payloads, or raw errors', async () => {
    const view = await new CorrelationQueryStore(env.DB_CONTROL).resolve({
      kind: 'trace',
      id: TRACE_ID,
    });
    if (view === null) throw new Error('correlation view missing');
    const records: CorrelationLogRecord[] = [];
    new CorrelationLogger((record) => records.push(record)).lookup(view);
    expect(records).toEqual([{
      schemaVersion: '1',
      event: 'correlation_lookup',
      correlationId: RUN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      attemptIds: [ATTEMPT_ID],
      githubRunIds: [GITHUB_RUN_ID],
      pullRequestNumbers: [],
      deploymentIds: [],
      githubDeploymentIds: [],
      traceIds: [TRACE_ID],
      matchedByKind: 'trace',
      matchedById: TRACE_ID,
      observedAt: expect.any(String),
    }]);
    const encoded = JSON.stringify(records);
    expect(encoded).not.toContain('r2://');
    expect(encoded).not.toContain('https://');
    expect(encoded).not.toContain('CANARY_');
  });
});
