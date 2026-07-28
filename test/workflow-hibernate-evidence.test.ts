import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  WorkflowHibernateEvidenceManifestV1Schema,
  type WorkflowHibernateEvidenceManifestV1,
} from '../src/domain/workflow-hibernate-evidence.js';
import { verifyWorkflowHibernateEvidence } from '../src/pilot/workflow-hibernate-evidence-verifier.js';

const REPOSITORY = 'example/delivery-target';
const RUN_ID = 'run-hibernate-1';
const ATTEMPT_ID = 'attempt-hibernate-analysis-1';
const ACTION_RUN_ID = '930001';
const BASE_SHA = 'a'.repeat(40);
const CONTROL_TOKEN = 'CANARY_HIBERNATE_CONTROL_TOKEN';
const OPERATIONS_TOKEN = 'CANARY_HIBERNATE_OPERATIONS_TOKEN';
const GITHUB_TOKEN = 'CANARY_HIBERNATE_GITHUB_TOKEN';
const CLOUDFLARE_TOKEN = 'CANARY_HIBERNATE_CLOUDFLARE_TOKEN';
const CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
const SECURITY_CANARY = `ghp_${'H'.repeat(36)}`;
const CONTROL_ORIGIN = 'https://control.example';
const GITHUB_ORIGIN = 'https://api.github.test';
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.test/client/v4';
const BEFORE_DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const BEFORE_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const AFTER_DEPLOYMENT_ID = '33333333-3333-4333-8333-333333333333';
const AFTER_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const INSTANCE_VERSION_ID = '55555555-5555-4555-8555-555555555555';
const INSTANCE_STARTED_AT = '2026-07-27T02:00:00.000Z';
const WAIT_STARTED_AT = '2026-07-27T02:02:00.000Z';
const REDEPLOYED_AT = '2026-07-27T02:10:00.000Z';
const WAIT_ENDED_AT = '2026-07-27T02:20:00.000Z';

type Manifest = WorkflowHibernateEvidenceManifestV1;
type Drift =
  | 'none'
  | 'control'
  | 'projection'
  | 'cloudflare_deployment'
  | 'cloudflare_extra_deployment'
  | 'cloudflare_step'
  | 'github_run'
  | 'github_duplicate'
  | 'pagination'
  | 'oversize'
  | 'case8_digest'
  | 'controlled_replay'
  | 'credential_canary';

function platformSteps(drift: Drift = 'none'): Array<Record<string, unknown>> {
  const dispatchEnd = drift === 'cloudflare_step'
    ? '2026-07-27T02:11:00.000Z' : '2026-07-27T02:01:30.000Z';
  return [
    {
      name: 'register-run', type: 'step', start: '2026-07-27T02:00:10.000Z',
      end: '2026-07-27T02:00:30.000Z', success: true,
      attempts: [{ start: '2026-07-27T02:00:10.000Z', end: '2026-07-27T02:00:30.000Z', success: true }],
    },
    {
      name: 'dispatch-analysis-attempt', type: 'step', start: '2026-07-27T02:01:00.000Z',
      end: dispatchEnd, success: true,
      attempts: [{ start: '2026-07-27T02:01:00.000Z', end: dispatchEnd, success: true }],
    },
    {
      name: 'await-analysis-result', type: 'waitForEvent',
      start: WAIT_STARTED_AT, end: WAIT_ENDED_AT,
    },
    {
      name: 'verify-analysis-result', type: 'step', start: '2026-07-27T02:20:05.000Z',
      end: '2026-07-27T02:20:20.000Z', success: true,
      attempts: [{ start: '2026-07-27T02:20:05.000Z', end: '2026-07-27T02:20:20.000Z', success: true }],
    },
    {
      name: 'activate-analysis-plan', type: 'step', start: '2026-07-27T02:20:25.000Z',
      end: '2026-07-27T02:20:40.000Z', success: true,
      attempts: [{ start: '2026-07-27T02:20:25.000Z', end: '2026-07-27T02:20:40.000Z', success: true }],
    },
    {
      name: 'observe-run-control-state', type: 'step', start: '2026-07-27T02:20:45.000Z',
      end: '2026-07-27T02:21:00.000Z', success: true,
      attempts: [{ start: '2026-07-27T02:20:45.000Z', end: '2026-07-27T02:21:00.000Z', success: true }],
    },
    {
      name: 'await-run-terminal', type: 'waitForEvent', start: '2026-07-27T02:21:05.000Z',
    },
  ];
}

async function safeStepDigest(): Promise<string> {
  return await canonicalSha256(platformSteps());
}

