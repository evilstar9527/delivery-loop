export const RUN_STATES = [
  'received',
  'triaging',
  'awaiting_approval',
  'queued',
  'planning',
  'executing',
  'verifying',
  'pull_request_open',
  'awaiting_review',
  'ready_to_merge',
  'merging',
  'deploying',
  'succeeded',
  'blocked',
  'failed',
  'cancelled',
] as const;

export type RunState = (typeof RUN_STATES)[number];

const transitions: Readonly<Record<RunState, readonly RunState[]>> = {
  received: ['triaging', 'cancelled', 'failed'],
  triaging: ['awaiting_approval', 'queued', 'blocked', 'cancelled', 'failed'],
  awaiting_approval: ['queued', 'planning', 'executing', 'cancelled', 'blocked'],
  queued: ['planning', 'cancelled', 'failed'],
  planning: ['executing', 'awaiting_approval', 'blocked', 'cancelled', 'failed'],
  executing: ['planning', 'verifying', 'awaiting_approval', 'blocked', 'cancelled', 'failed'],
  verifying: ['planning', 'executing', 'pull_request_open', 'blocked', 'cancelled', 'failed'],
  pull_request_open: ['planning', 'awaiting_review', 'ready_to_merge', 'cancelled', 'failed'],
  awaiting_review: ['planning', 'executing', 'ready_to_merge', 'blocked', 'cancelled', 'failed'],
  ready_to_merge: ['planning', 'merging', 'cancelled', 'failed'],
  merging: ['deploying', 'succeeded', 'failed'],
  deploying: ['succeeded', 'blocked', 'failed'],
  blocked: ['triaging', 'queued', 'planning', 'executing', 'cancelled', 'failed'],
  succeeded: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

export class InvalidRunTransitionError extends Error {
  constructor(from: RunState, to: RunState) {
    super(`invalid run transition: ${from} -> ${to}`);
    this.name = 'InvalidRunTransitionError';
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return transitions[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new InvalidRunTransitionError(from, to);
  }
}

export function isTerminalRunState(state: RunState): boolean {
  return state === 'succeeded' || state === 'cancelled';
}

/** States in which the durable control Workflow must no longer remain active. */
export function expectsActiveWorkflow(state: RunState): boolean {
  return state !== 'blocked' && state !== 'failed' &&
    state !== 'succeeded' && state !== 'cancelled';
}
