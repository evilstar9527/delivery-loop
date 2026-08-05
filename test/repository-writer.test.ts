import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import { patchContentDigest } from '../src/domain/patch-proposal.js';
import {
  BOT_COMMIT_EMAIL,
  BOT_COMMIT_NAME,
  GitRepositoryWriter,
  RepositoryWritePolicyError,
  executeGitCommand,
  repositoryAttemptBranch,
  type GitCommandExecutor,
} from '../src/runner/git-repository-writer.js';

const executeFile = promisify(execFile);
const TASK_ID = 'task-123';
const ATTEMPT_ID = 'attempt-456';
const DELIVERY_POLICY = await parseDeliveryPolicy(`
schemaVersion: '1'
commands:
  setup:
    install: { argv: [pnpm, install], timeoutSeconds: 600 }
  targeted:
    unit: { argv: [pnpm, test], timeoutSeconds: 300 }
  verify:
    all: { argv: [pnpm, verify], timeoutSeconds: 1200 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);

function credential() {
  return {
    credentialId: 'github-write-credential',
    repository: 'example/delivery-target',
    approvalId: 'approval-repo-write',
    token: 'test-repo-write-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    permissions: { contents: 'write', pullRequests: 'write' } as const,
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await executeFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

async function fixture(): Promise<{
  repository: string;
  remote: string;
  baseSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-repository-writer-'));
  const repository = join(root, 'repo');
  const remote = join(root, 'remote.git');
  await mkdir(repository, { mode: 0o700 });
  await git(root, 'init', '--bare', remote);
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Untrusted Host User');
  await git(repository, 'config', 'user.email', 'untrusted@example.test');
  await writeFile(join(repository, 'README.md'), 'base\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', 'base');
  await git(repository, 'branch', '-M', 'main');
  await git(repository, 'remote', 'add', 'origin', remote);
  await git(repository, 'push', 'origin', 'main');
  return { repository, remote, baseSha: await git(repository, 'rev-parse', 'HEAD') };
}

describe('approved Git repository writer', () => {
  it('creates a task/attempt branch, commits as the fixed bot, and pushes only that branch', async () => {
    const repo = await fixture();
    const commands: Parameters<GitCommandExecutor>[0][] = [];
    const executor: GitCommandExecutor = async (request) => {
      commands.push(request);
      return await executeGitCommand(request);
    };
    const writer = new GitRepositoryWriter({
      repositoryPath: repo.repository,
      repository: 'example/delivery-target',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      baseSha: repo.baseSha,
      baseBranch: 'main',
      protectedBranches: ['release'],
      deliveryPolicy: DELIVERY_POLICY,
      onProtectedPathApprovalRequired: async () => undefined,
      credential: credential(),
    }, executor);
    const branch = repositoryAttemptBranch(TASK_ID, ATTEMPT_ID);
    await expect(writer.prepareBranch()).resolves.toEqual({ branch, baseSha: repo.baseSha });
    expect(await git(repo.repository, 'branch', '--show-current')).toBe(branch);

    await writeFile(join(repo.repository, 'README.md'), 'base\napproved change\n');
    const commit = await writer.commitAll();
    expect(commit).toMatchObject({ branch, authorName: BOT_COMMIT_NAME, authorEmail: BOT_COMMIT_EMAIL });
    expect(await git(repo.repository, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD'))
      .toBe(`${BOT_COMMIT_NAME} <${BOT_COMMIT_EMAIL}>|${BOT_COMMIT_NAME} <${BOT_COMMIT_EMAIL}>`);

    await expect(writer.push({ targetBranch: branch, force: false })).resolves.toEqual({
      branch,
      commitSha: commit.commitSha,
    });
    expect(await git(repo.remote, 'show-ref', '--hash', `refs/heads/${branch}`)).toBe(commit.commitSha);
    expect(await git(repo.remote, 'show-ref', '--hash', 'refs/heads/main')).toBe(repo.baseSha);
    expect(commands.some((command) => command.args.includes('--force'))).toBe(false);
    expect(commands.some((command) => command.args.includes('--force-with-lease'))).toBe(false);
    expect(JSON.stringify(commands.map((command) => command.args))).not.toContain(
      credential().token,
    );
    expect(commands.at(-1)?.environment).toMatchObject({
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
        `x-access-token:${credential().token}`,
        'utf8',
      ).toString('base64')}`,
    });
  });

  it('applies only a fully preconditioned bounded text proposal before the bot commit', async () => {
    const repo = await fixture();
    const writer = new GitRepositoryWriter({
      repositoryPath: repo.repository,
      repository: 'example/delivery-target',
      taskId: TASK_ID,
      attemptId: 'attempt-patch-proposal',
      baseSha: repo.baseSha,
      baseBranch: 'main',
      protectedBranches: [],
      deliveryPolicy: DELIVERY_POLICY,
      onProtectedPathApprovalRequired: async () => undefined,
      credential: credential(),
    });
    await writer.prepareBranch();
    await writer.applyPatchProposal({
      schemaVersion: '1',
      changes: [
        {
          path: 'README.md',
          baseDigest: await patchContentDigest('base\n'),
          content: 'base\napproved patch\n',
        },
        { path: 'notes.txt', baseDigest: null, content: 'new file\n' },
      ],
    });
    expect(await readFile(join(repo.repository, 'README.md'), 'utf8'))
      .toBe('base\napproved patch\n');
    expect(await readFile(join(repo.repository, 'notes.txt'), 'utf8')).toBe('new file\n');
    expect(await git(repo.repository, 'rev-parse', 'HEAD')).toBe(repo.baseSha);
    await expect(writer.commitAll()).resolves.toMatchObject({
      branch: repositoryAttemptBranch(TASK_ID, 'attempt-patch-proposal'),
    });
  });

  it('rejects stale, escaping, protected, duplicate, missing-parent, and symlink proposals before writing', async () => {
    const repo = await fixture();
    await mkdir(join(repo.repository, 'real-dir'));
    await symlink('README.md', join(repo.repository, 'linked.txt'));
    await symlink('real-dir', join(repo.repository, 'dir-link'));
    await git(repo.repository, 'add', 'linked.txt', 'dir-link');
    await git(repo.repository, 'commit', '-m', 'add tracked symlink');
    await git(repo.repository, 'push', 'origin', 'main');
    const baseSha = await git(repo.repository, 'rev-parse', 'HEAD');
    const writer = new GitRepositoryWriter({
      repositoryPath: repo.repository,
      repository: 'example/delivery-target',
      taskId: TASK_ID,
      attemptId: 'attempt-invalid-patch-proposal',
      baseSha,
      baseBranch: 'main',
      protectedBranches: [],
      deliveryPolicy: DELIVERY_POLICY,
      onProtectedPathApprovalRequired: async () => undefined,
      credential: credential(),
    });
    await writer.prepareBranch();
    const proposals = [
      {
        schemaVersion: '1' as const,
        changes: [{ path: 'README.md', baseDigest: `sha256:${'a'.repeat(64)}`, content: 'stale\n' }],
      },
      {
        schemaVersion: '1' as const,
        changes: [{ path: '../escape.txt', baseDigest: null, content: 'escape\n' }],
      },
      {
        schemaVersion: '1' as const,
        changes: [{ path: 'delivery.yaml', baseDigest: null, content: 'protected\n' }],
      },
      {
        schemaVersion: '1' as const,
        changes: [
          { path: 'same.txt', baseDigest: null, content: 'one\n' },
          { path: 'same.txt', baseDigest: null, content: 'two\n' },
        ],
      },
      {
        schemaVersion: '1' as const,
        changes: [{ path: 'missing/child.txt', baseDigest: null, content: 'missing\n' }],
      },
      {
        schemaVersion: '1' as const,
        changes: [{ path: 'dir-link/child.txt', baseDigest: null, content: 'followed\n' }],
      },
      {
        schemaVersion: '1' as const,
        changes: [{
          path: 'linked.txt',
          baseDigest: await patchContentDigest('base\n'),
          content: 'followed\n',
        }],
      },
    ];
    for (const proposal of proposals) {
      await expect(writer.applyPatchProposal(proposal))
        .rejects.toBeInstanceOf(RepositoryWritePolicyError);
      expect(await readFile(join(repo.repository, 'README.md'), 'utf8')).toBe('base\n');
      expect(await git(repo.repository, 'status', '--porcelain=v1', '--untracked-files=all'))
        .toBe('');
    }
  });

  it('rejects main, base, protected, force, and ref-injection pushes before invoking Git', async () => {
    const executor: GitCommandExecutor = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const writer = new GitRepositoryWriter({
      repositoryPath: '/trusted/repository',
      repository: 'example/delivery-target',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      baseSha: 'a'.repeat(40),
      baseBranch: 'develop',
      protectedBranches: ['release', 'production'],
      deliveryPolicy: DELIVERY_POLICY,
      onProtectedPathApprovalRequired: async () => undefined,
      credential: credential(),
    }, executor);
    const rejected = [
      { targetBranch: 'main', force: false },
      { targetBranch: 'master', force: false },
      { targetBranch: 'develop', force: false },
      { targetBranch: 'release', force: false },
      { targetBranch: repositoryAttemptBranch(TASK_ID, ATTEMPT_ID), force: true },
      { targetBranch: 'agent/task/attempt:refs/heads/main', force: false },
    ];
    for (const input of rejected) {
      await expect(writer.push(input)).rejects.toBeInstanceOf(RepositoryWritePolicyError);
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it('rejects caller-controlled branch identities and does not expose commit author inputs', () => {
    expect(repositoryAttemptBranch(TASK_ID, ATTEMPT_ID)).toBe(
      `agent/${TASK_ID}/${ATTEMPT_ID}`,
    );
    const invalidIdentities: ReadonlyArray<readonly [string, string]> = [
      ['../main', ATTEMPT_ID],
      [TASK_ID, 'attempt/../../main'],
      ['task with spaces', ATTEMPT_ID],
      ['main', '--force'],
    ];
    for (const [taskId, attemptId] of invalidIdentities) {
      expect(() => repositoryAttemptBranch(taskId, attemptId)).toThrow(
        'repository write identity is invalid',
      );
    }
    expect(GitRepositoryWriter.prototype.commitAll).toHaveLength(0);
    expect(() => new GitRepositoryWriter({
      repositoryPath: '/trusted/repository',
      repository: 'example/delivery-target',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      baseSha: 'a'.repeat(40),
      baseBranch: 'main',
      protectedBranches: [],
      deliveryPolicy: DELIVERY_POLICY,
      onProtectedPathApprovalRequired: async () => undefined,
      credential: { ...credential(), expiresAt: '2000-01-01T00:00:00.000Z' },
    })).toThrow('repository write policy denied');
  });

  it('rejects Agent-created commits before the trusted bot commit or push', async () => {
    const repo = await fixture();
    const writer = new GitRepositoryWriter({
      repositoryPath: repo.repository,
      repository: 'example/delivery-target',
      taskId: TASK_ID,
      attemptId: 'attempt-agent-commit',
      baseSha: repo.baseSha,
      baseBranch: 'main',
      protectedBranches: [],
      deliveryPolicy: DELIVERY_POLICY,
      onProtectedPathApprovalRequired: async () => undefined,
      credential: credential(),
    });
    await writer.prepareBranch();
    await writeFile(join(repo.repository, 'README.md'), 'Agent-owned commit\n');
    await git(repo.repository, 'add', 'README.md');
    await git(repo.repository, 'commit', '-m', 'untrusted Agent commit');
    await writeFile(join(repo.repository, 'after-commit.txt'), 'additional Agent edit\n');

    await expect(writer.commitAll()).rejects.toBeInstanceOf(RepositoryWritePolicyError);
    expect(await git(repo.remote, 'show-ref', '--hash', 'refs/heads/main')).toBe(repo.baseSha);
  });
});