async function manifest(): Promise<Manifest> {
  const input: Manifest = {
    schemaVersion: '1',
    evidenceId: 'workflow-hibernate-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-27T02:30:00.000Z',
    case8ReportDigest: `sha256:${'0'.repeat(64)}`,
    safety: { canaryDigest: await canonicalSha256(SECURITY_CANARY) },
    run: {
      runId: RUN_ID,
      state: 'awaiting_approval',
      version: 8,
      taskRevision: 'revision-hibernate-1',
      baseSha: BASE_SHA,
      planId: 'plan-hibernate-1',
      planVersion: 1,
      planDigest: `sha256:${'1'.repeat(64)}`,
    },
    analysis: {
      attemptId: ATTEMPT_ID,
      attemptStatus: 'completed',
      dispatchOutboxId: 'outbox-hibernate-analysis-dispatch',
      actionRunId: ACTION_RUN_ID,
      actionUrl: `https://github.com/${REPOSITORY}/actions/runs/${ACTION_RUN_ID}`,
      workflowPath: '.github/workflows/delivery-agent.yml',
      workflowHeadSha: BASE_SHA,
      headBranch: 'main',
      actionConclusion: 'success',
    },
    cloudflare: {
      accountIdDigest: await canonicalSha256(CLOUDFLARE_ACCOUNT_ID),
      workerScriptName: 'delivery-loop-control-plane',
      workflowName: 'delivery-run',
      instanceVersionId: INSTANCE_VERSION_ID,
      instanceStatus: 'waiting',
      instanceStartedAt: INSTANCE_STARTED_AT,
      beforeDeployment: {
        deploymentId: BEFORE_DEPLOYMENT_ID,
        versionId: BEFORE_VERSION_ID,
        createdAt: '2026-07-27T01:50:00.000Z',
      },
      afterDeployment: {
        deploymentId: AFTER_DEPLOYMENT_ID,
        versionId: AFTER_VERSION_ID,
        createdAt: REDEPLOYED_AT,
      },
      hibernateWait: {
        name: 'await-analysis-result',
        startedAt: WAIT_STARTED_AT,
        endedAt: WAIT_ENDED_AT,
      },
      platformStepsDigest: await safeStepDigest(),
      auditUrls: {
        workflowInstance: 'https://dash.cloudflare.com/example/workflows/delivery-run/instances/run-hibernate-1',
        beforeDeployment: `https://dash.cloudflare.com/example/workers/services/view/delivery-loop-control-plane/production/deployments/${BEFORE_DEPLOYMENT_ID}`,
        afterDeployment: `https://dash.cloudflare.com/example/workers/services/view/delivery-loop-control-plane/production/deployments/${AFTER_DEPLOYMENT_ID}`,
      },
    },
    noDuplicate: {
      analysisAttempts: 1,
      analysisDispatchOutboxes: 1,
      githubActionRuns: 1,
      workflowInstances: 1,
    },
  };
  input.case8ReportDigest = await canonicalSha256(auditBody(input));
  return input;
}

