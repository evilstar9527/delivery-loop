/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubAppCredentialError } from '../../src/auth/github-app-installation-token.js';
import type { TaskEnvelope } from '../../src/domain/task.js';
import { taskApi } from '../../src/http/task-api.js';
import { GitHubBaseResolutionError } from '../../src/reconciliation/github-base-observation-reconciler.js';
import { SecretScanner } from '../../src/security/redaction.js';

const BASE_URL = 'https://delivery-loop.test';
const TEST_TOKEN = 'test-task-intake-token';
const OPERATIONS_TOKEN = 'test-operations-token';
const BASE_SHA = 'b'.repeat(40);
const baseResolutionCalls: Array<{ repository: string; baseBranch: string }> = [];
let baseResolutionFails = false;
let baseResolutionFactoryFailure: 'none' | 'null' | 'throw' | 'credential' = 'none';
let baseResolutionError: Error | null = null;
let baseResolutionResult = BASE_SHA;
const APP = taskApi({
  baseShaResolverFromEnv: () => {
    if (baseResolutionFactoryFailure === 'null') return null;
    if (baseResolutionFactoryFailure === 'throw') {
      throw new Error('CANARY_GITHUB_CONFIGURATION_DETAIL');
    }
    if (baseResolutionFactoryFailure === 'credential') {
      throw new GitHubAppCredentialError('credential_signing_unavailable');
    }
    return {
      async resolveBaseSha(repository, baseBranch) {
        baseResolutionCalls.push({ repository, baseBranch });
        if (baseResolutionError !== null) throw baseResolutionError;
        if (baseResolutionFails) throw new Error('untrusted upstream detail');
        return baseResolutionResult;
      },
    };
  },
});

