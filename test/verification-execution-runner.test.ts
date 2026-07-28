import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { CommandExecutor } from '../src/agent/command-runtime.js';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import { verificationSuiteCommands } from '../src/domain/verification-evidence.js';
import type { GitCommandExecutor } from '../src/runner/git-repository-writer.js';
import {
  VerificationExecutionError,
  VerificationExecutionRunner,
  type VerificationEvidenceReporter,
} from '../src/runner/verification-execution-runner.js';

const HEAD_SHA = 'a'.repeat(40);
const executeFile = promisify(execFile);
const POLICY = await parseDeliveryPolicy(`
schemaVersion: '1'
commands:
  setup:
    install: { argv: [pnpm, install], timeoutSeconds: 600 }
  targeted:
    integration: { argv: [pnpm, test, integration], timeoutSeconds: 300 }
    unit: { argv: [pnpm, test, unit], timeoutSeconds: 300 }
  verify:
    all: { argv: [pnpm, verify, all], timeoutSeconds: 1200 }
    security: { argv: [pnpm, verify, security], timeoutSeconds: 600 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);

function gitExecutor(heads: string[] = [HEAD_SHA]): GitCommandExecutor {
  let call = 0;
  return vi.fn(async (request) => {
    expect(request.args).toEqual(['rev-parse', '--verify', 'HEAD']);
    const head = heads[Math.min(call, heads.length - 1)]!;
    call += 1;
    return { exitCode: 0, stdout: `${head}\n`, stderr: '' };
  });
}

function reporter(): VerificationEvidenceReporter & {
  starts: unknown[];
  records: Array<Record<string, unknown>>;
} {
  const starts: unknown[] = [];
  const records: Array<Record<string, unknown>> = [];
  let commandCount = 0;
  return {
    starts,
    records,
    async start(manifest) {
      starts.push(manifest);
      commandCount = verificationSuiteCommands(manifest).length;
      return {
        suiteId: 'verification-suite-1',
        created: true,
        status: 'running',
        commands: verificationSuiteCommands(manifest),
      };
    },
    async record(suiteId, result) {
      records.push({ suiteId, ...result });
      return {
        evidenceId: `evidence-${result.position}`,
        created: true,
        suiteStatus: result.exitCode !== 0
          ? 'failed'
          : result.position === commandCount - 1
            ? 'completed'
            : 'running',
      };
    },
  };
}

describe('verification execution runner', () => {
  it('executes real targeted and required subprocesses in a Git repository', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'delivery-verification-runner-'));
    await executeFile('git', ['init'], { cwd: repository });
    await executeFile('git', ['config', 'user.name', 'Verification Test'], { cwd: repository });
    await executeFile('git', ['config', 'user.email', 'verification@example.test'], {
      cwd: repository,
    });
    await writeFile(join(repository, 'README.md'), 'verification fixture\n');
    await executeFile('git', ['add', 'README.md'], { cwd: repository });
    await executeFile('git', ['commit', '-m', 'fixture'], { cwd: repository });
    const headSha = (await executeFile('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    })).stdout.trim();
    const deliveryPolicy = await parseDeliveryPolicy(`
schemaVersion: '1'
commands:
  setup:
    install: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  targeted:
    smoke: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);
    const evidence = reporter();
    const runner = new VerificationExecutionRunner({
      repositoryPath: repository,
      expectedHeadSha: headSha,
      deliveryPolicy,
      targetedCommandRefs: ['test:smoke'],
      reporter: evidence,
    });

    await expect(runner.run()).resolves.toEqual({
      suiteId: 'verification-suite-1',
      status: 'passed',
      evidenceIds: ['evidence-0', 'evidence-1'],
    });
    expect(evidence.records.map((record) => record.commandRef)).toEqual([
      'test:smoke',
      'verify:all',
    ]);
    expect(evidence.records.every((record) =>
      typeof record.durationMs === 'number' && record.durationMs >= 0)).toBe(true);
  });

  it('runs selected targeted tests before every required verify and reports exact evidence facts', async () => {
    const commandRequests: Parameters<CommandExecutor>[0][] = [];
    const executor: CommandExecutor = vi.fn(async (request) => {
      commandRequests.push(request);
      return { exitCode: 0, stderr: 'must not enter Evidence' };
    });
    const evidence = reporter();
    let monotonic = 0;
    const runner = new VerificationExecutionRunner({
      repositoryPath: '/trusted/repository',
      expectedHeadSha: HEAD_SHA,
      deliveryPolicy: POLICY,
      targetedCommandRefs: ['test:unit'],
      reporter: evidence,
    }, {
      commandExecutor: executor,
      gitExecutor: gitExecutor(),
      monotonicNow: () => {
        monotonic += 10;
        return monotonic;
      },
    });

    await expect(runner.run()).resolves.toEqual({
      suiteId: 'verification-suite-1',
      status: 'passed',
      evidenceIds: ['evidence-0', 'evidence-1', 'evidence-2'],
    });
    expect(commandRequests.map(({ command, args }) => [command, ...args])).toEqual([
      ['pnpm', 'test', 'unit'],
      ['pnpm', 'verify', 'all'],
      ['pnpm', 'verify', 'security'],
    ]);
    expect(evidence.starts).toEqual([{
      schemaVersion: '1',
      headSha: HEAD_SHA,
      policyDigest: POLICY.digest,
      targetedCommandRefs: ['test:unit'],
      requiredVerifyCommandRefs: ['verify:all', 'verify:security'],
    }]);
    expect(evidence.records).toEqual([
      {
        suiteId: 'verification-suite-1',
        schemaVersion: '1',
        position: 0,
        phase: 'targeted',
        commandRef: 'test:unit',
        exitCode: 0,
        durationMs: 10,
        headSha: HEAD_SHA,
      },
      {
        suiteId: 'verification-suite-1',
        schemaVersion: '1',
        position: 1,
        phase: 'required_verify',
        commandRef: 'verify:all',
        exitCode: 0,
        durationMs: 10,
        headSha: HEAD_SHA,
      },
      {
        suiteId: 'verification-suite-1',
        schemaVersion: '1',
        position: 2,
        phase: 'required_verify',
        commandRef: 'verify:security',
        exitCode: 0,
        durationMs: 10,
        headSha: HEAD_SHA,
      },
    ]);
    expect(JSON.stringify(evidence.records)).not.toContain('must not enter Evidence');
  });

  it('records a targeted failure and never starts required verification', async () => {
    const executor: CommandExecutor = vi.fn(async () => ({ exitCode: 7 }));
    const evidence = reporter();
    const runner = new VerificationExecutionRunner({
      repositoryPath: '/trusted/repository',
      expectedHeadSha: HEAD_SHA,
      deliveryPolicy: POLICY,
      targetedCommandRefs: ['test:integration'],
      reporter: evidence,
    }, {
      commandExecutor: executor,
      gitExecutor: gitExecutor(),
      monotonicNow: (() => {
        let now = 0;
        return () => (now += 5);
      })(),
    });

    await expect(runner.run()).resolves.toEqual({
      suiteId: 'verification-suite-1',
      status: 'failed',
      failedCommandRef: 'test:integration',
      evidenceIds: ['evidence-0'],
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(evidence.records).toEqual([
      expect.objectContaining({
        phase: 'targeted',
        commandRef: 'test:integration',
        exitCode: 7,
        durationMs: 5,
      }),
    ]);
  });

  it('stops the remaining required commands after the first required verify failure', async () => {
    let call = 0;
    const executor: CommandExecutor = vi.fn(async () => {
      call += 1;
      return { exitCode: call === 2 ? 4 : 0 };
    });
    const evidence = reporter();
    const runner = new VerificationExecutionRunner({
      repositoryPath: '/trusted/repository',
      expectedHeadSha: HEAD_SHA,
      deliveryPolicy: POLICY,
      targetedCommandRefs: ['test:unit'],
      reporter: evidence,
    }, { commandExecutor: executor, gitExecutor: gitExecutor() });

    await expect(runner.run()).resolves.toMatchObject({
      status: 'failed',
      failedCommandRef: 'verify:all',
      evidenceIds: ['evidence-0', 'evidence-1'],
    });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(evidence.records.map((record) => record.commandRef)).toEqual([
      'test:unit',
      'verify:all',
    ]);
  });

  it('rejects an empty, unknown, or non-targeted selection before starting a suite', async () => {
    for (const targetedCommandRefs of [
      [],
      ['test:missing'],
      ['verify:all'],
      ['test:unit', 'test:unit'],
    ]) {
      const evidence = reporter();
      const executor: CommandExecutor = vi.fn(async () => ({ exitCode: 0 }));
      const runner = new VerificationExecutionRunner({
        repositoryPath: '/trusted/repository',
        expectedHeadSha: HEAD_SHA,
        deliveryPolicy: POLICY,
        targetedCommandRefs,
        reporter: evidence,
      }, { commandExecutor: executor, gitExecutor: gitExecutor() });
      await expect(runner.run()).rejects.toBeInstanceOf(VerificationExecutionError);
      expect(evidence.starts).toEqual([]);
      expect(executor).not.toHaveBeenCalled();
    }
  });

  it('fails closed without Evidence if a command changes HEAD', async () => {
    const evidence = reporter();
    const runner = new VerificationExecutionRunner({
      repositoryPath: '/trusted/repository',
      expectedHeadSha: HEAD_SHA,
      deliveryPolicy: POLICY,
      targetedCommandRefs: ['test:unit'],
      reporter: evidence,
    }, {
      commandExecutor: async () => ({ exitCode: 0 }),
      gitExecutor: gitExecutor([HEAD_SHA, 'b'.repeat(40)]),
    });
    await expect(runner.run()).rejects.toMatchObject({
      name: VerificationExecutionError.name,
      code: 'head_changed',
    });
    expect(evidence.records).toEqual([]);
  });
});
