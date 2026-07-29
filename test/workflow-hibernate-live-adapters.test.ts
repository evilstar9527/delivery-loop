import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TaskEnvelope } from '../src/domain/task.js';
import {
  WorkflowHibernateLiveWindowError,
  type WorkflowHibernateWindowAuthorizationV1,
} from '../src/pilot/workflow-hibernate-live-window.js';
import {
  createWorkflowHibernateLiveWindowDependencies,
  type WorkflowHibernateCommandExecutor,
  type WorkflowHibernateLiveAdapterOptions,
} from '../src/pilot/workflow-hibernate-live-adapters.js';

const SOURCE_SHA = 'e14d11e5420e04d49c042a01c562ff5432ebb98c';
const ACTION_SHA = 'a02831a15a985bb691c2f6c76f8866f09418cea6';
const BEFORE_DEPLOYMENT_ID = '8b646225-4d71-4867-aff3-f22d137a8fa5';
const BEFORE_VERSION_ID = '6911feca-acf7-476a-b10c-cc61e71aedad';
const AFTER_DEPLOYMENT_ID = 'd78d2179-cac7-42cb-97d0-41b46a91aabd';
const AFTER_VERSION_ID = '7272a1c7-4dcc-42da-b087-314e94305a9a';
const INSTANCE_VERSION_ID = '6272a1c7-4dcc-42da-b087-314e94305a9a';
const BUNDLE = 'export default { fetch() { return new Response("ok") } };\n';
const BUNDLE_SHA256 = createHash('sha256').update(BUNDLE).digest('hex');
const ACCOUNT_ID = 'b8488957e88658039d2a38fb8f160514';
const TOKENS = {
  task: 'task-window-token-111111',
  operations: 'operations-window-token-222222',
  github: 'github-window-read-333333',
  cloudflareRead: 'cloudflare-window-read-444444',
  cloudflareDeploy: 'cloudflare-window-deploy-555555',
} as const;

function task(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'hibernate-drill-20260729',
    occurredAt: '2026-07-29T05:50:00.000Z',
    source: {
      system: 'manual', tenantKey: 'delivery-loop-owner',
      taskKey: 'phase1-hibernate-drill-20260729', revision: '1',
    },
    actor: { type: 'user', id: 'owner' },
    target: {
      owner: 'evilstar9527', repo: 'delivery-loop', baseBranch: 'main', environment: 'none',
    },
    intent: {
      kind: 'requirement', title: 'Read-only Workflow hibernate drill',
      description: 'Inspect the repository and propose a read-only execution plan.',
      acceptanceCriteria: ['The proposed plan uses read-only effects.'], priority: 'p2',
    },
    policy: {
      allowRepositoryWrite: false, allowTestDeploy: false,
      allowProductionDeploy: false, requireHumanApproval: true,
    },
  };
}

