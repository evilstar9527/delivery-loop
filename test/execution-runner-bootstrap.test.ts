import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import { patchContentDigest } from '../src/domain/patch-proposal.js';
import { taskRevisionDigest, type TaskEnvelope } from '../src/domain/task.js';
import { EXECUTION_TOOL_ACTIONS } from '../src/domain/tool-bridge.js';
import {
  BOT_COMMIT_EMAIL,
  BOT_COMMIT_NAME,
  repositoryAttemptBranch,
} from '../src/runner/git-repository-writer.js';
import { runExecutionAttempt } from '../src/runner/execution-runner.js';

const exec = promisify(execFile);
const TASK_ID = 'task-execution-bootstrap';
const RUN_ID = 'run-execution-bootstrap';
const ATTEMPT_ID = 'attempt-execution-bootstrap';
const PLAN_ID = 'plan-execution-bootstrap';
const ITEM_ID = 'repair-and-verify';
const REPOSITORY = 'example/delivery-target';
const OIDC_TOKEN = 'CANARY_EXECUTION_OIDC_TOKEN';
const WRITE_TOKEN = 'CANARY_EXECUTION_WRITE_TOKEN';
const REBASE_SOURCE_ATTEMPT_ID = 'attempt-execution-rebase-source';

function task(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-execution-bootstrap',
    occurredAt: '2026-07-25T15:00:00.000Z',
    source: {
      system: 'manual',
      tenantKey: 'execution-bootstrap',
      taskKey: TASK_ID,
      revision: 'revision-1',
    },
    actor: { type: 'user', id: 'execution-bootstrap-user' },
    target: { owner: 'example', repo: 'delivery-target', baseBranch: 'main', environment: 'test' },
    intent: {
      kind: 'bug',
      title: 'Repair failed value verification',
      description: 'The value fixture is broken on the failed execution head.',
      acceptanceCriteria: ['The value is fixed and trusted verification passes.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: true,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

async function repository(): Promise<{
  root: string;
  path: string;
  remote: string;
  baseSha: string;
  checkoutSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-bootstrap-'));
  const path = join(root, 'repo');
  const remote = join(root, 'remote.git');
  await exec('git', ['init', path]);
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['config', 'user.name', 'Fixture'], { cwd: path });
  await exec('git', ['config', 'user.email', 'fixture@example.test'], { cwd: path });
  await writeFile(join(path, 'delivery.yaml'), `
schemaVersion: '1'
commands:
  setup:
    install: { argv: [node, -e, "process.exit(0)"], timeoutSeconds: 60 }
  targeted:
    unit: { argv: [node, -e, "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='fixed'?0:7)"], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='fixed'?0:9)"], timeoutSeconds: 60 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);
  await writeFile(join(path, 'value.txt'), 'base\n');
  await exec('git', ['add', '.'], { cwd: path });
  await exec('git', ['commit', '-m', 'trusted base'], { cwd: path });
  await exec('git', ['branch', '-M', 'main'], { cwd: path });
  const baseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  await writeFile(join(path, 'value.txt'), 'broken\n');
  await exec('git', ['add', 'value.txt'], { cwd: path });
  await exec('git', ['commit', '-m', 'failed execution head'], { cwd: path });
  const checkoutSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: path });
  await exec('git', ['push', 'origin', 'main'], { cwd: path });
  return { root, path, remote, baseSha, checkoutSha };
}

async function rebaseRepository(conflict = false): Promise<{
  root: string;
  path: string;
  remote: string;
  oldBaseSha: string;
  newBaseSha: string;
  sourceHeadSha: string;
  sourceBranch: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-rebase-bootstrap-'));
  const path = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const sourceBranch = repositoryAttemptBranch(TASK_ID, REBASE_SOURCE_ATTEMPT_ID);
  await exec('git', ['init', path]);
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['config', 'user.name', BOT_COMMIT_NAME], { cwd: path });
  await exec('git', ['config', 'user.email', BOT_COMMIT_EMAIL], { cwd: path });
  await writeFile(join(path, 'delivery.yaml'), `
schemaVersion: '1'
commands:
  setup:
    install: { argv: [node, -e, "process.exit(0)"], timeoutSeconds: 60 }
  targeted:
    unit: { argv: [node, -e, "const fs=require('node:fs');process.exit(fs.existsSync('feature.txt')&&fs.existsSync('base.txt')?0:7)"], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, "const fs=require('node:fs');process.exit(fs.readFileSync('feature.txt','utf8').trim()==='source'&&fs.readFileSync('base.txt','utf8').trim()==='new-base'?0:9)"], timeoutSeconds: 60 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);
  await writeFile(join(path, 'README.md'), 'old base\n');
  await exec('git', ['add', '.'], { cwd: path });
  await exec('git', ['commit', '-m', 'trusted old base'], { cwd: path });
  await exec('git', ['branch', '-M', 'main'], { cwd: path });
  const oldBaseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  await exec('git', ['switch', '--create', sourceBranch, oldBaseSha], { cwd: path });
  const sourcePath = conflict ? 'README.md' : 'feature.txt';
  await writeFile(join(path, sourcePath), 'source\n');
  await exec('git', ['add', sourcePath], { cwd: path });
  await exec('git', ['commit', '-m', 'verified source change'], { cwd: path });
  const sourceHeadSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  await exec('git', ['switch', 'main'], { cwd: path });
  const basePath = conflict ? 'README.md' : 'base.txt';
  await writeFile(join(path, basePath), 'new-base\n');
  await exec('git', ['add', basePath], { cwd: path });
  await exec('git', ['commit', '-m', 'advance base'], { cwd: path });
  const newBaseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: path });
  await exec('git', ['push', 'origin', 'main'], { cwd: path });
  await exec('git', ['push', 'origin', sourceBranch], { cwd: path });
  await exec('git', ['checkout', '--detach', sourceHeadSha], { cwd: path });
  return { root, path, remote, oldBaseSha, newBaseSha, sourceHeadSha, sourceBranch };
}