function taskEnvelope(taskKey = 'api-task'): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: `event-${taskKey}-1`,
    occurredAt: '2026-07-25T05:00:00.000Z',
    source: {
      system: 'manual',
      tenantKey: 'tenant-api-test',
      taskKey,
      revision: '1',
      url: `https://tasks.example.test/${taskKey}`,
    },
    actor: { type: 'user', id: 'user-api-test' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'requirement',
      title: 'Create an idempotent task intake',
      description: 'Persist the normalized request once without exposing its body.',
      acceptanceCriteria: ['Concurrent requests resolve to one Task and Run.'],
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

async function postTask(args: {
  task: unknown;
  idempotencyKey?: string;
  token?: string;
  correlationId?: string;
}): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (args.idempotencyKey !== undefined) {
    headers.set('idempotency-key', args.idempotencyKey);
  }
  if (args.token !== undefined) {
    headers.set('authorization', `Bearer ${args.token}`);
  }
  if (args.correlationId !== undefined) {
    headers.set('x-correlation-id', args.correlationId);
  }
  return await APP.request(`${BASE_URL}/v1/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args.task),
  }, env);
}

async function getGitHubBaseReadiness(
  query: string,
  token: string | null = OPERATIONS_TOKEN,
): Promise<Response> {
  const headers = new Headers();
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return await APP.request(
    `${BASE_URL}/v1/operations/github-base/readiness${query}`,
    { method: 'GET', headers },
    env,
  );
}

async function count(table: 'tasks' | 'runs' | 'outbox' | 'idempotency_keys'): Promise<number> {
  const row = await env.DB_CONTROL.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  if (row === null) throw new Error(`missing count for ${table}`);
  return row.count;
}

beforeEach(async () => {
  baseResolutionCalls.length = 0;
  baseResolutionFails = false;
  baseResolutionFactoryFailure = 'none';
  baseResolutionError = null;
  baseResolutionResult = BASE_SHA;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
});

describe('GET /v1/operations/github-base/readiness', () => {
  const EXACT_QUERY = '?repository=example%2Fdelivery-target&baseBranch=main';

  async function expectZeroBusinessWrites(): Promise<void> {
    expect(await count('tasks')).toBe(0);
    expect(await count('runs')).toBe(0);
    expect(await count('outbox')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
    expect((await env.TASK_OBJECTS.list()).objects).toHaveLength(0);
  }

  it('requires the operations identity and rejects the Task intake identity', async () => {
    const missing = await getGitHubBaseReadiness(EXACT_QUERY, null);
    const wrongPurpose = await getGitHubBaseReadiness(EXACT_QUERY, TEST_TOKEN);

    expect(missing.status).toBe(401);
    expect(wrongPurpose.status).toBe(401);
    expect(baseResolutionCalls).toHaveLength(0);
    await expectZeroBusinessWrites();
  });

  it('rejects missing, duplicate, extra, and unsafe query fields before resolution', async () => {
    const invalidQueries = [
      '',
      '?repository=example%2Fdelivery-target',
      '?baseBranch=main',
      `${EXACT_QUERY}&repository=example%2Fother`,
      `${EXACT_QUERY}&extra=true`,
      '?repository=example%2Fdelivery-target&baseBranch=..%2Fmain',
      '?repository=example%2Fdelivery-target%2Fextra&baseBranch=main',
      '?repository=..%2Fdelivery-target&baseBranch=main',
    ];
    for (const query of invalidQueries) {
      const response = await getGitHubBaseReadiness(query);
      expect(response.status, query).toBe(400);
      expect(await response.json(), query).toMatchObject({
        code: 'invalid_argument',
        retryable: false,
      });
    }
    expect(baseResolutionCalls).toHaveLength(0);
    await expectZeroBusinessWrites();
  });

  it('reports configuration failures with a fixed safe reason and no business writes', async () => {
    for (const failure of ['null', 'throw'] as const) {
      baseResolutionFactoryFailure = failure;
      const response = await getGitHubBaseReadiness(EXACT_QUERY);
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain('CANARY_GITHUB_CONFIGURATION_DETAIL');
      expect(JSON.parse(text)).toMatchObject({
        schemaVersion: '1',
        ready: false,
        reason: 'configuration_unavailable',
        code: 'unavailable',
        retryable: true,
      });
    }
    expect(baseResolutionCalls).toHaveLength(0);
    await expectZeroBusinessWrites();
  });

  it('preserves a fixed signing-stage failure raised while building the real resolver', async () => {
    baseResolutionFactoryFailure = 'credential';
    const response = await getGitHubBaseReadiness(EXACT_QUERY);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      schemaVersion: '1',
      ready: false,
      reason: 'credential_signing_unavailable',
      code: 'unavailable',
    });
    expect(baseResolutionCalls).toHaveLength(0);
    await expectZeroBusinessWrites();
  });

  it.each([
    'credential_unavailable',
    'credential_signing_unavailable',
    'credential_auth_rejected',
    'credential_unauthenticated',
    'credential_forbidden',
    'credential_installation_not_found',
    'credential_policy_rejected',
    'credential_transport_unavailable',
    'credential_upstream_unavailable',
    'credential_response_invalid',
    'reference_unavailable',
    'reference_invalid',
  ] as const)('returns only the safe %s classification', async (reason) => {
    const canary = `CANARY_GITHUB_READINESS_${reason}`;
    baseResolutionError = new GitHubBaseResolutionError(reason, canary);

    const response = await getGitHubBaseReadiness(EXACT_QUERY);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain(canary);
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: '1',
      ready: false,
      reason,
      code: 'unavailable',
      retryable: true,
    });
    expect(baseResolutionCalls).toEqual([{
      repository: 'example/delivery-target',
      baseBranch: 'main',
    }]);
    await expectZeroBusinessWrites();
  });

  it('classifies a non-commit resolver result as an invalid reference', async () => {
    baseResolutionResult = 'not-a-commit';

    const response = await getGitHubBaseReadiness(EXACT_QUERY);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      schemaVersion: '1',
      ready: false,
      reason: 'reference_invalid',
      code: 'unavailable',
    });
    await expectZeroBusinessWrites();
  });

  it('returns the exact trusted SHA without creating Task, Run, outbox, or R2 state', async () => {
    const response = await getGitHubBaseReadiness(EXACT_QUERY);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schemaVersion: '1',
      ready: true,
      repository: 'example/delivery-target',
      baseBranch: 'main',
      baseSha: BASE_SHA,
    });
    expect(baseResolutionCalls).toEqual([{
      repository: 'example/delivery-target',
      baseBranch: 'main',
    }]);
    await expectZeroBusinessWrites();
  });
});

describe('POST /v1/tasks', () => {
  it('returns 202 and converges 20 concurrent uses of one Idempotency-Key', async () => {
    const task = taskEnvelope();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        postTask({ task, idempotencyKey: 'api-concurrent-key', token: TEST_TOKEN }),
      ),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);

    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      accepted: boolean;
      taskId: string;
      runId: string;
    }>;
    const first = bodies[0];
    if (first === undefined) throw new Error('missing API response');
    expect(first.accepted).toBe(true);
    expect(new Set(bodies.map((body) => body.taskId))).toEqual(new Set([first.taskId]));
    expect(new Set(bodies.map((body) => body.runId))).toEqual(new Set([first.runId]));
    expect(await count('tasks')).toBe(1);
    expect(await count('runs')).toBe(1);
    expect(await count('outbox')).toBe(1);
    expect(await count('idempotency_keys')).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT base_sha FROM runs WHERE run_id = ?',
    ).bind(first.runId).first()).toEqual({ base_sha: BASE_SHA });
    expect(baseResolutionCalls).toHaveLength(20);
    expect(baseResolutionCalls.every((call) =>
      call.repository === 'example/delivery-target' && call.baseBranch === 'main')).toBe(true);

    const listed = await env.TASK_OBJECTS.list({ prefix: `tasks/${first.taskId}/` });
    expect(listed.objects).toHaveLength(1);
    const stored = await env.TASK_OBJECTS.get(listed.objects[0]!.key);
    expect(stored).not.toBeNull();
    const storedText = (await stored?.text()) ?? '{}';
    expect(JSON.parse(storedText)).toEqual(task);
    const projections = await Promise.all(
      ['tasks', 'runs', 'outbox', 'idempotency_keys'].map(
        async (table) => (await env.DB_CONTROL.prepare(`SELECT * FROM ${table}`).all()).results,
      ),
    );
    expect(
      new SecretScanner({ secrets: [TEST_TOKEN, 'api-concurrent-key'] }).scan({
        responses: bodies,
        projections,
        taskObject: storedText,
      }),
    ).toEqual([]);
  });

  it('returns the same 202 response when the completed request is replayed', async () => {
    const args = {
      task: taskEnvelope('api-replay'),
      idempotencyKey: 'api-replay-key',
      token: TEST_TOKEN,
    };
    const first = await postTask(args);
    baseResolutionFails = true;
    const second = await postTask(args);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
    expect(await count('tasks')).toBe(1);
    expect(await count('runs')).toBe(1);
    expect(baseResolutionCalls).toHaveLength(1);
  });

  it('rejects reusing an Idempotency-Key with another payload without creating it', async () => {
    const first = await postTask({
      task: taskEnvelope('api-original'),
      idempotencyKey: 'api-conflict-key',
      token: TEST_TOKEN,
    });
    expect(first.status).toBe(202);
    expect(baseResolutionCalls).toHaveLength(1);

    const conflict = await postTask({
      task: taskEnvelope('api-different'),
      idempotencyKey: 'api-conflict-key',
      token: TEST_TOKEN,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'conflict', retryable: false });
    expect(await count('tasks')).toBe(1);
    expect(await count('runs')).toBe(1);
    expect(await count('outbox')).toBe(1);
    expect(await count('idempotency_keys')).toBe(1);
    expect((await env.TASK_OBJECTS.list()).objects).toHaveLength(1);
    expect(baseResolutionCalls).toHaveLength(1);
  });

  it('rejects unauthenticated, missing-key, and invalid Task requests without echoing content', async () => {
    const task = taskEnvelope('api-negative');
    const unauthenticated = await postTask({
      task,
      idempotencyKey: 'api-negative-auth',
    });
    expect(unauthenticated.status).toBe(401);

    const missingKey = await postTask({ task, token: TEST_TOKEN });
    expect(missingKey.status).toBe(400);

    const canary = 'CANARY_TASK_BODY_MUST_NOT_BE_ECHOED';
    const invalid = await postTask({
      task: {
        ...task,
        intent: { ...task.intent, description: canary, acceptanceCriteria: [] },
      },
      idempotencyKey: 'api-negative-invalid',
      token: TEST_TOKEN,
    });
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.text();
    expect(invalidBody).not.toContain(canary);
    expect(JSON.parse(invalidBody)).toMatchObject({
      code: 'invalid_argument',
      retryable: false,
    });
    expect(await count('tasks')).toBe(0);
    expect(await count('runs')).toBe(0);
    expect(await count('outbox')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
    expect((await env.TASK_OBJECTS.list()).objects).toHaveLength(0);
  });

  it('does not reflect a secret-shaped correlation header but preserves a canonical UUID', async () => {
    const task = taskEnvelope('api-correlation-id');
    const canary = 'CANARY_HEADER_SECRET_123456';
    const rejected = await postTask({
      task,
      idempotencyKey: 'api-correlation-id-rejected',
      correlationId: canary,
    });
    expect(rejected.status).toBe(401);
    const rejectedText = await rejected.text();
    expect(rejectedText).not.toContain(canary);
    expect(JSON.parse(rejectedText).correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const trustedCorrelationId = '018f6d5e-7b9a-7c31-8c2a-bbd3e12f0123';
    const accepted = await postTask({
      task,
      idempotencyKey: 'api-correlation-id-accepted',
      correlationId: trustedCorrelationId,
    });
    expect(accepted.status).toBe(401);
    const acceptedBody = (await accepted.json()) as { correlationId: string };
    expect(acceptedBody.correlationId).toBe(trustedCorrelationId);
  });

  it('rejects a Task containing a configured Secret before D1/R2 persistence', async () => {
    const task = taskEnvelope('api-secret-rejected');
    const response = await postTask({
      task: {
        ...task,
        intent: { ...task.intent, description: `copied credential: ${TEST_TOKEN}` },
      },
      idempotencyKey: 'api-secret-rejected-key',
      token: TEST_TOKEN,
    });
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain(TEST_TOKEN);
    expect(JSON.parse(text)).toMatchObject({ code: 'policy_denied' });
    expect(await count('tasks')).toBe(0);
    expect(await count('runs')).toBe(0);
    expect(await count('outbox')).toBe(0);
    expect((await env.TASK_OBJECTS.list()).objects).toHaveLength(0);
  });

  it('rejects a newly configured operations Secret through the same complete catalog', async () => {
    const operationsSecret = env.OPERATIONS_TOKEN;
    if (operationsSecret === undefined) throw new Error('test operations Secret is unavailable');
    const task = taskEnvelope('api-operations-secret-rejected');
    const response = await postTask({
      task: {
        ...task,
        intent: { ...task.intent, description: `copied credential: ${operationsSecret}` },
      },
      idempotencyKey: 'api-operations-secret-rejected-key',
      token: TEST_TOKEN,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(operationsSecret);
    expect(await count('tasks')).toBe(0);
    expect(await count('runs')).toBe(0);
    expect(await count('outbox')).toBe(0);
    expect((await env.TASK_OBJECTS.list()).objects).toHaveLength(0);
  });

  it('fails closed before D1/R2 persistence when the trusted GitHub base is unavailable', async () => {
    baseResolutionFails = true;
    const response = await postTask({
      task: taskEnvelope('api-base-unavailable'),
      idempotencyKey: 'api-base-unavailable-key',
      token: TEST_TOKEN,
    });

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('untrusted upstream detail');
    expect(JSON.parse(text)).toMatchObject({ code: 'unavailable', retryable: true });
    expect(baseResolutionCalls).toEqual([{
      repository: 'example/delivery-target',
      baseBranch: 'main',
    }]);
    expect(await count('tasks')).toBe(0);
    expect(await count('runs')).toBe(0);
    expect(await count('outbox')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
    expect((await env.TASK_OBJECTS.list()).objects).toHaveLength(0);
  });
});
