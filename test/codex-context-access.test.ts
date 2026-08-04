import { describe, expect, it } from 'vitest';
import { CodexContextAccessAccumulator } from '../src/agent/codex-context-access.js';

const CONTEXT_PATH = '/workspace/.delivery-loop-analysis-context-test/context.json';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function commandEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item-context-access',
      type: 'command_execution',
      command: `node read-marker ${CONTEXT_PATH}`,
      aggregated_output: `${DIGEST}\n`,
      exit_code: 0,
      status: 'completed',
      ...overrides,
    },
  });
}

describe('Codex context access projection', () => {
  it('accepts exactly one completed command bound to the file and marker', () => {
    const proof = new CodexContextAccessAccumulator(CONTEXT_PATH, DIGEST);
    proof.acceptLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'message', type: 'agent_message', text: 'CANARY_NOT_RETAINED' },
    }));
    proof.acceptLine(commandEvent());

    expect(proof.result()).toBe(true);
    expect(JSON.stringify(proof)).not.toContain('CANARY_NOT_RETAINED');
  });

  it('does not accept the wrong file, digest, status, or exit code', () => {
    for (const event of [
      commandEvent({ command: 'node read-marker /workspace/other.json' }),
      commandEvent({ aggregated_output: `sha256:${'b'.repeat(64)}` }),
      commandEvent({ status: 'failed' }),
      commandEvent({ exit_code: 1 }),
    ]) {
      const proof = new CodexContextAccessAccumulator(CONTEXT_PATH, DIGEST);
      proof.acceptLine(event);
      expect(proof.result()).toBe(false);
    }
  });

  it('fails closed on duplicate, malformed, or oversized command events', () => {
    const duplicate = new CodexContextAccessAccumulator(CONTEXT_PATH, DIGEST);
    duplicate.acceptLine(commandEvent());
    expect(() => duplicate.acceptLine(commandEvent())).toThrow(
      'Codex context access event is invalid',
    );

    for (const event of [
      commandEvent({ exit_code: '0' }),
      commandEvent({ unexpected: true }),
      '{',
      'x'.repeat(65_537),
    ]) {
      const proof = new CodexContextAccessAccumulator(CONTEXT_PATH, DIGEST);
      expect(() => proof.acceptLine(event)).toThrow('Codex context access event is invalid');
    }
  });
});
