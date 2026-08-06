import { describe, expect, it } from 'vitest';
import { analysisAttemptId } from '../src/domain/workflow-event.js';
import { taskRevisionIds, type TaskEnvelope } from '../src/domain/task.js';
import {
  runGuardedTaskIntake,
  type GuardedTaskIntakeError,
  type GuardedTaskIntakeOptions,
} from '../src/pilot/guarded-task-intake.js';

const TASK_TOKEN = 'task-intake-token-purpose';
const GITHUB_TOKEN = 'github-actions-read-purpose';

const task: TaskEnvelope = {
  schemaVersion: '1',
  eventId: 'event-safe-intake-1',
  occurredAt: '2026-08-06T22:00:00+08:00',
  source: {
    system: 'manual',
    tenantKey: 'phase7-safe-intake',
    taskKey: 'bug-feedback',
    revision: '1',
  },
  actor: { type: 'user', id: 'owner' },
  target: {
    owner: 'evilstar9527',
    repo: 'delivery-loop',
    baseBranch: 'main',
    environment: 'none',
  },
  intent: {
    kind: 'bug',
    title: 'Investigate a production failure',
    description: 'Use the supplied safe locators to diagnose and fix the bug.',
    acceptanceCriteria: ['A verified diagnosis and Draft PR are produced.'],
    priority: 'p1',
  },
  policy: {
    allowRepositoryWrite: true,
    allowTestDeploy: false,
    allowProductionDeploy: false,
    requireHumanApproval: true,
  },
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function options(fetcher: typeof fetch): GuardedTaskIntakeOptions {
  return {
    controlPlaneOrigin: 'https://control.example.com',
    githubApiOrigin: 'https://api.github.com',
    repository: 'evilstar9527/delivery-loop',
    taskToken: TASK_TOKEN,
    githubToken: GITHUB_TOKEN,
    task,
    fetch: fetcher,
  };
}

describe('guarded Task intake', () => {
  it('requires both guards before making exactly one Task POST', async () => {
    const ids = await taskRevisionIds(task);
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.origin === 'https://control.example.com' && url.pathname === `/v1/tasks/${ids.taskId}`) {
        return new Response(null, { status: 404 });
      }
      if (url.origin === 'https://api.github.com') {
        return json({ total_count: 0, workflow_runs: [] });
      }
      if (url.origin === 'https://control.example.com' && url.pathname === '/v1/tasks') {
        return json({ accepted: true, taskId: ids.taskId, runId: ids.runId }, { status: 202 });
      }
      return new Response(null, { status: 500 });
    };

    const result = await runGuardedTaskIntake(options(fetcher));

    expect(result).toMatchObject({
      taskId: ids.taskId,
      runId: ids.runId,
      analysisAttemptId: analysisAttemptId(ids.runId),
      taskGuardStatus: 404,
      matchingActionRuns: 0,
      taskCreateRequests: 1,
      accepted: true,
    });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.init.method ?? 'GET')).toEqual(['GET', 'GET', 'POST']);
    expect(calls[2]?.init.body).toBe(JSON.stringify(task));
    const headers = new Headers(calls[2]?.init.headers);
    expect(headers.get('idempotency-key')).toBe(
      `guarded-task-intake:${ids.taskId.slice('task_'.length)}`,
    );
  });

  it('stops before POST when the deterministic Task already exists', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return json({ id: 'existing' });
    };
    await expect(runGuardedTaskIntake(options(fetcher))).rejects.toMatchObject({
      code: 'task_already_exists',
      taskCreateRequests: 0,
    } satisfies Partial<GuardedTaskIntakeError>);
    expect(calls).toBe(1);
  });

  it('checks paginated Action inventory and stops on the stable analysis title', async () => {
    const ids = await taskRevisionIds(task);
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      if (url.origin === 'https://control.example.com') return new Response(null, { status: 404 });
      if (url.searchParams.get('page') === '2') {
        return json({
          total_count: 101,
          workflow_runs: [
            ...Array.from({ length: 100 }, (_, index) => ({
              display_title: index === 0
                ? `delivery-loop/${analysisAttemptId(ids.runId)}`
                : `delivery-loop/unrelated-page-2-${index}`,
            })),
          ],
        });
      }
      const next = new URL(url);
      next.searchParams.set('page', '2');
      return json(
        { total_count: 101, workflow_runs: [{ display_title: 'delivery-loop/unrelated' }] },
        { headers: { link: `<${next}>; rel="next"` } },
      );
    };
    await expect(runGuardedTaskIntake(options(fetcher))).rejects.toMatchObject({
      code: 'action_already_exists',
      taskCreateRequests: 0,
    });
    expect(calls).toBe(3);
  });

  it.each([
    ['read-only policy', { ...task, policy: { ...task.policy, allowRepositoryWrite: false } }],
    ['test deployment policy', { ...task, policy: { ...task.policy, allowTestDeploy: true } }],
    ['wrong repository', { ...task, target: { ...task.target, repo: 'other' } }],
  ])('rejects %s before network access', async (_name, input) => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    };
    await expect(runGuardedTaskIntake({ ...options(fetcher), task: input })).rejects.toMatchObject({
      code: 'task_policy_rejected',
      taskCreateRequests: 0,
    });
    expect(calls).toBe(0);
  });

  it('rejects credential reflection in a bounded GitHub response', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === 'https://control.example.com') return new Response(null, { status: 404 });
      return json({ total_count: 0, workflow_runs: [], reflected: GITHUB_TOKEN });
    };
    await expect(runGuardedTaskIntake(options(fetcher))).rejects.toMatchObject({
      code: 'action_inventory_invalid',
      taskCreateRequests: 0,
    });
  });

  it('rejects an incomplete Action page even when GitHub omits the next link', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin === 'https://control.example.com') return new Response(null, { status: 404 });
      return json({ total_count: 2, workflow_runs: [{ display_title: 'delivery-loop/one' }] });
    };
    await expect(runGuardedTaskIntake(options(fetcher))).rejects.toMatchObject({
      code: 'action_inventory_invalid',
      taskCreateRequests: 0,
    });
  });
});
