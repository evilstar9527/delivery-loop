import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { CommandExecutionRequest } from '../src/agent/command-runtime.js';
import { runProductionDeployment } from '../src/runner/production-deployment-runner.js';

const exec = promisify(execFile);

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: repository, encoding: 'utf8' })).stdout.trim();
}

async function fixture(): Promise<{ repository: string; sha: string }> {
  const repository = await mkdtemp(join(tmpdir(), 'delivery-production-deploy-runner-'));
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
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment:
  mode: github_actions
  production:
    workflowPath: .github/workflows/delivery-production-deploy.yml
    environment: production
    oidcAudience: delivery-loop-production-deploy
    roleRef: production:delivery-loop-deployer
    command:
      argv: [pnpm, run, deploy:production]
      timeoutSeconds: 900
    verifyCommandRef: verify:all
`);
  await git(repository, 'add', 'delivery.yaml');
  await git(repository, 'commit', '-m', 'production deployment policy');
  return { repository, sha: await git(repository, 'rev-parse', 'HEAD') };
}

describe('production deployment runner', () => {
  it('uses production-only OIDC, exact merge policy, and isolated control credentials', async () => {
    const source = await fixture();
    const statusBodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://oidc.actions.test') {
        expect(url.searchParams.get('audience')).toBe('delivery-loop-production-deploy');
        return Response.json({ value: 'CANARY_SIGNED_PRODUCTION_DEPLOY_OIDC' });
      }
      if (url.origin === 'https://control.delivery.test') {
        expect(url.pathname).toBe(
          '/v1/production-deployments/deployment-production-runner/oidc-attestation',
        );
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_SIGNED_PRODUCTION_DEPLOY_OIDC',
        );
        return Response.json({
          accepted: true,
          attestationId: 'attestation-production-runner',
          disposition: 'created',
          roleRef: 'production:delivery-loop-deployer',
        });
      }
      expect(url.toString()).toBe(
        'https://api.github.com/repos/example/repo/deployments/8801/statuses',
      );
      statusBodies.push(JSON.parse(String(init?.body)) as unknown);
      return Response.json({ id: statusBodies.length }, { status: 201 });
    };
    const execute = vi.fn(async (request: CommandExecutionRequest) => {
      expect(request).toMatchObject({
        command: 'pnpm',
        args: ['run', 'deploy:production'],
        cwd: source.repository,
        stdin: '',
        timeoutMs: 900_000,
      });
      expect(request.environment?.GITHUB_TOKEN).toBeUndefined();
      expect(request.environment?.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(request.environment?.DELIVERY_PRODUCTION_DEPLOYMENT_ID).toBeUndefined();
      expect(request.environment?.DELIVERY_GITHUB_DEPLOYMENT_ID).toBeUndefined();
      expect(request.environment?.DELIVERY_TEST_SECRET).toBeUndefined();
      return { exitCode: 0 };
    });
    await expect(runProductionDeployment({
      environment: {
        DELIVERY_PRODUCTION_DEPLOYMENT_ID: 'deployment-production-runner',
        DELIVERY_GITHUB_DEPLOYMENT_ID: '8801',
        DELIVERY_PRODUCTION_MERGE_SHA: source.sha,
        DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
        DELIVERY_PRODUCTION_ENVIRONMENT_URL: 'https://prod.example.test/app',
        GITHUB_REPOSITORY: 'example/repo',
        GITHUB_WORKSPACE: source.repository,
        GITHUB_TOKEN: 'CANARY_GITHUB_PRODUCTION_STATUS_TOKEN',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=deploy',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
        DELIVERY_TEST_SECRET: 'CANARY_TEST_ENVIRONMENT_SECRET',
      },
      fetch: fetcher,
      execute,
    })).resolves.toEqual({
      status: 'succeeded',
      deploymentId: 'deployment-production-runner',
      githubDeploymentId: '8801',
      exitCode: 0,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(statusBodies).toEqual([
      {
        state: 'in_progress',
        environment: 'production',
        auto_inactive: false,
        description: 'delivery-loop production deployment started',
      },
      {
        state: 'success',
        environment: 'production',
        auto_inactive: false,
        description: 'delivery-loop production deployment succeeded',
        environment_url: 'https://prod.example.test/app',
      },
    ]);
  });

  it('refuses a checkout that is not the approved merge SHA before any external call', async () => {
    const source = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    await expect(runProductionDeployment({
      environment: {
        DELIVERY_PRODUCTION_DEPLOYMENT_ID: 'deployment-production-runner',
        DELIVERY_GITHUB_DEPLOYMENT_ID: '8801',
        DELIVERY_PRODUCTION_MERGE_SHA: 'f'.repeat(40),
        DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
        GITHUB_REPOSITORY: 'example/repo',
        GITHUB_WORKSPACE: source.repository,
        GITHUB_TOKEN: 'CANARY_GITHUB_PRODUCTION_STATUS_TOKEN',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
      },
      fetch: fetcher,
    })).rejects.toThrow('production deployment merge binding changed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
