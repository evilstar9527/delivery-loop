import { describe, expect, it, vi } from 'vitest';
import { writeHeartbeatLifecycle } from '../src/observability/runner-log.js';

const ATTEMPT_ID = 'analysis-run_d251a4fa0eba206e769bfc7606be3079bba785751db51c95e077d0e1-1';

function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe('writeHeartbeatLifecycle', () => {
  it('emits nothing unless DELIVERY_HEARTBEAT_TRACE=1', () => {
    const lines = captureStderr(() => {
      writeHeartbeatLifecycle('launched', {}, { DELIVERY_ATTEMPT_ID: ATTEMPT_ID });
      writeHeartbeatLifecycle('iteration', { iteration: 1 }, {
        DELIVERY_ATTEMPT_ID: ATTEMPT_ID,
        DELIVERY_HEARTBEAT_TRACE: '0',
      });
    });
    expect(lines).toEqual([]);
  });

  it('emits one breadcrumb per phase when tracing is enabled', () => {
    const env = { DELIVERY_ATTEMPT_ID: ATTEMPT_ID, DELIVERY_HEARTBEAT_TRACE: '1' };
    const lines = captureStderr(() => {
      writeHeartbeatLifecycle('launched', {}, env);
      writeHeartbeatLifecycle('iteration', { iteration: 3 }, env);
      writeHeartbeatLifecycle('beat', { iteration: 3 }, env);
    });
    expect(lines).toHaveLength(3);
    const [launched, iteration, beat] = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(launched).toMatchObject({
      event: 'heartbeat_lifecycle',
      phase: 'launched',
      attemptId: ATTEMPT_ID,
    });
    expect(launched?.iteration).toBeUndefined();
    expect(iteration).toMatchObject({ phase: 'iteration', iteration: 3 });
    expect(beat).toMatchObject({ phase: 'beat', iteration: 3 });
  });

  it('omits an attemptId that is not a valid identifier', () => {
    const lines = captureStderr(() => {
      writeHeartbeatLifecycle('launched', {}, {
        DELIVERY_ATTEMPT_ID: 'not a valid id',
        DELIVERY_HEARTBEAT_TRACE: '1',
      });
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.attemptId).toBeUndefined();
  });
});
