import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { CommandExecutionRequest } from '../src/agent/command-runtime.js';
import { parseDeliveryPolicy } from '../src/domain/delivery-policy.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import { runTestRollback } from '../src/runner/test-rollback-runner.js';

const exec = promisify(execFile);
const POLICY = `schemaVersion: '1'
commands:
  setup:
    install: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  targeted:
    unit: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  acceptance:
    smoke: { argv: [pnpm, run, acceptance:test], timeoutSeconds: 300 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment:
  mode: github_actions
  test:
    workflowPath: .github/workflows/delivery-test-deploy.yml
    environment: test
    oidcAudience: delivery-loop-test-deploy
    roleRef: test:delivery-loop-deployer
    command: { argv: [pnpm, run, deploy:test], timeoutSeconds: 900 }
    verifyCommandRef: verify:all
    acceptanceCommandRef: acceptance:smoke
    rollback:
      workflowPath: .github/workflows/delivery-test-rollback.yml
      environment: test
      oidcAudience: delivery-loop-test-rollback
      roleRef: test:delivery-loop-rollback
      automaticOn: [deployment_failure, acceptance_failure]
      command: { argv: [pnpm, run, rollback:test], timeoutSeconds: 600 }
`;

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: repository, encoding: 'utf8' })).stdout.trim();
}

async function fixture(): Promise<{
  repository: string;
  sha: string;
  policyDigest: string;
  contractDigest: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), 'delivery-test-rollback-runner-'));
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Delivery Loop Test');
  await git(repository, 'config', 'user.email', 'delivery-loop@example.test');
  await writeFile(join(repository, 'delivery.yaml'), POLICY);
  await git(repository, 'add', 'delivery.yaml');
  await git(repository, 'commit', '-m', 'test rollback policy');
  const parsed = await parseDeliveryPolicy(POLICY);
  if (parsed.policy.deployment.mode !== 'github_actions') throw new Error('invalid fixture');
  const rollback = parsed.policy.deployment.test?.rollback;
  if (rollback === undefined) throw new Error('invalid fixture');
  return {
    repository,
    sha: await git(repository, 'rev-parse', 'HEAD'),
    policyDigest: parsed.digest,
    contractDigest: await canonicalSha256(rollback),
  };
}

function environment(repository: string, sha: string): NodeJS.ProcessEnv {
  return {
    DELIVERY_ROLLBACK_ID: 'rollback-test-runner',
    DELIVERY_ROLLBACK_SOURCE_KIND: 'deployment_failure',
    DELIVERY_ROLLBACK_SHA: sha,
    DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_WORKSPACE: repository,
    GITHUB_TOKEN: 'CANARY_GITHUB_TOKEN',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=rollback',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
  };
}

describe('test rollback runner', () => {
  it('uses exact policy argv, dedicated audience/role, and an isolated command environment', async () => {
    const source = await fixture();
    const reports: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://oidc.actions.test') {
        expect(url.searchParams.get('audience')).toBe('delivery-loop-test-rollback');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
        );
        return Response.json({ value: 'CANARY_SIGNED_TEST_ROLLBACK_OIDC' });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer CANARY_SIGNED_TEST_ROLLBACK_OIDC',
      );
      if (url.pathname.endsWith('/oidc-attestation')) {
        expect(init?.body).toBeUndefined();
        return Response.json({
          accepted: true,
          attestationId: 'attestation-test-rollback-runner',
          disposition: 'created',
          rollbackId: 'rollback-test-runner',
          sourceKind: 'deployment_failure',
          refSha: source.sha,
          roleRef: 'test:delivery-loop-rollback',
          policyDigest: source.policyDigest,
          contractDigest: source.contractDigest,
        });
      }
      expect(url.pathname).toBe('/v1/test-rollbacks/rollback-test-runner/result');
      reports.push(JSON.parse(String(init?.body)) as unknown);
      return Response.json({
        accepted: true,
        rollbackId: 'rollback-test-runner',
        status: 'passed',
        disposition: 'created',
      });
    };
    const execute = vi.fn(async (request: CommandExecutionRequest) => {
      expect(request).toMatchObject({
        command: 'pnpm',
        args: ['run', 'rollback:test'],
        cwd: source.repository,
        stdin: '',
        timeoutMs: 600_000,
      });
      expect(request.environment?.DELIVERY_ROLLBACK_ENVIRONMENT).toBe('test');
      expect(request.environment?.DELIVERY_ROLLBACK_TRIGGER).toBe('deployment_failure');
      expect(request.environment?.GITHUB_TOKEN).toBeUndefined();
      expect(request.environment?.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(request.environment?.DELIVERY_ROLLBACK_ID).toBeUndefined();
      expect(request.environment?.DELIVERY_CONTROL_PLANE_URL).toBeUndefined();
      return { exitCode: 0 };
    });
    const times = [1_000, 1_456];
    await expect(runTestRollback({
      environment: environment(source.repository, source.sha),
      fetch: fetcher,
      execute,
      monotonicNow: () => times.shift() ?? 1_456,
    })).resolves.toEqual({
      rollbackId: 'rollback-test-runner',
      status: 'passed',
      exitCode: 0,
      durationMs: 456,
    });
    expect(reports).toEqual([{ exitCode: 0, durationMs: 456 }]);
  });

  it('rejects a trigger absent from the exact-SHA contract before OIDC or command execution', async () => {
    const source = await fixture();
    const env = environment(source.repository, source.sha);
    env.DELIVERY_ROLLBACK_SOURCE_KIND = 'acceptance_failure';
    await writeFile(join(source.repository, 'delivery.yaml'), POLICY.replace(
      '[deployment_failure, acceptance_failure]',
      '[deployment_failure]',
    ));
    await git(source.repository, 'add', 'delivery.yaml');
    await git(source.repository, 'commit', '-m', 'narrow rollback trigger');
    const sha = await git(source.repository, 'rev-parse', 'HEAD');
    env.DELIVERY_ROLLBACK_SHA = sha;
    const fetcher = vi.fn<typeof fetch>();
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    await expect(runTestRollback({ environment: env, fetch: fetcher, execute }))
      .rejects.toThrow('test rollback policy binding is invalid');
    expect(fetcher).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

