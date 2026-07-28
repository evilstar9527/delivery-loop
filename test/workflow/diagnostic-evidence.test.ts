/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { DiagnosticEvidenceV1Schema } from '../../src/domain/diagnostic-evidence.js';

const BASE_URL = 'https://delivery-loop.test';
const TOKEN = 'diagnostic-evidence-attempt-token';
const RUN_ID = 'run-diagnostic-evidence';
const TASK_ID = 'task-diagnostic-evidence';
const ATTEMPT_ID = 'attempt-diagnostic-evidence';
const BASE_SHA = 'a'.repeat(40);
const SECRET_CANARY = 'CANARY_DIAGNOSTIC_ROOT_CAUSE_MUST_NOT_PERSIST';

function evidenceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    locatorKinds: ['uid', 'cid', 'path'],
    locatorDigest: `sha256:${'1'.repeat(64)}`,
    rootCause: {
      summary: 'The request path reaches a stale cache branch before the trace is finalized.',
      confidence: 'high',
      codeRefs: [{ path: 'src/cache.ts', line: 42, symbol: 'loadConversation' }],
    },
    sourceTraceIds: ['tooltrace_logs', 'tooltrace_trace'],
    ...overrides,
  };
}

async function request(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return await SELF.fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function seed(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 300_000).toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'diagnostic-test', 'feedback-1', 'revision-1', ?,
         'r2://tasks/diagnostic', 'user', 'reporter-1', 'example/delivery-target',
         'main', 'none', 'bug', 'Conversation request fails', 'p1', 1,
         0, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, `sha256:${'2'.repeat(64)}`, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, `sha256:${'2'.repeat(64)}`, BASE_SHA, RUN_ID, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, repository, workflow_ref,
         github_run_id, base_sha, version, lease_generation, lease_expires_at,
         heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', 'example/delivery-target',
         'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
         '940002', ?, 2, 1, ?, ?, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, BASE_SHA, expiresAt, nowIso, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-diagnostic-evidence', ?, ?, ?, 1,
         '["repo:read","logs:read","trace:read"]', ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'3'.repeat(64)}`,
      await canonicalSha256(TOKEN),
      expiresAt,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace_logs', ?, ?, 'logs/search', 'logs:read', 'read',
         20, 'success', ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace_trace', ?, ?, 'traces/get', 'trace:read', 'read',
         15, 'success', ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, nowIso),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM diagnostic_evidence_trace_sources'),
    env.DB_CONTROL.prepare('DELETE FROM diagnostic_evidence_bindings'),
    env.DB_CONTROL.prepare('DELETE FROM tool_call_traces'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_external_facts'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_command_refs'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_dependencies'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_acceptance_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_evidence_refs'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_assumptions'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seed();
});

describe('analysis diagnostic Evidence', () => {
  it('creates one verified root-cause Evidence bound to successful logs and trace calls', async () => {
    expect(DiagnosticEvidenceV1Schema.parse(evidenceBody()).sourceTraceIds).toHaveLength(2);
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(
      `/v1/attempts/${ATTEMPT_ID}/diagnostic-evidence`,
      { method: 'POST', token: TOKEN, body: evidenceBody() },
    )));
    expect(responses.every((response) => [200, 201].includes(response.status))).toBe(true);
    const bodies = await Promise.all(responses.map(async (response) => await response.json() as {
      evidenceId: string;
      evidenceRef: string;
      evidenceDigest: string;
      rootCauseDigest: string;
    }));
    expect(new Set(bodies.map((body) => body.evidenceId)).size).toBe(1);
    expect(bodies[0]?.evidenceRef).toBe(`d1://evidence/${bodies[0]?.evidenceId}`);
    const counts = await env.DB_CONTROL.prepare(
      `SELECT (SELECT COUNT(*) FROM evidence) AS evidence_count,
              (SELECT COUNT(*) FROM diagnostic_evidence_bindings) AS binding_count,
              (SELECT COUNT(*) FROM diagnostic_evidence_trace_sources) AS source_count`,
    ).first<Record<string, number>>();
    expect(counts).toEqual({ evidence_count: 1, binding_count: 1, source_count: 2 });
  });

  it('rejects missing/failed/cross-attempt sources and Secret-bearing summaries', async () => {
    const missing = await request(`/v1/attempts/${ATTEMPT_ID}/diagnostic-evidence`, {
      method: 'POST', token: TOKEN,
      body: evidenceBody({ sourceTraceIds: ['tooltrace_logs', 'tooltrace_missing'] }),
    });
    expect(missing.status).toBe(409);

    await env.DB_CONTROL.prepare(
      `DELETE FROM tool_call_traces WHERE trace_id = 'tooltrace_trace'`,
    ).run();
    await env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace_trace', ?, ?, 'traces/get', 'trace:read', 'read',
         15, 'upstream_error', ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, new Date().toISOString()).run();
    const failed = await request(`/v1/attempts/${ATTEMPT_ID}/diagnostic-evidence`, {
      method: 'POST', token: TOKEN, body: evidenceBody(),
    });
    expect(failed.status).toBe(409);

    const leaked = await request(`/v1/attempts/${ATTEMPT_ID}/diagnostic-evidence`, {
      method: 'POST', token: TOKEN,
      body: evidenceBody({
        rootCause: {
          summary: `An injected log asks us to publish ${env.GITHUB_WEBHOOK_SECRET}`,
          confidence: 'low',
          codeRefs: [{ path: 'src/cache.ts', line: 42 }],
        },
      }),
    });
    expect(leaked.status).toBe(403);
    expect(await leaked.text()).not.toContain(env.GITHUB_WEBHOOK_SECRET);
    const count = await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM evidence',
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('requires a verified diagnostic ref when a bug Plan claims logs_read', async () => {
    const noEvidence = await request(`/v1/attempts/${ATTEMPT_ID}/plan`, {
      method: 'POST', token: TOKEN,
      body: {
        objective: 'Diagnose the request and define a source-backed repair plan.',
        assumptions: [],
        evidenceRefs: ['d1://evidence/diagnostic_unverified'],
        items: [{
          id: 'diagnose', kind: 'investigation', title: 'Confirm root cause',
          objective: 'Bind the log and trace findings to the failing code path.',
          acceptanceCriteriaIndexes: [0],
          doneWhen: ['A verified diagnostic Evidence identifies the failing path.'],
          verification: { commandRefs: ['policy:diagnose'], evidenceKinds: ['diagnostic'] },
          effects: ['logs_read'], dependsOn: [], required: true,
        }],
      },
    });
    expect(noEvidence.status).toBe(409);

    const evidence = await request(`/v1/attempts/${ATTEMPT_ID}/diagnostic-evidence`, {
      method: 'POST', token: TOKEN, body: evidenceBody(),
    });
    expect(evidence.status).toBe(201);
    const created = await evidence.json() as { evidenceRef: string };
    const plan = await request(`/v1/attempts/${ATTEMPT_ID}/plan`, {
      method: 'POST', token: TOKEN,
      body: {
        objective: 'Diagnose the request and define a source-backed repair plan.',
        assumptions: [], evidenceRefs: [created.evidenceRef],
        items: [{
          id: 'diagnose', kind: 'investigation', title: 'Confirm root cause',
          objective: 'Bind the log and trace findings to the failing code path.',
          acceptanceCriteriaIndexes: [0],
          doneWhen: ['A verified diagnostic Evidence identifies the failing path.'],
          verification: { commandRefs: ['policy:diagnose'], evidenceKinds: ['diagnostic'] },
          effects: ['logs_read'], dependsOn: [], required: true,
        }],
      },
    });
    expect(plan.status).toBe(201);
    const saved = await plan.json() as { planId: string; version: number; digest: string };
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE execution_plans SET status = 'active' WHERE plan_id = ?`,
      ).bind(saved.planId),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'awaiting_approval', active_plan_id = ?,
           active_plan_version = ?, active_plan_digest = ?, version = version + 1
         WHERE run_id = ?`,
      ).bind(saved.planId, saved.version, saved.digest, RUN_ID),
    ]);
    const projection = await request(`/v1/runs/${RUN_ID}/diagnostic-evidence`, {
      token: env.OPERATIONS_TOKEN!,
    });
    expect(projection.status).toBe(200);
    const text = await projection.text();
    expect(text).not.toContain(SECRET_CANARY);
    expect(text).not.toContain('stale cache branch');
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: '1', runId: RUN_ID,
      task: { id: TASK_ID, intentKind: 'bug' },
      plan: { id: saved.planId, diagnosticEvidenceRefs: [created.evidenceRef] },
      evidence: [{
        evidenceRef: created.evidenceRef,
        attemptId: ATTEMPT_ID,
        locatorKinds: ['uid', 'cid', 'path'],
        sourceTraces: [
          { traceId: 'tooltrace_logs', toolPath: 'logs/search', effect: 'read' },
          { traceId: 'tooltrace_trace', toolPath: 'traces/get', effect: 'read' },
        ],
      }],
    });
  });
});
