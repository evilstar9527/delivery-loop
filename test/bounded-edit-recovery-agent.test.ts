import { describe, expect, it } from 'vitest';
import {
  BoundedEditRecoveryAgent,
  ExecutionAgentUsageSettlementError,
} from '../src/agent/bounded-edit-recovery-agent.js';
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
  it('classifies persistent usage settlement failure as external quota infrastructure', async () => {
    const agent = new BoundedEditRecoveryAgent({
      agent: meteredApply(async (input) => {
        input.onUsage?.({
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        });
        throw new CodexExecutionAdapterError('decision_invalid', 'no_tool_activity');
      }),
      beforeInvocation: async () => ({ model: 'gpt-test' }),
      afterInvocation: async () => { throw new Error('CANARY_RAW_SETTLEMENT_ERROR'); },
      canRecover: async () => true,
    });

    const failure = await agent.apply(INPUT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExecutionAgentUsageSettlementError);
    expect(String(failure)).not.toContain('CANARY_RAW_SETTLEMENT_ERROR');
  });

  it('preserves an adapter failure when no model usage was produced', async () => {
    const events: string[] = [];
    const agent = new BoundedEditRecoveryAgent({
      agent: meteredApply(async () => {
        events.push('apply');
        throw new CodexExecutionAdapterError('transcript_invalid');
      }),
      beforeInvocation: async () => {
        events.push('before');
        return { model: 'gpt-test' };
      },
      afterInvocation: async () => {
        events.push('after');
        throw new Error('usage settlement must not replace the adapter failure');
      },
      canRecover: async () => {
        events.push('clean');
        return true;
      },
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      kind: 'transcript_invalid',
    });
    expect(events).toEqual(['before', 'apply']);
  });

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

  it('allows only one read-only patch proposal fallback and settles both invocations', async () => {
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
        if (input.editTurn === 1) {
          expect(input.patchProposal).toBeUndefined();
          throw new CodexExecutionAdapterError('decision_invalid', 'no_tool_activity');
        }
        expect(input.patchProposal).toBe(true);
        return {
          schemaVersion: '1',
          action: 'apply_patch',
          proposal: {
            schemaVersion: '1',
            changes: [{
              path: 'README.md',
              baseDigest: `sha256:${'a'.repeat(64)}`,
              content: 'updated\n',
            }],
          },
        };
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

    await expect(agent.apply(INPUT)).resolves.toMatchObject({
      action: 'apply_patch',
      proposal: { changes: [{ path: 'README.md' }] },
    });
    expect(events).toEqual([
      'before:1', 'apply:1', 'after:1:10', 'clean',
      'before:2', 'apply:2', 'after:2:10',
    ]);
  });

  it('does not start a third invocation when the patch proposal turn fails', async () => {
    const events: string[] = [];
    const agent = new BoundedEditRecoveryAgent({
      agent: meteredApply(async (input) => {
        events.push(`apply:${input.editTurn}:${input.patchProposal === true}`);
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
      afterInvocation: async (invocation) => { events.push(`after:${invocation}`); },
      canRecover: async () => true,
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      kind: 'decision_invalid',
      reason: 'no_tool_activity',
    });
    expect(events).toEqual([
      'before:1', 'apply:1:false', 'after:1',
      'before:2', 'apply:2:true', 'after:2',
    ]);
  });

  it.each([
    { invalidInvocation: 1 as const, invalidAction: 'apply_patch' as const, calls: 1 },
    { invalidInvocation: 2 as const, invalidAction: 'apply_fix' as const, calls: 2 },
  ])('enforces the action type for invocation $invalidInvocation', async (scenario) => {
    let calls = 0;
    const agent = new BoundedEditRecoveryAgent({
      agent: meteredApply(async (input) => {
        calls += 1;
        input.onUsage?.({
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        });
        if (input.editTurn === 1 && scenario.invalidInvocation === 2) {
          throw new CodexExecutionAdapterError('decision_invalid', 'no_tool_activity');
        }
        if (scenario.invalidAction === 'apply_fix') {
          return { schemaVersion: '1', action: 'apply_fix' };
        }
        return {
          schemaVersion: '1',
          action: 'apply_patch',
          proposal: {
            schemaVersion: '1',
            changes: [{
              path: 'README.md',
              baseDigest: `sha256:${'a'.repeat(64)}`,
              content: 'updated\n',
            }],
          },
        };
      }),
      beforeInvocation: async () => ({ model: 'gpt-test' }),
      afterInvocation: async () => undefined,
      canRecover: async () => true,
    });

    await expect(agent.apply(INPUT)).rejects.toMatchObject({
      kind: 'decision_invalid',
      reason: 'invalid_output',
    });
    expect(calls).toBe(scenario.calls);
  });
});