describe('production execution Runner bootstrap', () => {
  it('accepts exact human and automated review identities while rejecting malformed or mixed sources', async () => {
    const fixture = await repository();
    const taskDigest = await taskRevisionDigest(task());
    const branch = `agent/${TASK_ID}/attempt-prior-review`;

    const run = async (
      reviewId: string,
      options: { includeRepair?: boolean } = {},
    ): Promise<{ error: unknown; credentialRequests: number; failureReports: number }> => {
      const runnerTemp = join(fixture.root, `runner-temp-review-${reviewId.replaceAll('/', '-')}`);
      await mkdir(runnerTemp, { mode: 0o700 });
      const environment: NodeJS.ProcessEnv = {
        DELIVERY_SCHEMA_VERSION: '1',
        DELIVERY_RUN_ID: RUN_ID,
        DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
        DELIVERY_TASK_DIGEST: taskDigest,
        DELIVERY_BASE_SHA: fixture.baseSha,
        DELIVERY_CHECKOUT_SHA: fixture.checkoutSha,
        DELIVERY_ATTEMPT_MODE: 'review_fix',
        DELIVERY_PLAN_VERSION: '1',
        DELIVERY_PLAN_ITEM_ID: ITEM_ID,
        DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
        ACTIONS_ID_TOKEN_REQUEST_URL: `https://oidc.actions.test/token?review=${reviewId}`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_REVIEW_CONTEXT_TOKEN',
        GITHUB_WORKSPACE: fixture.path,
        RUNNER_TEMP: runnerTemp,
        GITHUB_REPOSITORY: REPOSITORY,
      };
      const attemptToken = 'CANARY_EXECUTION_REVIEW_CONTEXT_ATTEMPT_TOKEN';
      let credentialRequests = 0;
      let failureReports = 0;
      const fetchImplementation: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith('https://oidc.actions.test/token')) {
          return Response.json({ value: OIDC_TOKEN });
        }
        if (url.endsWith('/exchange')) {
          return Response.json({
            attemptToken,
            expiresAt: '2099-01-01T00:00:00.000Z',
            attemptVersion: 7,
            leaseGeneration: 3,
            grant: {
              toolBridgeToken: 'CANARY_EXECUTION_REVIEW_CONTEXT_TOOL_TOKEN',
              expiresAt: '2099-01-01T00:00:00.000Z',
              scopes: [...EXECUTION_TOOL_ACTIONS],
            },
          });
        }
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${attemptToken}`);
        if (url.endsWith('/context')) {
          return Response.json({
            schemaVersion: '1',
            attempt: {
              id: ATTEMPT_ID,
              runId: RUN_ID,
              taskId: TASK_ID,
              mode: 'review_fix',
              version: 7,
              leaseGeneration: 3,
              baseSha: fixture.baseSha,
              checkoutSha: fixture.checkoutSha,
              repository: REPOSITORY,
              baseBranch: 'main',
              planId: PLAN_ID,
              planVersion: 1,
              planItemId: ITEM_ID,
              targetBranch: branch,
              targetBranchMode: 'existing_fast_forward',
            },
            task: task(),
            item: {
              id: ITEM_ID,
              kind: 'change',
              title: 'Apply exact review feedback',
              objective: 'Fix only the blocking finding on the reviewed head.',
              required: true,
              doneWhen: ['Targeted and required verification pass on the replacement head.'],
              commandRefs: ['test:unit', 'verify:all'],
              evidenceKinds: ['commit', 'test'],
              effects: ['repo_read', 'repo_write'],
            },
            reviewFeedback: {
              reviewId,
              body: '[MAJOR] Fix the exact reviewed behavior.',
              bodyDigest: `sha256:${'7'.repeat(64)}`,
              sourceHeadSha: fixture.checkoutSha,
              branch,
              url: 'https://github.com/example/delivery-target/pull/1',
              submittedAt: '2026-08-10T04:46:30.000Z',
            },
            ...(options.includeRepair === true ? {
              repair: {
                failedAttemptId: 'attempt-conflicting-repair-source',
                sourceSuiteId: 'suite-conflicting-repair-source',
                sourceEvidenceId: 'evidence-conflicting-repair-source',
                sourceHeadSha: fixture.checkoutSha,
                failureFactDigest: `sha256:${'8'.repeat(64)}`,
                phase: 'targeted',
                commandRef: 'test:unit',
                exitCode: 7,
              },
            } : {}),
          });
        }
        if (url.endsWith('/github/write-token')) {
          credentialRequests += 1;
          return new Response(null, { status: 503 });
        }
        if (url.endsWith('/events')) {
          failureReports += 1;
          return Response.json({ accepted: true }, {
            status: 202,
            headers: { 'cache-control': 'no-store' },
          });
        }
        throw new Error(`unexpected fake URL: ${url}`);
      };
      let error: unknown;
      try {
        await runExecutionAttempt({
          environment,
          fetch: fetchImplementation,
          heartbeatIntervalMs: 60_000,
          agent: { apply: async () => { throw new Error('credential gate must run first'); } },
          now: () => new Date('2026-08-10T04:47:00.000Z'),
        });
      } catch (caught) {
        error = caught;
      }
      return { error, credentialRequests, failureReports };
    };

    for (const reviewId of ['9001', `automated_review_${'a'.repeat(52)}`]) {
      const accepted = await run(reviewId);
      expect(accepted.error).toMatchObject({
        message: 'repo_write credential dependency is unavailable',
        kind: 'credential_unavailable',
      });
      expect(accepted.credentialRequests).toBe(1);
      expect(accepted.failureReports).toBe(1);
    }

    const malformed = await run('automated_review_not-a-stable-identity');
    expect(malformed.error).toMatchObject({
      message: 'execution context response is invalid',
      kind: 'context_invalid',
    });
    expect(malformed.credentialRequests).toBe(0);
    expect(malformed.failureReports).toBe(0);

    const mixed = await run(`automated_review_${'b'.repeat(52)}`, { includeRepair: true });
    expect(mixed.error).toMatchObject({
      message: 'execution context identity does not match dispatch',
      kind: 'context_invalid',
    });
    expect(mixed.credentialRequests).toBe(0);
    expect(mixed.failureReports).toBe(0);
  });

  it('runs a base-only rebase without Agent edits, publishes a new branch, and reports new Evidence', async () => {
    const fixture = await rebaseRepository();
    const runnerTemp = join(fixture.root, 'runner-temp-rebase');
    await mkdir(runnerTemp, { mode: 0o700 });
    const taskDigest = await taskRevisionDigest(task());
    const environment: NodeJS.ProcessEnv = {
      DELIVERY_SCHEMA_VERSION: '1',
      DELIVERY_RUN_ID: RUN_ID,
      DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
      DELIVERY_TASK_DIGEST: taskDigest,
      DELIVERY_BASE_SHA: fixture.newBaseSha,
      DELIVERY_CHECKOUT_SHA: fixture.sourceHeadSha,
      DELIVERY_ATTEMPT_MODE: 'review_fix',
      DELIVERY_PLAN_VERSION: '2',
      DELIVERY_PLAN_ITEM_ID: ITEM_ID,
      DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=base-rebase',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_REBASE_TOKEN',
      GITHUB_WORKSPACE: fixture.path,
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: REPOSITORY,
    };
    const attemptToken = 'CANARY_BASE_REBASE_ATTEMPT_TOKEN';
    const generation = 2;
    let version = 5;
    let rebasedHead = '';
    let completed: Record<string, unknown> | undefined;
    const evidenceRefs: string[] = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: version,
          leaseGeneration: generation,
          grant: {
            toolBridgeToken: 'CANARY_BASE_REBASE_TOOL_TOKEN',
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...EXECUTION_TOOL_ACTIONS],
          },
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${attemptToken}`);
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            taskId: TASK_ID,
            mode: 'review_fix',
            version,
            leaseGeneration: generation,
            baseSha: fixture.newBaseSha,
            checkoutSha: fixture.sourceHeadSha,
            repository: REPOSITORY,
            baseBranch: 'main',
            planId: PLAN_ID,
            planVersion: 2,
            planItemId: ITEM_ID,
            targetBranch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
            targetBranchMode: 'new',
          },
          task: task(),
          item: {
            id: ITEM_ID,
            kind: 'change',
            title: 'Rebase and verify',
            objective: 'Replay the verified bot change onto the new base.',
            required: true,
            doneWhen: ['Targeted and required verification pass on the rebased head.'],
            commandRefs: ['test:unit', 'verify:all'],
            evidenceKinds: ['test'],
            effects: ['repo_write'],
          },
          baseRebase: {
            sourceAttemptId: REBASE_SOURCE_ATTEMPT_ID,
            sourceBranch: fixture.sourceBranch,
            sourceHeadSha: fixture.sourceHeadSha,
            oldBaseSha: fixture.oldBaseSha,
            newBaseSha: fixture.newBaseSha,
          },
        });
      }
      if (url.endsWith('/github/write-token')) {
        return Response.json({
          credentialId: 'credential-base-rebase-bootstrap',
          repository: REPOSITORY,
          token: WRITE_TOKEN,
          expiresAt: '2099-01-01T00:00:00.000Z',
          githubExpiresAt: '2099-01-01T00:00:00.000Z',
          approvalId: 'approval-base-rebase-bootstrap',
          permissions: { contents: 'write', pullRequests: 'write' },
          created: true,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/head')) {
        const body = JSON.parse(String(init?.body)) as {
          parentSha: string;
          headSha: string;
          branch: string;
        };
        expect(body).toMatchObject({
          parentSha: fixture.sourceHeadSha,
          branch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
        });
        rebasedHead = body.headSha;
        version += 1;
        return Response.json({
          updateId: 'head-base-rebase-bootstrap',
          evidenceId: 'evidence-head-base-rebase-bootstrap',
          created: true,
          version,
          leaseGeneration: generation,
          parentSha: body.parentSha,
          headSha: body.headSha,
          branch: body.branch,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/verifications')) {
        const body = JSON.parse(String(init?.body)) as {
          expectedVersion: number;
          manifest: { headSha: string };
        };
        expect(body.expectedVersion).toBe(version);
        expect(body.manifest.headSha).toBe(rebasedHead);
        return Response.json({
          suiteId: 'suite-base-rebase-bootstrap',
          created: true,
          status: 'running',
          commands: [
            { position: 0, phase: 'targeted', commandRef: 'test:unit' },
            { position: 1, phase: 'required_verify', commandRef: 'verify:all' },
          ],
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.includes('/verifications/suite-base-rebase-bootstrap/results')) {
        const body = JSON.parse(String(init?.body)) as {
          result: { position: number; commandRef: string; headSha: string; exitCode: number };
        };
        expect(body.result.headSha).toBe(rebasedHead);
        expect(body.result.exitCode).toBe(0);
        evidenceRefs.push(body.result.commandRef);
        return Response.json({
          evidenceId: `evidence-base-rebase-bootstrap-${body.result.position}`,
          created: true,
          suiteStatus: body.result.position === 1 ? 'completed' : 'running',
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/base-rebase/complete')) {
        completed = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(completed).toMatchObject({
          expectedVersion: version,
          leaseGeneration: generation,
          headSha: rebasedHead,
          suiteId: 'suite-base-rebase-bootstrap',
        });
        return Response.json({
          accepted: true,
          rebaseId: 'base-rebase-bootstrap',
          status: 'passed',
          headSha: rebasedHead,
          suiteId: 'suite-base-rebase-bootstrap',
          created: true,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      throw new Error(`unexpected fake URL: ${url}`);
    };

    const result = await runExecutionAttempt({
      environment,
      fetch: fetchImplementation,
      heartbeatIntervalMs: 60_000,
      agent: { apply: async () => { throw new Error('base rebase must not invoke the Agent'); } },
      now: () => new Date('2026-07-26T02:01:00.000Z'),
    });
    expect(result).toMatchObject({
      status: 'passed',
      branch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
      headSha: rebasedHead,
      suiteId: 'suite-base-rebase-bootstrap',
      evidenceIds: [
        'evidence-base-rebase-bootstrap-0',
        'evidence-base-rebase-bootstrap-1',
      ],
    });
    expect(completed).toBeDefined();
    expect(evidenceRefs).toEqual(['test:unit', 'verify:all']);
    expect((await exec('git', [
      'merge-base',
      '--is-ancestor',
      fixture.newBaseSha,
      rebasedHead,
    ], { cwd: fixture.path })).stdout).toBe('');
    expect((await exec('git', ['rev-parse', fixture.sourceBranch], { cwd: fixture.path })).stdout.trim())
      .toBe(fixture.sourceHeadSha);
    expect((await exec('git', [
      'rev-parse',
      `refs/heads/${repositoryAttemptBranch(TASK_ID, ATTEMPT_ID)}`,
    ], { cwd: fixture.remote })).stdout.trim()).toBe(rebasedHead);
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it('reports a real rebase content conflict without pushing, Agent edits, or Evidence', async () => {
    const fixture = await rebaseRepository(true);
    const runnerTemp = join(fixture.root, 'runner-temp-rebase-conflict');
    await mkdir(runnerTemp, { mode: 0o700 });
    const environment: NodeJS.ProcessEnv = {
      DELIVERY_SCHEMA_VERSION: '1',
      DELIVERY_RUN_ID: RUN_ID,
      DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
      DELIVERY_TASK_DIGEST: await taskRevisionDigest(task()),
      DELIVERY_BASE_SHA: fixture.newBaseSha,
      DELIVERY_CHECKOUT_SHA: fixture.sourceHeadSha,
      DELIVERY_ATTEMPT_MODE: 'review_fix',
      DELIVERY_PLAN_VERSION: '2',
      DELIVERY_PLAN_ITEM_ID: ITEM_ID,
      DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=base-rebase-conflict',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_REBASE_CONFLICT',
      GITHUB_WORKSPACE: fixture.path,
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: REPOSITORY,
    };
    const attemptToken = 'CANARY_BASE_REBASE_CONFLICT_ATTEMPT_TOKEN';
    let conflictBody: Record<string, unknown> | undefined;
    let forbiddenEffect = false;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: 4,
          leaseGeneration: 2,
          grant: {
            toolBridgeToken: 'CANARY_BASE_REBASE_CONFLICT_TOOL_TOKEN',
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...EXECUTION_TOOL_ACTIONS],
          },
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${attemptToken}`);
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            taskId: TASK_ID,
            mode: 'review_fix',
            version: 4,
            leaseGeneration: 2,
            baseSha: fixture.newBaseSha,
            checkoutSha: fixture.sourceHeadSha,
            repository: REPOSITORY,
            baseBranch: 'main',
            planId: PLAN_ID,
            planVersion: 2,
            planItemId: ITEM_ID,
            targetBranch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
            targetBranchMode: 'new',
          },
          task: task(),
          item: {
            id: ITEM_ID,
            kind: 'verification',
            title: 'Rebase conflict',
            objective: 'Stop safely when the verified change conflicts.',
            required: true,
            doneWhen: ['The rebase is resolved and all checks pass.'],
            commandRefs: ['test:unit', 'verify:all'],
            evidenceKinds: ['test'],
            effects: ['repo_write'],
          },
          baseRebase: {
            sourceAttemptId: REBASE_SOURCE_ATTEMPT_ID,
            sourceBranch: fixture.sourceBranch,
            sourceHeadSha: fixture.sourceHeadSha,
            oldBaseSha: fixture.oldBaseSha,
            newBaseSha: fixture.newBaseSha,
          },
        });
      }
      if (url.endsWith('/github/write-token')) {
        return Response.json({
          credentialId: 'credential-base-rebase-conflict',
          repository: REPOSITORY,
          token: WRITE_TOKEN,
          expiresAt: '2099-01-01T00:00:00.000Z',
          githubExpiresAt: '2099-01-01T00:00:00.000Z',
          approvalId: 'approval-base-rebase-conflict',
          permissions: { contents: 'write', pullRequests: 'write' },
          created: true,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/base-rebase/conflict')) {
        conflictBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(conflictBody).toEqual({
          expectedVersion: 4,
          leaseGeneration: 2,
          reason: 'content_conflict',
        });
        return Response.json({
          accepted: true,
          rebaseId: 'base-rebase-conflict-bootstrap',
          status: 'blocked',
          reason: 'content_conflict',
          runVersion: 21,
          cancelOutboxId: 'cancel-base-rebase-conflict-bootstrap',
          created: true,
        }, { status: 202, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/head') || url.includes('/verifications') ||
        url.endsWith('/base-rebase/complete')) {
        forbiddenEffect = true;
      }
      throw new Error(`unexpected fake URL: ${url}`);
    };
    const result = await runExecutionAttempt({
      environment,
      fetch: fetchImplementation,
      heartbeatIntervalMs: 60_000,
      agent: { apply: async () => { throw new Error('conflict path must not invoke Agent'); } },
      now: () => new Date('2026-07-26T02:02:00.000Z'),
    });
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'content_conflict',
      sourceBranch: fixture.sourceBranch,
      sourceHeadSha: fixture.sourceHeadSha,
      oldBaseSha: fixture.oldBaseSha,
      newBaseSha: fixture.newBaseSha,
    });
    expect(conflictBody).toBeDefined();
    expect(forbiddenEffect).toBe(false);
    await expect(exec('git', [
      'show-ref',
      '--verify',
      `refs/heads/${repositoryAttemptBranch(TASK_ID, ATTEMPT_ID)}`,
    ], { cwd: fixture.remote })).rejects.toBeDefined();
    expect((await exec('git', ['rev-parse', fixture.sourceBranch], { cwd: fixture.path })).stdout.trim())
      .toBe(fixture.sourceHeadSha);
    expect((await exec('git', [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ], { cwd: fixture.path })).stdout).toBe('');
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it('recovers one clean no-op apply_fix turn through a separately settled patch proposal', async () => {
    const fixture = await repository();
    const runnerTemp = join(fixture.root, 'runner-temp');
    await mkdir(runnerTemp, { mode: 0o700 });
    const taskDigest = await taskRevisionDigest(task());
    const environment: NodeJS.ProcessEnv = {
      DELIVERY_SCHEMA_VERSION: '1',
      DELIVERY_RUN_ID: RUN_ID,
      DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
      DELIVERY_TASK_DIGEST: taskDigest,
      DELIVERY_BASE_SHA: fixture.baseSha,
      DELIVERY_CHECKOUT_SHA: fixture.checkoutSha,
      DELIVERY_ATTEMPT_MODE: 'review_fix',
      DELIVERY_PLAN_VERSION: '1',
      DELIVERY_PLAN_ITEM_ID: ITEM_ID,
      DELIVERY_MODEL_PROFILE_ID: 'profile-execution-recovery',
      DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=execution',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_TOKEN',
      GITHUB_WORKSPACE: fixture.path,
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: REPOSITORY,
    };
    let activeToken = 'CANARY_EXECUTION_ATTEMPT_TOKEN_7';
    let toolToken = 'CANARY_EXECUTION_TOOL_TOKEN_7';
    let version = 7;
    const generation = 3;
    let heartbeatCount = 0;
    let headBody: Record<string, unknown> | undefined;
    const verificationRefs: string[] = [];
    const failures: unknown[] = [];
    const transcriptMarker = 'PUBLIC_EXECUTION_TRANSCRIPT_MARKER';
    const requestBodies: Array<{ url: string; body: string }> = [];
    let artifactBody: Record<string, unknown> | undefined;
    let manifestDigest = '';
    const reservationIds: string[] = [];
    const usageReservations: string[] = [];
    let transientUsageFailureInjected = false;
    const agentModels: string[] = [];
    let credentialRequests = 0;
    let agentInvocation = 0;
    let releaseAgent!: () => void;
    const heartbeatSeen = new Promise<void>((resolve) => { releaseAgent = resolve; });

    const authorized = (init: RequestInit | undefined): void => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${activeToken}`);
    };
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.body !== undefined) requestBodies.push({ url, body: String(init.body) });
      if (url.startsWith('https://oidc.actions.test/token')) {
        expect(new URL(url).searchParams.get('audience')).toBe('delivery-loop-control-plane');
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/exchange`)) {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${OIDC_TOKEN}`);
        return Response.json({
          attemptToken: activeToken,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: version,
          leaseGeneration: generation,
          grant: {
            toolBridgeToken: toolToken,
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...EXECUTION_TOOL_ACTIONS],
          },
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/context`)) {
        authorized(init);
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            taskId: TASK_ID,
            mode: 'review_fix',
            version,
            leaseGeneration: generation,
            baseSha: fixture.baseSha,
            checkoutSha: fixture.checkoutSha,
            repository: REPOSITORY,
            baseBranch: 'main',
            planId: PLAN_ID,
            planVersion: 1,
            planItemId: ITEM_ID,
            targetBranch: `agent/${TASK_ID}/${ATTEMPT_ID}`,
            targetBranchMode: 'new',
          },
          task: task(),
          item: {
            id: ITEM_ID,
            kind: 'verification',
            title: 'Repair and verify',
            objective: 'Apply the smallest fix to value.txt and rerun trusted verification.',
            required: true,
            doneWhen: ['Targeted and required verification pass on the bot head.'],
            commandRefs: ['test:unit', 'verify:all'],
            evidenceKinds: ['test'],
            effects: ['repo_write'],
          },
          repair: {
            failedAttemptId: 'attempt-failed-before-bootstrap',
            sourceSuiteId: 'suite-failed-before-bootstrap',
            sourceEvidenceId: 'evidence-failed-before-bootstrap',
            sourceHeadSha: fixture.checkoutSha,
            failureFactDigest: `sha256:${'8'.repeat(64)}`,
            phase: 'targeted',
            commandRef: 'test:unit',
            exitCode: 7,
          },
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/github/write-token`)) {
        authorized(init);
        credentialRequests += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersion: version,
          leaseGeneration: generation,
        });
        return Response.json({
          credentialId: 'credential-execution-bootstrap',
          repository: REPOSITORY,
          token: WRITE_TOKEN,
          expiresAt: '2099-01-01T00:00:00.000Z',
          githubExpiresAt: '2099-01-01T00:00:00.000Z',
          approvalId: 'approval-execution-bootstrap',
          permissions: { contents: 'write', pullRequests: 'write' },
          created: credentialRequests === 1,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/model-reservations`)) {
        authorized(init);
        const body = JSON.parse(String(init?.body)) as {
          reservationId: string;
          profileId: string;
        };
        expect(body.profileId).toBe('profile-execution-recovery');
        reservationIds.push(body.reservationId);
        return Response.json({
          reservationId: body.reservationId,
          attemptId: ATTEMPT_ID,
          runId: RUN_ID,
          provider: 'openai',
          model: 'gpt-test-metered',
          reservedTokens: 1_000,
          reservedCostMicrousd: 1_000,
          expiresAt: '2099-01-01T00:00:00.000Z',
          overrideId: null,
          disposition: 'created',
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/model-usage`)) {
        authorized(init);
        const body = JSON.parse(String(init?.body)) as {
          reservationId: string;
          usageId: string;
        };
        usageReservations.push(body.reservationId);
        if (!transientUsageFailureInjected) {
          transientUsageFailureInjected = true;
          return Response.json(
            { code: 'temporarily_unavailable' },
            { status: 503, headers: { 'cache-control': 'no-store' } },
          );
        }
        return Response.json({
          usageId: body.usageId,
          reservationId: body.reservationId,
          totalTokens: 18,
          costMicrousd: 10,
          disposition: 'existing',
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/heartbeat`)) {
        authorized(init);
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersion: version,
          leaseGeneration: generation,
        });
        heartbeatCount += 1;
        version += 1;
        activeToken = `CANARY_EXECUTION_ATTEMPT_TOKEN_${version}`;
        toolToken = `CANARY_EXECUTION_TOOL_TOKEN_${version}`;
        releaseAgent();
        return Response.json({
          attemptToken: activeToken,
          toolBridgeToken: toolToken,
          version,
          leaseGeneration: generation,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/artifacts`)) {
        authorized(init);
        artifactBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(artifactBody).toMatchObject({
          schemaVersion: '1',
          category: 'raw_transcript',
          expectedVersion: version,
          leaseGeneration: generation,
        });
        expect(artifactBody.artifactId).toMatch(
          /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        );
        return Response.json({
          accepted: true,
          status: 'ready',
          artifactId: artifactBody.artifactId,
          category: 'raw_transcript',
          objectIdentityDigest: `sha256:${'a'.repeat(64)}`,
          ciphertextDigest: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 256,
          expiresAt: '2099-01-01T00:00:00.000Z',
          created: true,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/head`)) {
        authorized(init);
        headBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(headBody).toMatchObject({
          expectedVersion: version,
          leaseGeneration: generation,
          parentSha: fixture.checkoutSha,
          branch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
        });
        version += 1;
        return Response.json({
          updateId: 'head-update-execution-bootstrap',
          evidenceId: 'evidence-commit-execution-bootstrap',
          created: true,
          version,
          leaseGeneration: generation,
          parentSha: fixture.checkoutSha,
          headSha: headBody.headSha,
          branch: headBody.branch,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/verifications`)) {
        authorized(init);
        const body = JSON.parse(String(init?.body)) as {
          expectedVersion: number;
          leaseGeneration: number;
          manifest: { policyDigest: string; targetedCommandRefs: string[]; requiredVerifyCommandRefs: string[] };
        };
        expect(body.expectedVersion).toBe(version);
        expect(body.leaseGeneration).toBe(generation);
        manifestDigest = body.manifest.policyDigest;
        expect(body.manifest.targetedCommandRefs).toEqual(['test:unit']);
        expect(body.manifest.requiredVerifyCommandRefs).toEqual(['verify:all']);
        return Response.json({
          suiteId: 'suite-execution-bootstrap',
          created: true,
          status: 'running',
          commands: [
            { position: 0, phase: 'targeted', commandRef: 'test:unit' },
            { position: 1, phase: 'required_verify', commandRef: 'verify:all' },
          ],
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.includes('/verifications/suite-execution-bootstrap/results')) {
        authorized(init);
        const body = JSON.parse(String(init?.body)) as {
          expectedVersion: number;
          leaseGeneration: number;
          result: { position: number; commandRef: string; headSha: string; exitCode: number };
        };
        expect(body.expectedVersion).toBe(version);
        expect(body.leaseGeneration).toBe(generation);
        expect(body.result.headSha).toBe(headBody?.headSha);
        expect(body.result.exitCode).toBe(0);
        verificationRefs.push(body.result.commandRef);
        return Response.json({
          evidenceId: `evidence-execution-bootstrap-${body.result.position}`,
          created: true,
          suiteStatus: body.result.position === 1 ? 'completed' : 'running',
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith(`/v1/attempts/${ATTEMPT_ID}/events`)) {
        failures.push(JSON.parse(String(init?.body)));
        return Response.json({ accepted: true }, { status: 202, headers: { 'cache-control': 'no-store' } });
      }
      throw new Error(`unexpected fake URL: ${url}`);
    };

    let agentActivity: Record<string, unknown> | undefined;
    const result = await runExecutionAttempt({
      environment,
      fetch: fetchImplementation,
      heartbeatIntervalMs: 20,
      onAgentActivity: (activity) => { agentActivity = activity; },
      agent: {
        usesMeteredModel: true,
        apply: async (input) => {
          agentInvocation += 1;
          agentModels.push(input.model ?? 'missing');
          expect(input.timeoutMs).toBe(10 * 60_000);
          input.onUsage?.({
            inputTokens: 12,
            cachedInputTokens: 4,
            outputTokens: 6,
            reasoningOutputTokens: 2,
          });
          expect((await stat(input.contextFilePath)).mode & 0o777).toBe(0o600);
          expect((await stat(input.outputFilePath)).mode & 0o777).toBe(0o600);
          expect(await readFile(input.contextFilePath, 'utf8')).toContain('review_fix');
          if (agentInvocation === 1) {
            expect(input.editTurn).toBe(1);
            input.onTranscriptLine?.(JSON.stringify({
              type: 'item.completed',
              item: { type: 'file_change', status: 'completed' },
            }));
            input.onTranscriptLine?.(JSON.stringify({
              type: 'item.completed',
              item: { type: 'agent_message', text: 'PUBLIC_FIRST_NO_OP_TURN' },
            }));
            return { schemaVersion: '1', action: 'apply_fix' };
          }
          expect(input.editTurn).toBe(2);
          expect(input.patchProposal).toBe(true);
          await heartbeatSeen;
          input.onTranscriptLine?.(JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: transcriptMarker },
          }));
          return {
            schemaVersion: '1',
            action: 'apply_patch',
            proposal: {
              schemaVersion: '1',
              changes: [{
                path: 'value.txt',
                baseDigest: await patchContentDigest('broken\n'),
                content: 'fixed\n',
              }],
            },
          };
        },
      },
      now: () => new Date('2026-07-25T15:01:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'passed',
      branch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
      suiteId: 'suite-execution-bootstrap',
      evidenceIds: ['evidence-execution-bootstrap-0', 'evidence-execution-bootstrap-1'],
    });
    expect(heartbeatCount).toBeGreaterThanOrEqual(1);
    expect(reservationIds).toHaveLength(2);
    expect(new Set(reservationIds).size).toBe(2);
    expect(usageReservations).toEqual([reservationIds[0], ...reservationIds]);
    expect(agentModels).toEqual(['gpt-test-metered', 'gpt-test-metered']);
    expect(credentialRequests).toBe(2);
    expect(verificationRefs).toEqual(['test:unit', 'verify:all']);
    expect(manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(failures).toEqual([]);
    expect(agentActivity).toEqual({
      schemaVersion: '1',
      jsonlEventCount: 3,
      commandExecutionStartedCount: 0,
      commandExecutionCompletedCount: 0,
      fileChangeStartedCount: 0,
      fileChangeCompletedCount: 1,
      agentMessageCompletedCount: 2,
      turnCompletedCount: 0,
    });
    expect(artifactBody?.content).toBe([
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', status: 'completed' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'PUBLIC_FIRST_NO_OP_TURN' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '[PATCH_PROPOSAL_OMITTED]' },
      }),
      '',
    ].join('\n'));
    expect(requestBodies.filter(({ url }) => !url.endsWith('/artifacts'))
      .every(({ body }) => !body.includes(transcriptMarker))).toBe(true);
    expect(await readdir(runnerTemp)).toEqual([]);
    const remoteHead = (await exec('git', [
      'rev-parse',
      `refs/heads/${repositoryAttemptBranch(TASK_ID, ATTEMPT_ID)}`,
    ], { cwd: fixture.remote })).stdout.trim();
    expect(remoteHead).toBe((result as { headSha: string }).headSha);
    expect(await canonicalSha256(WRITE_TOKEN)).not.toBe(manifestDigest);
  });

  it('reports a bounded external dependency when the repo_write credential is unavailable', async () => {
    const fixture = await repository();
    const runnerTemp = join(fixture.root, 'runner-temp-credential-failure');
    await mkdir(runnerTemp, { mode: 0o700 });
    const taskDigest = await taskRevisionDigest(task());
    const environment: NodeJS.ProcessEnv = {
      DELIVERY_SCHEMA_VERSION: '1',
      DELIVERY_RUN_ID: RUN_ID,
      DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
      DELIVERY_TASK_DIGEST: taskDigest,
      DELIVERY_BASE_SHA: fixture.checkoutSha,
      DELIVERY_CHECKOUT_SHA: fixture.checkoutSha,
      DELIVERY_ATTEMPT_MODE: 'implement',
      DELIVERY_PLAN_VERSION: '1',
      DELIVERY_PLAN_ITEM_ID: ITEM_ID,
      DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=credential-failure',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_TOKEN_CREDENTIAL_FAILURE',
      GITHUB_WORKSPACE: fixture.path,
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: REPOSITORY,
    };
    const attemptToken = 'CANARY_EXECUTION_CREDENTIAL_FAILURE_ATTEMPT_TOKEN';
    const generation = 5;
    const version = 12;
    let credentialRequests = 0;
    let agentCalls = 0;
    let reportedFailure: Record<string, unknown> | undefined;
    const upstreamCanary = 'CANARY_GITHUB_CREDENTIAL_RESPONSE_MUST_NOT_ESCAPE';
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: version,
          leaseGeneration: generation,
          grant: {
            toolBridgeToken: 'CANARY_EXECUTION_CREDENTIAL_FAILURE_TOOL_TOKEN',
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...EXECUTION_TOOL_ACTIONS],
          },
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${attemptToken}`);
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            taskId: TASK_ID,
            mode: 'implement',
            version,
            leaseGeneration: generation,
            baseSha: fixture.checkoutSha,
            checkoutSha: fixture.checkoutSha,
            repository: REPOSITORY,
            baseBranch: 'main',
            planId: PLAN_ID,
            planVersion: 1,
            planItemId: ITEM_ID,
            targetBranch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
            targetBranchMode: 'new',
          },
          task: task(),
          item: {
            id: ITEM_ID,
            kind: 'change',
            title: 'Apply the approved change',
            objective: 'Apply and verify the approved bounded change.',
            required: true,
            doneWhen: ['The trusted verification commands pass on the bot head.'],
            commandRefs: ['test:unit', 'verify:all'],
            evidenceKinds: ['commit', 'test'],
            effects: ['repo_read', 'repo_write'],
          },
        });
      }
      if (url.endsWith('/github/write-token')) {
        credentialRequests += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersion: version,
          leaseGeneration: generation,
        });
        return new Response(upstreamCanary, { status: 503 });
      }
      if (url.endsWith('/events')) {
        reportedFailure = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ accepted: true }, {
          status: 202,
          headers: { 'cache-control': 'no-store' },
        });
      }
      throw new Error(`unexpected fake URL: ${url}`);
    };

    await expect(runExecutionAttempt({
      environment,
      fetch: fetchImplementation,
      heartbeatIntervalMs: 60_000,
      agent: {
        apply: async () => {
          agentCalls += 1;
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      now: () => new Date('2026-08-05T08:00:00.000Z'),
    })).rejects.toThrow('repo_write credential dependency is unavailable');

    expect(credentialRequests).toBe(1);
    expect(agentCalls).toBe(0);
    expect(reportedFailure).toMatchObject({
      schemaVersion: '1',
      type: 'attempt_failed',
      sequence: 1,
      failureCode: 'tool_unavailable',
      failureSite: 'external_reconciliation',
      attemptedPaths: ['external_reconciliation'],
      neededHumanInput: 'resolve_external_dependency',
      expectedVersion: version,
      leaseGeneration: generation,
    });
    expect(JSON.stringify(reportedFailure)).not.toContain(upstreamCanary);
    expect(await readdir(runnerTemp)).toEqual([]);
  });

  it('turns only a real nonzero targeted result into the fixed terminal failure event', async () => {
    const fixture = await repository();
    const runnerTemp = join(fixture.root, 'runner-temp-failure');
    await mkdir(runnerTemp, { mode: 0o700 });
    const taskDigest = await taskRevisionDigest(task());
    const environment: NodeJS.ProcessEnv = {
      DELIVERY_SCHEMA_VERSION: '1',
      DELIVERY_RUN_ID: RUN_ID,
      DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
      DELIVERY_TASK_DIGEST: taskDigest,
      DELIVERY_BASE_SHA: fixture.baseSha,
      DELIVERY_CHECKOUT_SHA: fixture.checkoutSha,
      DELIVERY_ATTEMPT_MODE: 'review_fix',
      DELIVERY_PLAN_VERSION: '1',
      DELIVERY_PLAN_ITEM_ID: ITEM_ID,
      DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=failure',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_RUNTIME_TOKEN_FAILURE',
      GITHUB_WORKSPACE: fixture.path,
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: REPOSITORY,
    };
    const attemptToken = 'CANARY_EXECUTION_FAILURE_ATTEMPT_TOKEN';
    const generation = 4;
    let version = 10;
    let headSha = '';
    let failureBody: Record<string, unknown> | undefined;
    let repairCommand: unknown;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.startsWith('https://oidc.actions.test/token')) {
        return Response.json({ value: OIDC_TOKEN });
      }
      if (url.endsWith('/exchange')) {
        return Response.json({
          attemptToken,
          expiresAt: '2099-01-01T00:00:00.000Z',
          attemptVersion: version,
          leaseGeneration: generation,
          grant: {
            toolBridgeToken: 'CANARY_EXECUTION_FAILURE_TOOL_TOKEN',
            expiresAt: '2099-01-01T00:00:00.000Z',
            scopes: [...EXECUTION_TOOL_ACTIONS],
          },
        });
      }
      expect(authorization).toBe(`Bearer ${attemptToken}`);
      if (url.endsWith('/context')) {
        return Response.json({
          schemaVersion: '1',
          attempt: {
            id: ATTEMPT_ID,
            runId: RUN_ID,
            taskId: TASK_ID,
            mode: 'review_fix',
            version,
            leaseGeneration: generation,
            baseSha: fixture.baseSha,
            checkoutSha: fixture.checkoutSha,
            repository: REPOSITORY,
            baseBranch: 'main',
            planId: PLAN_ID,
            planVersion: 1,
            planItemId: ITEM_ID,
            targetBranch: `agent/${TASK_ID}/${ATTEMPT_ID}`,
            targetBranchMode: 'new',
          },
          task: task(),
          item: {
            id: ITEM_ID,
            kind: 'verification',
            title: 'Repair and verify',
            objective: 'Apply the smallest fix and rerun trusted verification.',
            required: true,
            doneWhen: ['Targeted and required verification pass on the bot head.'],
            commandRefs: ['test:unit', 'verify:all'],
            evidenceKinds: ['test'],
            effects: ['repo_write'],
          },
          repair: {
            failedAttemptId: 'attempt-failed-before-bootstrap',
            sourceSuiteId: 'suite-failed-before-bootstrap',
            sourceEvidenceId: 'evidence-failed-before-bootstrap',
            sourceHeadSha: fixture.checkoutSha,
            failureFactDigest: `sha256:${'8'.repeat(64)}`,
            phase: 'targeted',
            commandRef: 'test:unit',
            exitCode: 7,
          },
        });
      }
      if (url.endsWith('/github/write-token')) {
        return Response.json({
          credentialId: 'credential-execution-failure',
          repository: REPOSITORY,
          token: WRITE_TOKEN,
          expiresAt: '2099-01-01T00:00:00.000Z',
          githubExpiresAt: '2099-01-01T00:00:00.000Z',
          approvalId: 'approval-execution-failure',
          permissions: { contents: 'write', pullRequests: 'write' },
          created: true,
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/head')) {
        const body = JSON.parse(String(init?.body)) as { headSha: string };
        headSha = body.headSha;
        version += 1;
        return Response.json({
          updateId: 'head-update-execution-failure',
          evidenceId: 'evidence-commit-execution-failure',
          created: true,
          version,
          leaseGeneration: generation,
          parentSha: fixture.checkoutSha,
          headSha,
          branch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/verifications')) {
        return Response.json({
          suiteId: 'suite-execution-failure',
          created: true,
          status: 'running',
          commands: [
            { position: 0, phase: 'targeted', commandRef: 'test:unit' },
            { position: 1, phase: 'required_verify', commandRef: 'verify:all' },
          ],
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.includes('/verifications/suite-execution-failure/results')) {
        const body = JSON.parse(String(init?.body)) as {
          result: { position: number; commandRef: string; exitCode: number; headSha: string };
        };
        expect(body.result).toMatchObject({
          position: 0,
          commandRef: 'test:unit',
          exitCode: 7,
          headSha,
        });
        return Response.json({
          evidenceId: 'evidence-execution-failure-0',
          created: true,
          suiteStatus: 'failed',
        }, { status: 201, headers: { 'cache-control': 'no-store' } });
      }
      if (url.endsWith('/events')) {
        failureBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ accepted: true }, {
          status: 202,
          headers: { 'cache-control': 'no-store' },
        });
      }
      throw new Error(`unexpected fake URL: ${url}`);
    };

    const result = await runExecutionAttempt({
      environment,
      fetch: fetchImplementation,
      heartbeatIntervalMs: 60_000,
      agent: {
        apply: async (input) => {
          repairCommand = input.repairCommand;
          await writeFile(join(fixture.path, 'value.txt'), 'still-broken\n');
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      now: () => new Date('2026-07-25T15:02:00.000Z'),
    });
    expect(result).toMatchObject({
      status: 'failed',
      suiteId: 'suite-execution-failure',
      failedCommandRef: 'test:unit',
      evidenceIds: ['evidence-execution-failure-0'],
      headSha,
    });
    expect(failureBody).toMatchObject({
      schemaVersion: '1',
      type: 'attempt_failed',
      sequence: 1,
      failureCode: 'verification_nonzero_exit',
      failureSite: 'targeted_verification',
      attemptedPaths: ['code_change', 'targeted_test'],
      neededHumanInput: 'manual_investigation',
      expectedVersion: 11,
      leaseGeneration: generation,
    });
    expect(failureBody).not.toHaveProperty('message');
    expect(failureBody).not.toHaveProperty('stack');
    expect(repairCommand).toEqual({
      ref: 'test:unit',
      argv: [
        'node',
        '-e',
        "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='fixed'?0:7)",
      ],
    });
    expect(await readdir(runnerTemp)).toEqual([]);
  });
});
