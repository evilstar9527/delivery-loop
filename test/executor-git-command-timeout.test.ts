import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { makeExecutorGitCommand } from '../src/runner/executor-repository-checkout.js';

// Minimal ChildProcess stand-in: an EventEmitter with a stdout stream, a pid,
// and a kill() that records the signals it received. It deliberately does NOT
// emit 'close' on kill unless the test tells it to — modeling a wedged git
// helper that survives SIGTERM, which is the freeze this fix targets.
function fakeChild(pid: number | undefined) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    stdout: EventEmitter & { setEncoding: (enc: string) => void };
    kill: (signal: NodeJS.Signals) => boolean;
  };
  child.pid = pid;
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
  stdout.setEncoding = () => undefined;
  child.stdout = stdout;
  child.kill = () => true;
  return child;
}

describe('runExecutorGitCommand timeout escalation', () => {
  it('resolves normally when the child closes before the deadline', async () => {
    const child = fakeChild(1234);
    const spawnFn = vi.fn(() => child) as never;
    const run = makeExecutorGitCommand({ spawnFn, timeoutMs: 10_000, sigkillGraceMs: 5_000 });
    const promise = run({ repositoryPath: '/tmp', args: ['status'] });
    child.stdout.emit('data', 'ok\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ exitCode: 0, stdout: 'ok\n' });
  });

  it('escalates SIGTERM then SIGKILL and still settles when the child never closes', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(4321);
      const signals: NodeJS.Signals[] = [];
      // Group-kill goes through process.kill(-pid, signal); capture it.
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        expect(pid).toBe(-4321); // negative pid = whole process group
        signals.push(signal as NodeJS.Signals);
        return true;
      });
      const spawnFn = vi.fn(() => child) as never;
      const run = makeExecutorGitCommand({ spawnFn, timeoutMs: 1_000, sigkillGraceMs: 500 });
      const promise = run({ repositoryPath: '/tmp', args: ['fetch', 'origin'] });
      // Child never emits 'close' — a wedged helper. Advance past the deadline.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals).toEqual(['SIGTERM']);
      // Advance past the SIGKILL grace: escalate + guaranteed settle.
      await vi.advanceTimersByTimeAsync(500);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      await expect(promise).resolves.toEqual({ exitCode: 1, stdout: '' });
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects if the child errors before closing', async () => {
    const child = fakeChild(999);
    const spawnFn = vi.fn(() => child) as never;
    const run = makeExecutorGitCommand({ spawnFn, timeoutMs: 10_000 });
    const promise = run({ repositoryPath: '/tmp', args: ['status'] });
    const boom = new Error('spawn failed');
    child.emit('error', boom);
    await expect(promise).rejects.toBe(boom);
  });

  it('falls back to a bare child kill when there is no pid for a group signal', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(undefined);
      const killed: NodeJS.Signals[] = [];
      child.kill = (signal: NodeJS.Signals) => { killed.push(signal); return true; };
      const spawnFn = vi.fn(() => child) as never;
      const run = makeExecutorGitCommand({ spawnFn, timeoutMs: 1_000, sigkillGraceMs: 500 });
      const promise = run({ repositoryPath: '/tmp', args: ['fetch', 'origin'] });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(killed).toEqual(['SIGTERM', 'SIGKILL']);
      await expect(promise).resolves.toEqual({ exitCode: 1, stdout: '' });
    } finally {
      vi.useRealTimers();
    }
  });
});
