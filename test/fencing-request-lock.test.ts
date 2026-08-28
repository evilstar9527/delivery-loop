import { describe, expect, it } from 'vitest';
import { FencingRequestLock } from '../src/runner/analysis-runner.js';

/** A promise plus its resolver, so a test can hold the lock open deliberately. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('FencingRequestLock', () => {
  it('never runs two operations concurrently, across both lanes', async () => {
    const lock = new FencingRequestLock();
    let active = 0;
    let maxActive = 0;
    const body = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    };
    await Promise.all([
      lock.run(body),
      lock.runPriority(body),
      lock.run(body),
      lock.runPriority(body),
      lock.run(body),
    ]);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });

  it('serves a due heartbeat ahead of a queued tool-call backlog (the freeze regression)', async () => {
    const lock = new FencingRequestLock();
    const order: string[] = [];
    // An operation is in flight, holding the lock.
    const inFlight = deferred();
    const holder = lock.run(async () => {
      order.push('in_flight_start');
      await inFlight.promise;
      order.push('in_flight_end');
    });
    await settle();

    // A backlog of bulk work queues up behind it (the mediation tool calls).
    const bulk = [1, 2, 3].map((n) =>
      lock.run(async () => { order.push(`bulk_${n}`); }),
    );
    await settle();

    // Then the heartbeat becomes due and enters the priority lane LAST.
    const heartbeat = lock.runPriority(async () => { order.push('heartbeat'); });
    await settle();

    // Release the in-flight holder: the heartbeat must go first, not the backlog.
    inFlight.resolve();
    await Promise.all([holder, heartbeat, ...bulk]);

    expect(order).toEqual([
      'in_flight_start',
      'in_flight_end',
      'heartbeat',
      'bulk_1',
      'bulk_2',
      'bulk_3',
    ]);
    // The heartbeat waited for at most the single in-flight operation.
    expect(order.indexOf('heartbeat')).toBeLessThan(order.indexOf('bulk_1'));
  });

  it('keeps bulk work FIFO among itself', async () => {
    const lock = new FencingRequestLock();
    const order: number[] = [];
    const inFlight = deferred();
    const holder = lock.run(async () => { await inFlight.promise; });
    await settle();
    const queued = [1, 2, 3, 4].map((n) => lock.run(async () => { order.push(n); }));
    await settle();
    inFlight.resolve();
    await Promise.all([holder, ...queued]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('releases the lock when an operation throws, and propagates the rejection', async () => {
    const lock = new FencingRequestLock();
    const boom = new Error('operation failed');
    await expect(lock.run(async () => { throw boom; })).rejects.toBe(boom);
    // The lock is free: the next operation proceeds.
    await expect(lock.run(async () => 'ok')).resolves.toBe('ok');
    // Same for the priority lane.
    await expect(lock.runPriority(async () => { throw boom; })).rejects.toBe(boom);
    await expect(lock.run(async () => 'still-ok')).resolves.toBe('still-ok');
  });

  it('has no lost wakeup: a fresh acquire works after the queue drains', async () => {
    const lock = new FencingRequestLock();
    const inFlight = deferred();
    const holder = lock.run(async () => { await inFlight.promise; });
    await settle();
    const queued = lock.run(async () => 'queued');
    await settle();
    inFlight.resolve();
    await Promise.all([holder, queued]);
    // Queue fully drained; a brand new operation must acquire immediately.
    await expect(lock.run(async () => 'fresh')).resolves.toBe('fresh');
    await expect(lock.runPriority(async () => 'fresh-priority')).resolves.toBe('fresh-priority');
  });

  it('returns the operation result to the correct caller', async () => {
    const lock = new FencingRequestLock();
    const results = await Promise.all([
      lock.run(async () => 'a'),
      lock.runPriority(async () => 'b'),
      lock.run(async () => 'c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });
});
