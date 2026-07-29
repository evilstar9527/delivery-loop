import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
  type TaskEnvelope,
} from '../src/domain/task.js';
import { analysisAttemptId } from '../src/domain/workflow-event.js';
import {
  WorkflowHibernateLiveWindowError,
  WorkflowHibernateWindowAuthorizationV1Schema,
  executeWorkflowHibernateLiveWindow,
  resumeWorkflowHibernateLiveWindow,
  workflowHibernateWindowAuthorityDigest,
  type WorkflowHibernateLiveWindowDependencies,
  type WorkflowHibernateWindowAuthorizationV1,
} from '../src/pilot/workflow-hibernate-live-window.js';
import type {
  WorkflowHibernateAfterResult,
  WorkflowHibernateWindowSnapshot,
} from '../src/pilot/workflow-hibernate-window-guard.js';

const SOURCE_SHA = 'e14d11e5420e04d49c042a01c562ff5432ebb98c';
const ACTION_SHA = 'a02831a15a985bb691c2f6c76f8866f09418cea6';
const BUNDLE_SHA256 = '14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8';
const BEFORE_DEPLOYMENT_ID = '8b646225-4d71-4867-aff3-f22d137a8fa5';
const BEFORE_VERSION_ID = '6911feca-acf7-476a-b10c-cc61e71aedad';
const AFTER_DEPLOYMENT_ID = 'd78d2179-cac7-42cb-97d0-41b46a91aabd';
const AFTER_VERSION_ID = '7272a1c7-4dcc-42da-b087-314e94305a9a';

