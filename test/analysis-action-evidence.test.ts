import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_RUNNER_CONTRACT_PATHS,
  AnalysisActionEvidenceManifestV1Schema,
  type AnalysisActionEvidenceManifestV1,
} from '../src/domain/analysis-action-evidence.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import type { GitHubAppDispatchEvidenceManifestV1 } from
  '../src/domain/github-app-dispatch-evidence.js';
import {
  ANALYSIS_RUNNER_TRANSITIVE_CONTRACT_PATHS,
  AnalysisActionEvidenceVerificationError,
  verifyAnalysisActionEvidence,
} from '../src/pilot/analysis-action-evidence-verifier.js';

const REPOSITORY = 'example/delivery-target';
const REPOSITORY_ID = '87654321';
const APP_ID = '123456';
const INSTALLATION_ID = '654321';
const TASK_ID = 'task-analysis-action-1';
const RUN_ID = 'run-analysis-action-1';
const ATTEMPT_ID = 'attempt-analysis-action-1';
const OUTBOX_ID = 'outbox-analysis-action-1';
const ACTION_RUN_ID = '940001';
const BASE_SHA = 'a'.repeat(40);
const WORKFLOW_BLOB_SHA = 'b'.repeat(40);
const APP_JWT = 'CANARY_ANALYSIS_ACTION_APP_JWT';
const INSTALLATION_TOKEN = 'CANARY_ANALYSIS_ACTION_INSTALLATION_TOKEN';
const CONTROL_TOKEN = 'CANARY_ANALYSIS_ACTION_CONTROL_TOKEN';
const OPERATIONS_TOKEN = 'CANARY_ANALYSIS_ACTION_OPERATIONS_TOKEN';
const CONTROL_ORIGIN = 'https://control.example';
const GITHUB_ORIGIN = 'https://api.github.test';
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';
const WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`;
const TASK_DIGEST = `sha256:${'1'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'2'.repeat(64)}`;
const PLAN_ID = 'plan-analysis-action-1';
const EVIDENCE_REFS = ['d1://evidence/source-inspection-1'];
const OBJECTIVE = 'Diagnose the reported behavior and prepare a verified execution plan.';
const CODEX_VERSION = '0.145.0';
const WORKFLOW_SOURCE = readFileSync(
  new URL('../.github/workflows/delivery-agent.yml', import.meta.url),
  'utf8',
);
const SOURCE_CONTENT: ReadonlyMap<string, string> = new Map(
  [...ANALYSIS_RUNNER_CONTRACT_PATHS, ...ANALYSIS_RUNNER_TRANSITIVE_CONTRACT_PATHS].map((path) => [
    path,
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  ]),
);
const PLAN_ITEMS = [{
  id: 'inspect-source',
  kind: 'investigation',
  title: 'Inspect the affected code path',
  objective: 'Locate the source of the reported behavior in the trusted repository snapshot.',
  required: true,
  status: 'ready',
  progressVersion: 0,
  acceptanceCriteriaIndexes: [0],
  doneWhen: ['The source path and repair boundary are identified with a durable reference.'],
  dependsOn: [],
  effects: ['repo_read'],
  commandRefs: [],
  evidenceKinds: ['diagnostic'],
  externalFacts: [],
}];
const CONTEXT_READS = [
  ['logs', 'logs:read'],
  ['repository', 'repo:read'],
  ['traces', 'trace:read'],
].map(([category, action]) => ({
  category,
  action,
  effect: 'read',
  totalCalls: 1,
  successfulCalls: 1,
  deniedCalls: 0,
  attemptIds: [ATTEMPT_ID],
  firstObservedAt: '2026-07-27T03:01:00.000Z',
  lastObservedAt: '2026-07-27T03:20:00.000Z',
}));
const PERMISSIONS = { actions: 'write', contents: 'read', metadata: 'read' } as const;
const EVENTS = ['workflow_run'] as const;

type Manifest = AnalysisActionEvidenceManifestV1;
type Drift =
  | 'none'
  | 'task'
  | 'plan'
  | 'item'
  | 'context_write'
  | 'context_denied'
  | 'runner'
  | 'provider'
  | 'job'
  | 'oversize';

async function runnerFiles(): Promise<Manifest['runner']['files']> {
  return await Promise.all(ANALYSIS_RUNNER_CONTRACT_PATHS.map(async (path, index) => ({
    path,
    blobSha: (index + 3).toString(16).repeat(40),
    contentDigest: await canonicalSha256(SOURCE_CONTENT.get(path)!),
  }))) as Manifest['runner']['files'];
}

async function dispatchEvidence(): Promise<GitHubAppDispatchEvidenceManifestV1> {
  return {
    schemaVersion: '1',
    evidenceId: 'analysis-action-dispatch-evidence-test',
    recordedAt: '2026-07-27T03:30:00.000Z',
    app: {
      appId: APP_ID,
      slug: 'delivery-loop-test',
      ownerLogin: 'example-platform',
      ownerType: 'Organization',
      permissions: { ...PERMISSIONS },
      events: [...EVENTS],
      appUrl: 'https://github.com/apps/delivery-loop-test',
    },
    installation: {
      installationId: INSTALLATION_ID,
      targetId: '99887766',
      targetLogin: 'example',
      targetType: 'Organization',
      repositorySelection: 'selected',
      suspended: false,
      selectedRepositoryCount: 1,
      selectedRepositoriesDigest: await canonicalSha256([{
        id: REPOSITORY_ID,
        fullName: REPOSITORY,
      }]),
      settingsUrl: `https://github.com/organizations/example/settings/installations/${INSTALLATION_ID}`,
    },
    repository: {
      repositoryId: REPOSITORY_ID,
      fullName: REPOSITORY,
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      disabled: false,
    },
    dispatch: {
      runId: RUN_ID,
      runState: 'awaiting_approval',
      runVersion: 8,
      taskRevision: 'revision-analysis-action-1',
      taskDigest: TASK_DIGEST,
      baseSha: BASE_SHA,
      planId: PLAN_ID,
      planVersion: 1,
      planDigest: PLAN_DIGEST,
      attemptId: ATTEMPT_ID,
      attemptStatus: 'completed',
      dispatchOutboxId: OUTBOX_ID,
      workflowPath: WORKFLOW_PATH,
      workflowRef: WORKFLOW_REF,
      workflowBlobSha: WORKFLOW_BLOB_SHA,
      workflowContentDigest: await canonicalSha256(WORKFLOW_SOURCE),
      actionRunId: ACTION_RUN_ID,
      actionUrl: `https://github.com/${REPOSITORY}/actions/runs/${ACTION_RUN_ID}`,
      actionConclusion: 'success',
      actionUpdatedAt: '2026-07-27T03:20:00.000Z',
    },
    noDuplicate: {
      selectedRepositories: 1,
      analysisAttempts: 1,
      analysisDispatchOutboxes: 1,
      githubActionRuns: 1,
      githubJobs: 1,
    },
  };
}

