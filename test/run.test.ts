import { describe, expect, it } from 'vitest';
import {
  InvalidRunTransitionError,
  assertRunTransition,
  canTransition,
  isTerminalRunState,
} from '../src/domain/run.js';

describe('run state machine', () => {
  it('supports the normal delivery path', () => {
    expect(canTransition('received', 'triaging')).toBe(true);
    expect(canTransition('verifying', 'pull_request_open')).toBe(true);
    expect(canTransition('ready_to_merge', 'merging')).toBe(true);
    expect(canTransition('merging', 'deploying')).toBe(true);
    expect(canTransition('deploying', 'succeeded')).toBe(true);
  });

  it('supports a review feedback repair loop', () => {
    expect(canTransition('awaiting_review', 'executing')).toBe(true);
    expect(canTransition('verifying', 'executing')).toBe(true);
  });

  it('returns active pre-merge work to planning when its immutable Plan must be revised', () => {
    for (const state of [
      'awaiting_approval',
      'executing',
      'verifying',
      'pull_request_open',
      'awaiting_review',
      'ready_to_merge',
      'blocked',
    ] as const) {
      expect(canTransition(state, 'planning')).toBe(true);
    }
    expect(canTransition('merging', 'planning')).toBe(false);
    expect(canTransition('deploying', 'planning')).toBe(false);
  });

  it('supports explicit recovery from blocked and failed states', () => {
    expect(canTransition('awaiting_approval', 'executing')).toBe(true);
    expect(canTransition('blocked', 'queued')).toBe(true);
    expect(canTransition('blocked', 'executing')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
  });

  it('rejects skipping required gates', () => {
    expect(() => assertRunTransition('executing', 'succeeded')).toThrow(
      InvalidRunTransitionError,
    );
    expect(canTransition('awaiting_approval', 'deploying')).toBe(false);
    expect(canTransition('succeeded', 'queued')).toBe(false);
  });

  it('only treats irreversible final outcomes as terminal', () => {
    expect(isTerminalRunState('succeeded')).toBe(true);
    expect(isTerminalRunState('cancelled')).toBe(true);
    expect(isTerminalRunState('failed')).toBe(false);
    expect(isTerminalRunState('blocked')).toBe(false);
  });
});
