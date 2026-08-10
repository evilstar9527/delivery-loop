import { describe, expect, it } from 'vitest';
import {
  CodexExecutionAdapterError,
  type CodexExecutionInput,
} from '../src/agent/codex-execution-adapter.js';
import { createRawTranscriptArtifactAgent } from '../src/runner/execution-runner.js';

const INPUT: CodexExecutionInput = {
  attemptId: 'attempt-transcript-artifact',
  workspacePath: '/tmp/transcript-artifact-workspace',
  contextFilePath: '/tmp/transcript-artifact-context.json',
  outputFilePath: '/tmp/transcript-artifact-output.json',
  timeoutMs: 60_000,
  allowPlanRevision: false,
};

const TRANSCRIPT_LINE = JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'PUBLIC_TRANSCRIPT_MARKER' },
});

describe('execution raw transcript artifact Agent', () => {
  it('preserves an existing typed Agent failure when artifact persistence also fails', async () => {
    const activity: unknown[] = [];
    let persisted = 0;
    const agent = createRawTranscriptArtifactAgent({
      agent: {
        usesMeteredModel: true,
        apply: async (input) => {
          input.onTranscriptLine?.(TRANSCRIPT_LINE);
          throw new CodexExecutionAdapterError('decision_invalid', 'no_tool_activity');
        },
      },
      runtimeSecrets: new Set(['runtime-private-value']),
      persist: async () => {
        persisted += 1;
        throw new Error('artifact dependency failed');
      },
      onActivity: (value) => { activity.push(value); },
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      name: 'CodexExecutionAdapterError',
      kind: 'decision_invalid',
      reason: 'no_tool_activity',
    });
    expect(persisted).toBe(1);
    expect(activity).toEqual([expect.objectContaining({
      jsonlEventCount: 1,
      agentMessageCompletedCount: 1,
    })]);
  });

  it('classifies transcript persistence as transcript_invalid when the Agent succeeded', async () => {
    const agent = createRawTranscriptArtifactAgent({
      agent: {
        usesMeteredModel: true,
        apply: async (input) => {
          input.onTranscriptLine?.(TRANSCRIPT_LINE);
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      runtimeSecrets: new Set(),
      persist: async () => { throw new Error('artifact dependency failed'); },
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      name: 'CodexExecutionAdapterError',
      kind: 'transcript_invalid',
    });
  });

  it('classifies a missing required transcript without attempting persistence', async () => {
    let persisted = false;
    const agent = createRawTranscriptArtifactAgent({
      agent: {
        usesMeteredModel: true,
        apply: async () => ({ schemaVersion: '1', action: 'apply_fix' }),
      },
      runtimeSecrets: new Set(),
      persist: async () => { persisted = true; },
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      name: 'CodexExecutionAdapterError',
      kind: 'transcript_invalid',
    });
    expect(persisted).toBe(false);
  });

  it('rejects invalid transcript content with the fixed typed classification', async () => {
    let persisted = false;
    const agent = createRawTranscriptArtifactAgent({
      agent: {
        usesMeteredModel: true,
        apply: async (input) => {
          input.onTranscriptLine?.('not-json');
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      runtimeSecrets: new Set(),
      persist: async () => { persisted = true; },
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      name: 'CodexExecutionAdapterError',
      kind: 'transcript_invalid',
    });
    expect(persisted).toBe(false);
  });
});
