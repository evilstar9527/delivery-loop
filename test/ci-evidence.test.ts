import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  CiEvidenceManifestV1Schema,
  type CiEvidenceManifestV1,
} from '../src/domain/ci-evidence.js';
import { verifyCiEvidence } from '../src/pilot/ci-evidence-verifier.js';

const REPOSITORY = 'example/delivery-loop';
const GITHUB_TOKEN = 'CANARY_CI_GITHUB_TOKEN';
const INVALID_TASK_CANARY = 'CANARY_INVALID_TASK_BODY_7f93b2';
const API_ORIGIN = 'https://api.github.test';
const CI_WORKFLOW = `name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run verify
`;
const CI_WORKFLOW_WRITE = CI_WORKFLOW.replace('contents: read', 'contents: write');
const CI_WORKFLOW_ACTION_DRIFT = CI_WORKFLOW.replace('actions/checkout@v4', 'actions/checkout@v3');
const VALIDATE_WORKFLOW = `name: Validate task contract

on:
  workflow_dispatch:
    inputs:
      task_json:
        description: TaskEnvelope v1 JSON (contract validation only)
        required: true
        type: string

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Validate without printing the task body
        run: pnpm validate:task
`;

type CiCase = CiEvidenceManifestV1['cases'][number];
type Drift =
  | 'none'
  | 'permissions'
  | 'workflow_step'
  | 'run_event'
  | 'run_conclusion'
  | 'run_sha'
  | 'run_title'
  | 'job_count'
  | 'job_conclusion'
  | 'validation_step'
  | 'leak'
  | 'pagination'
  | 'oversize';

function title(item: CiCase): string {
  return item.kind === 'ci_main_success' ? 'ci evidence main' :
    item.kind === 'ci_pull_request_success' ? 'ci evidence pull request' :
      item.kind === 'validate_valid_success' ? 'Validate task contract' :
        'Validate task contract invalid input';
}

async function makeCase(
  kind: CiCase['kind'],
  index: number,
): Promise<CiCase> {
  const ci = kind === 'ci_main_success' || kind === 'ci_pull_request_success';
  const invalid = kind === 'validate_invalid_failure';
  const workflowPath = ci
    ? '.github/workflows/ci.yml' as const
    : '.github/workflows/validate-task.yml' as const;
  const event = kind === 'ci_main_success' ? 'push' as const :
    kind === 'ci_pull_request_success' ? 'pull_request' as const : 'workflow_dispatch' as const;
  const conclusion = invalid ? 'failure' as const : 'success' as const;
  const runId = String(920_000 + index);
  const headSha = String(index).repeat(40);
  const item = {
    caseId: `ci-case-${index}`,
    kind,
    runId,
    repository: REPOSITORY,
    workflowPath,
    event,
    status: 'completed' as const,
    conclusion,
    headSha,
    headBranch: kind === 'ci_pull_request_success' ? 'feature/ci-proof' : 'main',
    displayTitleDigest: '',
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    workflowBlobSha: String(index + 4).repeat(40),
    workflowContentDigest: await canonicalSha256(ci ? CI_WORKFLOW : VALIDATE_WORKFLOW),
    permissions: { contents: 'read' as const },
    job: { name: ci ? 'verify' as const : 'validate' as const, status: 'completed' as const, conclusion },
    logCanaryDigest: invalid ? await canonicalSha256(INVALID_TASK_CANARY) : null,
  };
  return { ...item, displayTitleDigest: await canonicalSha256(title(item as CiCase)) };
}

async function manifest(): Promise<CiEvidenceManifestV1> {
  return {
    schemaVersion: '1',
    evidenceId: 'ci-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-27T09:30:00.000+08:00',
    cases: await Promise.all([
      makeCase('ci_main_success', 1),
      makeCase('ci_pull_request_success', 2),
      makeCase('validate_valid_success', 3),
      makeCase('validate_invalid_failure', 4),
    ]),
  };
}

