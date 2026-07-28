import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { launchCommand, type CommandExecutionRequest } from '../src/agent/command-runtime.js';
import { CodexSessionAdapter } from '../src/agent/codex-session-adapter.js';
import {
  AgentRecoveryRunner,
  type AgentRecoveryContext,
} from '../src/runner/agent-recovery-runner.js';
import {
  computeAgentCheckpointDigest,
  type AgentCheckpointV1,
} from '../src/domain/checkpoint.js';

const executeFile = promisify(execFile);
const OUTPUT_SCHEMA_PATH = resolve('schemas/agent-session-result-v1.schema.json');

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await executeFile('git', args, { cwd: repository, encoding: 'utf8' });
  return result.stdout.trim();
}

async function privateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function repositoryFixture(): Promise<{
  root: string;
  repository: string;
  contextFile: string;
  checkpointFile: string;
  outputFile: string;
  baseSha: string;
  checkpointSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-recovery-runner-'));
  const repository = join(root, 'repo');
  const contextFile = join(root, 'context.json');
  const checkpointFile = join(root, 'checkpoint.json');
  const outputFile = join(root, 'last-message.txt');
  await mkdir(repository, { mode: 0o700 });
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Delivery Loop Test');
  await git(repository, 'config', 'user.email', 'delivery-loop@example.test');
  await writeFile(join(repository, 'state.txt'), 'base\n');
  await git(repository, 'add', 'state.txt');
  await git(repository, 'commit', '-m', 'base');
  const baseSha = await git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'state.txt'), 'checkpoint\n');
  await git(repository, 'add', 'state.txt');
  await git(repository, 'commit', '-m', 'checkpoint');
  const checkpointSha = await git(repository, 'rev-parse', 'HEAD');
  await privateFile(contextFile, JSON.stringify({ taskRef: 'r2://tasks/recovery-test' }));
  return {
    root,
    repository,
    contextFile,
    checkpointFile,
    outputFile,
    baseSha,
    checkpointSha,
  };
}

function checkpoint(headSha: string, sequence: number): AgentCheckpointV1 {
  return {
    schemaVersion: '1',
    sequence,
    provider: 'codex',
    planVersion: 1,
    planItemId: 'recover-active-item',
    headBranch: 'agent/recovery-test/attempt-old',
    headSha,
    completedAcceptanceCriteria: ['The durable checkpoint was published.'],
    evidenceRefs: ['d1://evidence/recovery-checkpoint'],
    summary: 'Continue after the durable checkpoint without repeating prior work.',
    nextStep: 'Verify the remaining acceptance criterion.',
    workingTreeDigest: `sha256:${'d'.repeat(64)}`,
  };
}

describe('Agent Runner Git + semantic checkpoint recovery', () => {
  it('kills the old process and resumes a new Attempt at the checkpoint commit', async () => {
    const fixture = await repositoryFixture();
    const oldAdapter = new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      launch: () =>
        launchCommand({
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: fixture.repository,
          stdin: '',
          timeoutMs: 10_000,
        }),
    });
    const oldSession = await oldAdapter.start({
      attemptId: 'attempt-recovery-old',
      workspacePath: fixture.repository,
      contextFilePath: fixture.contextFile,
      outputFilePath: fixture.outputFile,
      timeoutMs: 10_000,
      initialCheckpoint: checkpoint(fixture.checkpointSha, 1),
    });
    oldSession.recordCheckpoint(checkpoint(fixture.checkpointSha, 2));
    const exported = await oldAdapter.exportCheckpoint(oldSession);
    await privateFile(fixture.checkpointFile, JSON.stringify(exported));
    await oldAdapter.interrupt(oldSession, 'simulated Runner kill');
    expect(oldSession.status).toBe('interrupted');

    await git(fixture.repository, 'checkout', '--detach', fixture.baseSha);
    expect(await git(fixture.repository, 'rev-parse', 'HEAD')).toBe(fixture.baseSha);

    let observed: CommandExecutionRequest | undefined;
    const resumedAdapter = new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      launch: (request) => {
        observed = request;
        return launchCommand({
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: request.cwd,
          stdin: '',
          timeoutMs: request.timeoutMs,
        });
      },
    });
    const context: AgentRecoveryContext = {
      attemptId: 'attempt-recovery-new',
      runId: 'run-recovery-test',
      planVersion: 1,
      planItemId: 'recover-active-item',
      checkpointDigest: await computeAgentCheckpointDigest(exported),
      checkpointFilePath: fixture.checkpointFile,
      contextFilePath: fixture.contextFile,
      outputFilePath: fixture.outputFile,
      completedPlanItemIds: ['already-passed-item'],
    };
    const result = await new AgentRecoveryRunner(resumedAdapter).resume({
      repositoryPath: fixture.repository,
      timeoutMs: 10_000,
      context,
    });
    expect(result.skippedPlanItemIds).toEqual(['already-passed-item']);
    expect(result.session.id).toBe('attempt-recovery-new');
    expect(await git(fixture.repository, 'rev-parse', 'HEAD')).toBe(fixture.checkpointSha);
    expect(observed?.stdin).toContain(fixture.checkpointFile);
    expect(observed?.stdin).not.toContain(exported.summary);
    expect(observed?.stdin).not.toContain('already-passed-item');
    expect(await result.session.completion).toEqual({ exitCode: 0 });
    expect(result.session.status).toBe('completed');
  });

  it('refuses to resume a Plan Item already present in the passed set', async () => {
    const fixture = await repositoryFixture();
    const value = checkpoint(fixture.checkpointSha, 2);
    await privateFile(fixture.checkpointFile, JSON.stringify(value));
    const adapter = new CodexSessionAdapter({
      outputSchemaPath: OUTPUT_SCHEMA_PATH,
      launch: () => {
        throw new Error('provider must not start');
      },
    });
    await expect(
      new AgentRecoveryRunner(adapter).resume({
        repositoryPath: fixture.repository,
        timeoutMs: 10_000,
        context: {
          attemptId: 'attempt-recovery-rejected',
          runId: 'run-recovery-test',
          planVersion: 1,
          planItemId: 'recover-active-item',
          checkpointDigest: await computeAgentCheckpointDigest(value),
          checkpointFilePath: fixture.checkpointFile,
          contextFilePath: fixture.contextFile,
          outputFilePath: fixture.outputFile,
          completedPlanItemIds: ['recover-active-item'],
        },
      }),
    ).rejects.toThrow('Recovery target Plan Item is already passed');
    expect(await git(fixture.repository, 'rev-parse', 'HEAD')).toBe(fixture.checkpointSha);
  });
});
