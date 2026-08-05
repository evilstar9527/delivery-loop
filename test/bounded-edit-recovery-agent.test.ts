import { describe, expect, it } from 'vitest';
import { BoundedEditRecoveryAgent } from '../src/agent/bounded-edit-recovery-agent.js';
import {
  CodexExecutionAdapterError,
  type CodexExecutionInput,
  type ExecutionAgent,
} from '../src/agent/codex-execution-adapter.js';

const INPUT: CodexExecutionInput = {
  attemptId: 'attempt-bounded-edit-recovery',
  workspacePath: '/tmp/bounded-edit-recovery-workspace',
  contextFilePath: '/tmp/bounded-edit-recovery-context.json',
  outputFilePath: '/tmp/bounded-edit-recovery-output.json',
  timeoutMs: 60_000,
  allowPlanRevision: false,
};

function meteredApply(
  apply: ExecutionAgent['apply'],
): ExecutionAgent {
  return { usesMeteredModel: true, apply };
}

describe('bounded edit recovery Agent', () => {
  it('does not recover incomplete activity or an unclean zero-tool turn', async () => {
    for (const scenario of [
      { reason: 'incomplete_tool_activity' as const, clean: true },
      { reason: 'no_tool_activity' as const, clean: false },
    ]) {
      const events: string[] = [];
      const agent = new BoundedEditRecoveryAgent({
        agent: meteredApply(async (input) => {
          events.push(`apply:${input.editTurn}`);
          input.onUsage?.({
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 4,
            reasoningOutputTokens: 1,
          });
          throw new CodexExecutionAdapterError('decision_invalid', scenario.reason);
        }),
        beforeInvocation: async (invocation) => {
          events.push(`before:${invocation}`);
          return { model: 'gpt-test' };
        },
        afterInvocation: async (invocation, usage) => {
          events.push(`after:${invocation}:${usage?.inputTokens ?? 'missing'}`);
        },
        canRecover: async () => {
          events.push('clean');
          return scenario.clean;
        },
      });

      await expect(agent.apply(INPUT)).rejects.toMatchObject({
        kind: 'decision_invalid',
        reason: scenario.reason,
      });
      expect(events).toEqual(scenario.reason === 'no_tool_activity'
        ? ['before:1', 'apply:1', 'after:1:10', 'clean']
        : ['before:1', 'apply:1', 'after:1:10']);
    }
  });

  it('allows only one recovery turn and settles both invocations', async () => {
    const events: string[] = [];
    const agent = new BoundedEditRecoveryAgent({
      agent: meteredApply(async (input) => {
        events.push(`apply:${input.editTurn}`);
        input.onUsage?.({
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        });
        throw new CodexExecutionAdapterError('decision_invalid', 'no_tool_activity');
      }),
      beforeInvocation: async (invocation) => {
        events.push(`before:${invocation}`);
        return { model: 'gpt-test' };
      },
      afterInvocation: async (invocation, usage) => {
        events.push(`after:${invocation}:${usage?.inputTokens ?? 'missing'}`);
      },
      canRecover: async () => {
        events.push('clean');
        return true;
      },
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      kind: 'decision_invalid',
      reason: 'no_tool_activity',
    });
    expect(events).toEqual([
      'before:1', 'apply:1', 'after:1:10', 'clean',
      'before:2', 'apply:2', 'after:2:10',
    ]);
  });
});
