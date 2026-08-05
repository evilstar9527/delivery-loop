import type { CodexModelUsage } from '../domain/quota.js';
import {
  CodexExecutionAdapterError,
  type CodexExecutionInput,
  type ExecutionAgent,
  type ExecutionAgentDecision,
} from './codex-execution-adapter.js';

export interface EditInvocationBinding {
  model: string;
}

export interface BoundedEditRecoveryAgentOptions {
  agent: ExecutionAgent;
  beforeInvocation(invocation: 1 | 2): Promise<EditInvocationBinding>;
  afterInvocation(invocation: 1 | 2, usage: CodexModelUsage | null): Promise<void>;
  canRecover(): Promise<boolean>;
}

/**
 * Gives an edit turn one recovery invocation only when Codex emitted no repo
 * tool activity and the trusted Runner independently proves the tree stayed
 * clean. Each real invocation is separately admitted and settled by callers.
 */
export class BoundedEditRecoveryAgent implements ExecutionAgent {
  readonly usesMeteredModel = true as const;

  constructor(private readonly options: BoundedEditRecoveryAgentOptions) {
    if (options.agent.usesMeteredModel !== true) {
      throw new Error('bounded edit recovery requires a metered Agent');
    }
  }

  async apply(input: CodexExecutionInput): Promise<ExecutionAgentDecision> {
    if (input.model !== undefined || input.onUsage !== undefined || input.editTurn !== undefined) {
      throw new Error('bounded edit recovery owns model invocation bindings');
    }
    for (const invocation of [1, 2] as const) {
      const binding = await this.options.beforeInvocation(invocation);
      let usage: CodexModelUsage | null = null;
      let decision: ExecutionAgentDecision | undefined;
      let failure: unknown;
      try {
        decision = await this.options.agent.apply({
          ...input,
          editTurn: invocation,
          model: binding.model,
          onUsage: (measured) => {
            if (usage !== null) throw new Error('duplicate execution Agent usage');
            usage = measured;
          },
        });
      } catch (error) {
        failure = error;
      }
      await this.options.afterInvocation(invocation, usage);
      if (decision !== undefined) return decision;
      const recoverable = invocation === 1 && !input.allowPlanRevision &&
        failure instanceof CodexExecutionAdapterError &&
        failure.kind === 'decision_invalid' &&
        failure.reason === 'no_tool_activity';
      if (!recoverable || !(await this.options.canRecover())) throw failure;
    }
    throw new Error('bounded edit recovery exhausted');
  }
}
