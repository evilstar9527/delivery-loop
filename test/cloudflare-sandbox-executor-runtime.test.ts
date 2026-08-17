import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/env.js';
import {
  CloudflareSandboxWorkerEffects,
  cloudflareSandboxEffectsFromEnv,
} from '../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-runtime.js';
import type { CloudflareSandboxStartRequest } from
  '../src/executor/cloudflare-worker/protocol.js';

const ORIGIN = 'https://agent-executor.example.test';
const TOKEN = 'executor-control-token-for-tests';
const CANARY = 'executor-runtime-canary-do-not-return';

const startRequest: CloudflareSandboxStartRequest = {
  schemaVersion: '1',
  profileId: 'sandbox-default',
  releaseDigest: `sha256:${'1'.repeat(64)}`,
  executionId: 'execution-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  leaseGeneration: 1,
  role: 'work',
  mode: 'analysis',
  imageRef: `registry.example.test/agent@sha256:${'2'.repeat(64)}`,
  taskDigest: `sha256:${'3'.repeat(64)}`,
  repository: 'example/repo',
  baseSha: 'a'.repeat(40),
  checkoutSha: 'b'.repeat(40),
  targetBaseBranch: 'main',
  controlPlaneUrl: 'https://control.example.test',
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

describe('Cloudflare Sandbox control-plane effects', () => {
  it('uses a service binding with bounded authenticated strict requests', async () => {
    const requests: Request[] = [];
    const binding = {
      async fetch(request: Request) {
        requests.push(request);
        return json({
          schemaVersion: '1',
          disposition: 'created',
          sandboxId: 'execution-1',
          containerId: 'container-1',
        });
      },
    } as unknown as Fetcher;
    const effects = new CloudflareSandboxWorkerEffects({
      binding,
      controlToken: TOKEN,
    });

    await expect(effects.ensureSandbox(ORIGIN, startRequest)).resolves.toEqual({
      disposition: 'created',
      sandboxId: 'execution-1',
      containerId: 'container-1',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${ORIGIN}/v1/executions/ensure`);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(await requests[0]?.json()).toEqual(startRequest);
  });

  it('uses only the configured HTTPS origin and implements observe/cancel', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      if (request.url.endsWith('/observe')) {
        return json({
          schemaVersion: '1',
          status: 'running',
          externalUpdatedAt: '2026-08-17T06:00:00.000Z',
          exitCode: null,
          imageDigest: `sha256:${'4'.repeat(64)}`,
        });
      }
      return json({ schemaVersion: '1', disposition: 'cancelled' });
    });
    const effects = new CloudflareSandboxWorkerEffects({
      workerOrigin: ORIGIN,
      controlToken: TOKEN,
      fetch: fetcher,
    });

    await expect(effects.observeSandbox(ORIGIN, 'execution-1')).resolves.toMatchObject({
      status: 'running',
      exitCode: null,
    });
    await expect(
      effects.cancelSandbox(ORIGIN, 'execution-1', 'lease_expired'),
    ).resolves.toBe('cancelled');
    await expect(
      effects.observeSandbox('https://other.example.test', 'execution-1'),
    ).rejects.toThrow('executor request origin is not configured');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed for mixed, partial, or absent runtime configuration', () => {
    const base = {} as Bindings;
    expect(cloudflareSandboxEffectsFromEnv(base)).toBeNull();
    expect(() => cloudflareSandboxEffectsFromEnv({
      ...base,
      AGENT_EXECUTOR_CONTROL_TOKEN: TOKEN,
    })).toThrow('Cloudflare Sandbox runtime configuration is incomplete');
    expect(() => cloudflareSandboxEffectsFromEnv({
      ...base,
      AGENT_EXECUTOR_URL: ORIGIN,
    })).toThrow('Cloudflare Sandbox runtime configuration is incomplete');
    expect(() => cloudflareSandboxEffectsFromEnv({
      ...base,
      AGENT_EXECUTOR: { fetch: vi.fn() } as unknown as Fetcher,
      AGENT_EXECUTOR_URL: ORIGIN,
      AGENT_EXECUTOR_CONTROL_TOKEN: TOKEN,
    })).toThrow('Cloudflare Sandbox runtime configuration mixes transports');
    expect(cloudflareSandboxEffectsFromEnv({
      ...base,
      AGENT_EXECUTOR: { fetch: vi.fn() } as unknown as Fetcher,
      AGENT_EXECUTOR_CONTROL_TOKEN: TOKEN,
    })).toBeInstanceOf(CloudflareSandboxWorkerEffects);
  });

  it('rejects redirects, oversized or non-strict responses without exposing bodies', async () => {
    const cases = [
      new Response(null, { status: 302, headers: { location: `https://${CANARY}.test` } }),
      new Response(JSON.stringify({ error: CANARY }).padEnd(1_048_577, 'x'), {
        headers: { 'content-type': 'application/json' },
      }),
      json({
        schemaVersion: '1',
        disposition: 'created',
        sandboxId: 'execution-1',
        containerId: 'container-1',
        rawProviderError: CANARY,
      }),
      new Response(CANARY, { headers: { 'content-type': 'text/plain' } }),
    ];
    for (const response of cases) {
      const effects = new CloudflareSandboxWorkerEffects({
        workerOrigin: ORIGIN,
        controlToken: TOKEN,
        fetch: vi.fn(async () => response),
      });
      const error = await effects.ensureSandbox(ORIGIN, startRequest).catch((cause) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(CANARY);
      expect(String(error)).toMatch(/executor (request|response)/);
    }
  });

  it('enforces the request deadline even when the transport never settles', async () => {
    const effects = new CloudflareSandboxWorkerEffects({
      workerOrigin: ORIGIN,
      controlToken: TOKEN,
      timeoutMs: 5,
      fetch: vi.fn(async () => await new Promise<Response>(() => undefined)),
    });
    await expect(effects.ensureSandbox(ORIGIN, startRequest)).rejects.toThrow(
      'executor request timed out',
    );
  });

  it('keeps executor identity verification unavailable until a grant is implemented', async () => {
    const effects = new CloudflareSandboxWorkerEffects({
      binding: { fetch: vi.fn() } as unknown as Fetcher,
      controlToken: TOKEN,
    });
    await expect(effects.verifySandboxIdentity({} as never, {} as never, CANARY))
      .rejects.toThrow('executor identity verification is unavailable');
  });

  it('verifies only the exact Worker-injected callback and container binding', async () => {
    const effects = new CloudflareSandboxWorkerEffects({
      binding: { fetch: vi.fn() } as unknown as Fetcher,
      controlToken: TOKEN,
      callbackToken: 'executor-callback-token-for-tests',
    });
    const profile = {
      schemaVersion: '1',
      profileId: 'sandbox-default',
      kind: 'cloudflare_sandbox',
      pluginSchemaVersion: '1',
      releaseDigest: `sha256:${'1'.repeat(64)}`,
      configuration: {},
    } as const;
    const handle = {
      schemaVersion: '1',
      kind: 'cloudflare_sandbox',
      pluginSchemaVersion: '1',
      profileId: 'sandbox-default',
      releaseDigest: `sha256:${'1'.repeat(64)}`,
      externalId: 'sandbox-1',
      executionId: 'execution-1',
      attemptId: 'attempt-1',
      leaseGeneration: 1,
      role: 'work',
      repository: 'example/repo',
      attributes: { containerId: 'container-1' },
    } as const;
    await expect(effects.verifySandboxIdentity(profile, handle, {
      authorization: 'Bearer executor-callback-token-for-tests',
      executionId: 'execution-1',
      containerId: 'container-1',
    })).resolves.toMatchObject({
      executionId: 'execution-1',
      providerSubject: 'cloudflare-sandbox:container-1',
    });
    await expect(effects.verifySandboxIdentity(profile, handle, {
      authorization: `Bearer ${CANARY}`,
      executionId: 'execution-1',
      containerId: 'container-1',
    })).rejects.toThrow('executor identity assertion is invalid');
  });
});
