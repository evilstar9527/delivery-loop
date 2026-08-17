import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ExecutorRepositoryCheckoutError,
  checkoutExecutorRepository,
  type ExecutorGitCommandInput,
} from '../src/runner/executor-repository-checkout.js';

const CHECKOUT_SHA = 'a'.repeat(40);

describe('executor repository checkout', () => {
  it('fetches the exact frozen SHA while keeping the short grant out of argv and remote URL', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'executor-checkout-'));
    const calls: ExecutorGitCommandInput[] = [];
    const runGit = vi.fn(async (input: ExecutorGitCommandInput) => {
      calls.push(input);
      const command = input.args.join(' ');
      if (command === `rev-parse --verify HEAD`) {
        return { exitCode: 0, stdout: `${CHECKOUT_SHA}\n` };
      }
      if (command === 'status --porcelain=v1 --untracked-files=all') {
        return { exitCode: 0, stdout: '' };
      }
      if (command === 'remote get-url origin') {
        return {
          exitCode: 0,
          stdout: 'https://control.delivery-loop.internal/v1/attempts/attempt-1/repository.git\n',
        };
      }
      return { exitCode: 0, stdout: '' };
    });
    await checkoutExecutorRepository({
      controlPlaneUrl: 'https://control.delivery-loop.internal',
      attemptId: 'attempt-1',
      executionId: 'execution-1',
      attemptToken: 'short-executor-grant',
      checkoutSha: CHECKOUT_SHA,
      repositoryPath,
      runGit,
    });
    const fetch = calls.find((call) => call.args[0] === 'fetch');
    expect(fetch).toMatchObject({
      args: [
        'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1',
        'origin', CHECKOUT_SHA,
      ],
      authorizationHeader: 'Authorization: Bearer short-executor-grant',
    });
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(
      'short-executor-grant',
    );
    expect(calls.filter((call) => call.authorizationHeader !== undefined)).toHaveLength(1);
  });

  it('fails closed instead of erasing a non-empty or stale workspace', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'executor-checkout-stale-'));
    await writeFile(join(repositoryPath, 'untrusted.txt'), 'preserve\n');
    const runGit = vi.fn();
    await expect(checkoutExecutorRepository({
      controlPlaneUrl: 'https://control.delivery-loop.internal',
      attemptId: 'attempt-1',
      executionId: 'execution-1',
      attemptToken: 'short-executor-grant',
      checkoutSha: CHECKOUT_SHA,
      repositoryPath,
      runGit,
    })).rejects.toBeInstanceOf(ExecutorRepositoryCheckoutError);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('uses the isolated publisher repository endpoint with only a proxy placeholder', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'executor-publisher-checkout-'));
    const calls: ExecutorGitCommandInput[] = [];
    const repositoryUrl =
      'https://control.delivery-loop.internal/v1/attempts/attempt-1/' +
      'executor-publisher/repository.git';
    const runGit = vi.fn(async (input: ExecutorGitCommandInput) => {
      calls.push(input);
      if (input.args.join(' ') === 'rev-parse --verify HEAD') {
        return { exitCode: 0, stdout: `${CHECKOUT_SHA}\n` };
      }
      if (input.args.join(' ') === 'remote get-url origin') {
        return { exitCode: 0, stdout: `${repositoryUrl}\n` };
      }
      return { exitCode: 0, stdout: '' };
    });
    await checkoutExecutorRepository({
      controlPlaneUrl: 'https://control.delivery-loop.internal',
      attemptId: 'attempt-1',
      executionId: 'execution-publisher-1',
      attemptToken: 'executor-proxy-placeholder',
      role: 'publisher',
      checkoutSha: CHECKOUT_SHA,
      repositoryPath,
      runGit,
    });
    expect(calls.find((call) => call.args[0] === 'remote')).toMatchObject({
      args: ['remote', 'add', 'origin', repositoryUrl],
    });
    expect(calls.find((call) => call.args[0] === 'fetch')?.authorizationHeader)
      .toBe('Authorization: Bearer executor-proxy-placeholder');
  });
});
