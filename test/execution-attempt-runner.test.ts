import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import { CodexExecutionAdapterError } from '../src/agent/codex-execution-adapter.js';
import type { VerificationEvidenceReporter } from '../src/runner/verification-execution-runner.js';
import {
  ExecutionAttemptRunner,
  type ExecutionAttemptError,
  type ExecutionAttemptFailure,
} from '../src/runner/execution-attempt-runner.js';
import {
  GitRepositoryWriter,
  ProtectedPathApprovalRequired,
  repositoryAttemptBranch,
} from '../src/runner/git-repository-writer.js';

const exec = promisify(execFile);
const TASK_ID = 'task-execution-runner';
const ATTEMPT_ID = 'attempt-execution-runner';

const policy = await parseDeliveryPolicy(`
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

async function repository(): Promise<{
  path: string;
  remote: string;
  checkoutSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-execution-runner-'));
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
    unit: { argv: [node, -e, "process.exit(0)"], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, "process.exit(0)"], timeoutSeconds: 60 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);
  await writeFile(join(path, 'value.txt'), 'broken\n');
  await exec('git', ['add', '.'], { cwd: path });
  await exec('git', ['commit', '-m', 'failed verification head'], { cwd: path });
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: path });
  const checkoutSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  return { path, remote, checkoutSha };
}

function evidenceReporter(): VerificationEvidenceReporter & {
  commands: string[];
} {
  const commands: string[] = [];
  let count = 0;
  return {
    commands,
    async start(manifest) {
      const all = [
        ...manifest.targetedCommandRefs.map((commandRef, position) => ({
          position,
          phase: 'targeted' as const,
          commandRef,
        })),
        ...manifest.requiredVerifyCommandRefs.map((commandRef, index) => ({
          position: manifest.targetedCommandRefs.length + index,
          phase: 'required_verify' as const,
          commandRef,
        })),
      ];
      count = all.length;
      return { suiteId: 'suite-execution-runner', created: true, status: 'running', commands: all };
    },
    async record(_suiteId, result) {
      commands.push(result.commandRef);
      return {
        evidenceId: `evidence-execution-${result.position}`,
        created: true,
        suiteStatus: result.exitCode !== 0
          ? 'failed'
          : result.position === count - 1 ? 'completed' : 'running',
      };
    },
  };
}

function writer(path: string, checkoutSha: string): GitRepositoryWriter {
  return new GitRepositoryWriter({
    repositoryPath: path,
    repository: 'example/delivery-target',
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    baseSha: checkoutSha,
    baseBranch: 'main',
    protectedBranches: [],
    deliveryPolicy: policy,
    onProtectedPathApprovalRequired: async () => undefined,
    credential: {
      credentialId: 'credential-execution-runner',
      repository: 'example/delivery-target',
      approvalId: 'approval-execution-runner',
      token: 'test-repository-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      permissions: { contents: 'write', pullRequests: 'write' },
    },
  });
}

function agentInput(repositoryPath: string) {
  const root = dirname(repositoryPath);
  return {
    attemptId: ATTEMPT_ID,
    workspacePath: repositoryPath,
    contextFilePath: join(root, 'execution-context.json'),
    outputFilePath: join(root, 'execution-output.txt'),
    timeoutMs: 60_000,
    allowPlanRevision: false,
  };
}

describe('execution Attempt Runner', () => {
  it('creates a new Attempt branch, commits/pushes the Agent fix, then runs targeted and required verify', async () => {
    const fixture = await repository();
    const evidence = evidenceReporter();
    const heads: Array<Record<string, string>> = [];
    const failures: ExecutionAttemptFailure[] = [];
    const runner = new ExecutionAttemptRunner({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      planVersion: 1,
      planItemId: 'verify-and-repair',
      targetedCommandRefs: ['test:unit'],
      deliveryPolicy: policy,
      repositoryWriter: writer(fixture.path, fixture.checkoutSha),
      agent: { apply: async () => {
        await writeFile(join(fixture.path, 'value.txt'), 'fixed\n');
        return { schemaVersion: '1' as const, action: 'apply_fix' as const };
      } },
      agentInput: agentInput(fixture.path),
      headReporter: { record: async (head) => { heads.push(head); } },
      evidenceReporter: evidence,
      failureReporter: { report: async (failure) => { failures.push(failure); } },
    });

    await expect(runner.run()).resolves.toMatchObject({
      status: 'passed',
      branch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID),
      evidenceIds: ['evidence-execution-0', 'evidence-execution-1'],
    });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({ parentSha: fixture.checkoutSha });
    expect(heads[0]?.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.commands).toEqual(['test:unit', 'verify:all']);
    expect(failures).toEqual([]);
    const remoteHead = (await exec(
      'git',
      ['rev-parse', `refs/heads/${repositoryAttemptBranch(TASK_ID, ATTEMPT_ID)}`],
      { cwd: fixture.remote },
    )).stdout.trim();
    expect(remoteHead).toBe(heads[0]?.headSha);
  });

  it('reports a trusted targeted failure and does not execute required verify', async () => {
    const fixture = await repository();
    const evidence = evidenceReporter();
    const failures: ExecutionAttemptFailure[] = [];
    const runner = new ExecutionAttemptRunner({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      planVersion: 1,
      planItemId: 'verify-and-repair',
      targetedCommandRefs: ['test:unit'],
      deliveryPolicy: policy,
      repositoryWriter: writer(fixture.path, fixture.checkoutSha),
      agent: { apply: async () => {
        await writeFile(join(fixture.path, 'value.txt'), 'still-broken\n');
        return { schemaVersion: '1' as const, action: 'apply_fix' as const };
      } },
      agentInput: agentInput(fixture.path),
      headReporter: { record: async () => undefined },
      evidenceReporter: evidence,
      failureReporter: { report: async (failure) => { failures.push(failure); } },
    });

    await expect(runner.run()).resolves.toMatchObject({
      status: 'failed',
      failedCommandRef: 'test:unit',
      evidenceIds: ['evidence-execution-0'],
    });
    expect(evidence.commands).toEqual(['test:unit']);
    expect(failures).toEqual([{
      failureCode: 'verification_nonzero_exit',
      failureSite: 'targeted_verification',
      attemptedPaths: ['code_change', 'targeted_test'],
      neededHumanInput: 'manual_investigation',
    }]);
  });

  it('requires exact Agent input and reports Agent failure with a fixed redacted classification', async () => {
    const fixture = await repository();
    const failures: ExecutionAttemptFailure[] = [];
    const base = {
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      planVersion: 1,
      planItemId: 'verify-and-repair',
      targetedCommandRefs: ['test:unit'],
      deliveryPolicy: policy,
      repositoryWriter: writer(fixture.path, fixture.checkoutSha),
      headReporter: { record: async () => undefined },
      evidenceReporter: evidenceReporter(),
      failureReporter: { report: async (failure: ExecutionAttemptFailure) => { failures.push(failure); } },
    };
    expect(() => new ExecutionAttemptRunner({
      ...base,
      agent: { apply: async () => ({ schemaVersion: '1', action: 'apply_fix' }) },
    } as never)).toThrow('execution Attempt context is invalid');

    const runner = new ExecutionAttemptRunner({
      ...base,
      agent: {
        apply: async () => { throw new CodexExecutionAdapterError('transcript_invalid'); },
      },
      agentInput: agentInput(fixture.path),
    });
    const rejected = runner.run();
    await expect(rejected).rejects.toMatchObject({
      name: 'ExecutionAttemptError',
      kind: 'transcript_invalid',
      message: 'execution Attempt failed',
    } satisfies Partial<ExecutionAttemptError>);
    expect(failures).toEqual([{
      failureCode: 'invalid_agent_output',
      failureSite: 'agent_output',
      attemptedPaths: ['code_change'],
      neededHumanInput: 'manual_investigation',
    }]);
  });

  it('reports and classifies a no-change commit boundary without exposing repository errors', async () => {
    const fixture = await repository();
    const failures: ExecutionAttemptFailure[] = [];
    const runner = new ExecutionAttemptRunner({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      planVersion: 1,
      planItemId: 'verify-and-repair',
      targetedCommandRefs: ['test:unit'],
      deliveryPolicy: policy,
      repositoryWriter: writer(fixture.path, fixture.checkoutSha),
      agent: { apply: async () => ({ schemaVersion: '1', action: 'apply_fix' }) },
      agentInput: agentInput(fixture.path),
      headReporter: { record: async () => undefined },
      evidenceReporter: evidenceReporter(),
      failureReporter: { report: async (failure) => { failures.push(failure); } },
    });

    await expect(runner.run()).rejects.toMatchObject({
      name: 'ExecutionAttemptError',
      kind: 'repository_commit_failed',
      message: 'execution Attempt failed',
    } satisfies Partial<ExecutionAttemptError>);
    expect(failures).toEqual([{
      failureCode: 'unknown_failure',
      failureSite: 'repo_snapshot',
      attemptedPaths: ['code_change'],
      neededHumanInput: 'manual_investigation',
    }]);
  });

  it('preserves the protected-path pause instead of reporting a terminal commit failure', async () => {
    const fixture = await repository();
    const failures: ExecutionAttemptFailure[] = [];
    const runner = new ExecutionAttemptRunner({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      planVersion: 1,
      planItemId: 'verify-and-repair',
      targetedCommandRefs: ['test:unit'],
      deliveryPolicy: policy,
      repositoryWriter: writer(fixture.path, fixture.checkoutSha),
      agent: { apply: async () => {
        await mkdir(join(fixture.path, '.github', 'workflows'), { recursive: true });
        await writeFile(join(fixture.path, '.github', 'workflows', 'unsafe.yml'), 'name: unsafe\n');
        return { schemaVersion: '1', action: 'apply_fix' };
      } },
      agentInput: agentInput(fixture.path),
      headReporter: { record: async () => undefined },
      evidenceReporter: evidenceReporter(),
      failureReporter: { report: async (failure) => { failures.push(failure); } },
    });

    await expect(runner.run()).rejects.toBeInstanceOf(ProtectedPathApprovalRequired);
    expect(failures).toEqual([]);
  });

  it('keeps the safe stage kind when terminal failure reporting also fails', async () => {
    const fixture = await repository();
    const runner = new ExecutionAttemptRunner({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      planVersion: 1,
      planItemId: 'verify-and-repair',
      targetedCommandRefs: ['test:unit'],
      deliveryPolicy: policy,
      repositoryWriter: writer(fixture.path, fixture.checkoutSha),
      agent: { apply: async () => ({ schemaVersion: '1', action: 'apply_fix' }) },
      agentInput: agentInput(fixture.path),
      headReporter: { record: async () => undefined },
      evidenceReporter: evidenceReporter(),
      failureReporter: { report: async () => { throw new Error('CANARY_RAW_REPORT_ERROR'); } },
    });

    const rejected = runner.run();
    await expect(rejected).rejects.toMatchObject({
      name: 'ExecutionAttemptError',
      kind: 'repository_commit_failed',
      message: 'execution Attempt failed',
    });
    await expect(rejected).rejects.not.toThrow(/CANARY_RAW_REPORT_ERROR/);
  });

  it('reports and classifies push and head boundaries without propagating raw errors', async () => {
    const fixture = await repository();
    const failureCases = [
      {
        kind: 'repository_push_failed' as const,
        writer: {
          prepareBranch: async () => ({ branch: 'agent-safe-branch', baseSha: fixture.checkoutSha }),
          commitAll: async () => ({
            branch: 'agent-safe-branch',
            commitSha: 'a'.repeat(40),
            authorName: 'Delivery Loop Bot' as const,
            authorEmail: 'delivery-loop[bot]@users.noreply.github.com' as const,
          }),
          push: async () => { throw new Error('CANARY_RAW_PUSH_ERROR'); },
        },
        headReporter: { record: async () => undefined },
        failure: {
          failureCode: 'tool_unavailable' as const,
          failureSite: 'external_reconciliation' as const,
          attemptedPaths: ['code_change', 'external_reconciliation'] as const,
          neededHumanInput: 'resolve_external_dependency' as const,
        },
      },
      {
        kind: 'head_report_failed' as const,
        writer: {
          prepareBranch: async () => ({ branch: 'agent-safe-branch', baseSha: fixture.checkoutSha }),
          commitAll: async () => ({
            branch: 'agent-safe-branch',
            commitSha: 'a'.repeat(40),
            authorName: 'Delivery Loop Bot' as const,
            authorEmail: 'delivery-loop[bot]@users.noreply.github.com' as const,
          }),
          push: async () => ({ branch: 'agent-safe-branch', commitSha: 'a'.repeat(40) }),
        },
        headReporter: { record: async () => { throw new Error('CANARY_RAW_HEAD_ERROR'); } },
        failure: {
          failureCode: 'unknown_failure' as const,
          failureSite: 'external_reconciliation' as const,
          attemptedPaths: ['code_change', 'external_reconciliation'] as const,
          neededHumanInput: 'manual_investigation' as const,
        },
      },
    ];
    for (const failureCase of failureCases) {
      const failures: ExecutionAttemptFailure[] = [];
      const runner = new ExecutionAttemptRunner({
        repositoryPath: fixture.path,
        checkoutSha: fixture.checkoutSha,
        planVersion: 1,
        planItemId: 'verify-and-repair',
        targetedCommandRefs: ['test:unit'],
        deliveryPolicy: policy,
        repositoryWriter: failureCase.writer,
        agent: { apply: async () => ({ schemaVersion: '1', action: 'apply_fix' }) },
        agentInput: agentInput(fixture.path),
        headReporter: failureCase.headReporter,
        evidenceReporter: evidenceReporter(),
        failureReporter: { report: async (failure) => { failures.push(failure); } },
      });
      const rejected = runner.run();
      await expect(rejected).rejects.toMatchObject({
        name: 'ExecutionAttemptError',
        kind: failureCase.kind,
        message: 'execution Attempt failed',
      });
      await expect(rejected).rejects.not.toThrow(/CANARY_RAW_(?:PUSH|HEAD)_ERROR/);
      expect(failures).toEqual([{
        ...failureCase.failure,
        attemptedPaths: [...failureCase.failure.attemptedPaths],
      }]);
    }
  });

  it('requests immutable re-analysis before commit/push/verification when exact review feedback changes the Plan', async () => {
    const fixture = await repository();
    const evidence = evidenceReporter();
    const revisions: string[] = [];
    const runner = new ExecutionAttemptRunner({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      planVersion: 1,
      planItemId: 'verify-and-repair',
      targetedCommandRefs: ['test:unit'],
      deliveryPolicy: policy,
      repositoryWriter: writer(fixture.path, fixture.checkoutSha),
      agent: { apply: async () => ({
        schemaVersion: '1',
        action: 'request_replan',
      }) },
      agentInput: { ...agentInput(fixture.path), allowPlanRevision: true },
      planRevisionReporter: {
        request: async () => {
          revisions.push('requested');
          return {
            revisionId: 'plan_revision_review',
            analysisAttemptId: 'attempt_replan_review',
            dispatchOutboxId: 'dispatch_replan_review',
            runVersion: 12,
          };
        },
      },
      headReporter: { record: async () => { throw new Error('head must not be recorded'); } },
      evidenceReporter: evidence,
      failureReporter: { report: async () => { throw new Error('failure must not be reported'); } },
    });

    await expect(runner.run()).resolves.toEqual({
      status: 'replanning',
      revisionId: 'plan_revision_review',
      analysisAttemptId: 'attempt_replan_review',
      dispatchOutboxId: 'dispatch_replan_review',
      runVersion: 12,
    });
    expect(revisions).toEqual(['requested']);
    expect(evidence.commands).toEqual([]);
    await expect(exec(
      'git',
      ['show-ref', '--verify', `refs/heads/${repositoryAttemptBranch(TASK_ID, ATTEMPT_ID)}`],
      { cwd: fixture.remote },
    )).rejects.toThrow();
  });
});
