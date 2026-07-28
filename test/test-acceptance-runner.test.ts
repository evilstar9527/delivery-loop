import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { CommandExecutionRequest } from '../src/agent/command-runtime.js';
import { runTestAcceptance } from '../src/runner/test-acceptance-runner.js';

const exec = promisify(execFile);

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: repository, encoding: 'utf8' })).stdout.trim();
}

async function fixture(): Promise<{ repository: string; sha: string }> {
  const repository = await mkdtemp(join(tmpdir(), 'delivery-test-acceptance-runner-'));
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
    smoke: { argv: [pnpm, run, acceptance:test], timeoutSeconds: 300 }
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
  await git(repository, 'commit', '-m', 'test acceptance policy');
  return { repository, sha: await git(repository, 'rev-parse', 'HEAD') };
}

function environment(repository: string, sha: string): NodeJS.ProcessEnv {
  return {
    DELIVERY_ACCEPTANCE_ID: 'acceptance-test-runner',
    DELIVERY_ACCEPTANCE_SHA: sha,
    DELIVERY_CONTROL_PLANE_URL: 'https://control.delivery.test',
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_WORKSPACE: repository,
    GITHUB_TOKEN: 'CANARY_GITHUB_TOKEN',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.test/token?job=acceptance',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
  };
}

describe('test acceptance runner', () => {
  it('uses the dedicated audience, commit-bound argv, sanitized URL, and isolated command env', async () => {
    const source = await fixture();
    const reportBodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://oidc.actions.test') {
        expect(url.searchParams.get('audience')).toBe('delivery-loop-test-acceptance');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_ACTIONS_OIDC_REQUEST_TOKEN',
        );
        return Response.json({ value: 'CANARY_SIGNED_TEST_ACCEPTANCE_OIDC' });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer CANARY_SIGNED_TEST_ACCEPTANCE_OIDC',
      );
      if (url.pathname.endsWith('/oidc-attestation')) {
        expect(init?.body).toBeUndefined();
        return Response.json({
          accepted: true,
          attestationId: 'attestation-test-runner',
          disposition: 'created',
          acceptanceId: 'acceptance-test-runner',
          commandRef: 'acceptance:smoke',
          refSha: source.sha,
          environmentUrl: 'https://test.example.test/app',
        });
      }
      expect(url.pathname).toBe('/v1/test-acceptances/acceptance-test-runner/result');
      reportBodies.push(JSON.parse(String(init?.body)) as unknown);
      return Response.json({
        accepted: true,
        acceptanceId: 'acceptance-test-runner',
        status: 'passed',
        disposition: 'created',
      });
    };
    const execute = vi.fn(async (request: CommandExecutionRequest) => {
      expect(request).toMatchObject({
        command: 'pnpm',
        args: ['run', 'acceptance:test'],
        cwd: source.repository,
        stdin: '',
        timeoutMs: 300_000,
      });
      expect(request.environment?.DELIVERY_TEST_BASE_URL).toBe(
        'https://test.example.test/app',
      );
      expect(request.environment?.GITHUB_TOKEN).toBeUndefined();
      expect(request.environment?.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(request.environment?.DELIVERY_ACCEPTANCE_ID).toBeUndefined();
      expect(request.environment?.DELIVERY_CONTROL_PLANE_URL).toBeUndefined();
      return { exitCode: 0 };
    });
    const times = [1_000, 1_456];
    const result = await runTestAcceptance({
      environment: environment(source.repository, source.sha),
      fetch: fetcher,
      execute,
      monotonicNow: () => times.shift() ?? 1_456,
    });
    expect(result).toEqual({
      acceptanceId: 'acceptance-test-runner',
      status: 'passed',
      exitCode: 0,
      durationMs: 456,
    });
    expect(reportBodies).toEqual([{ exitCode: 0, durationMs: 456 }]);
  });

  it('reports a failed command before returning a failed Runner result', async () => {
    const source = await fixture();
    const reports: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://oidc.actions.test') {
        return Response.json({ value: 'CANARY_SIGNED_TEST_ACCEPTANCE_OIDC' });
      }
      if (url.pathname.endsWith('/oidc-attestation')) {
        return Response.json({
          accepted: true,
          attestationId: 'attestation-test-runner',
          disposition: 'created',
          acceptanceId: 'acceptance-test-runner',
          commandRef: 'acceptance:smoke',
          refSha: source.sha,
          environmentUrl: 'https://test.example.test/app',
        });
      }
      reports.push(JSON.parse(String(init?.body)) as unknown);
      return Response.json({
        accepted: true,
        acceptanceId: 'acceptance-test-runner',
        status: 'failed',
        disposition: 'created',
      });
    };
    const times = [2_000, 2_321];
    await expect(runTestAcceptance({
      environment: environment(source.repository, source.sha),
      fetch: fetcher,
      execute: async () => ({ exitCode: 1 }),
      monotonicNow: () => times.shift() ?? 2_321,
    })).resolves.toEqual({
      acceptanceId: 'acceptance-test-runner',
      status: 'failed',
      exitCode: 1,
      durationMs: 321,
    });
    expect(reports).toEqual([{ exitCode: 1, durationMs: 321 }]);
  });
});