function task(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'hibernate-drill-20260729',
    occurredAt: '2026-07-29T05:50:00.000Z',
    source: {
      system: 'manual',
      tenantKey: 'delivery-loop-owner',
      taskKey: 'phase1-hibernate-drill-20260729',
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
      kind: 'requirement',
      title: 'Read-only Workflow hibernate drill',
      description: 'Inspect the repository and propose a read-only execution plan.',
      acceptanceCriteria: ['The proposed plan uses read-only effects.'],
      priority: 'p2',
    },
    policy: {
      allowRepositoryWrite: false,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

async function authorization(
  override: Partial<WorkflowHibernateWindowAuthorizationV1> = {},
): Promise<WorkflowHibernateWindowAuthorizationV1> {
  const input = task();
  const ids = await taskRevisionIds(input);
  const result: WorkflowHibernateWindowAuthorizationV1 = {
    schemaVersion: '1',
    authorizationId: 'hibernate-window-authorization-20260729',
    authorizedAt: '2026-07-29T05:49:00.000Z',
    expiresAt: '2026-07-29T06:19:00.000Z',
    authorityDigest: `sha256:${'9'.repeat(64)}`,
    repository: 'evilstar9527/delivery-loop',
    baseBranch: 'main',
    analysisWorkflowHeadSha: ACTION_SHA,
    task: {
      envelopeDigest: await canonicalSha256(input),
      revisionDigest: await taskRevisionDigest(input),
      taskId: ids.taskId,
      runId: ids.runId,
      attemptId: analysisAttemptId(ids.runId),
      idempotencyKey: 'hibernate-window-20260729-v1',
    },
    source: {
      sha: SOURCE_SHA,
      bundleSha256: BUNDLE_SHA256,
      bundleBytes: 2_808_881,
    },
    beforeDeployment: {
      deploymentId: BEFORE_DEPLOYMENT_ID,
      versionId: BEFORE_VERSION_ID,
      createdAt: '2026-07-29T04:56:43.836Z',
    },
    effects: {
      taskCreates: 1,
      analysisActions: 1,
      afterDeployments: 1,
      rollbacks: 0,
    },
    ...override,
  };
  result.authorityDigest = await workflowHibernateWindowAuthorityDigest(result);
  return result;
}

function snapshot(auth: WorkflowHibernateWindowAuthorizationV1): WorkflowHibernateWindowSnapshot {
  return {
    observedAt: '2026-07-29T05:55:00.000Z',
    source: {
      headSha: SOURCE_SHA,
      bundleSha256: BUNDLE_SHA256,
      clean: true,
      matchingBundleBuilds: 2,
    },
    deployment: {
      deploymentId: BEFORE_DEPLOYMENT_ID,
      versionId: BEFORE_VERSION_ID,
      createdAt: auth.beforeDeployment.createdAt,
      trafficPercentage: 100,
      deploymentsDuringWait: 0,
    },
    run: {
      runId: auth.task.runId,
      state: 'planning',
      activePlanId: null,
      analysisAttemptCount: 1,
      analysisDispatchOutboxCount: 1,
      workflowInstanceCount: 1,
    },
    analysis: {
      attemptId: auth.task.attemptId,
      attemptStatus: 'running',
      dispatchOutboxId: `dispatch-${auth.task.attemptId}`,
      dispatchOutboxState: 'settled',
      resultSignalOutboxCount: 0,
      actionRunId: '30430000001',
      actionStatus: 'in_progress',
      actionConclusion: null,
      actionRunCount: 1,
    },
    workflow: {
      instanceId: auth.task.runId,
      status: 'waiting',
      registerRun: { status: 'complete', endedAt: '2026-07-29T05:52:00.000Z' },
      dispatchAnalysisAttempt: {
        status: 'complete', endedAt: '2026-07-29T05:52:01.000Z',
      },
      analysisWait: {
        status: 'waiting', startedAt: '2026-07-29T05:52:01.100Z', endedAt: null,
      },
      resumedStepCount: 0,
    },
  };
}

function after(auth: WorkflowHibernateWindowAuthorizationV1): WorkflowHibernateAfterResult {
  return {
    deployment: {
      deploymentId: AFTER_DEPLOYMENT_ID,
      versionId: AFTER_VERSION_ID,
      createdAt: '2026-07-29T05:55:04.000Z',
      trafficPercentage: 100,
    },
    observedAt: '2026-07-29T05:55:05.000Z',
    workflow: {
      instanceId: auth.task.runId,
      analysisWaitStartedAt: '2026-07-29T05:52:01.100Z',
      analysisWaitEndedAt: null,
    },
    deploymentsDuringWait: 1,
  };
}

function dependencies(
  auth: WorkflowHibernateWindowAuthorizationV1,
  override: Partial<WorkflowHibernateLiveWindowDependencies> = {},
): WorkflowHibernateLiveWindowDependencies {
  return {
    verifyFrozenSource: vi.fn().mockResolvedValue({
      headSha: SOURCE_SHA,
      bundleSha256: BUNDLE_SHA256,
      bundleBytes: 2_808_881,
      matchingBundleBuilds: 2,
      clean: true,
    }),
    readBeforeDeployment: vi.fn().mockResolvedValue({
      deploymentId: BEFORE_DEPLOYMENT_ID,
      versionId: BEFORE_VERSION_ID,
      createdAt: auth.beforeDeployment.createdAt,
      trafficPercentage: 100,
    }),
    taskExists: vi.fn().mockResolvedValue(false),
    createTask: vi.fn().mockResolvedValue({
      accepted: true,
      taskId: auth.task.taskId,
      runId: auth.task.runId,
    }),
    readSnapshot: vi.fn().mockResolvedValue(snapshot(auth)),
    deployAfter: vi.fn().mockResolvedValue(after(auth)),
    sleep: vi.fn().mockResolvedValue(undefined),
    now: () => new Date('2026-07-29T05:55:00.500Z'),
    ...override,
  };
}

describe('live Workflow hibernate window orchestration', () => {
  it('keeps the external Task and authorization examples canonically bound', async () => {
    const taskInput = JSON.parse(await readFile(
      resolve('schemas/workflow-hibernate-window-task-v1.example.json'), 'utf8',
    )) as unknown;
    const authorizationInput = JSON.parse(await readFile(
      resolve('schemas/workflow-hibernate-window-authorization-v1.example.json'), 'utf8',
    )) as unknown;
    const taskParsed = TaskEnvelopeSchema.safeParse(taskInput);
    const authorizationParsed = WorkflowHibernateWindowAuthorizationV1Schema
      .safeParse(authorizationInput);
    expect(taskParsed.success).toBe(true);
    expect(authorizationParsed.success).toBe(true);
    if (!taskParsed.success || !authorizationParsed.success) return;
    const ids = await taskRevisionIds(taskParsed.data);
    expect(authorizationParsed.data.task).toMatchObject({
      envelopeDigest: await canonicalSha256(taskParsed.data),
      revisionDigest: await taskRevisionDigest(taskParsed.data),
      taskId: ids.taskId,
      runId: ids.runId,
      attemptId: analysisAttemptId(ids.runId),
    });
    expect(await workflowHibernateWindowAuthorityDigest(authorizationParsed.data))
      .toBe(authorizationParsed.data.authorityDigest);
  });

  it('binds authorization to the exact Task, source, before and one conditional after', async () => {
    const auth = await authorization();
    expect(WorkflowHibernateWindowAuthorizationV1Schema.safeParse(auth).success).toBe(true);
    const deps = dependencies(auth);
    await expect(executeWorkflowHibernateLiveWindow(auth, task(), deps)).resolves.toEqual({
      schemaVersion: '1',
      authorizationId: auth.authorizationId,
      taskId: auth.task.taskId,
      runId: auth.task.runId,
      attemptId: auth.task.attemptId,
      actionBaseSha: ACTION_SHA,
      beforeDeploymentId: BEFORE_DEPLOYMENT_ID,
      afterDeploymentId: AFTER_DEPLOYMENT_ID,
      afterVersionId: AFTER_VERSION_ID,
      taskCreateRequests: 1,
      afterDeployRequests: 1,
      rollbackRequests: 0,
    });
    expect(deps.verifyFrozenSource).toHaveBeenCalledOnce();
    expect(deps.readBeforeDeployment).toHaveBeenCalledOnce();
    expect(deps.taskExists).toHaveBeenCalledOnce();
    expect(deps.createTask).toHaveBeenCalledOnce();
    expect(deps.deployAfter).toHaveBeenCalledOnce();
  });

  it('resumes an existing exact Task without a second Task POST', async () => {
    const auth = await authorization({ resumeExistingTask: true });
    const deps = dependencies(auth, { taskExists: vi.fn().mockResolvedValue(true) });
    await expect(resumeWorkflowHibernateLiveWindow(auth, task(), deps)).resolves.toEqual({
      schemaVersion: '1',
      authorizationId: auth.authorizationId,
      taskId: auth.task.taskId,
      runId: auth.task.runId,
      attemptId: auth.task.attemptId,
      actionBaseSha: ACTION_SHA,
      beforeDeploymentId: BEFORE_DEPLOYMENT_ID,
      afterDeploymentId: AFTER_DEPLOYMENT_ID,
      afterVersionId: AFTER_VERSION_ID,
      taskCreateRequests: 0,
      afterDeployRequests: 1,
      rollbackRequests: 0,
    });
    expect(deps.taskExists).toHaveBeenCalledOnce();
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.deployAfter).toHaveBeenCalledOnce();
  });

  it('requires explicit resume authority and the pre-existing exact Task', async () => {
    const normal = await authorization();
    const normalDeps = dependencies(normal);
    await expect(resumeWorkflowHibernateLiveWindow(normal, task(), normalDeps))
      .rejects.toMatchObject({ code: 'authorization_invalid' });
    expect(normalDeps.verifyFrozenSource).not.toHaveBeenCalled();

    const resume = await authorization({ resumeExistingTask: true });
    const missingDeps = dependencies(resume, { taskExists: vi.fn().mockResolvedValue(false) });
    await expect(resumeWorkflowHibernateLiveWindow(resume, task(), missingDeps))
      .rejects.toMatchObject({ code: 'task_not_found' });
    expect(missingDeps.createTask).not.toHaveBeenCalled();
    expect(missingDeps.deployAfter).not.toHaveBeenCalled();
  });

  it('rejects expired or Task-drifted authority before any live read', async () => {
    const auth = await authorization();
    for (const candidate of [
      await authorization({ expiresAt: '2026-07-29T05:54:59.000Z' }),
      auth,
    ]) {
      const deps = dependencies(candidate, {
        now: () => new Date('2026-07-29T05:55:00.000Z'),
      });
      const input = candidate === auth ? { ...task(), eventId: 'changed-event' } : task();
      await expect(executeWorkflowHibernateLiveWindow(candidate, input, deps))
        .rejects.toBeInstanceOf(WorkflowHibernateLiveWindowError);
      expect(deps.verifyFrozenSource).not.toHaveBeenCalled();
      expect(deps.createTask).not.toHaveBeenCalled();
    }
  });

  it('rejects a modified authorization whose canonical authority digest is stale', async () => {
    const auth = await authorization();
    auth.analysisWorkflowHeadSha = 'f'.repeat(40);
    const deps = dependencies(auth);
    await expect(executeWorkflowHibernateLiveWindow(auth, task(), deps))
      .rejects.toMatchObject({ code: 'authorization_invalid' });
    expect(deps.verifyFrozenSource).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ['source drift', { verifyFrozenSource: vi.fn().mockResolvedValue({ headSha: 'f'.repeat(40), bundleSha256: BUNDLE_SHA256, bundleBytes: 2_808_881, matchingBundleBuilds: 2, clean: true }) }],
    ['before drift', { readBeforeDeployment: vi.fn().mockResolvedValue({ deploymentId: AFTER_DEPLOYMENT_ID, versionId: BEFORE_VERSION_ID, createdAt: '2026-07-29T04:56:43.836Z', trafficPercentage: 100 }) }],
    ['existing Task', { taskExists: vi.fn().mockResolvedValue(true) }],
  ])('stops before Task creation on %s', async (_name, override) => {
    const auth = await authorization();
    const deps = dependencies(auth, override as Partial<WorkflowHibernateLiveWindowDependencies>);
    await expect(executeWorkflowHibernateLiveWindow(auth, task(), deps))
      .rejects.toBeInstanceOf(WorkflowHibernateLiveWindowError);
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.deployAfter).not.toHaveBeenCalled();
  });

  it('polls only not-ready snapshots and never creates a second Task', async () => {
    const auth = await authorization();
    const notReady = new WorkflowHibernateLiveWindowError('live_snapshot_not_ready');
    const readSnapshot = vi.fn()
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockResolvedValue(snapshot(auth));
    const deps = dependencies(auth, { readSnapshot });
    await expect(executeWorkflowHibernateLiveWindow(auth, task(), deps))
      .resolves.toMatchObject({ taskCreateRequests: 1, afterDeployRequests: 1 });
    expect(deps.createTask).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it('times out or loses the second guard without deploying or rollback', async () => {
    const auth = await authorization();
    let timestamp = Date.parse('2026-07-29T05:50:00.000Z');
    const deps = dependencies(auth, {
      readSnapshot: vi.fn().mockRejectedValue(
        new WorkflowHibernateLiveWindowError('live_snapshot_not_ready'),
      ),
      sleep: async () => { timestamp += 60_000; },
      now: () => new Date(timestamp),
    });
    await expect(executeWorkflowHibernateLiveWindow(auth, task(), deps))
      .rejects.toMatchObject({ code: 'live_window_timeout' });
    expect(deps.createTask).toHaveBeenCalledOnce();
    expect(deps.deployAfter).not.toHaveBeenCalled();
  });

  it('keeps the production command behind opt-in before file or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_WORKFLOW_HIBERNATE_WINDOW;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/run-workflow-hibernate-window.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('workflow-hibernate-window: opt-in missing');
  });

  it('returns configuration exit 2 before any input read when opt-in config is incomplete', () => {
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/run-workflow-hibernate-window.ts'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DELIVERY_LOOP_WORKFLOW_HIBERNATE_WINDOW: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('required production configuration is incomplete');
  });

  it('returns file-unavailable exit 2 without reaching commands or network', () => {
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/run-workflow-hibernate-window.ts'],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          DELIVERY_LOOP_WORKFLOW_HIBERNATE_WINDOW: '1',
          WORKFLOW_HIBERNATE_WINDOW_AUTHORIZATION_FILE:
            '/tmp/delivery-loop-window-missing-authorization-168.json',
          WORKFLOW_HIBERNATE_WINDOW_TASK_FILE:
            '/tmp/delivery-loop-window-missing-task-168.json',
          WORKFLOW_HIBERNATE_WINDOW_SOURCE_DIRECTORY: '/tmp/frozen-source-not-read',
          WORKFLOW_HIBERNATE_WINDOW_WRANGLER_BINARY: '/tmp/wrangler-not-run',
          WORKFLOW_HIBERNATE_WINDOW_CONTROL_PLANE_URL: 'https://control.invalid',
          WORKFLOW_HIBERNATE_WINDOW_TASK_TOKEN: 'task-token-not-sent-1111',
          WORKFLOW_HIBERNATE_WINDOW_OPERATIONS_TOKEN: 'operations-token-not-sent-2222',
          WORKFLOW_HIBERNATE_WINDOW_GITHUB_TOKEN: 'github-token-not-sent-3333',
          WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_READ_TOKEN: 'cf-read-token-not-sent-4444',
          WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_DEPLOY_TOKEN: 'cf-deploy-token-not-sent-5555',
          WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_ACCOUNT_ID:
            'b8488957e88658039d2a38fb8f160514',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('production input is unavailable');
    expect(result.stderr).not.toContain('not-sent');
  });
});
