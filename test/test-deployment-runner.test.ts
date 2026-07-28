import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { CommandExecutionRequest } from '../src/agent/command-runtime.js';
import { runTestDeployment } from '../src/runner/test-deployment-runner.js';

const exec = promisify(execFile);

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: repository, encoding: 'utf8' })).stdout.trim();
}

async function fixture(): Promise<{ repository: string; sha: string }> {
  const repository = await mkdtemp(join(tmpdir(), 'delivery-test-deploy-runner-'));
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Delivery Loop Test');
  await git(repository, 'config', 'user.email', 'delivery-loop@example.test');
  await writeFile(join(repository, 'delivery.yaml'), `schemaVersion: '1'
commands:
  setup:
    install: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  targeted:
    unit: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  verify:
    all: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
  acceptance:
    smoke: { argv: [node, -e, process.exit(0)], timeoutSeconds: 60 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment:
  mode: github_actions
  test:
    workflowPath: .github/workflows/delivery-test-deploy.yml
    environment: test
    oidcAudience: delivery-loop-test-deploy
    roleRef: test:delivery-loop-deployer
    command:
      argv: [pnpm, run, deploy:test]
      timeoutSeconds: 900
    verifyCommandRef: verify:all
    acceptanceCommandRef: acceptance:smoke
`);
  await git(repository, 'add', 'delivery.yaml');
  await git(repository, 'commit', '-m', 'test deployment policy');
  return { repository, sha: await git(repository, 'rev-parse', 'HEAD') };
}

describe('test deployment runner', () => {
  it('attests the dedicated audience, hides control credentials from argv, and reports status', async () => {
    const source = await fixture();
    const statusBodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://oidc.actions.test') {
        expect(url.searchParams.get('audience')).toBe('delivery-loop-test-deploy');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
        );
        return Response.json({ value: 'CANARY_SIGNED_TEST_DEPLOY_OIDC' });
      }
      if (url.origin === 'https://control.delivery.test') {
        expect(url.pathname).toBe(
          '/v1/test-deployments/deployment-test-runner/oidc-attestation',
        );
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_SIGNED_TEST_DEPLOY_OIDC',
        );
        expect(init?.body).toBeUndefined();
        return Response.json({
          accepted: true,
          attestationId: 'attestation-test-runner',
          disposition: 'created',
          roleRef: 'test:delivery-loop-deployer',
        });
      }
      expect(url.toString()).toBe(
        'https://api.github.com/repos/example/repo/deployments/7001/statuses',
      );
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer CANARY_GITHUB_DEPLOYMENT_STATUS_TOKEN',
      );
      statusBodies.push(JSON.parse(String(init?.body)) as unknown);
      return Response.json({ id: statusBodies.length }, { status: 201 });
    };
    const execute = vi.fn(async (request: CommandExecutionRequest) => {
      expect(request).toMatchObject({
        command: 'pnpm',
        args: ['run', 'deploy:test'],
        cwd: source.repository,
        stdin: '',
        timeoutMs: 900_000,
      });
      expect(request.environment?.GITHUB_TOKEN).toBeUndefined();
      expect(request.environment?.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(request.environment?.DELIVERY_DEPLOYMENT_ID).toBeUndefined();
      return { exitCode: 0 };
    });
    const result = await runTestDeployment({
      environment: {
        DELIVERY_DEPLOYMENT_ID: 'deployment-test-runner',
        DELIVERY_GITHUB_DEPLOYMENT_ID: '7001',
        DELIVERY_DEPLOYMENT_SHA: source.sha,
        DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
        DELIVERY_TEST_ENVIRONMENT_URL: 'https://test.example.test/app',
        GITHUB_REPOSITORY: 'example/repo',
        GITHUB_WORKSPACE: source.repository,
        GITHUB_TOKEN: 'CANARY_GITHUB_DEPLOYMENT_STATUS_TOKEN',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=deploy',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
        TEST_DEPLOYMENT_SECRET: 'CANARY_TEST_ONLY_CLOUD_SECRET',
      },
      fetch: fetcher,
      execute,
    });
    expect(result).toEqual({
      status: 'succeeded',
      deploymentId: 'deployment-test-runner',
      githubDeploymentId: '7001',
      exitCode: 0,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(statusBodies).toEqual([
      {
        state: 'in_progress',
        environment: 'test',
        auto_inactive: false,
        description: 'delivery-loop test deployment started',
      },
      {
        state: 'success',
        environment: 'test',
        auto_inactive: false,
        description: 'delivery-loop test deployment succeeded',
        environment_url: 'https://test.example.test/app',
      },
    ]);
  });
});
