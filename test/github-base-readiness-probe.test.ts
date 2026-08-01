import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubBaseReadinessProbe,
  GitHubBaseReadinessProbeError,
  type GitHubBaseReadinessProbeOptions,
} from '../src/pilot/github-base-readiness-probe.js';

const ORIGIN = 'https://control.example.test';
const TOKEN = 'readiness-operations-token-secret';
const REPOSITORY = 'evilstar9527/delivery-loop';
const BASE_BRANCH = 'main';
const BASE_SHA = 'a'.repeat(40);
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

function options(overrides: Partial<GitHubBaseReadinessProbeOptions> = {}) {
  return {
    controlPlaneOrigin: ORIGIN,
    operationsToken: TOKEN,
    repository: REPOSITORY,
    baseBranch: BASE_BRANCH,
    fetch: vi.fn(async () => response({
      schemaVersion: '1',
      ready: true,
      repository: REPOSITORY,
      baseBranch: BASE_BRANCH,
      baseSha: BASE_SHA,
    })),
    ...overrides,
  } satisfies GitHubBaseReadinessProbeOptions;
}

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=UTF-8',
      ...headers,
    },
  });
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GitHubBaseReadinessProbeError && error.code === code;
}

describe('GitHub base readiness probe', () => {
  it('sends one exact bounded request and refuses a second attempt', async () => {
    const current = options();
    const probe = createGitHubBaseReadinessProbe(current);

    await expect(probe.run()).resolves.toEqual({
      requestAttempts: 1,
      status: 200,
      ready: true,
      repository: REPOSITORY,
      baseBranch: BASE_BRANCH,
      baseSha: BASE_SHA,
      cacheControl: 'no-store',
    });
    expect(current.fetch).toHaveBeenCalledOnce();
    expect(current.fetch).toHaveBeenCalledWith(
      `${ORIGIN}/v1/operations/github-base/readiness?` +
        'repository=evilstar9527%2Fdelivery-loop&baseBranch=main',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(probe.run()).rejects.toSatisfy(expectCode('request_already_attempted'));
    expect(current.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'configuration_unavailable',
    'credential_unavailable',
    'credential_signing_unavailable',
    'credential_auth_rejected',
    'credential_installation_not_found',
    'credential_policy_rejected',
    'credential_transport_unavailable',
    'credential_upstream_unavailable',
    'credential_response_invalid',
    'reference_unavailable',
    'reference_invalid',
  ] as const)('accepts the fixed zero-effect 503 reason: %s', async (reason) => {
    const probe = createGitHubBaseReadinessProbe(options({
      fetch: vi.fn(async () => response({
        schemaVersion: '1',
        ready: false,
        reason,
        code: 'unavailable',
        message: 'GitHub base readiness check failed',
        retryable: true,
        correlationId: CORRELATION_ID,
      }, 503)),
    }));

    await expect(probe.run()).resolves.toEqual({
      requestAttempts: 1,
      status: 503,
      ready: false,
      reason,
      cacheControl: 'no-store',
    });
  });

  it.each([
    ['request_timed_out', Object.assign(new Error(`timeout ${TOKEN}`), { name: 'TimeoutError' })],
    ['dns_failed', new TypeError(`dns ${TOKEN}`, { cause: { code: 'ENOTFOUND' } })],
    ['tcp_failed', new TypeError(`tcp ${TOKEN}`, { cause: { code: 'ECONNRESET' } })],
    ['tls_failed', new TypeError(`tls ${TOKEN}`, { cause: { code: 'CERT_HAS_EXPIRED' } })],
    ['request_failed', new TypeError(`unknown ${TOKEN}`, { cause: { code: 'UNKNOWN' } })],
  ] as const)('classifies transport failure as %s without raw error text', async (code, failure) => {
    const probe = createGitHubBaseReadinessProbe(options({
      fetch: vi.fn().mockRejectedValue(failure),
    }));

    let thrown: unknown;
    try { await probe.run(); } catch (error) { thrown = error; }
    expect(thrown).toSatisfy(expectCode(code));
    expect(String(thrown)).not.toContain(TOKEN);
    expect(String(thrown)).not.toContain('UNKNOWN');
  });

  it('contains a hostile transport error getter as a fixed generic failure', async () => {
    const hostile = Object.defineProperty({}, 'name', {
      get: () => { throw new Error(`getter ${TOKEN}`); },
    });
    const probe = createGitHubBaseReadinessProbe(options({
      fetch: vi.fn().mockRejectedValue(hostile),
    }));

    await expect(probe.run()).rejects.toSatisfy(expectCode('request_failed'));
  });

  it.each([
    { controlPlaneOrigin: 'http://control.example.test' },
    { controlPlaneOrigin: 'https://user@control.example.test' },
    { controlPlaneOrigin: 'https://control.example.test/path' },
    { controlPlaneOrigin: 'https://127.0.0.1' },
    { controlPlaneOrigin: 'https://[::1]' },
    { controlPlaneOrigin: 'https://localhost' },
    { controlPlaneOrigin: 'https://control.internal' },
    { operationsToken: 'short' },
    { repository: '../delivery-loop' },
    { repository: 'evilstar9527/delivery-loop/extra' },
    { baseBranch: '../main' },
    { baseBranch: 'refs//heads/main' },
  ])('rejects unsafe configuration before network: %j', async (override) => {
    const current = options(override);
    const probe = createGitHubBaseReadinessProbe(current);

    await expect(probe.run()).rejects.toSatisfy(expectCode('configuration_invalid'));
    expect(current.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['pagination', response({}, 200, { link: '<https://next.example>; rel="next"' })],
    ['declared oversize', response({}, 200, { 'content-length': String(1_048_577) })],
    ['actual oversize', response('x'.repeat(1_048_577))],
    ['wrong content type', response({}, 200, { 'content-type': 'text/plain' })],
    ['cacheable', response({}, 200, { 'cache-control': 'public' })],
    ['malformed JSON', response('{', 200)],
    ['credential-shaped response', response({ value: `Bearer ${TOKEN}${TOKEN}` })],
    ['wrong success binding', response({
      schemaVersion: '1', ready: true, repository: 'other/repo',
      baseBranch: BASE_BRANCH, baseSha: BASE_SHA,
    })],
    ['unknown 503 reason', response({
      schemaVersion: '1', ready: false, reason: 'raw_upstream_failure',
      code: 'unavailable', message: 'GitHub base readiness check failed',
      retryable: true, correlationId: CORRELATION_ID,
    }, 503)],
  ])('rejects an invalid bounded response: %s', async (_label, candidate) => {
    const probe = createGitHubBaseReadinessProbe(options({
      fetch: vi.fn(async () => candidate.clone()),
    }));

    await expect(probe.run()).rejects.toSatisfy(expectCode('response_invalid'));
  });

  it('rejects unexpected HTTP status without reading its untrusted body', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => { cancelled = true; },
      pull: () => undefined,
    });
    const probe = createGitHubBaseReadinessProbe(options({
      fetch: vi.fn(async () => new Response(body, { status: 401 })),
    }));

    await expect(probe.run()).rejects.toSatisfy(expectCode('http_rejected'));
    expect(cancelled).toBe(true);
  });

  it('defaults the CLI to exit 2 before reading configuration or using network', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_GITHUB_BASE_READINESS;
    delete environment.GITHUB_BASE_READINESS_CONTROL_PLANE_URL;
    delete environment.GITHUB_BASE_READINESS_OPERATIONS_TOKEN;
    delete environment.GITHUB_BASE_READINESS_REPOSITORY;
    delete environment.GITHUB_BASE_READINESS_BASE_BRANCH;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/probe-github-base-readiness.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('github-base-readiness: opt-in missing\n');
  });

  it('keeps explicit opt-in fail-closed when required configuration is absent', () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DELIVERY_LOOP_GITHUB_BASE_READINESS: '1',
    };
    delete environment.GITHUB_BASE_READINESS_CONTROL_PLANE_URL;
    delete environment.GITHUB_BASE_READINESS_OPERATIONS_TOKEN;
    delete environment.GITHUB_BASE_READINESS_REPOSITORY;
    delete environment.GITHUB_BASE_READINESS_BASE_BRANCH;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/probe-github-base-readiness.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'github-base-readiness: required configuration is incomplete\n',
    );
  });

  it('does not use network when only the operations token is missing', () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DELIVERY_LOOP_GITHUB_BASE_READINESS: '1',
      GITHUB_BASE_READINESS_CONTROL_PLANE_URL: ORIGIN,
      GITHUB_BASE_READINESS_REPOSITORY: REPOSITORY,
      GITHUB_BASE_READINESS_BASE_BRANCH: BASE_BRANCH,
    };
    delete environment.GITHUB_BASE_READINESS_OPERATIONS_TOKEN;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/probe-github-base-readiness.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'github-base-readiness: required configuration is incomplete\n',
    );
  });
});
