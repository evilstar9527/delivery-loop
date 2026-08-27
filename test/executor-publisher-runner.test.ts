import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import { sha256Bytes } from '../src/domain/digest.js';
import { patchContentDigest } from '../src/domain/patch-proposal.js';
import {
  ExecutorPublisherRunner,
  type ExecutorPublisherRunnerError,
} from '../src/runner/executor-publisher-runner.js';
import {
  GitRepositoryWriter,
  executeGitCommand,
  type GitCommandRequest,
} from '../src/runner/git-repository-writer.js';
import type { VerificationEvidenceReporter } from
  '../src/runner/verification-execution-runner.js';

const exec = promisify(execFile);
const TASK_ID = 'task-publisher';
const ATTEMPT_ID = 'attempt-publisher';
const TARGET_BRANCH = `agent/${TASK_ID}/${ATTEMPT_ID}`;

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

async function fixture(): Promise<{ repository: string; remote: string; checkoutSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'executor-publisher-'));
  const repository = join(root, 'repository');
  const remote = join(root, 'remote.git');
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['init', repository]);
  await exec('git', ['config', 'user.name', 'Fixture'], { cwd: repository });
  await exec('git', ['config', 'user.email', 'fixture@example.test'], { cwd: repository });
  await writeFile(join(repository, 'value.txt'), 'broken\n');
  await exec('git', ['add', '.'], { cwd: repository });
  await exec('git', ['commit', '-m', 'base'], { cwd: repository });
  await exec('git', ['branch', '-M', 'main'], { cwd: repository });
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: repository });
  await exec('git', ['push', 'origin', 'main'], { cwd: repository });
  const checkoutSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository }))
    .stdout.trim();
  await exec('git', ['checkout', '--detach', checkoutSha], { cwd: repository });
  return { repository, remote, checkoutSha };
}

function evidenceReporter(commands: string[]): VerificationEvidenceReporter {
  let count = 0;
  return {
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
      return { suiteId: 'suite-publisher', created: true, status: 'running', commands: all };
    },
    async record(_suiteId, result) {
      commands.push(result.commandRef);
      return {
        evidenceId: `evidence-publisher-${result.position}`,
        created: true,
        suiteStatus: result.exitCode !== 0
          ? 'failed' as const
          : result.position === count - 1 ? 'completed' as const : 'running' as const,
      };
    },
  };
}

async function input(repository: string, checkoutSha: string) {
  const proposal = {
    schemaVersion: '1' as const,
    changes: [{
      path: 'value.txt',
      baseDigest: await patchContentDigest('broken\n'),
      content: 'fixed\n',
    }],
  };
  return {
    repositoryPath: repository,
    repository: 'example/delivery-target',
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    publisherExecutionId: 'execution-publisher-1',
    publicationId: 'publication-publisher-1',
    checkoutSha,
    baseBranch: 'main',
    targetBranch: TARGET_BRANCH,
    targetBranchMode: 'new' as const,
    planVersion: 1,
    planItemId: 'change',
    targetedCommandRefs: ['test:unit'],
    requiredVerifyCommandRefs: ['verify:all'],
    deliveryPolicy: policy,
    proposal,
    patchDigest: await sha256Bytes(new TextEncoder().encode(JSON.stringify(proposal))),
    credential: {
      credentialId: 'publisher-authority-1',
      repository: 'example/delivery-target',
      approvalId: 'approval-publisher-1',
      token: 'publisher-opaque-authority',
      expiresAt: '2099-01-01T00:00:00.000Z',
      permissions: { contents: 'write' as const, pullRequests: 'write' as const },
    },
  };
}

describe('executor publisher Git runner', () => {
  it('checks out exact clean source, applies the frozen patch, non-force pushes, verifies, and completes', async () => {
    const repo = await fixture();
    const commands: GitCommandRequest[] = [];
    const heads: unknown[] = [];
    const completions: unknown[] = [];
    const verified: string[] = [];
    const value = await input(repo.repository, repo.checkoutSha);
    const runner = new ExecutorPublisherRunner(value, {
      checkout: async () => {
        expect((await exec('git', ['rev-parse', 'HEAD'], { cwd: repo.repository })).stdout.trim())
          .toBe(repo.checkoutSha);
        expect((await exec('git', ['status', '--porcelain'], { cwd: repo.repository })).stdout)
          .toBe('');
      },
      headReporter: { record: async (head) => { heads.push(head); } },
      evidenceReporter: evidenceReporter(verified),
      completionReporter: { complete: async (completion) => { completions.push(completion); } },
      createWriter: (writerInput) => new GitRepositoryWriter({
        repositoryPath: writerInput.repositoryPath,
        repository: writerInput.repository,
        taskId: writerInput.taskId,
        attemptId: writerInput.attemptId,
        baseSha: writerInput.checkoutSha,
        baseBranch: writerInput.baseBranch,
        targetBranch: writerInput.targetBranch,
        targetBranchMode: writerInput.targetBranchMode,
        protectedBranches: [],
        deliveryPolicy: writerInput.deliveryPolicy,
        onProtectedPathApprovalRequired: async () => undefined,
        credential: writerInput.credential,
      }, async (request) => {
        commands.push(request);
        return await executeGitCommand(request);
      }),
    });

    const result = await runner.run();
    expect(result).toMatchObject({ status: 'passed', branch: TARGET_BRANCH });
    expect(result.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(verified).toEqual(['test:unit', 'verify:all']);
    expect(heads).toEqual([{
      parentSha: repo.checkoutSha,
      headSha: result.headSha,
      branch: TARGET_BRANCH,
    }]);
    expect(completions).toEqual([expect.objectContaining({
      publicationId: value.publicationId,
      publisherExecutionId: value.publisherExecutionId,
      recomputedPatchDigest: value.patchDigest,
      headSha: result.headSha,
      branch: TARGET_BRANCH,
      suiteId: 'suite-publisher',
    })]);
    expect((await exec('git', ['rev-parse', `refs/heads/${TARGET_BRANCH}`], {
      cwd: repo.remote,
    })).stdout.trim()).toBe(result.headSha);
    const push = commands.find((command) => command.args.includes('push'));
    expect(push?.args).not.toContain('--force');
    expect(push?.args).not.toContain('--force-with-lease');
  });

  it('rejects a patch digest mismatch before branch, commit, push, Evidence, or completion', async () => {
    const repo = await fixture();
    const heads: unknown[] = [];
    const completions: unknown[] = [];
    const verified: string[] = [];
    const value = { ...(await input(repo.repository, repo.checkoutSha)), patchDigest: `sha256:${'f'.repeat(64)}` };
    const runner = new ExecutorPublisherRunner(value, {
      checkout: async () => undefined,
      headReporter: { record: async (head) => { heads.push(head); } },
      evidenceReporter: evidenceReporter(verified),
      completionReporter: { complete: async (completion) => { completions.push(completion); } },
    });
    await expect(runner.run()).rejects.toMatchObject({
      name: 'ExecutorPublisherRunnerError',
      code: 'invalid_context',
    } satisfies Partial<ExecutorPublisherRunnerError>);
    expect(heads).toEqual([]);
    expect(verified).toEqual([]);
    expect(completions).toEqual([]);
    await expect(exec('git', ['show-ref', '--verify', `refs/heads/${TARGET_BRANCH}`], {
      cwd: repo.remote,
    })).rejects.toBeDefined();
  });
});
