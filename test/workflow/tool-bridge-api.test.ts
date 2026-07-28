/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import type { Bindings } from '../../src/env.js';
import { attemptApi } from '../../src/http/attempt-api.js';
import type {
  ToolBridgeCall,
  ToolBridgeCallResult,
  ToolBridgeClient,
} from '../../src/tools/tool-bridge-client.js';
import { ServiceBindingToolBridgeClient } from '../../src/tools/tool-bridge-client.js';

const BASE_URL = 'https://delivery-loop.test';
const RAW_TOKEN = 'tool-bridge-attempt-token';
const RAW_TOOL_TOKEN = 'tool-bridge-scoped-token';
const TASK_ID = 'task-tool-bridge';
const RUN_ID = 'run-tool-bridge';
const ATTEMPT_ID = 'attempt-tool-bridge';
const BASE_SHA = '8'.repeat(40);
const ARGUMENT_CANARY = 'CANARY_NESTED_TOOL_ARGUMENT_MUST_NOT_PERSIST';
const UPSTREAM_ERROR_CANARY = 'CANARY_UPSTREAM_ERROR_MUST_NOT_ESCAPE';

class FakeToolBridgeClient implements ToolBridgeClient {
  readonly calls: ToolBridgeCall[] = [];
  result: ToolBridgeCallResult = { ok: true, result: { matches: 1 } };

  async call(input: ToolBridgeCall): Promise<ToolBridgeCallResult> {
    this.calls.push(structuredClone(input));
    return this.result;
  }
}

async function seedAttempt(scopes = [
  'repo:read',
  'logs:read',
  'trace:read',
  'k8s:read',
  'database:diagnostic',
]): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         ?, 'manual', 'tool-bridge-test', 'tool-bridge-test', '1', ?,
         'r2://tasks/tool-bridge', 'system', 'tool-bridge-test', 'example/repo',
         'main', 'test', 'bug', 'Tool bridge trace test', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(TASK_ID, `sha256:${'1'.repeat(64)}`, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, `sha256:${'1'.repeat(64)}`, BASE_SHA, RUN_ID, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, version, lease_generation,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '777', 1, 1, ?, ?, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, BASE_SHA, expiresAt, nowIso, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-tool-bridge', ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'2'.repeat(64)}`,
      await canonicalSha256(RAW_TOKEN),
      await canonicalSha256(RAW_TOOL_TOKEN),
      JSON.stringify(scopes),
      expiresAt,
      nowIso,
    ),
  ]);
}

function toolApp(client: ToolBridgeClient, monotonicNow?: () => number) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route('/', attemptApi({ toolBridgeClient: client, monotonicNow }));
  return app;
}

async function callTool(
  client: ToolBridgeClient,
  body: unknown,
  args: { token?: string; monotonicNow?: () => number } = {},
): Promise<Response> {
  const app = toolApp(client, args.monotonicNow);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('authorization', `Bearer ${args.token ?? RAW_TOOL_TOKEN}`);
  return await app.request(
    `${BASE_URL}/v1/attempts/${ATTEMPT_ID}/tools/call`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    env,
  );
}

async function traces(): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB_CONTROL.prepare(
    `SELECT trace_id, run_id, attempt_id, tool_path, action, effect,
            duration_ms, result_category, occurred_at
     FROM tool_call_traces ORDER BY occurred_at, trace_id`,
  ).all<Record<string, unknown>>();
  return rows.results;
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM tool_call_traces'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedAttempt();
});

