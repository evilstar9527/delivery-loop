import { describe, expect, it } from 'vitest';
import { DashboardDeleteStore } from '../src/dashboard/dashboard-delete-store.js';

const NOW = new Date('2026-08-20T09:00:00.000Z');

/**
 * Minimal D1 stand-in. Only the shapes `DashboardDeleteStore` issues are
 * answered; every statement is recorded so the test can assert the order of
 * effects relative to the sandbox destruction.
 */
function fakeDb(options: {
  runState: string;
  sandboxIds: string[];
  log: string[];
}): D1Database {
  const prepare = (sql: string) => {
    const statement = {
      bind: (...args: unknown[]) => {
        void args;
        return statement;
      },
      first: async () => {
        if (sql.includes('FROM runs')) {
          options.log.push('read_run');
          return { run_id: 'run-1', state: options.runState, version: 3 };
        }
        return null;
      },
      all: async () => {
        options.log.push('read_sandboxes');
        return {
          results: options.sandboxIds.map((sandboxId, index) => ({
            run_id: 'run-1',
            provider_external_id: sandboxId,
            execution_id: `exec-${index}`,
            execution_role: 'work',
          })),
        };
      },
      run: async () => {
        if (sql.includes('dashboard_dismissals')) options.log.push('dismiss');
        return { success: true };
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return { prepare } as unknown as D1Database;
}

/** Executor transport over HTTP; the control token must be at least 16 chars. */
const EXECUTOR_ENV = {
  AGENT_EXECUTOR_URL: 'https://executor.test',
  AGENT_EXECUTOR_CONTROL_TOKEN: 'control-token-0123456789',
} as const;

/**
 * Stubs the global fetch the sandbox transport uses, recording each cancel into
 * the shared log so its ordering against the D1 writes can be asserted.
 */
function stubExecutorFetch(log: string[], mode: 'ok' | 'fail'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : input.url;
    if (mode === 'fail') throw new Error('executor unreachable');
    const match = /\/v1\/executions\/([^/]+)\/cancel/.exec(url);
    if (match === null) return new Response(null, { status: 404 });
    log.push(`cancel_sandbox:${decodeURIComponent(match[1]!)}`);
    // The transport validates this strictly; schemaVersion is required.
    return new Response(JSON.stringify({ schemaVersion: '1', disposition: 'cancelled' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

describe('dashboard delete store', () => {
  it('refuses to touch anything while a container is live and uncascaded', async () => {
    const log: string[] = [];
    const restore = stubExecutorFetch(log, 'ok');
    try {
      const store = new DashboardDeleteStore(
        fakeDb({ runState: 'executing', sandboxIds: ['executor-a'], log }),
        EXECUTOR_ENV as never,
        () => NOW,
      );

      const outcome = await store.deleteRun('run-1', false);

      expect(outcome.status).toBe('sandbox_active');
      expect(outcome.sandboxes.map((s) => s.sandboxId)).toEqual(['executor-a']);
      expect(outcome.terminatedSandboxes).toEqual([]);
      // No dismissal and no container kill on the refused path.
      expect(log).not.toContain('dismiss');
      expect(log.some((entry) => entry.startsWith('cancel_sandbox'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('destroys containers only after the run is hidden, never before', async () => {
    const log: string[] = [];
    const restore = stubExecutorFetch(log, 'ok');
    try {
      // A terminal run skips cancelRun, which keeps this test focused on the
      // dismissal-then-destroy ordering without needing the lifecycle batch.
      const store = new DashboardDeleteStore(
        fakeDb({ runState: 'succeeded', sandboxIds: ['executor-a', 'executor-b'], log }),
        EXECUTOR_ENV as never,
        () => NOW,
      );

      const outcome = await store.deleteRun('run-1', true);

      expect(outcome.status).toBe('deleted');
      expect(outcome.terminatedSandboxes).toEqual(['executor-a', 'executor-b']);
      // Ordering is the safety property: the control-plane record must be settled
      // before any container is destroyed, so a runner cannot write once more.
      expect(log.indexOf('dismiss')).toBeLessThan(log.indexOf('cancel_sandbox:executor-a'));
      expect(log).toEqual([
        'read_run',
        'read_sandboxes',
        'dismiss',
        'cancel_sandbox:executor-a',
        'cancel_sandbox:executor-b',
      ]);
    } finally {
      restore();
    }
  });

  it('still hides the run when a container refuses to die', async () => {
    const log: string[] = [];
    const restore = stubExecutorFetch(log, 'fail');
    try {
      const store = new DashboardDeleteStore(
        fakeDb({ runState: 'succeeded', sandboxIds: ['executor-wedged'], log }),
        EXECUTOR_ENV as never,
        () => NOW,
      );

      const outcome = await store.deleteRun('run-1', true);

      // The board keeps listing the container so it can still be reaped; the task
      // itself is removed as asked.
      expect(outcome.status).toBe('deleted');
      expect(outcome.terminatedSandboxes).toEqual([]);
      expect(log).toContain('dismiss');
    } finally {
      restore();
    }
  });

  it('reports a missing run without writing', async () => {
    const log: string[] = [];
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => { log.push('write'); return { success: true }; },
        }),
      }),
    } as unknown as D1Database;
    const store = new DashboardDeleteStore(db, EXECUTOR_ENV as never, () => NOW);

    const outcome = await store.deleteRun('run-missing', true);

    expect(outcome.status).toBe('not_found');
    expect(log).toEqual([]);
  });
});
