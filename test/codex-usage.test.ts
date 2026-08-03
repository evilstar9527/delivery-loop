import { describe, expect, it } from 'vitest';
import { CodexUsageAccumulator } from '../src/agent/codex-usage.js';

describe('Codex JSONL usage accounting', () => {
  it('projects only the official turn.completed usage fields and keeps the latest cumulative fact', () => {
    const usage = new CodexUsageAccumulator();
    usage.acceptLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-secret' }));
    usage.acceptLine(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'CANARY_AGENT_OUTPUT' },
    }));
    usage.acceptLine(JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 24_763,
        cached_input_tokens: 24_448,
        cache_write_input_tokens: 315,
        output_tokens: 122,
        reasoning_output_tokens: 17,
      },
    }));

    expect(usage.result()).toEqual({
      inputTokens: 24_763,
      cachedInputTokens: 24_448,
      outputTokens: 122,
      reasoningOutputTokens: 17,
    });
    expect(JSON.stringify(usage.result())).not.toContain('CANARY_AGENT_OUTPUT');
    expect(JSON.stringify(usage.result())).not.toContain('thread-secret');
  });

  it('fails closed on malformed, negative, inconsistent, duplicate, or oversized usage', () => {
    const invalid = [
      '{',
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: -1 } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: -1,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 2,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 2,
        },
      }),
      'x'.repeat(65_537),
    ];
    for (const line of invalid) {
      const usage = new CodexUsageAccumulator();
      expect(() => usage.acceptLine(line)).toThrow('Codex usage event is invalid');
    }

    const duplicate = new CodexUsageAccumulator();
    const completed = JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    });
    duplicate.acceptLine(completed);
    expect(() => duplicate.acceptLine(completed)).toThrow('Codex usage event is invalid');
  });
});