describe('attempt-scoped tool-bridge proxy and trace', () => {
  it('allows only the five bounded triage read/diagnostic paths', async () => {
    const client = new FakeToolBridgeClient();
    const allowed = [
      ['repo/read', 'repo:read'],
      ['logs/search', 'logs:read'],
      ['traces/get', 'trace:read'],
      ['k8s/diagnose', 'k8s:read'],
      ['database/diagnose', 'database:diagnostic'],
    ] as const;
    for (const [toolPath] of allowed) {
      const response = await callTool(client, {
        toolPath,
        arguments: { bounded: true },
      });
      expect(response.status).toBe(200);
    }
    expect(client.calls.map((call) => call.toolPath)).toEqual(
      allowed.map(([path]) => path),
    );
    const recorded = (await traces())
      .map((trace) => [trace.tool_path, trace.action, trace.effect])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    expect(recorded).toEqual(
      allowed
        .map(([path, action]) => [path, action, 'read'])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
  });

  it('derives path/action/effect from the trusted catalog and persists no arguments', async () => {
    const client = new FakeToolBridgeClient();
    const ticks = [100, 112.8];
    const response = await callTool(
      client,
      {
        toolPath: 'repo/read',
        arguments: {
          path: 'src/worker.ts',
          nested: { authorization: ARGUMENT_CANARY },
        },
      },
      { monotonicNow: () => ticks.shift() ?? 112.8 },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const responseText = await response.text();
    expect(responseText).not.toContain(ARGUMENT_CANARY);
    expect(JSON.parse(responseText)).toMatchObject({ ok: true, result: { matches: 1 } });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      traceId: expect.any(String),
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      toolPath: 'repo/read',
      arguments: { nested: { authorization: ARGUMENT_CANARY } },
    });

    expect(await traces()).toEqual([
      expect.objectContaining({
        trace_id: expect.any(String),
        run_id: RUN_ID,
        attempt_id: ATTEMPT_ID,
        tool_path: 'repo/read',
        action: 'repo:read',
        effect: 'read',
        duration_ms: 12,
        result_category: 'success',
      }),
    ]);
    const persisted = JSON.stringify(await traces());
    expect(persisted).not.toContain(ARGUMENT_CANARY);

    const columns = await env.DB_CONTROL.prepare('PRAGMA table_info(tool_call_traces)').all<{
      name: string;
    }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      'trace_id',
      'run_id',
      'attempt_id',
      'tool_path',
      'action',
      'effect',
      'duration_ms',
      'result_category',
      'occurred_at',
    ]);
  });

  it('records fixed upstream/timeout categories without persisting or echoing error detail', async () => {
    const upstream = new FakeToolBridgeClient();
    upstream.result = {
      ok: false,
      category: 'upstream_error',
      retryable: true,
      unsafeDetail: UPSTREAM_ERROR_CANARY,
    };
    const upstreamResponse = await callTool(upstream, {
      toolPath: 'repo/read',
      arguments: { path: 'src/index.ts', secret: ARGUMENT_CANARY },
    });
    expect(upstreamResponse.status).toBe(502);
    expect(await upstreamResponse.text()).not.toContain(UPSTREAM_ERROR_CANARY);

    const timeout = new FakeToolBridgeClient();
    timeout.result = {
      ok: false,
      category: 'timeout',
      retryable: true,
      unsafeDetail: UPSTREAM_ERROR_CANARY,
    };
    const timeoutResponse = await callTool(timeout, {
      toolPath: 'repo/read',
      arguments: { path: 'src/index.ts' },
    });
    expect(timeoutResponse.status).toBe(504);
    expect(await timeoutResponse.text()).not.toContain(UPSTREAM_ERROR_CANARY);

    const recorded = await traces();
    expect(recorded.map((trace) => trace.result_category).sort()).toEqual([
      'timeout',
      'upstream_error',
    ]);
    expect(recorded.every((trace) => Number(trace.duration_ms) >= 0)).toBe(true);
    expect(recorded.every((trace) => Number(trace.duration_ms) <= 60_000)).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(ARGUMENT_CANARY);
    expect(JSON.stringify(recorded)).not.toContain(UPSTREAM_ERROR_CANARY);
  });

  it('denies stale tokens, unknown paths, missing scopes, and caller-supplied policy fields', async () => {
    const client = new FakeToolBridgeClient();

    const wrongToken = await callTool(
      client,
      { toolPath: 'repo/read', arguments: { path: 'src/index.ts' } },
      { token: 'wrong-token' },
    );
    expect(wrongToken.status).toBe(401);

    const controlPlaneToken = await callTool(
      client,
      { toolPath: 'repo/read', arguments: { path: 'src/index.ts' } },
      { token: RAW_TOKEN },
    );
    expect(controlPlaneToken.status).toBe(401);

    const unknown = await callTool(client, {
      toolPath: `repo/${ARGUMENT_CANARY}`,
      arguments: {},
    });
    expect(unknown.status).toBe(403);

    const callerPolicy = await callTool(client, {
      toolPath: 'repo/read',
      effect: 'read',
      arguments: {},
    });
    expect(callerPolicy.status).toBe(400);

    await env.DB_CONTROL.prepare(
      `UPDATE attempt_tokens SET scopes_json = '["repo:read"]' WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).run();
    const missingScope = await callTool(client, {
      toolPath: 'logs/search',
      arguments: { query: 'bounded diagnostic query' },
    });
    expect(missingScope.status).toBe(403);

    expect(client.calls).toHaveLength(0);
    expect(await traces()).toEqual([
      expect.objectContaining({
        run_id: RUN_ID,
        attempt_id: ATTEMPT_ID,
        tool_path: 'logs/search',
        action: 'logs:read',
        effect: 'read',
        result_category: 'policy_denied',
      }),
    ]);
    expect(JSON.stringify(await traces())).not.toContain(ARGUMENT_CANARY);
  });

  it('denies known write and destructive paths before any upstream call', async () => {
    const client = new FakeToolBridgeClient();
    await env.DB_CONTROL.prepare(
      `UPDATE attempt_tokens
       SET scopes_json = '["repo:read","logs:read","trace:read","k8s:read","database:diagnostic","repo:write","k8s:write","database:write","shell:exec"]'
       WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).run();
    for (const toolPath of ['repo/write', 'k8s/apply', 'database/execute', 'shell/exec']) {
      const response = await callTool(client, {
        toolPath,
        arguments: { command: ARGUMENT_CANARY },
      });
      expect(response.status).toBe(403);
    }
    expect(client.calls).toHaveLength(0);
    const denied = (await traces()).map((trace) => [
      trace.tool_path,
      trace.action,
      trace.effect,
      trace.result_category,
    ]).sort(([left], [right]) => String(left).localeCompare(String(right)));
    expect(denied).toEqual([
      ['database/execute', 'database:write', 'destructive', 'policy_denied'],
      ['k8s/apply', 'k8s:write', 'write', 'policy_denied'],
      ['repo/write', 'repo:write', 'write', 'policy_denied'],
      ['shell/exec', 'shell:exec', 'destructive', 'policy_denied'],
    ]);
    expect(JSON.stringify(await traces())).not.toContain(ARGUMENT_CANARY);
  });

  it('rejects the tool credential after the shared Attempt grant is revoked', async () => {
    await env.DB_CONTROL.prepare(
      'UPDATE attempt_tokens SET revoked_at = ? WHERE attempt_id = ?',
    ).bind(new Date().toISOString(), ATTEMPT_ID).run();
    const client = new FakeToolBridgeClient();
    const response = await callTool(client, {
      toolPath: 'repo/read',
      arguments: { path: 'src/index.ts' },
    });
    expect(response.status).toBe(401);
    expect(client.calls).toHaveLength(0);
  });
});