function authorization(): WorkflowHibernateWindowAuthorizationV1 {
  return {
    schemaVersion: '1',
    authorizationId: 'hibernate-window-authorization-20260729',
    authorizedAt: '2026-07-29T05:49:00.000Z',
    expiresAt: '2026-07-29T06:19:00.000Z',
    authorityDigest: `sha256:${'9'.repeat(64)}`,
    repository: 'evilstar9527/delivery-loop',
    baseBranch: 'main',
    analysisWorkflowHeadSha: ACTION_SHA,
    task: {
      envelopeDigest: `sha256:${'1'.repeat(64)}`,
      revisionDigest: `sha256:${'2'.repeat(64)}`,
      taskId: 'task-hibernate-live',
      runId: 'run-hibernate-live',
      attemptId: 'attempt-run-hibernate-live-analysis',
      idempotencyKey: 'hibernate-window-20260729-v1',
    },
    source: { sha: SOURCE_SHA, bundleSha256: BUNDLE_SHA256, bundleBytes: Buffer.byteLength(BUNDLE) },
    beforeDeployment: {
      deploymentId: BEFORE_DEPLOYMENT_ID,
      versionId: BEFORE_VERSION_ID,
      createdAt: '2026-07-29T04:56:43.836Z',
    },
    effects: { taskCreates: 1, analysisActions: 1, afterDeployments: 1, rollbacks: 0 },
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function cloudflare(result: unknown): unknown {
  return { success: true, errors: [], messages: [], result };
}

function deployment(id: string, versionId: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    created_on: createdAt,
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

interface FixtureOptions {
  driftSecondBuild?: boolean;
  deploymentCommandFails?: boolean;
  planNotFound?: boolean;
  duplicateAction?: boolean;
  duplicateDispatch?: boolean;
  pagination?: boolean;
  oversize?: boolean;
  leakedSecret?: boolean;
  deploymentVisibilityLag?: boolean;
}

function fixture(options: FixtureOptions = {}): {
  adapterOptions: WorkflowHibernateLiveAdapterOptions;
  command: WorkflowHibernateCommandExecutor;
  commandRequests: Array<Parameters<WorkflowHibernateCommandExecutor>[0]>;
  fetchRequests: Array<{ url: URL; authorization: string; method: string }>;
} {
  let buildCount = 0;
  let deployed = false;
  let postDeployReads = 0;
  const commandRequests: Array<Parameters<WorkflowHibernateCommandExecutor>[0]> = [];
  const command: WorkflowHibernateCommandExecutor = async (request) => {
    commandRequests.push(request);
    if (request.command === 'git' && request.args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${SOURCE_SHA}\n`, stderr: '' };
    }
    if (request.command === 'git' && request.args[0] === 'status') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (request.command === '/trusted/wrangler' && request.args.includes('--dry-run')) {
      buildCount += 1;
      const outdir = request.args[request.args.indexOf('--outdir') + 1]!;
      await writeFile(
        join(outdir, 'worker.js'),
        options.driftSecondBuild && buildCount === 2 ? `${BUNDLE}// drift\n` : BUNDLE,
      );
      return { exitCode: 0, stdout: 'dry build output', stderr: '' };
    }
    if (request.command === '/trusted/wrangler' && request.args[0] === 'deploy') {
      deployed = !options.deploymentCommandFails;
      return options.deploymentCommandFails
        ? { exitCode: 1, stdout: TOKENS.cloudflareDeploy, stderr: TOKENS.task }
        : { exitCode: 0, stdout: 'provider output is deliberately ignored', stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: '' };
  };

  const auth = authorization();
  const fetchRequests: Array<{ url: URL; authorization: string; method: string }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    fetchRequests.push({
      url,
      authorization: headers.get('authorization') ?? '',
      method: init?.method ?? 'GET',
    });
    if (options.leakedSecret) return json({ detail: TOKENS.task });
    if (options.oversize) {
      return json({}, { headers: { 'content-length': String(2 * 1_024 * 1_024) } });
    }
    if (url.pathname === `/v1/tasks/${auth.task.taskId}`) {
      return json({ code: 'not_found' }, { status: 404 });
    }
    if (url.pathname === '/v1/tasks' && init?.method === 'POST') {
      return json({ accepted: true, taskId: auth.task.taskId, runId: auth.task.runId }, {
        status: 202,
      });
    }
    if (url.pathname === `/v1/runs/${auth.task.runId}/plan`) {
      if (options.planNotFound) return json({ code: 'not_found' }, { status: 404 });
      return json({
        run: { id: auth.task.runId, state: 'planning', baseSha: ACTION_SHA },
        plan: null,
        attempts: [{ id: auth.task.attemptId, mode: 'analysis', status: 'running' }],
      });
    }
    if (url.pathname === `/v1/runs/${auth.task.runId}/audit`) {
      const dispatch = {
        id: `dispatch-${auth.task.attemptId}`, kind: 'analysis_dispatch', state: 'settled',
      };
      return json({
        answers: {
          checks: {
            effectOutboxes: options.duplicateDispatch ? [dispatch, { ...dispatch }] : [dispatch],
          },
        },
      });
    }
    if (url.pathname.endsWith(`/workflows/delivery-run/instances/${auth.task.runId}`)) {
      return json(cloudflare({
        versionId: INSTANCE_VERSION_ID,
        status: 'waiting',
        steps: [
          {
            name: 'register-run', type: 'step', success: true,
            start: '2026-07-29T05:51:59.000Z', end: '2026-07-29T05:52:00.000Z',
          },
          {
            name: 'dispatch-analysis-attempt', type: 'step', success: true,
            start: '2026-07-29T05:52:00.100Z', end: '2026-07-29T05:52:01.000Z',
          },
          {
            name: 'await-analysis-result', type: 'waitForEvent',
            start: '2026-07-29T05:52:01.100Z',
          },
        ],
      }));
    }
    if (url.pathname.endsWith('/workers/scripts/delivery-loop-control-plane/deployments')) {
      if (deployed) postDeployReads += 1;
      const afterVisible = deployed &&
        (!options.deploymentVisibilityLag || postDeployReads > 1);
      const response = json(cloudflare({
        deployments: afterVisible
          ? [
            deployment(AFTER_DEPLOYMENT_ID, AFTER_VERSION_ID, '2026-07-29T05:55:01.000Z'),
            deployment(BEFORE_DEPLOYMENT_ID, BEFORE_VERSION_ID, '2026-07-29T04:56:43.836Z'),
          ]
          : [deployment(BEFORE_DEPLOYMENT_ID, BEFORE_VERSION_ID, '2026-07-29T04:56:43.836Z')],
      }), options.pagination ? {
        headers: { link: '<https://api.cloudflare.test/client/v4/next>; rel="next"' },
      } : undefined);
      return response;
    }
    if (url.pathname.endsWith('/actions/workflows/.github%2Fworkflows%2Fdelivery-agent.yml/runs')) {
      const action = {
        id: 30430000001,
        event: 'workflow_dispatch',
        status: 'in_progress',
        conclusion: null,
        display_title: `delivery-loop/${auth.task.attemptId}`,
        head_branch: 'main',
        head_sha: ACTION_SHA,
        path: '.github/workflows/delivery-agent.yml',
      };
      const inventory = options.duplicateAction ? [action, { ...action, id: 30430000002 }] : [action];
      return json({ total_count: inventory.length, workflow_runs: inventory });
    }
    return json({ code: 'missing' }, { status: 404 });
  }) as typeof fetch;

  return {
    command,
    commandRequests,
    fetchRequests,
    adapterOptions: {
      sourceDirectory: '/frozen/source',
      wranglerBinary: '/trusted/wrangler',
      controlPlaneOrigin: 'https://control.test',
      taskToken: TOKENS.task,
      operationsToken: TOKENS.operations,
      githubToken: TOKENS.github,
      cloudflareReadToken: TOKENS.cloudflareRead,
      cloudflareDeployToken: TOKENS.cloudflareDeploy,
      cloudflareAccountId: ACCOUNT_ID,
      githubApiOrigin: 'https://api.github.test',
      cloudflareApiOrigin: 'https://api.cloudflare.test/client/v4',
      fetch: fetcher,
      command,
      now: () => new Date('2026-07-29T05:55:00.000Z'),
      sleep: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WorkflowHibernateLiveWindowError && error.code === code;
}

describe('Workflow hibernate live adapters', () => {
  it('collects the exact live snapshot with purpose-separated credentials', async () => {
    const auth = authorization();
    const current = fixture();
    const dependencies = createWorkflowHibernateLiveWindowDependencies(current.adapterOptions);
    await expect(dependencies.verifyFrozenSource(auth)).resolves.toEqual({
      headSha: SOURCE_SHA,
      bundleSha256: BUNDLE_SHA256,
      bundleBytes: Buffer.byteLength(BUNDLE),
      matchingBundleBuilds: 2,
      clean: true,
    });
    await expect(dependencies.readBeforeDeployment(auth)).resolves.toMatchObject({
      deploymentId: BEFORE_DEPLOYMENT_ID, versionId: BEFORE_VERSION_ID, trafficPercentage: 100,
    });
    await expect(dependencies.taskExists(auth)).resolves.toBe(false);
    await expect(dependencies.createTask(task(), auth)).resolves.toEqual({
      accepted: true, taskId: auth.task.taskId, runId: auth.task.runId,
    });
    await expect(dependencies.readSnapshot(auth)).resolves.toMatchObject({
      observedAt: '2026-07-29T05:55:00.000Z',
      run: { runId: auth.task.runId, analysisAttemptCount: 1, analysisDispatchOutboxCount: 1 },
      analysis: {
        attemptId: auth.task.attemptId, actionRunId: '30430000001', actionRunCount: 1,
      },
      workflow: { instanceId: auth.task.runId, status: 'waiting', resumedStepCount: 0 },
    });

    const reads = current.fetchRequests.map((request) => [
      request.url.pathname, request.authorization, request.method,
    ]);
    expect(reads).toContainEqual([
      `/v1/tasks/${auth.task.taskId}`, `Bearer ${TOKENS.task}`, 'GET',
    ]);
    expect(reads).toContainEqual(['/v1/tasks', `Bearer ${TOKENS.task}`, 'POST']);
    expect(reads).toContainEqual([
      `/v1/runs/${auth.task.runId}/audit`, `Bearer ${TOKENS.operations}`, 'GET',
    ]);
    expect(reads.some(([path, token]) =>
      String(path).includes('/workflows/delivery-run/instances/') &&
      token === `Bearer ${TOKENS.cloudflareRead}`)).toBe(true);
    expect(reads.some(([path, token]) =>
      String(path).includes('/actions/workflows/') &&
      token === `Bearer ${TOKENS.github}`)).toBe(true);
    expect(reads.some(([, token]) => token === `Bearer ${TOKENS.cloudflareDeploy}`)).toBe(false);
  });

  it('runs exactly two deterministic dry builds and one strict token-isolated deploy', async () => {
    const auth = authorization();
    const current = fixture({ deploymentVisibilityLag: true });
    const dependencies = createWorkflowHibernateLiveWindowDependencies(current.adapterOptions);
    await dependencies.verifyFrozenSource(auth);
    const request = {
      runId: auth.task.runId,
      sourceSha: SOURCE_SHA,
      bundleSha256: BUNDLE_SHA256,
      expectedBeforeDeploymentId: BEFORE_DEPLOYMENT_ID,
      message: `phase1-hibernate-after run@${auth.task.runId}`,
      strict: true as const,
    };
    await expect(dependencies.deployAfter(request)).resolves.toMatchObject({
      deployment: {
        deploymentId: AFTER_DEPLOYMENT_ID, versionId: AFTER_VERSION_ID, trafficPercentage: 100,
      },
      deploymentsDuringWait: 1,
    });
    const wrangler = current.commandRequests.filter((request) =>
      request.command === '/trusted/wrangler');
    expect(wrangler.map((request) => request.args)).toEqual([
      [
        'deploy', '--dry-run', '--outdir', expect.any(String),
        '--env-file', expect.stringMatching(/\/delivery-loop-hibernate-[^/]+\/empty\.env$/),
        '--config', '/frozen/source/wrangler.jsonc',
      ],
      [
        'deploy', '--dry-run', '--outdir', expect.any(String),
        '--env-file', expect.stringMatching(/\/delivery-loop-hibernate-[^/]+\/empty\.env$/),
        '--config', '/frozen/source/wrangler.jsonc',
      ],
      [
        'deploy', expect.stringMatching(/\/delivery-loop-hibernate-upload-[^/]+\/worker\.js$/),
        '--no-bundle', '--strict', '--message', `phase1-hibernate-after run@${auth.task.runId}`,
        '--env-file',
        expect.stringMatching(/\/delivery-loop-hibernate-upload-[^/]+\/empty\.env$/),
        '--config', '/frozen/source/wrangler.jsonc',
      ],
    ]);
    for (const request of wrangler.slice(0, 2)) {
      expect(request.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
      expect(request.env.HOME).toMatch(/\/delivery-loop-hibernate-[^/]+$/);
      expect(request.env.XDG_CONFIG_HOME).toBe(request.env.HOME);
    }
    expect(wrangler[2]!.env.CLOUDFLARE_API_TOKEN).toBe(TOKENS.cloudflareDeploy);
    expect(wrangler[2]!.env.HOME).toMatch(/\/delivery-loop-hibernate-upload-[^/]+$/);
    expect(wrangler[2]!.env.XDG_CONFIG_HOME).toBe(wrangler[2]!.env.HOME);
    expect(wrangler.flatMap((request) => request.args).join(' ')).not.toContain('token-');
    expect(Object.values(wrangler[2]!.env)).not.toContain(TOKENS.cloudflareRead);
    expect(Object.values(wrangler[2]!.env)).not.toContain(TOKENS.task);
    expect(current.adapterOptions.sleep).toHaveBeenCalledWith(500);
    await expect(dependencies.deployAfter(request)).rejects.toSatisfy(
      expectCode('after_deploy_failed'),
    );
    expect(current.commandRequests.filter((candidate) =>
      candidate.args.includes('--strict'))).toHaveLength(1);
  });

  it('rejects a second-build drift before any Task or deployment effect', async () => {
    const auth = authorization();
    const current = fixture({ driftSecondBuild: true });
    const dependencies = createWorkflowHibernateLiveWindowDependencies(current.adapterOptions);
    await expect(dependencies.verifyFrozenSource(auth)).rejects.toSatisfy(
      expectCode('source_verification_failed'),
    );
    expect(current.fetchRequests).toHaveLength(0);
    expect(current.commandRequests.some((request) =>
      request.args.includes('--strict'))).toBe(false);
  });

  it.each([
    ['404 projection', { planNotFound: true }, 'live_snapshot_not_ready'],
    ['duplicate action', { duplicateAction: true }, 'live_snapshot_conflict'],
    ['duplicate outbox', { duplicateDispatch: true }, 'live_snapshot_conflict'],
    ['pagination', { pagination: true }, 'external_response_invalid'],
    ['oversize response', { oversize: true }, 'external_response_invalid'],
    ['Secret response', { leakedSecret: true }, 'secret_leak_detected'],
  ] as const)('fails closed on %s', async (_name, options, code) => {
    const auth = authorization();
    const current = fixture(options);
    const dependencies = createWorkflowHibernateLiveWindowDependencies(current.adapterOptions);
    await dependencies.verifyFrozenSource(auth);
    const externalRead = 'pagination' in options || 'oversize' in options ||
      'leakedSecret' in options;
    const operation = externalRead
      ? dependencies.readBeforeDeployment(auth)
      : dependencies.readSnapshot(auth);
    await expect(operation).rejects.toSatisfy(expectCode(code));
  });

  it('folds raw deploy output to a fixed error without leaking credentials', async () => {
    const auth = authorization();
    const current = fixture({ deploymentCommandFails: true });
    const dependencies = createWorkflowHibernateLiveWindowDependencies(current.adapterOptions);
    await dependencies.verifyFrozenSource(auth);
    let failure: unknown;
    try {
      await dependencies.deployAfter({
        runId: auth.task.runId,
        sourceSha: SOURCE_SHA,
        bundleSha256: BUNDLE_SHA256,
        expectedBeforeDeploymentId: BEFORE_DEPLOYMENT_ID,
        message: `phase1-hibernate-after run@${auth.task.runId}`,
        strict: true,
      });
    } catch (error) { failure = error; }
    expect(failure).toSatisfy(expectCode('after_deploy_failed'));
    expect(String(failure)).not.toContain(TOKENS.cloudflareDeploy);
    expect(String(failure)).not.toContain(TOKENS.task);
  });

  it('rejects credential-shaped Task content before the intake request', async () => {
    const auth = authorization();
    const current = fixture();
    const dependencies = createWorkflowHibernateLiveWindowDependencies(current.adapterOptions);
    const unsafe = task();
    unsafe.intent.description = TOKENS.github;
    await expect(dependencies.createTask(unsafe, auth)).rejects.toSatisfy(
      expectCode('secret_leak_detected'),
    );
    expect(current.fetchRequests).toHaveLength(0);
    expect(current.commandRequests).toHaveLength(0);
  });

  it('rejects shared read/deploy authority before commands or network', () => {
    const current = fixture();
    let failure: unknown;
    try {
      createWorkflowHibernateLiveWindowDependencies({
        ...current.adapterOptions,
        cloudflareDeployToken: TOKENS.cloudflareRead,
      });
    } catch (error) { failure = error; }
    expect(failure).toSatisfy(expectCode('configuration_invalid'));
    expect(current.fetchRequests).toHaveLength(0);
    expect(current.commandRequests).toHaveLength(0);
  });
});