function auditBody(input: Manifest, withReplay = false) {
  return {
    schemaVersion: '1',
    runId: RUN_ID,
    run: { state: input.run.state, version: input.run.version, baseSha: BASE_SHA },
    task: { repository: REPOSITORY, revision: input.run.taskRevision },
    answers: {
      who: { attempts: [{
        attemptId: ATTEMPT_ID, ordinal: 1, mode: 'analysis',
        status: input.analysis.attemptStatus,
        githubRunId: ACTION_RUN_ID,
        githubStatus: 'completed', githubConclusion: 'success', baseSha: BASE_SHA,
      }] },
      sourceEvents: [],
      permissions: { grants: [], repositoryWriteCredentials: [] },
      contextReads: [],
      changes: [],
      checks: {
        effectOutboxes: [{
          id: input.analysis.dispatchOutboxId,
          kind: 'analysis_dispatch', state: 'settled', attemptCount: 1,
          createdAt: '2026-07-27T02:01:00.000Z',
        }],
        replays: withReplay ? [{ replayId: 'replay-hibernate-repair' }] : [],
      },
      approvals: [],
      deployments: [],
    },
    digests: {},
    links: [],
  };
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function cloudflareResult(result: unknown): Record<string, unknown> {
  return { success: true, errors: [], messages: [], result };
}

function fakeFetch(input: Manifest, drift: Drift = 'none'): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (url.origin === CONTROL_ORIGIN) {
      if (url.pathname.endsWith('/plan')) {
        const factDigest = await canonicalSha256({ workflowInstanceId: RUN_ID, status: 'waiting' });
        const projection = {
          run: {
            id: RUN_ID,
            state: drift === 'control' ? 'planning' : input.run.state,
            version: input.run.version,
            taskRevision: input.run.taskRevision,
            baseSha: BASE_SHA,
            workflowInstance: {
              id: RUN_ID,
              runVersion: input.run.version,
              d1State: input.run.state,
              platformStatus: drift === 'projection' ? 'running' : 'waiting',
              factDigest,
              checkedAt: '2026-07-27T02:25:00.000Z',
              reconciliations: [],
            },
          },
          plan: {
            id: input.run.planId,
            version: input.run.planVersion,
            taskRevision: input.run.taskRevision,
            baseSha: BASE_SHA,
            digest: input.run.planDigest,
            status: 'active',
            createdByAttemptId: ATTEMPT_ID,
          },
          items: [], checkpoints: [], evidence: [],
          attempts: [{
            id: ATTEMPT_ID, ordinal: 1, mode: 'analysis',
            status: input.analysis.attemptStatus, baseSha: BASE_SHA,
          }],
        };
        return json(drift === 'credential_canary'
          ? { ...projection, credentialLeak: SECURITY_CANARY }
          : projection);
      }
      const body = auditBody(input, drift === 'controlled_replay');
      return json({
        ...body,
        generatedAt: '2026-07-27T02:26:00.000Z',
        queryDurationMs: 10,
        reportDigest: drift === 'case8_digest'
          ? `sha256:${'9'.repeat(64)}`
          : await canonicalSha256(body),
      });
    }
    if (url.origin === GITHUB_ORIGIN) {
      if (url.pathname.endsWith(`/actions/runs/${ACTION_RUN_ID}`)) {
        return json({
          id: Number(ACTION_RUN_ID), repository: { full_name: REPOSITORY },
          event: 'workflow_dispatch', status: 'completed',
          conclusion: drift === 'github_run' ? 'failure' : 'success',
          head_sha: BASE_SHA, head_branch: 'main',
          path: '.github/workflows/delivery-agent.yml',
          display_title: `delivery-loop/${ATTEMPT_ID}`,
          run_attempt: 1, updated_at: '2026-07-27T02:22:00.000Z',
        });
      }
      if (url.pathname.endsWith('/actions/workflows/.github%2Fworkflows%2Fdelivery-agent.yml/runs')) {
        const run = {
          id: Number(ACTION_RUN_ID), event: 'workflow_dispatch',
          status: 'completed', conclusion: 'success', head_sha: BASE_SHA,
          head_branch: 'main', path: '.github/workflows/delivery-agent.yml',
          display_title: `delivery-loop/${ATTEMPT_ID}`,
        };
        return json(
          { total_count: drift === 'github_duplicate' ? 2 : 1,
            workflow_runs: drift === 'github_duplicate' ? [run, { ...run, id: 930002 }] : [run] },
          drift === 'pagination'
            ? { headers: { link: '<https://api.github.test/next>; rel="next"' } } : undefined,
        );
      }
    }
    if (url.origin === 'https://api.cloudflare.test') {
      if (url.pathname.endsWith(`/workflows/delivery-run/instances/${RUN_ID}`)) {
        if (drift === 'oversize') {
          return json(cloudflareResult({}), {
            headers: { 'content-length': String(2 * 1_024 * 1_024) },
          });
        }
        return json(cloudflareResult({
          versionId: INSTANCE_VERSION_ID,
          status: 'waiting',
          start: INSTANCE_STARTED_AT,
          steps: platformSteps(drift),
        }));
      }
      if (url.pathname.endsWith('/workers/scripts/delivery-loop-control-plane/deployments')) {
        const deployments = [
          {
            id: AFTER_DEPLOYMENT_ID,
            created_on: REDEPLOYED_AT,
            versions: [{
              version_id: drift === 'cloudflare_deployment'
                ? '66666666-6666-4666-8666-666666666666' : AFTER_VERSION_ID,
              percentage: 100,
            }],
          },
          {
            id: BEFORE_DEPLOYMENT_ID,
            created_on: '2026-07-27T01:50:00.000Z',
            versions: [{ version_id: BEFORE_VERSION_ID, percentage: 100 }],
          },
        ];
        if (drift === 'cloudflare_extra_deployment') {
          deployments.push({
            id: '77777777-7777-4777-8777-777777777777',
            created_on: '2026-07-27T02:05:00.000Z',
            versions: [{
              version_id: '88888888-8888-4888-8888-888888888888', percentage: 100,
            }],
          });
        }
        return json(cloudflareResult({ deployments }));
      }
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

function options(input: Manifest, drift: Drift = 'none') {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    controlPlaneToken: CONTROL_TOKEN,
    operationsToken: OPERATIONS_TOKEN,
    githubToken: GITHUB_TOKEN,
    githubApiOrigin: GITHUB_ORIGIN,
    cloudflareToken: CLOUDFLARE_TOKEN,
    cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
    canary: SECURITY_CANARY,
    cloudflareApiOrigin: CLOUDFLARE_ORIGIN,
    fetch: fakeFetch(input, drift),
  };
}

describe('Workflow hibernate and Worker redeploy external evidence', () => {
  it('binds a real wait across Worker versions to one D1 dispatch and one Action', async () => {
    const input = await manifest();
    expect(WorkflowHibernateEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/workflow-hibernate-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(WorkflowHibernateEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(WorkflowHibernateEvidenceManifestV1Schema.safeParse({
      ...input,
      cloudflare: {
        ...input.cloudflare,
        auditUrls: { ...input.cloudflare.auditUrls, workflowInstance: 'not-a-url' },
      },
    }).success).toBe(false);
    await expect(verifyWorkflowHibernateEvidence(input, options(input))).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, runId: RUN_ID,
      repository: REPOSITORY, workflowInstanceId: RUN_ID,
      beforeVersionId: BEFORE_VERSION_ID, afterVersionId: AFTER_VERSION_ID,
      verifiedStepCount: 7, analysisAttemptCount: 1,
      analysisDispatchOutboxCount: 1, githubActionRunCount: 1,
      reusedCompletedSteps: true, duplicateDispatches: 0,
      controlledReplayCount: 0, plaintextLeaks: 0,
    });
  });

  it('rejects D1 Run or Workflow projection drift', async () => {
    for (const drift of ['control', 'projection'] as const) {
      const input = await manifest();
      await expect(verifyWorkflowHibernateEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    }
  });

  it('rejects Worker deployment and durable step timing drift', async () => {
    for (const drift of [
      'cloudflare_deployment', 'cloudflare_extra_deployment', 'cloudflare_step',
    ] as const) {
      const input = await manifest();
      await expect(verifyWorkflowHibernateEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: drift.startsWith('cloudflare_deployment') ||
          drift === 'cloudflare_extra_deployment'
          ? 'cloudflare_deployment_mismatch' : 'cloudflare_instance_mismatch' });
    }
  });

  it('rejects a failed or duplicate GitHub Action for the stable attempt title', async () => {
    for (const drift of ['github_run', 'github_duplicate'] as const) {
      const input = await manifest();
      await expect(verifyWorkflowHibernateEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: drift === 'github_run'
          ? 'github_action_mismatch' : 'github_inventory_mismatch' });
    }
  });

  it('requires a recomputable Case 8 report with zero controlled replay repair', async () => {
    const input = await manifest();
    await expect(verifyWorkflowHibernateEvidence(input, options(input, 'case8_digest')))
      .rejects.toMatchObject({ code: 'control_plane_report_mismatch' });
    const replayBody = auditBody(input, true);
    const replayManifest = {
      ...input,
      case8ReportDigest: await canonicalSha256(replayBody),
    };
    await expect(verifyWorkflowHibernateEvidence(
      replayManifest,
      options(replayManifest, 'controlled_replay'),
    )).rejects.toMatchObject({ code: 'controlled_replay_detected' });
  });

  it('fails closed on pagination/oversize without propagating provider responses or tokens', async () => {
    for (const drift of ['pagination', 'oversize'] as const) {
      const input = await manifest();
      await expect(verifyWorkflowHibernateEvidence(input, options(input, drift)))
        .rejects.toBeInstanceOf(Error);
    }
    const input = await manifest();
    const raw = `RAW_${CONTROL_TOKEN}_${GITHUB_TOKEN}_${CLOUDFLARE_TOKEN}`;
    const error = await verifyWorkflowHibernateEvidence(input, {
      ...options(input), fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
    expect(String(error)).not.toContain(CLOUDFLARE_TOKEN);
    await expect(verifyWorkflowHibernateEvidence(
      input,
      options(input, 'credential_canary'),
    )).rejects.toMatchObject({ code: 'secret_leak_detected' });
  });

  it('puts every live request behind a ten-second abort signal', async () => {
    const input = await manifest();
    const signals: Array<AbortSignal | null | undefined> = [];
    const original = fakeFetch(input);
    await expect(verifyWorkflowHibernateEvidence(input, {
      ...options(input),
      fetch: (async (request, init) => {
        signals.push(init?.signal);
        return await original(request, init);
      }) as typeof fetch,
    })).resolves.toMatchObject({ reusedCompletedSteps: true });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it('keeps the named E2E command behind Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-workflow-hibernate-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('workflow-hibernate-e2e: opt-in missing');
  });
});
