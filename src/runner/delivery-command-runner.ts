import {
  executeCommand,
  type CommandExecutionResult,
  type CommandExecutor,
} from '../agent/command-runtime.js';
import {
  resolveDeliveryCommand,
  type DeliveryPolicyV1,
} from '../domain/delivery-policy.js';

export interface DeliveryCommandResult extends CommandExecutionResult {
  ref: string;
}

/** The execution boundary accepts only a trusted policy ref; callers cannot supply argv or stdin. */
export class DeliveryCommandRunner {
  constructor(
    private readonly policy: DeliveryPolicyV1,
    private readonly repositoryPath: string,
    private readonly executor: CommandExecutor = executeCommand,
  ) {}

  async run(commandRef: string): Promise<DeliveryCommandResult> {
    const resolved = resolveDeliveryCommand(this.policy, commandRef, this.repositoryPath);
    const result = await this.executor({
      command: resolved.command,
      args: resolved.args,
      cwd: resolved.cwd,
      stdin: resolved.stdin,
      timeoutMs: resolved.timeoutMs,
    });
    return { ref: resolved.ref, ...result };
  }
}