describe('Watt-compatible tool-bridge service transport', () => {
  const call: ToolBridgeCall = {
    traceId: 'tooltrace_transport',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    toolPath: 'repo/read',
    arguments: { path: 'src/index.ts' },
  };

  it('forwards the arguments envelope and fixed correlation headers', async () => {
    let captured: Request | undefined;
    const service = {
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        captured = new Request(input, init);
        return Response.json({ matches: 1 });
      },
    } as Fetcher;
    const result = await new ServiceBindingToolBridgeClient(service).call(call);
    expect(result).toEqual({ ok: true, result: { matches: 1 } });
    expect(captured?.url).toBe('https://tool-bridge.internal/htbp/repo/read');
    expect(captured?.headers.get('x-delivery-trace-id')).toBe(call.traceId);
    expect(captured?.headers.get('x-delivery-run-id')).toBe(RUN_ID);
    expect(captured?.headers.get('x-delivery-attempt-id')).toBe(ATTEMPT_ID);
    expect(await captured?.json()).toEqual({ arguments: call.arguments });
  });

  it('does not read or propagate upstream error bodies and classifies abort timeout', async () => {
    let errorBodyRead = false;
    const upstreamResponse = Response.json(
      { error: { message: UPSTREAM_ERROR_CANARY } },
      { status: 503 },
    );
    upstreamResponse.text = async () => {
      errorBodyRead = true;
      return UPSTREAM_ERROR_CANARY;
    };
    upstreamResponse.json = async () => {
      errorBodyRead = true;
      return { error: { message: UPSTREAM_ERROR_CANARY } };
    };
    const upstream = {
      async fetch(): Promise<Response> {
        return upstreamResponse;
      },
    } as unknown as Fetcher;
    expect(await new ServiceBindingToolBridgeClient(upstream).call(call)).toEqual({
      ok: false,
      category: 'upstream_error',
      retryable: true,
    });
    expect(errorBodyRead).toBe(false);

    const stalled = {
      fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    } as Fetcher;
    expect(
      await new ServiceBindingToolBridgeClient(stalled, { timeoutMs: 5 }).call(call),
    ).toEqual({ ok: false, category: 'timeout', retryable: true });
  });
});