async function manifest(): Promise<Manifest> {
  const files = await runnerFiles();
  const dispatch = await dispatchEvidence();
  const contractDigest = await canonicalSha256({
    sourceSha: BASE_SHA,
    codexVersion: CODEX_VERSION,
    files,
  });
  return {
    schemaVersion: '1',
    evidenceId: 'analysis-action-evidence-test',
    recordedAt: '2026-07-27T04:00:00.000Z',
    dispatchEvidence: dispatch,
    task: {
      taskId: TASK_ID,
      inputClass: 'user_feedback',
      intentKind: 'bug',
      acceptanceCriteriaCount: 1,
    },
    plan: {
      objectiveDigest: await canonicalSha256(OBJECTIVE),
      assumptionCount: 1,
      evidenceRefCount: EVIDENCE_REFS.length,
      evidenceRefsDigest: await canonicalSha256(EVIDENCE_REFS),
      itemCount: PLAN_ITEMS.length,
      itemsDigest: await canonicalSha256(PLAN_ITEMS),
    },
    context: {
      categories: ['logs', 'repository', 'traces'],
      totalCalls: 3,
      successfulCalls: 3,
      deniedCalls: 0,
      contextReadsDigest: await canonicalSha256(CONTEXT_READS),
    },
    runner: {
      sourceSha: BASE_SHA,
      codexVersion: CODEX_VERSION,
      contractDigest,
      files,
    },
    workspace: {
      checkoutSha: BASE_SHA,
      finalHeadSha: BASE_SHA,
      detachedHead: true,
      repositoryClean: true,
    },
  };
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function installationObject(): Record<string, unknown> {
  return {
    id: Number(INSTALLATION_ID),
    app_id: Number(APP_ID),
    app_slug: 'delivery-loop-test',
    target_id: 99887766,
    target_type: 'Organization',
    account: { id: 99887766, login: 'example', type: 'Organization' },
    repository_selection: 'selected',
    permissions: { ...PERMISSIONS },
    events: [...EVENTS],
    suspended_at: null,
  };
}

function workflowRun(): Record<string, unknown> {
  return {
    id: Number(ACTION_RUN_ID),
    repository: { full_name: REPOSITORY },
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: BASE_SHA,
    head_branch: 'main',
    path: WORKFLOW_PATH,
    display_title: `delivery-loop/${ATTEMPT_ID}`,
    run_attempt: 1,
    updated_at: '2026-07-27T03:20:00.000Z',
  };
}

function job(drift: Drift): Record<string, unknown> {
  return {
    id: 950001,
    name: 'attempt',
    status: 'completed',
    conclusion: 'success',
    head_sha: BASE_SHA,
    steps: [
      { name: 'Checkout trusted execution snapshot', status: 'completed', conclusion: 'success' },
      { name: 'Validate attempt mode bindings', status: 'completed', conclusion: 'success' },
      { name: 'Set up pnpm', status: 'completed', conclusion: 'success' },
      { name: 'Set up Node.js', status: 'completed', conclusion: 'success' },
      { name: 'Install locked dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Run read-only analysis attempt', status: 'completed', conclusion: 'success' },
      { name: 'Run approved execution attempt', status: 'completed', conclusion: 'skipped' },
      {
        name: 'Verify read-only workspace', status: 'completed',
        conclusion: drift === 'job' ? 'failure' : 'success',
      },
    ],
  };
}

function fakeFetch(input: Manifest, drift: Drift = 'none'): typeof fetch {
  return (async (request, init) => {
    const url = new URL(String(request));
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.origin === CONTROL_ORIGIN) {
      const expected = url.pathname.endsWith('/audit') ? OPERATIONS_TOKEN : CONTROL_TOKEN;
      if (authorization !== `Bearer ${expected}`) return new Response(null, { status: 401 });
      if (url.pathname === `/v1/tasks/${TASK_ID}`) {
        return json({
          task: {
            id: TASK_ID,
            digest: TASK_DIGEST,
            target: { repository: REPOSITORY, baseBranch: 'main', environment: 'test' },
            intent: {
              kind: drift === 'task' ? 'requirement' : 'bug',
              title: 'Reported behavior',
              priority: 'p1',
              acceptanceCriteriaCount: 1,
            },
          },
          run: { id: RUN_ID, state: 'awaiting_approval', version: 8 },
        });
      }
      if (url.pathname.endsWith('/plan')) {
        const items = structuredClone(PLAN_ITEMS);
        if (drift === 'item') items[0]!.doneWhen = [];
        return json({
          run: {
            id: RUN_ID,
            taskId: TASK_ID,
            state: input.dispatchEvidence.dispatch.runState,
            version: input.dispatchEvidence.dispatch.runVersion,
            taskRevision: input.dispatchEvidence.dispatch.taskRevision,
            baseSha: BASE_SHA,
          },
          plan: {
            id: PLAN_ID,
            version: 1,
            taskRevision: input.dispatchEvidence.dispatch.taskRevision,
            baseSha: BASE_SHA,
            digest: PLAN_DIGEST,
            status: 'active',
            createdByAttemptId: ATTEMPT_ID,
            objective: OBJECTIVE,
            assumptionCount: 1,
            evidenceRefCount: drift === 'plan' ? 0 : 1,
            evidenceRefsDigest: input.plan.evidenceRefsDigest,
          },
          items,
          checkpoints: [],
          evidence: [],
          attempts: [{
            id: ATTEMPT_ID,
            ordinal: 1,
            mode: 'analysis',
            status: 'completed',
            baseSha: BASE_SHA,
          }],
        });
      }
      const contextReads = structuredClone(CONTEXT_READS);
      const repositoryWriteCredentials: Array<Record<string, unknown>> = [];
      if (drift === 'context_denied') {
        contextReads[0]!.successfulCalls = 0;
        contextReads[0]!.deniedCalls = 1;
      }
      if (drift === 'context_write') repositoryWriteCredentials.push({
        attemptId: ATTEMPT_ID,
        credentialId: 'credential-analysis-write',
      });
      return json({
        schemaVersion: '1',
        runId: RUN_ID,
        run: { state: 'awaiting_approval', version: 8, baseSha: BASE_SHA },
        task: { repository: REPOSITORY, revision: 'revision-analysis-action-1' },
        answers: {
          who: { attempts: [{
            attemptId: ATTEMPT_ID,
            ordinal: 1,
            mode: 'analysis',
            status: 'completed',
            baseSha: BASE_SHA,
            repository: REPOSITORY,
            workflowRef: WORKFLOW_REF,
            githubRunId: ACTION_RUN_ID,
            githubStatus: 'completed',
            githubConclusion: 'success',
          }] },
          permissions: {
            grants: [{
              tokenId: 'token-analysis-action',
              attemptId: ATTEMPT_ID,
              leaseGeneration: 1,
              scopes: [
                'repo:read', 'logs:read', 'trace:read', 'k8s:read', 'database:diagnostic',
              ],
              expiresAt: '2026-07-27T03:25:00.000Z',
              revokedAt: '2026-07-27T03:20:00.000Z',
            }],
            repositoryWriteCredentials,
          },
          contextReads,
          checks: { effectOutboxes: [{
            id: OUTBOX_ID,
            kind: 'analysis_dispatch',
            state: 'settled',
            createdAt: '2026-07-27T03:00:00.000Z',
          }] },
        },
        digests: { task: TASK_DIGEST, plans: [PLAN_DIGEST] },
      });
    }
    if (url.origin !== GITHUB_ORIGIN) return new Response(null, { status: 404 });
    const appEndpoint = url.pathname === '/app' ||
      url.pathname.startsWith('/app/installations/') || url.pathname.endsWith('/installation');
    const expectedToken = appEndpoint ? APP_JWT : INSTALLATION_TOKEN;
    if (authorization !== `Bearer ${expectedToken}`) return new Response(null, { status: 401 });
    if (url.pathname === '/app') {
      return json({
        id: Number(APP_ID),
        slug: 'delivery-loop-test',
        owner: { login: 'example-platform', type: 'Organization' },
        permissions: { ...PERMISSIONS },
        events: [...EVENTS],
        html_url: 'https://github.com/apps/delivery-loop-test',
      });
    }
    if (url.pathname === `/app/installations/${INSTALLATION_ID}` ||
        url.pathname === `/repos/${REPOSITORY}/installation`) {
      return json(installationObject());
    }
    if (url.pathname === '/installation/repositories') {
      return json({
        total_count: 1,
        repositories: [{
          id: Number(REPOSITORY_ID),
          full_name: REPOSITORY,
          visibility: 'private',
          default_branch: 'main',
          archived: false,
          disabled: false,
        }],
      });
    }
    if (url.pathname.includes('/contents/')) {
      if (drift === 'oversize') {
        return json({}, { headers: { 'content-length': String(2 * 1_024 * 1_024) } });
      }
      const marker = '/contents/';
      const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
      if (path === WORKFLOW_PATH) {
        return json({
          type: 'file',
          path,
          sha: WORKFLOW_BLOB_SHA,
          encoding: 'base64',
          content: Buffer.from(WORKFLOW_SOURCE).toString('base64'),
        });
      }
      const file = input.runner.files.find((entry) => entry.path === path);
      const source = SOURCE_CONTENT.get(path);
      if (source === undefined) return new Response(null, { status: 404 });
      return json({
        type: 'file',
        path,
        sha: file?.blobSha ?? '9'.repeat(40),
        encoding: 'base64',
        content: Buffer.from(
          drift === 'runner' && path === 'src/runner/analysis-runner.ts'
            ? `${source}\n// drift`
            : drift === 'provider' && path === 'src/agent/provider-preflight-failure.ts'
              ? source.replace('this.code = candidate', 'this.code = null')
              : source,
        ).toString('base64'),
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${ACTION_RUN_ID}`)) return json(workflowRun());
    if (url.pathname.endsWith(`/actions/runs/${ACTION_RUN_ID}/jobs`)) {
      return json({ total_count: 1, jobs: [job(drift)] });
    }
    if (url.pathname.endsWith('/actions/workflows/.github%2Fworkflows%2Fdelivery-agent.yml/runs')) {
      return json({ total_count: 1, workflow_runs: [workflowRun()] });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

function options(input: Manifest, drift: Drift = 'none') {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    controlPlaneToken: CONTROL_TOKEN,
    operationsToken: OPERATIONS_TOKEN,
    githubAppJwt: APP_JWT,
    githubInstallationToken: INSTALLATION_TOKEN,
    githubApiOrigin: GITHUB_ORIGIN,
    expectedRunnerContractDigest: input.runner.contractDigest,
    fetch: fakeFetch(input, drift),
  };
}

describe('real read-only analysis Action external evidence', () => {
  it('binds user feedback, a validated Plan, read-only context, locked Codex, and clean Git', async () => {
    const input = await manifest();
    expect(AnalysisActionEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const prd = structuredClone(input);
    prd.task.inputClass = 'prd';
    prd.task.intentKind = 'requirement';
    expect(AnalysisActionEvidenceManifestV1Schema.safeParse(prd).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/analysis-action-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(AnalysisActionEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyAnalysisActionEvidence(input, options(input))).resolves.toEqual({
      schemaVersion: '1',
      evidenceId: input.evidenceId,
      repository: REPOSITORY,
      runId: RUN_ID,
      actionRunId: ACTION_RUN_ID,
      taskInputClass: 'user_feedback',
      planId: PLAN_ID,
      planVersion: 1,
      evidenceRefCount: 1,
      itemCount: 1,
      contextCategories: ['logs', 'repository', 'traces'],
      contextCallCount: 3,
      codexVersion: CODEX_VERSION,
      runnerContractDigest: input.runner.contractDigest,
      immutableHeadVerified: true,
      detachedHeadVerified: true,
      repositoryCleanVerified: true,
      repositoryWriteCredentials: 0,
    });
  });

  it('rejects Task classification, Plan Evidence refs, or invalid Item projection drift', async () => {
    for (const drift of ['task', 'plan', 'item'] as const) {
      const input = await manifest();
      await expect(verifyAnalysisActionEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: drift === 'task'
          ? 'task_projection_mismatch' : 'plan_projection_mismatch' });
    }
  });

  it('rejects denied context reads and any analysis repository-write credential', async () => {
    for (const drift of ['context_denied', 'context_write'] as const) {
      const input = await manifest();
      await expect(verifyAnalysisActionEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: 'context_projection_mismatch' });
    }
  });

  it('rejects unreviewed Runner source, Codex lock, and failed immutable workspace checks', async () => {
    const sourceDrift = await manifest();
    await expect(verifyAnalysisActionEvidence(sourceDrift, options(sourceDrift, 'runner')))
      .rejects.toMatchObject({ code: 'runner_contract_mismatch' });
    const providerDrift = await manifest();
    await expect(verifyAnalysisActionEvidence(
      providerDrift,
      options(providerDrift, 'provider'),
    )).rejects.toMatchObject({ code: 'runner_contract_mismatch' });
    const unreviewed = await manifest();
    await expect(verifyAnalysisActionEvidence(unreviewed, {
      ...options(unreviewed),
      expectedRunnerContractDigest: `sha256:${'f'.repeat(64)}`,
    })).rejects.toMatchObject({ code: 'runner_contract_mismatch' });
    const workspace = await manifest();
    await expect(verifyAnalysisActionEvidence(workspace, options(workspace, 'job')))
      .rejects.toMatchObject({ code: 'dispatch_evidence_mismatch' });
  });

  it('fails closed on oversized GitHub data without propagating raw data or credentials', async () => {
    const oversized = await manifest();
    await expect(verifyAnalysisActionEvidence(oversized, options(oversized, 'oversize')))
      .rejects.toBeInstanceOf(Error);
    const input = await manifest();
    const raw = `RAW_${APP_JWT}_${INSTALLATION_TOKEN}_${CONTROL_TOKEN}`;
    const error = await verifyAnalysisActionEvidence(input, {
      ...options(input),
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AnalysisActionEvidenceVerificationError);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(APP_JWT);
    expect(String(error)).not.toContain(INSTALLATION_TOKEN);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
  });

  it('keeps the named real E2E command behind Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_ANALYSIS_ACTION_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-analysis-action-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('analysis-action-e2e: opt-in missing');
  });
});
