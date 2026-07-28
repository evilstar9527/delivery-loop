import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  GitHubAppDispatchEvidenceManifestV1Schema,
  type GitHubAppDispatchEvidenceManifestV1,
} from '../src/domain/github-app-dispatch-evidence.js';
import { verifyGitHubAppDispatchEvidence } from
  '../src/pilot/github-app-dispatch-evidence-verifier.js';

const REPOSITORY = 'example/delivery-target';
const REPOSITORY_ID = '87654321';
const APP_ID = '123456';
const INSTALLATION_ID = '654321';
const RUN_ID = 'run-app-dispatch-1';
const ATTEMPT_ID = 'attempt-app-dispatch-1';
const OUTBOX_ID = 'outbox-app-dispatch-1';
const ACTION_RUN_ID = '940001';
const BASE_SHA = 'a'.repeat(40);
const WORKFLOW_BLOB_SHA = 'b'.repeat(40);
const APP_JWT = 'CANARY_GITHUB_APP_JWT';
const INSTALLATION_TOKEN = 'CANARY_GITHUB_INSTALLATION_AUDIT_TOKEN';
const CONTROL_TOKEN = 'CANARY_GITHUB_APP_CONTROL_TOKEN';
const OPERATIONS_TOKEN = 'CANARY_GITHUB_APP_OPERATIONS_TOKEN';
const CONTROL_ORIGIN = 'https://control.example';
const GITHUB_ORIGIN = 'https://api.github.test';
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';
const WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`;
const WORKFLOW_SOURCE = readFileSync(
  new URL('../.github/workflows/delivery-agent.yml', import.meta.url),
  'utf8',
);
const PERMISSIONS = { actions: 'write', contents: 'read', metadata: 'read' } as const;
const EVENTS = ['workflow_run'] as const;

type Manifest = GitHubAppDispatchEvidenceManifestV1;
type Drift =
  | 'none'
  | 'control'
  | 'app'
  | 'installation'
  | 'extra_repository'
  | 'workflow'
  | 'action_duplicate'
  | 'job'
  | 'pagination'
  | 'oversize';

async function manifest(): Promise<Manifest> {
  return {
    schemaVersion: '1',
    evidenceId: 'github-app-dispatch-evidence-test',
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
      taskRevision: 'revision-app-dispatch-1',
      taskDigest: `sha256:${'1'.repeat(64)}`,
      baseSha: BASE_SHA,
      planId: 'plan-app-dispatch-1',
      planVersion: 1,
      planDigest: `sha256:${'2'.repeat(64)}`,
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

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function installationObject(drift: Drift): Record<string, unknown> {
  return {
    id: drift === 'installation' ? 654322 : Number(INSTALLATION_ID),
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

function workflowRun(id = Number(ACTION_RUN_ID)): Record<string, unknown> {
  return {
    id,
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
      { name: 'Checkout trusted execution snapshot', status: 'completed', conclusion: 'success', number: 1 },
      { name: 'Validate attempt mode bindings', status: 'completed', conclusion: 'success', number: 2 },
      { name: 'Set up pnpm', status: 'completed', conclusion: 'success', number: 3 },
      { name: 'Set up Node.js', status: 'completed', conclusion: 'success', number: 4 },
      { name: 'Install locked dependencies', status: 'completed', conclusion: 'success', number: 5 },
      {
        name: 'Run read-only analysis attempt', status: 'completed',
        conclusion: drift === 'job' ? 'failure' : 'success', number: 6,
      },
      { name: 'Run approved execution attempt', status: 'completed', conclusion: 'skipped', number: 7 },
      { name: 'Verify read-only workspace', status: 'completed', conclusion: 'success', number: 8 },
      { name: 'Complete job', status: 'completed', conclusion: 'success', number: 9 },
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
      if (url.pathname.endsWith('/plan')) {
        return json({
          run: {
            id: RUN_ID,
            state: drift === 'control' ? 'planning' : input.dispatch.runState,
            version: input.dispatch.runVersion,
            taskRevision: input.dispatch.taskRevision,
            baseSha: BASE_SHA,
          },
          plan: {
            id: input.dispatch.planId,
            version: input.dispatch.planVersion,
            taskRevision: input.dispatch.taskRevision,
            baseSha: BASE_SHA,
            digest: input.dispatch.planDigest,
            status: 'active',
            createdByAttemptId: ATTEMPT_ID,
          },
          items: [], checkpoints: [], evidence: [],
          attempts: [{
            id: ATTEMPT_ID,
            ordinal: 1,
            mode: 'analysis',
            status: input.dispatch.attemptStatus,
            baseSha: BASE_SHA,
          }],
        });
      }
      return json({
        schemaVersion: '1',
        runId: RUN_ID,
        run: { state: input.dispatch.runState, version: input.dispatch.runVersion, baseSha: BASE_SHA },
        task: { repository: REPOSITORY, revision: input.dispatch.taskRevision },
        answers: {
          who: { attempts: [{
            attemptId: ATTEMPT_ID,
            ordinal: 1,
            mode: 'analysis',
            status: input.dispatch.attemptStatus,
            baseSha: BASE_SHA,
            repository: REPOSITORY,
            workflowRef: WORKFLOW_REF,
            githubRunId: ACTION_RUN_ID,
            githubStatus: 'completed',
            githubConclusion: 'success',
            headSha: BASE_SHA,
          }] },
          checks: { effectOutboxes: [{
            id: OUTBOX_ID,
            kind: 'analysis_dispatch',
            state: 'settled',
            createdAt: '2026-07-27T03:00:00.000Z',
          }] },
        },
        digests: { task: input.dispatch.taskDigest, plans: [] },
      });
    }
    if (url.origin !== GITHUB_ORIGIN) return new Response(null, { status: 404 });
    const appEndpoint = url.pathname === '/app' ||
      url.pathname.startsWith('/app/installations/') || url.pathname.endsWith('/installation');
    const expectedToken = appEndpoint ? APP_JWT : INSTALLATION_TOKEN;
    if (authorization !== `Bearer ${expectedToken}`) return new Response(null, { status: 401 });
    if (url.pathname === '/app') {
      return json({
        id: drift === 'app' ? 123457 : Number(APP_ID),
        slug: 'delivery-loop-test',
        owner: { login: 'example-platform', type: 'Organization' },
        permissions: { ...PERMISSIONS },
        events: [...EVENTS],
        html_url: 'https://github.com/apps/delivery-loop-test',
      });
    }
    if (url.pathname === `/app/installations/${INSTALLATION_ID}` ||
        url.pathname === `/repos/${REPOSITORY}/installation`) {
      return json(installationObject(drift));
    }
    if (url.pathname === '/installation/repositories') {
      const repositories = [{
        id: Number(REPOSITORY_ID),
        full_name: REPOSITORY,
        visibility: 'private',
        default_branch: 'main',
        archived: false,
        disabled: false,
      }];
      if (drift === 'extra_repository') repositories.push({
        id: 87654322,
        full_name: 'example/other-repo',
        visibility: 'private',
        default_branch: 'main',
        archived: false,
        disabled: false,
      });
      return json(
        { total_count: repositories.length, repositories },
        drift === 'pagination'
          ? { headers: { link: '<https://api.github.test/next>; rel="next"' } }
          : undefined,
      );
    }
    if (url.pathname.includes('/contents/')) {
      if (drift === 'oversize') {
        return json({}, { headers: { 'content-length': String(2 * 1_024 * 1_024) } });
      }
      return json({
        type: 'file',
        path: WORKFLOW_PATH,
        sha: WORKFLOW_BLOB_SHA,
        encoding: 'base64',
        content: Buffer.from(
          drift === 'workflow' ? WORKFLOW_SOURCE.replace('contents: read', 'contents: write') : WORKFLOW_SOURCE,
        ).toString('base64'),
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${ACTION_RUN_ID}`)) return json(workflowRun());
    if (url.pathname.endsWith(`/actions/runs/${ACTION_RUN_ID}/jobs`)) {
      return json({ total_count: 1, jobs: [job(drift)] });
    }
    if (url.pathname.endsWith('/actions/workflows/.github%2Fworkflows%2Fdelivery-agent.yml/runs')) {
      const runs = drift === 'action_duplicate'
        ? [workflowRun(), workflowRun(940002)] : [workflowRun()];
      return json({ total_count: runs.length, workflow_runs: runs });
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
    fetch: fakeFetch(input, drift),
  };
}

