import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import { verificationSuiteCommands } from '../src/domain/verification-evidence.js';
import {
  BaseRebaseRunner,
  type BaseRebaseContext,
} from '../src/runner/base-rebase-runner.js';
import {
  BOT_COMMIT_EMAIL,
  BOT_COMMIT_NAME,
  executeGitCommand,
  repositoryAttemptBranch,
  type GitCommandRequest,
} from '../src/runner/git-repository-writer.js';
import type { VerificationEvidenceReporter } from '../src/runner/verification-execution-runner.js';

const exec = promisify(execFile);
const TASK_ID = 'task-base-rebase';
const SOURCE_ATTEMPT_ID = 'attempt-source';
const TARGET_ATTEMPT_ID = 'attempt-rebase';
const SOURCE_BRANCH = repositoryAttemptBranch(TASK_ID, SOURCE_ATTEMPT_ID);
const TARGET_BRANCH = repositoryAttemptBranch(TASK_ID, TARGET_ATTEMPT_ID);
const POLICY = await parseDeliveryPolicy(`
schemaVersion: '1'
commands:
  setup:
    install: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  targeted:
    unit: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

interface Fixture {
  repository: string;
  oldBaseSha: string;
  newBaseSha: string;
  sourceHeadSha: string;
}

async function fixture(conflict: boolean): Promise<Fixture> {
  const repository = await mkdtemp(join(tmpdir(), 'delivery-base-rebase-'));
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', BOT_COMMIT_NAME);
  await git(repository, 'config', 'user.email', BOT_COMMIT_EMAIL);
  await writeFile(join(repository, 'README.md'), 'base\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', 'base');
  await git(repository, 'branch', '-M', 'main');
  const oldBaseSha = await git(repository, 'rev-parse', 'HEAD');

  await git(repository, 'switch', '--create', SOURCE_BRANCH, oldBaseSha);
  if (conflict) {
    await writeFile(join(repository, 'README.md'), 'source change\n');
    await git(repository, 'add', 'README.md');
  } else {
    await writeFile(join(repository, 'feature.txt'), 'source change\n');
    await git(repository, 'add', 'feature.txt');
  }
  await git(repository, 'commit', '-m', 'source change');
  const sourceHeadSha = await git(repository, 'rev-parse', 'HEAD');

  await git(repository, 'switch', 'main');
  if (conflict) {
    await writeFile(join(repository, 'README.md'), 'base change\n');
    await git(repository, 'add', 'README.md');
  } else {
    await writeFile(join(repository, 'base.txt'), 'base change\n');
    await git(repository, 'add', 'base.txt');
  }
  await git(repository, 'commit', '-m', 'advance base');
  const newBaseSha = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'checkout', '--detach', sourceHeadSha);
  return { repository, oldBaseSha, newBaseSha, sourceHeadSha };
}

function reporter(): VerificationEvidenceReporter & {
  manifests: unknown[];
  records: Array<Record<string, unknown>>;
} {
  const manifests: unknown[] = [];
  const records: Array<Record<string, unknown>> = [];
  let commandCount = 0;
  return {
    manifests,
    records,
    async start(manifest) {
      manifests.push(manifest);
      const commands = verificationSuiteCommands(manifest);
      commandCount = commands.length;
      return {
        suiteId: 'suite-base-rebase',
        created: true,
        status: 'running',
        commands,
      };
    },
    async record(suiteId, result) {
      records.push({ suiteId, ...result });
      return {
        evidenceId: `evidence-base-rebase-${result.position}`,
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

function context(repo: Fixture, evidence: VerificationEvidenceReporter): BaseRebaseContext {
  return {
    repositoryPath: repo.repository,
    taskId: TASK_ID,
    sourceAttemptId: SOURCE_ATTEMPT_ID,
    targetAttemptId: TARGET_ATTEMPT_ID,
    sourceBranch: SOURCE_BRANCH,
    oldBaseSha: repo.oldBaseSha,
    newBaseSha: repo.newBaseSha,
    sourceHeadSha: repo.sourceHeadSha,
    deliveryPolicy: POLICY,
    targetedCommandRefs: ['test:unit'],
    reporter: evidence,
  };
}

describe('safe base rebase and mandatory re-verification', () => {
  it('replays linear bot commits to a new unpublished branch and reruns all verification', async () => {
    const repo = await fixture(false);
    const evidence = reporter();
    const commands: GitCommandRequest[] = [];
    const runner = new BaseRebaseRunner(context(repo, evidence), {
      gitExecutor: async (request) => {
        commands.push(request);
        return await executeGitCommand(request);
      },
    });

    const first = await runner.run();
    expect(first).toMatchObject({
      status: 'passed',
      created: true,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      oldBaseSha: repo.oldBaseSha,
      newBaseSha: repo.newBaseSha,
      sourceHeadSha: repo.sourceHeadSha,
      suiteId: 'suite-base-rebase',
      evidenceIds: ['evidence-base-rebase-0', 'evidence-base-rebase-1'],
    });
    if (first.status !== 'passed') throw new Error('expected successful rebase');
    expect(await git(repo.repository, 'branch', '--show-current')).toBe(TARGET_BRANCH);
    expect(await git(repo.repository, 'merge-base', '--is-ancestor', repo.newBaseSha, first.headSha))
      .toBe('');
    expect(await git(repo.repository, 'rev-parse', SOURCE_BRANCH)).toBe(repo.sourceHeadSha);
    expect(evidence.records.map((record) => record.commandRef)).toEqual([
      'test:unit',
      'verify:all',
    ]);
    expect(commands.some((command) => command.args.includes('push'))).toBe(false);
    expect(commands.some((command) => command.args.some((arg) => arg.includes('--force')))).toBe(
      false,
    );

    const replayEvidence = reporter();
    const replayed = await new BaseRebaseRunner(context(repo, replayEvidence)).run();
    expect(replayed).toMatchObject({
      status: 'passed',
      created: false,
      headSha: first.headSha,
      evidenceIds: ['evidence-base-rebase-0', 'evidence-base-rebase-1'],
    });
    expect(replayEvidence.records).toHaveLength(2);
  });

  it('aborts a content conflict without verification, force push, or source-branch mutation', async () => {
    const repo = await fixture(true);
    const evidence = reporter();
    const commands: GitCommandRequest[] = [];
    const result = await new BaseRebaseRunner(context(repo, evidence), {
      gitExecutor: async (request) => {
        commands.push(request);
        return await executeGitCommand(request);
      },
    }).run();

    expect(result).toEqual({
      status: 'blocked',
      reason: 'content_conflict',
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      oldBaseSha: repo.oldBaseSha,
      newBaseSha: repo.newBaseSha,
      sourceHeadSha: repo.sourceHeadSha,
    });
    expect(await git(repo.repository, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(await git(repo.repository, 'rev-parse', SOURCE_BRANCH)).toBe(repo.sourceHeadSha);
    expect(await git(repo.repository, 'rev-parse', TARGET_BRANCH)).toBe(repo.sourceHeadSha);
    expect(evidence.manifests).toEqual([]);
    expect(evidence.records).toEqual([]);
    expect(commands.some((command) => command.args.includes('push'))).toBe(false);
    expect(commands.some((command) => command.args.some((arg) => arg.includes('--force')))).toBe(
      false,
    );

    const replay = await new BaseRebaseRunner(context(repo, reporter())).run();
    expect(replay).toEqual(result);
  });
});
