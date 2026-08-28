import { describe, expect, it, vi } from 'vitest';
import { postRunnerStage, RUNNER_STARTUP_STAGES } from '../src/observability/runner-log.js';
import { RUNNER_STARTUP_STAGES as STORE_STAGES } from '../src/storage/runner-startup-stage-store.js';

describe('runner startup stage enum stays in sync across runner and store', () => {
  it('the runner-side and store-side stage lists are identical', () => {
    expect([...RUNNER_STARTUP_STAGES]).toEqual([...STORE_STAGES]);
  });
});

const BASE = {
  controlPlaneUrl: 'https://control.test',
  attemptId: 'analysis-run_probe-1',
  attemptToken: 'attempt-token',
  stage: 'reserving_model' as const,
};

describe('postRunnerStage (fire-and-forget diagnostic)', () => {
  it('POSTs the stage to the control-plane runner-stage endpoint with the attempt token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 202 });
    }) as unknown as typeof globalThis.fetch;

    postRunnerStage({ ...BASE, fetchImplementation });
    // Fire-and-forget: let the detached microtask run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://control.test/v1/attempts/analysis-run_probe-1/runner-stage');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer attempt-token');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ stage: 'reserving_model' });
    // A real request carries an abort signal so a wedged POST cannot linger.
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns synchronously without awaiting the POST (a hung fetch never blocks the caller)', () => {
    let resolved = false;
    // A fetch that never settles — models a wedged control plane.
    const fetchImplementation = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof globalThis.fetch;
    const before = Date.now();
    postRunnerStage({ ...BASE, fetchImplementation });
    resolved = true;
    // The call returned immediately (void), regardless of the pending fetch.
    expect(resolved).toBe(true);
    expect(Date.now() - before).toBeLessThan(50);
  });

  it('swallows a rejecting fetch without throwing into the caller', async () => {
    const fetchImplementation = vi.fn(
      async () => { throw new Error('control plane down'); },
    ) as unknown as typeof globalThis.fetch;
    // Must not throw synchronously and must not produce an unhandled rejection.
    expect(() => postRunnerStage({ ...BASE, fetchImplementation })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
