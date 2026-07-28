import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import {
  GitRepositoryWriter,
  ProtectedPathApprovalRequired,
  executeGitCommand,
  type GitCommandExecutor,
  type ProtectedPathChangeReportV1,
} from '../src/runner/git-repository-writer.js';

const executeFile = promisify(execFile);
const SECRET_CANARY = 'protected-path-secret-canary-value';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await executeFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

async function fixture(): Promise<{
  repository: string;
  remote: string;
  baseSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-protected-path-'));
  const repository = join(root, 'repo');
  const remote = join(root, 'remote.git');
  await mkdir(repository, { mode: 0o700 });
  await git(root, 'init', '--bare', remote);
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Fixture User');
  await git(repository, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repository, 'README.md'), 'base\n');
  await writeFile(join(repository, 'CODEOWNERS'), '* @delivery-reviewers\n');
  await writeFile(join(repository, 'wrangler.jsonc'), '{"name":"fixture"}\n');
  await git(repository, 'add', '--all');
  await git(repository, 'commit', '-m', 'base');
  await git(repository, 'branch', '-M', 'main');
  await git(repository, 'remote', 'add', 'origin', remote);
  await git(repository, 'push', 'origin', 'main');
  return { repository, remote, baseSha: await git(repository, 'rev-parse', 'HEAD') };
}

async function policy() {
  return await parseDeliveryPolicy(`
schemaVersion: '1'
commands:
  setup:
    install:
      argv: [pnpm, install]
      timeoutSeconds: 600
  targeted:
    unit:
      argv: [pnpm, test]
      timeoutSeconds: 300
  verify:
    all:
      argv: [pnpm, verify]
      timeoutSeconds: 1200
protectedPaths:
  - delivery.yaml
  - .github/workflows/**
  - CODEOWNERS
  - ops/release/**
deployment:
  mode: none
`);
}

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

describe('protected path change gate', () => {
  it('lists safe added, deleted, renamed, and policy-defined changes before commit or push', async () => {
    const repo = await fixture();
    const commands: Parameters<GitCommandExecutor>[0][] = [];
    const executor: GitCommandExecutor = async (request) => {
      commands.push(request);
      return await executeGitCommand(request);
    };
    const reports: ProtectedPathChangeReportV1[] = [];
    const writer = new GitRepositoryWriter({
      repositoryPath: repo.repository,
      repository: 'example/delivery-target',
      taskId: 'task-protected-path',
      attemptId: 'attempt-protected-path',
      baseSha: repo.baseSha,
      baseBranch: 'main',
      protectedBranches: ['release'],
      deliveryPolicy: await policy(),
      onProtectedPathApprovalRequired: async (report) => {
        reports.push(report);
      },
      credential: credential(),
    }, executor);
    await writer.prepareBranch();

    await mkdir(join(repo.repository, '.github', 'workflows'), { recursive: true });
    await mkdir(join(repo.repository, 'ops', 'release'), { recursive: true });
    await writeFile(
      join(repo.repository, '.github', 'workflows', 'deploy.yml'),
      'name: deploy\n',
    );
    await writeFile(join(repo.repository, '.env.production'), `API_KEY=${SECRET_CANARY}\n`);
    await writeFile(join(repo.repository, 'ops', 'release', 'production.yml'), 'deploy: true\n');
    await rename(join(repo.repository, 'CODEOWNERS'), join(repo.repository, 'OWNERS'));
    await unlink(join(repo.repository, 'wrangler.jsonc'));

    let caught: unknown;
    try {
      await writer.commitAll();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProtectedPathApprovalRequired);
    const report = (caught as ProtectedPathApprovalRequired).report;
    expect(reports).toEqual([report]);
    expect(report).toMatchObject({
      schemaVersion: '1',
      baseSha: repo.baseSha,
      totalChangedFiles: 5,
    });
    expect(report.policyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.diffDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.stagedTreeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(report.protectedChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '.env.production',
        changeType: 'added',
        additions: 1,
        deletions: 0,
      }),
      expect.objectContaining({
        path: '.github/workflows/deploy.yml',
        changeType: 'added',
      }),
      expect.objectContaining({
        path: 'OWNERS',
        previousPath: 'CODEOWNERS',
        changeType: 'renamed',
      }),
      expect.objectContaining({
        path: 'wrangler.jsonc',
        changeType: 'deleted',
      }),
      expect.objectContaining({
        path: 'ops/release/production.yml',
        changeType: 'added',
      }),
    ]));
    expect(JSON.stringify(report)).not.toContain(SECRET_CANARY);
    expect(await git(repo.repository, 'rev-parse', 'HEAD')).toBe(repo.baseSha);
    expect(await git(repo.remote, 'show-ref', '--hash', 'refs/heads/main')).toBe(repo.baseSha);
    expect(commands.some((command) => command.args.includes('commit'))).toBe(false);
    expect(commands.some((command) => command.args.includes('push'))).toBe(false);
  });

  it('commits ordinary paths without creating an approval request', async () => {
    const repo = await fixture();
    const onProtectedPathApprovalRequired = vi.fn(async () => undefined);
    const writer = new GitRepositoryWriter({
      repositoryPath: repo.repository,
      repository: 'example/delivery-target',
      taskId: 'task-ordinary-path',
      attemptId: 'attempt-ordinary-path',
      baseSha: repo.baseSha,
      baseBranch: 'main',
      protectedBranches: [],
      deliveryPolicy: await policy(),
      onProtectedPathApprovalRequired,
      credential: credential(),
    });
    await writer.prepareBranch();
    await writeFile(join(repo.repository, 'README.md'), 'base\nordinary change\n');
    await expect(writer.commitAll()).resolves.toMatchObject({
      branch: 'agent/task-ordinary-path/attempt-ordinary-path',
    });
    expect(onProtectedPathApprovalRequired).not.toHaveBeenCalled();
  });
});
