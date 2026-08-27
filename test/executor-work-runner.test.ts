import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import { patchContentDigest } from '../src/domain/patch-proposal.js';
import {
  ExecutorWorkAttemptRunner,
  applyExecutorWorkPatch,
  captureExecutorWorkPatch,
} from '../src/runner/executor-work-runner.js';
import type { ExecutorWorkAttemptError } from '../src/runner/executor-work-runner.js';

const exec = promisify(execFile);

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

async function repository(): Promise<{ path: string; checkoutSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'executor-work-runner-'));
  const path = join(root, 'repository');
  await exec('git', ['init', path]);
  await exec('git', ['config', 'user.name', 'Fixture'], { cwd: path });
  await exec('git', ['config', 'user.email', 'fixture@example.test'], { cwd: path });
  await writeFile(join(path, 'delivery.yaml'), 'policy fixture\n');
  await writeFile(join(path, 'value.txt'), 'broken\n');
  await exec('git', ['add', '.'], { cwd: path });
  await exec('git', ['commit', '-m', 'base'], { cwd: path });
  const checkoutSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: path })).stdout.trim();
  await exec('git', ['checkout', '--detach', checkoutSha], { cwd: path });
  return { path, checkoutSha };
}

function agentInput(repositoryPath: string) {
  return {
    attemptId: 'attempt-executor-work',
    workspacePath: repositoryPath,
    contextFilePath: join(dirname(repositoryPath), 'context.json'),
    outputFilePath: join(dirname(repositoryPath), 'output.json'),
    timeoutMs: 60_000,
    allowPlanRevision: false,
  };
}

describe('executor credential-free work runner', () => {
  it('applies a digest-bound edit and reconstructs the strict content proposal', async () => {
    const fixture = await repository();
    await applyExecutorWorkPatch({
      repositoryPath: fixture.path,
      protectedPaths: policy.policy.protectedPaths,
      runtimeSecrets: [],
      proposal: {
        schemaVersion: '2',
        changes: [{
          path: 'value.txt',
          baseDigest: await patchContentDigest('broken\n'),
          edits: [{ oldText: 'broken', newText: 'fixed' }],
        }],
      },
    });
    await expect(captureExecutorWorkPatch({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      protectedPaths: policy.policy.protectedPaths,
      runtimeSecrets: [],
    })).resolves.toEqual({
      schemaVersion: '1',
      changes: [{
        path: 'value.txt',
        baseDigest: await patchContentDigest('broken\n'),
        content: 'fixed\n',
      }],
    });
  });

  it('refuses upload when a verification command mutates the proposed tree', async () => {
    const fixture = await repository();
    const mutatingPolicy = await parseDeliveryPolicy(`
schemaVersion: '1'
commands:
  setup:
    install: { argv: [node, -e, "process.exit(0)"], timeoutSeconds: 60 }
  targeted:
    unit: { argv: [node, -e, "require('node:fs').writeFileSync('generated.txt','x');process.exit(0)"], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, "process.exit(0)"], timeoutSeconds: 60 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`);
    const uploadPatch = vi.fn();
    const runner = new ExecutorWorkAttemptRunner({
      repositoryPath: fixture.path,
      checkoutSha: fixture.checkoutSha,
      targetedCommandRefs: ['test:unit'],
      requiredVerifyCommandRefs: ['verify:all'],
      deliveryPolicy: mutatingPolicy,
      runtimeSecrets: [],
      agent: {
        apply: async () => {
          await writeFile(join(fixture.path, 'value.txt'), 'fixed\n');
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      agentInput: agentInput(fixture.path),
      failureReporter: { report: async () => undefined },
      uploadPatch,
    });
    await expect(runner.run()).rejects.toMatchObject({
      name: 'ExecutorWorkAttemptError',
      kind: 'patch_failed',
    } satisfies Partial<ExecutorWorkAttemptError>);
    expect(uploadPatch).not.toHaveBeenCalled();
  });
});