describe('GitHub App single-repository fixed dispatch external evidence', () => {
  it('binds the App and selected installation to one fixed analysis Action', async () => {
    const input = await manifest();
    expect(GitHubAppDispatchEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/github-app-dispatch-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(GitHubAppDispatchEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyGitHubAppDispatchEvidence(input, options(input))).resolves.toEqual({
      schemaVersion: '1',
      evidenceId: input.evidenceId,
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      repository: REPOSITORY,
      runId: RUN_ID,
      actionRunId: ACTION_RUN_ID,
      selectedRepositoryCount: 1,
      analysisAttemptCount: 1,
      analysisDispatchOutboxCount: 1,
      githubActionRunCount: 1,
      githubJobCount: 1,
      fixedWorkflowVerified: true,
      duplicateDispatches: 0,
    });
  });

  it('rejects App, installation, or selected-repository drift', async () => {
    for (const drift of ['app', 'installation', 'extra_repository'] as const) {
      const input = await manifest();
      await expect(verifyGitHubAppDispatchEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: drift === 'app'
          ? 'github_app_mismatch' : 'github_installation_mismatch' });
    }
  });

  it('rejects D1 Run, Attempt, or dispatch projection drift', async () => {
    const input = await manifest();
    await expect(verifyGitHubAppDispatchEvidence(input, options(input, 'control')))
      .rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
  });

  it('rejects workflow blob, job path, or duplicate stable-title Action drift', async () => {
    for (const drift of ['workflow', 'job', 'action_duplicate'] as const) {
      const input = await manifest();
      await expect(verifyGitHubAppDispatchEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: drift === 'workflow'
          ? 'github_workflow_mismatch' : drift === 'job'
            ? 'github_job_mismatch' : 'github_inventory_mismatch' });
    }
  });

  it('fails closed on pagination/oversize without propagating raw responses or credentials', async () => {
    for (const drift of ['pagination', 'oversize'] as const) {
      const input = await manifest();
      await expect(verifyGitHubAppDispatchEvidence(input, options(input, drift)))
        .rejects.toBeInstanceOf(Error);
    }
    const input = await manifest();
    const raw = `RAW_${APP_JWT}_${INSTALLATION_TOKEN}_${CONTROL_TOKEN}`;
    const error = await verifyGitHubAppDispatchEvidence(input, {
      ...options(input), fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(APP_JWT);
    expect(String(error)).not.toContain(INSTALLATION_TOKEN);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
  });

  it('keeps the named E2E command behind Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_GITHUB_APP_DISPATCH_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-github-app-dispatch-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('github-app-dispatch-e2e: opt-in missing');
  });
});