function responseJson(value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch(input: CiEvidenceManifestV1, drift: Drift = 'none'): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (url.pathname.includes('/contents/')) {
      const item = input.cases.find((candidate) => candidate.headSha === url.searchParams.get('ref'));
      if (item === undefined) return new Response('missing', { status: 404 });
      const changedPermissions = drift === 'permissions' && item.kind === 'ci_main_success';
      const source = item.workflowPath.endsWith('/ci.yml')
        ? (changedPermissions ? CI_WORKFLOW_WRITE :
          drift === 'workflow_step' && item.kind === 'ci_main_success'
            ? CI_WORKFLOW_ACTION_DRIFT : CI_WORKFLOW)
        : VALIDATE_WORKFLOW;
      if (drift === 'oversize' && item.kind === 'ci_main_success') {
        return responseJson({}, { 'content-length': String(2 * 1_024 * 1_024) });
      }
      return responseJson({
        path: item.workflowPath,
        encoding: 'base64',
        sha: item.workflowBlobSha,
        content: Buffer.from(source, 'utf8').toString('base64'),
      });
    }
    const runMatch = /\/actions\/runs\/(\d+)$/.exec(url.pathname);
    if (runMatch !== null) {
      const item = input.cases.find((candidate) => candidate.runId === runMatch[1]);
      if (item === undefined) return new Response('missing', { status: 404 });
      return responseJson({
        id: Number(item.runId),
        repository: { full_name: item.repository },
        event: drift === 'run_event' && item.kind === 'ci_main_success' ? 'workflow_dispatch' : item.event,
        status: item.status,
        conclusion: drift === 'run_conclusion' && item.kind === 'ci_main_success' ? 'failure' : item.conclusion,
        head_sha: drift === 'run_sha' && item.kind === 'ci_main_success' ? 'f'.repeat(40) : item.headSha,
        head_branch: item.headBranch,
        path: item.workflowPath,
        display_title: drift === 'run_title' && item.kind === 'ci_main_success'
          ? 'drifted CI title' : title(item),
        run_attempt: 1,
        updated_at: '2026-07-27T01:20:00.000Z',
      });
    }
    const jobsMatch = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    if (jobsMatch !== null) {
      const item = input.cases.find((candidate) => candidate.runId === jobsMatch[1]);
      if (item === undefined) return new Response('missing', { status: 404 });
      const validationStep = {
        name: drift === 'validation_step' && item.kind === 'validate_invalid_failure'
          ? 'Unexpected validation step' : 'Validate without printing the task body',
        status: 'completed',
        conclusion: item.conclusion,
      };
      const job = {
        id: Number(item.runId) + 1_000_000,
        name: item.job.name,
        status: item.job.status,
        conclusion: drift === 'job_conclusion' && item.kind === 'ci_main_success'
          ? 'failure' : item.job.conclusion,
        steps: item.job.name === 'validate'
          ? [
            { name: 'Checkout', status: 'completed', conclusion: 'success' },
            { name: 'Install', status: 'completed', conclusion: 'success' },
            validationStep,
          ] : [{ name: 'Verify', status: 'completed', conclusion: 'success' }],
      };
      const duplicate = drift === 'job_count' && item.kind === 'ci_main_success';
      return responseJson(
        { total_count: duplicate ? 2 : 1, jobs: duplicate ? [job, { ...job, id: job.id + 1 }] : [job] },
        drift === 'pagination' && item.kind === 'ci_main_success'
          ? { link: '<https://api.github.test/next>; rel="next"' } : undefined,
      );
    }
    const logMatch = /\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
    if (logMatch !== null) {
      const item = input.cases.find(
        (candidate) => Number(candidate.runId) + 1_000_000 === Number(logMatch[1]),
      );
      if (item === undefined) return new Response('missing', { status: 404 });
      const log = drift === 'leak' && item.kind === 'validate_invalid_failure'
        ? `validation rejected ${INVALID_TASK_CANARY}`
        : item.kind === 'validate_invalid_failure' ? 'TaskEnvelope validation failed' : 'verification passed';
      return new Response(log, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

describe('GitHub CI external evidence', () => {
  it('requires main, pull request, valid task and invalid task cases', async () => {
    const input = await manifest();
    expect(CiEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/ci-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(CiEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyCiEvidence(input, {
      githubToken: GITHUB_TOKEN,
      canarySecret: INVALID_TASK_CANARY,
      githubApiOrigin: API_ORIGIN,
      fetch: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 4, verifiedRunCount: 4, verifiedJobCount: 4,
      verifiedWorkflowCount: 4, scannedLogCount: 4, leakedCanaries: 0,
    });
  });

  it('rejects workflow permission and run identity drift', async () => {
    const permissionInput = await manifest();
    permissionInput.cases[0]!.workflowContentDigest = await canonicalSha256(CI_WORKFLOW_WRITE);
    await expect(verifyCiEvidence(permissionInput, {
      githubToken: GITHUB_TOKEN, canarySecret: INVALID_TASK_CANARY,
      githubApiOrigin: API_ORIGIN, fetch: fakeFetch(permissionInput, 'permissions'),
    })).rejects.toMatchObject({ code: 'github_workflow_mismatch' });
    const actionInput = await manifest();
    actionInput.cases[0]!.workflowContentDigest = await canonicalSha256(CI_WORKFLOW_ACTION_DRIFT);
    await expect(verifyCiEvidence(actionInput, {
      githubToken: GITHUB_TOKEN, canarySecret: INVALID_TASK_CANARY,
      githubApiOrigin: API_ORIGIN, fetch: fakeFetch(actionInput, 'workflow_step'),
    })).rejects.toMatchObject({ code: 'github_workflow_mismatch' });
    for (const drift of ['run_event', 'run_conclusion', 'run_sha', 'run_title'] as const) {
      const input = await manifest();
      await expect(verifyCiEvidence(input, {
        githubToken: GITHUB_TOKEN, canarySecret: INVALID_TASK_CANARY,
        githubApiOrigin: API_ORIGIN, fetch: fakeFetch(input, drift),
      })).rejects.toBeInstanceOf(Error);
    }
  });

  it('rejects duplicate/drifted jobs and a failure outside the validation step', async () => {
    for (const drift of ['job_count', 'job_conclusion', 'validation_step'] as const) {
      const input = await manifest();
      await expect(verifyCiEvidence(input, {
        githubToken: GITHUB_TOKEN, canarySecret: INVALID_TASK_CANARY,
        githubApiOrigin: API_ORIGIN, fetch: fakeFetch(input, drift),
      })).rejects.toMatchObject({ code: 'github_job_mismatch' });
    }
  });

  it('rejects a canary in bounded Action logs', async () => {
    const input = await manifest();
    await expect(verifyCiEvidence(input, {
      githubToken: GITHUB_TOKEN, canarySecret: INVALID_TASK_CANARY,
      githubApiOrigin: API_ORIGIN, fetch: fakeFetch(input, 'leak'),
    })).rejects.toMatchObject({ code: 'github_log_leak_detected' });
  });

  it('fails closed on pagination/oversize and never propagates raw responses or tokens', async () => {
    for (const drift of ['pagination', 'oversize'] as const) {
      const input = await manifest();
      await expect(verifyCiEvidence(input, {
        githubToken: GITHUB_TOKEN, canarySecret: INVALID_TASK_CANARY,
        githubApiOrigin: API_ORIGIN, fetch: fakeFetch(input, drift),
      })).rejects.toBeInstanceOf(Error);
    }
    const input = await manifest();
    const raw = `RAW_${GITHUB_TOKEN}_${INVALID_TASK_CANARY}`;
    const error = await verifyCiEvidence(input, {
      githubToken: GITHUB_TOKEN,
      canarySecret: INVALID_TASK_CANARY,
      githubApiOrigin: API_ORIGIN,
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
    expect(String(error)).not.toContain(INVALID_TASK_CANARY);
  });

  it('keeps the E2E command behind Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_CI_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'), ['scripts/verify-ci-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain(GITHUB_TOKEN);
    expect(result.stderr).toContain('ci-e2e: opt-in missing');
  });
});
