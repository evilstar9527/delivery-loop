import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareExecutorBackendError,
  createCloudflareSandboxExecutorHandler,
  type CloudflareSandboxExecutorBackend,
} from '../src/executor/cloudflare-worker/executor-api.js';
import type { CloudflareSandboxStartRequest } from '../src/executor/cloudflare-worker/protocol.js';
import { proxyControlPlaneRequest } from
  '../src/executor/cloudflare-worker/control-plane-proxy.js';

const CONTROL_TOKEN = 'test-executor-control-token';
const IMAGE_REF = 'delivery-agent@sha256:immutable-image';

function startRequest(): CloudflareSandboxStartRequest {
  return {
    schemaVersion: '1',
    profileId: 'cloudflare-sandbox-v1',
    releaseDigest: `sha256:${'a'.repeat(64)}`,
    executionId: 'execution-worker-1',
    runId: 'run-worker-1',
    attemptId: 'attempt-worker-1',
    leaseGeneration: 2,
    role: 'work',
    mode: 'implement',
    imageRef: IMAGE_REF,
    taskDigest: `sha256:${'b'.repeat(64)}`,
    repository: 'business/repository',
    baseSha: 'c'.repeat(40),
    checkoutSha: 'd'.repeat(40),
    targetBaseBranch: 'main',
    controlPlaneUrl: 'https://control.example.test',
    planVersion: 3,
    planItemId: 'change',
    modelProfileId: 'codex-profile-1',
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://executor.example.test${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
}

function backend(): CloudflareSandboxExecutorBackend {
  return {
    ensure: vi.fn(async (input) => ({
      disposition: 'created' as const,
      sandboxId: `sandbox-${input.executionId}`,
      containerId: 'container-placement-1',
    })),
    observe: vi.fn(async () => ({
      status: 'running' as const,
      externalUpdatedAt: '2026-08-17T01:00:00.000Z',
      exitCode: null,
      imageDigest: `sha256:${'e'.repeat(64)}`,
    })),
    cancel: vi.fn(async () => 'cancelled' as const),
  };
}

describe('Cloudflare Sandbox executor Worker API', () => {
  it('keeps model grants separate from callback authority', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (outbound: Request) => {
      requests.push(outbound);
      return new Response(null, { status: 204 });
    });
    try {
      const context = {
        containerId: 'container-placement-1',
        params: {
          controlPlaneOrigin: 'https://control.example.test',
          executionId: 'execution-worker-1',
          attemptId: 'attempt-worker-1',
        },
      };
      const env = { EXECUTOR_CALLBACK_TOKEN: 'worker-callback-token-value' };
      const invoke = async (path: string, method: 'GET' | 'POST', token: string) =>
        await proxyControlPlaneRequest(new Request(`https://control.delivery-loop.internal${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'x-delivery-execution-id': 'forged-execution',
            'x-delivery-executor-container-id': 'forged-container',
          },
        }), env, context);

      await invoke(
        '/v1/attempts/attempt-worker-1/executor-exchange',
        'POST',
        'container-placeholder',
      );
      await invoke('/v1/attempts/attempt-worker-1/context', 'GET', 'short-attempt-token');
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-patches/patch-1',
        'GET',
        'container-placeholder',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-patches',
        'POST',
        'short-attempt-token',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/repository.git/info/refs?service=git-upload-pack',
        'GET',
        'short-attempt-token',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-publisher/write-token',
        'POST',
        'publisher-placeholder',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-publisher/repository.git/' +
          'info/refs?service=git-upload-pack',
        'GET',
        'publisher-placeholder',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-publisher/repository.git/' +
          'info/refs?service=git-receive-pack',
        'GET',
        'publisher-write-token',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-publisher/repository.git/git-receive-pack',
        'POST',
        'publisher-write-token',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-model/grants',
        'POST',
        'short-attempt-token',
      );
      await invoke(
        '/v1/attempts/attempt-worker-1/executor-model/v1/responses',
        'POST',
        'model-placeholder',
      );

      expect(requests.map((outbound) => ({
        authorization: outbound.headers.get('authorization'),
        executionId: outbound.headers.get('x-delivery-execution-id'),
        containerId: outbound.headers.get('x-delivery-executor-container-id'),
      }))).toEqual([
        'worker-callback-token-value',
        'short-attempt-token',
        'worker-callback-token-value',
        'short-attempt-token',
        'short-attempt-token',
        'worker-callback-token-value',
        'worker-callback-token-value',
        'publisher-write-token',
        'publisher-write-token',
        'short-attempt-token',
        'model-placeholder',
      ].map((token) => ({
        authorization: `Bearer ${token}`,
        executionId: 'execution-worker-1',
        containerId: 'container-placement-1',
      })));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('authenticates before parsing and starts one strictly bound execution', async () => {
    const effects = backend();
    const handler = createCloudflareSandboxExecutorHandler({
      controlToken: CONTROL_TOKEN,
      configuredImageRef: IMAGE_REF,
      backend: effects,
    });

    const unauthorized = await handler.fetch(new Request(
      'https://executor.example.test/v1/executions/ensure',
      { method: 'POST', body: '{not-json' },
    ));
    expect(unauthorized.status).toBe(401);
    expect(effects.ensure).not.toHaveBeenCalled();

    const response = await handler.fetch(request('/v1/executions/ensure', {
      method: 'POST',
      body: JSON.stringify(startRequest()),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: '1',
      disposition: 'created',
      sandboxId: 'sandbox-execution-worker-1',
      containerId: 'container-placement-1',
    });
    expect(effects.ensure).toHaveBeenCalledWith(startRequest());
  });

  it('rejects image drift, extra credential fields, and oversized bodies before effects', async () => {
    const effects = backend();
    const handler = createCloudflareSandboxExecutorHandler({
      controlToken: CONTROL_TOKEN,
      configuredImageRef: IMAGE_REF,
      backend: effects,
    });
    const imageDrift = await handler.fetch(request('/v1/executions/ensure', {
      method: 'POST',
      body: JSON.stringify({ ...startRequest(), imageRef: 'delivery-agent:latest' }),
    }));
    expect(imageDrift.status).toBe(409);
    await expect(imageDrift.json()).resolves.toEqual({
      error: { code: 'image_binding_conflict' },
    });

    const credentialInjection = await handler.fetch(request('/v1/executions/ensure', {
      method: 'POST',
      body: JSON.stringify({ ...startRequest(), apiToken: 'must-not-cross-boundary' }),
    }));
    expect(credentialInjection.status).toBe(400);
    expect(JSON.stringify(await credentialInjection.json())).not.toContain(
      'must-not-cross-boundary',
    );

    const oversized = await handler.fetch(request('/v1/executions/ensure', {
      method: 'POST',
      body: JSON.stringify({ padding: 'x'.repeat(70_000) }),
    }));
    expect(oversized.status).toBe(413);
    const publisherWithoutPatch = await handler.fetch(request('/v1/executions/ensure', {
      method: 'POST',
      body: JSON.stringify({ ...startRequest(), role: 'publisher' }),
    }));
    expect(publisherWithoutPatch.status).toBe(400);
    const workWithPatch = await handler.fetch(request('/v1/executions/ensure', {
      method: 'POST',
      body: JSON.stringify({ ...startRequest(), patchArtifactId: 'patch-1' }),
    }));
    expect(workWithPatch.status).toBe(400);
    expect(effects.ensure).not.toHaveBeenCalled();
  });

  it('observes and cancels by execution identity with strict cancellation reasons', async () => {
    const effects = backend();
    const handler = createCloudflareSandboxExecutorHandler({
      controlToken: CONTROL_TOKEN,
      configuredImageRef: IMAGE_REF,
      backend: effects,
    });

    const observed = await handler.fetch(request(
      '/v1/executions/execution-worker-1/observe',
    ));
    expect(observed.status).toBe(200);
    await expect(observed.json()).resolves.toMatchObject({
      schemaVersion: '1',
      status: 'running',
      exitCode: null,
    });
    expect(effects.observe).toHaveBeenCalledWith('execution-worker-1');

    const cancelled = await handler.fetch(request(
      '/v1/executions/execution-worker-1/cancel',
      { method: 'POST', body: JSON.stringify({ reason: 'lease_expired' }) },
    ));
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toEqual({
      schemaVersion: '1',
      disposition: 'cancelled',
    });
    expect(effects.cancel).toHaveBeenCalledWith(
      'execution-worker-1',
      'lease_expired',
    );

    const invalid = await handler.fetch(request(
      '/v1/executions/execution-worker-1/cancel',
      { method: 'POST', body: JSON.stringify({ reason: 'user_text' }) },
    ));
    expect(invalid.status).toBe(400);
    expect(effects.cancel).toHaveBeenCalledTimes(1);
  });

  it('maps known backend failures and never returns raw provider errors', async () => {
    const effects = backend();
    vi.mocked(effects.observe).mockRejectedValueOnce(
      new CloudflareExecutorBackendError('execution_not_found'),
    ).mockRejectedValueOnce(new Error('canary-provider-secret-response'));
    const handler = createCloudflareSandboxExecutorHandler({
      controlToken: CONTROL_TOKEN,
      configuredImageRef: IMAGE_REF,
      backend: effects,
    });

    const missing = await handler.fetch(request(
      '/v1/executions/execution-worker-1/observe',
    ));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: { code: 'execution_not_found' },
    });

    const unavailable = await handler.fetch(request(
      '/v1/executions/execution-worker-1/observe',
    ));
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).toBe(
      JSON.stringify({ error: { code: 'sandbox_unavailable' } }),
    );
  });
});
