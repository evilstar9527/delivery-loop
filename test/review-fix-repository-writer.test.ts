import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import {
  GitRepositoryWriter,
  RepositoryWritePolicyError,
} from '../src/runner/git-repository-writer.js';

const executeFile = promisify(execFile);
const TASK_ID = 'task-review-fix';
const ATTEMPT_ID = 'attempt-current-review';
const PRIOR_ATTEMPT_ID = 'attempt-pr-head';
const PR_BRANCH = `agent/${TASK_ID}/${PRIOR_ATTEMPT_ID}`;
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await executeFile('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

function credential() {
  return {
    credentialId: 'github-review-write',
    repository: 'example/delivery-target',
    approvalId: 'approval-review-write',
    token: 'test-review-write-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    permissions: { contents: 'write', pullRequests: 'write' } as const,
  };
}

async function fixture(): Promise<{
  root: string;
  repository: string;
  remote: string;
  baseSha: string;
  reviewedHeadSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-review-writer-'));
  const repository = join(root, 'repo');
  const remote = join(root, 'remote.git');
  await mkdir(repository, { mode: 0o700 });
  await git(root, 'init', '--bare', remote);
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Fixture User');
  await git(repository, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repository, 'README.md'), 'base\n');
  await git(repository, 'add', 'README.md');
  await git(repository, 'commit', '-m', 'base');
  await git(repository, 'branch', '-M', 'main');
  await git(repository, 'remote', 'add', 'origin', remote);
  await git(repository, 'push', 'origin', 'main');
  const baseSha = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'switch', '--create', PR_BRANCH, '--no-track', baseSha);
  await writeFile(join(repository, 'feature.txt'), 'reviewed implementation\n');
  await git(repository, 'add', 'feature.txt');
  await git(repository, 'commit', '-m', 'reviewed head');
  const reviewedHeadSha = await git(repository, 'rev-parse', 'HEAD');
  await git(repository, 'push', 'origin', PR_BRANCH);
  await git(repository, 'checkout', '--detach', reviewedHeadSha);
  return { root, repository, remote, baseSha, reviewedHeadSha };
}

async function advanceRemote(root: string, remote: string, marker: string): Promise<string> {
  const clone = join(root, `concurrent-${marker}`);
  await git(root, 'clone', remote, clone);
  await git(clone, 'config', 'user.name', 'Concurrent User');
  await git(clone, 'config', 'user.email', 'concurrent@example.test');
  await git(clone, 'switch', PR_BRANCH);
  await writeFile(join(clone, `${marker}.txt`), `${marker}\n`);
  await git(clone, 'add', `${marker}.txt`);
  await git(clone, 'commit', '-m', marker);
  await git(clone, 'push', 'origin', PR_BRANCH);
  return await git(clone, 'rev-parse', 'HEAD');
}

function writer(repo: Awaited<ReturnType<typeof fixture>>): GitRepositoryWriter {
  return new GitRepositoryWriter({
    repositoryPath: repo.repository,
    repository: 'example/delivery-target',
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    baseSha: repo.reviewedHeadSha,
    baseBranch: 'main',
    targetBranch: PR_BRANCH,
    targetBranchMode: 'existing_fast_forward',
    protectedBranches: [],
    deliveryPolicy: DELIVERY_POLICY,
    onProtectedPathApprovalRequired: async () => undefined,
    credential: credential(),
  });
}

describe('same-PR review fix repository writer', () => {
  it('commits and fast-forwards the reviewed PR branch without creating an Attempt branch', async () => {
    const repo = await fixture();
    const reviewWriter = writer(repo);
    await expect(reviewWriter.prepareBranch()).resolves.toEqual({
      branch: PR_BRANCH,
      baseSha: repo.reviewedHeadSha,
    });
    await writeFile(join(repo.repository, 'feature.txt'), 'reviewed implementation\nreview fix\n');
    const commit = await reviewWriter.commitAll();
    await expect(reviewWriter.push({ targetBranch: PR_BRANCH, force: false })).resolves.toEqual({
      branch: PR_BRANCH,
      commitSha: commit.commitSha,
    });
    expect(await git(repo.remote, 'show-ref', '--hash', `refs/heads/${PR_BRANCH}`))
      .toBe(commit.commitSha);
    expect(await git(repo.remote, 'show-ref', '--hash', 'refs/heads/main')).toBe(repo.baseSha);
    const refs = await git(repo.remote, 'show-ref');
    expect(refs).not.toContain(`agent/${TASK_ID}/${ATTEMPT_ID}`);
  });

  it('rejects a remote branch that advances before prepare or before the non-force push', async () => {
    const staleBeforePrepare = await fixture();
    await advanceRemote(staleBeforePrepare.root, staleBeforePrepare.remote, 'before-prepare');
    await expect(writer(staleBeforePrepare).prepareBranch())
      .rejects.toBeInstanceOf(RepositoryWritePolicyError);

    const staleBeforePush = await fixture();
    const reviewWriter = writer(staleBeforePush);
    await reviewWriter.prepareBranch();
    await writeFile(join(staleBeforePush.repository, 'feature.txt'), 'local review fix\n');
    const commit = await reviewWriter.commitAll();
    const concurrentHead = await advanceRemote(
      staleBeforePush.root,
      staleBeforePush.remote,
      'before-push',
    );
    await expect(reviewWriter.push({ targetBranch: PR_BRANCH, force: false }))
      .rejects.toBeInstanceOf(RepositoryWritePolicyError);
    expect(await git(staleBeforePush.remote, 'show-ref', '--hash', `refs/heads/${PR_BRANCH}`))
      .toBe(concurrentHead);
    expect(concurrentHead).not.toBe(commit.commitSha);
  });
});
