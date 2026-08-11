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
  afterInvocation(invocation: 1 | 2, usage: CodexModelUsage): Promise<void>;
  canRecover(): Promise<boolean>;
}

/** Safe boundary for an admitted model call whose durable usage settlement failed. */
export class ExecutionAgentUsageSettlementError extends Error {
  constructor() {
    super('execution Agent usage settlement is unavailable');
    this.name = 'ExecutionAgentUsageSettlementError';
  }
}

function omitPatchProposalBody(line: string): string {
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    return line;
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return line;
  const record = event as Record<string, unknown>;
  if (
    record.type !== 'item.completed' || record.item === null ||
    typeof record.item !== 'object' || Array.isArray(record.item)
  ) return line;
  const item = record.item as Record<string, unknown>;
  if (item.type !== 'agent_message') return line;
  return JSON.stringify({
    ...record,
    item: { type: 'agent_message', text: '[PATCH_PROPOSAL_OMITTED]' },
  });
}

/**
 * Gives a zero-tool edit one read-only proposal fallback only when the trusted
 * Runner independently proves the tree stayed clean. Each real invocation is
 * separately admitted and settled by callers.
 */
export class BoundedEditRecoveryAgent implements ExecutionAgent {
  readonly usesMeteredModel = true as const;

  constructor(private readonly options: BoundedEditRecoveryAgentOptions) {
    if (options.agent.usesMeteredModel !== true) {
      throw new Error('bounded edit recovery requires a metered Agent');
    }
  }

  async apply(input: CodexExecutionInput): Promise<ExecutionAgentDecision> {
    if (
      input.model !== undefined || input.onUsage !== undefined ||
      input.editTurn !== undefined || input.patchProposal !== undefined
    ) {
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
          ...(invocation === 2 ? { patchProposal: true } : {}),
          model: binding.model,
          ...(invocation === 2 && input.onTranscriptLine !== undefined ? {
            onTranscriptLine: (line: string) => {
              input.onTranscriptLine?.(omitPatchProposalBody(line));
            },
          } : {}),
          onUsage: (measured) => {
            if (usage !== null) throw new Error('duplicate execution Agent usage');
            usage = measured;
          },
        });
      } catch (error) {
        failure = error;
      }
      if (usage !== null) {
        try {
          await this.options.afterInvocation(invocation, usage);
        } catch {
          throw new ExecutionAgentUsageSettlementError();
        }
      }
      if (decision !== undefined && (
        (invocation === 1 && decision.action === 'apply_patch') ||
        (invocation === 2 && decision.action !== 'apply_patch')
      )) {
        failure = new CodexExecutionAdapterError('decision_invalid', 'invalid_output');
        decision = undefined;
      }
      const cleanApplyFix = decision?.action === 'apply_fix' && invocation === 1 &&
        !input.allowPlanRevision && await this.options.canRecover();
      if (decision !== undefined && !cleanApplyFix) return decision;
      const recoverable = cleanApplyFix || invocation === 1 && !input.allowPlanRevision &&
        failure instanceof CodexExecutionAdapterError &&
        failure.kind === 'decision_invalid' &&
        failure.reason === 'no_tool_activity';
      if (!recoverable || (!cleanApplyFix && !(await this.options.canRecover()))) throw failure;
    }
    throw new Error('bounded edit recovery exhausted');
  }
}
