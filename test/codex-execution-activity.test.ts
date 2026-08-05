import { describe, expect, it } from 'vitest';
import { CodexExecutionActivityAccumulator } from '../src/agent/codex-execution-activity.js';

describe('Codex execution activity projection', () => {
  it('counts only fixed JSONL event and item types', () => {
    const accumulator = new CodexExecutionActivityAccumulator();
    const events = [
      { type: 'thread.started', thread_id: 'CANARY_THREAD' },
      { type: 'item.started', item: { type: 'command_execution', command: 'CANARY_COMMAND' } },
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'CANARY_OUTPUT' } },
      { type: 'item.started', item: { type: 'file_change', changes: ['CANARY_PATH'] } },
      { type: 'item.completed', item: { type: 'file_change', changes: ['CANARY_PATH'] } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'CANARY_MESSAGE' } },
      { type: 'turn.completed', usage: { input_tokens: 10 } },
    ];
    for (const event of events) accumulator.accept(event);

    const result = accumulator.result();
    expect(result).toEqual({
      schemaVersion: '1',
      jsonlEventCount: 7,
      commandExecutionStartedCount: 1,
      commandExecutionCompletedCount: 1,
      fileChangeStartedCount: 1,
      fileChangeCompletedCount: 1,
      agentMessageCompletedCount: 1,
      turnCompletedCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/CANARY|command\W|output|path|message\W/i);
  });
});
