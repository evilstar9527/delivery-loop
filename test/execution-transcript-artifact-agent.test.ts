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

  it('reports progress activity while a long turn is still streaming', async () => {
    const activity: { jsonlEventCount: number }[] = [];
    let clock = 0;
    const agent = createRawTranscriptArtifactAgent({
      agent: {
        usesMeteredModel: true,
        apply: async (input) => {
          // Three lines spaced past the throttle window, then one inside it.
          clock += 6_000;
          input.onTranscriptLine?.(TRANSCRIPT_LINE);
          clock += 6_000;
          input.onTranscriptLine?.(TRANSCRIPT_LINE);
          clock += 10;
          input.onTranscriptLine?.(TRANSCRIPT_LINE);
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      runtimeSecrets: new Set(),
      persist: async () => {},
      onActivity: (value) => { activity.push({ jsonlEventCount: value.jsonlEventCount }); },
      now: () => clock,
    });

    await expect(agent.apply(INPUT)).resolves.toMatchObject({ action: 'apply_fix' });
    // Two throttled progress snapshots, then the terminal one covering all 3.
    expect(activity.map((value) => value.jsonlEventCount)).toEqual([1, 2, 3]);
  });

  it('suppresses a progress snapshot that repeats the previous counters', async () => {
    const activity: unknown[] = [];
    const agent = createRawTranscriptArtifactAgent({
      agent: {
        usesMeteredModel: true,
        apply: async (input) => {
          input.onTranscriptLine?.(TRANSCRIPT_LINE);
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      runtimeSecrets: new Set(),
      persist: async () => {},
      onActivity: (value) => { activity.push(value); },
      // A clock always past the window would emit on every line; only the
      // count guard keeps the single line from being reported twice.
      now: () => 1_000_000,
    });

    await expect(agent.apply(INPUT)).resolves.toMatchObject({ action: 'apply_fix' });
    expect(activity).toEqual([expect.objectContaining({ jsonlEventCount: 1 })]);
  });

  it('keeps the Attempt outcome when a progress activity observer throws', async () => {
    let clock = 0;
    const agent = createRawTranscriptArtifactAgent({
      agent: {
        usesMeteredModel: true,
        apply: async (input) => {
          clock += 6_000;
          input.onTranscriptLine?.(TRANSCRIPT_LINE);
          return { schemaVersion: '1', action: 'apply_fix' };
        },
      },
      runtimeSecrets: new Set(),
      persist: async () => {},
      onActivity: () => { throw new Error('diagnostic sink failed'); },
      now: () => clock,
    });

    await expect(agent.apply(INPUT)).resolves.toMatchObject({ action: 'apply_fix' });
  });
});
