import { isAbsolute, resolve } from 'node:path';
import type { CommandExecutor } from '../agent/command-runtime.js';
import { DeliveryPolicyV1Schema, type ParsedDeliveryPolicy } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  VerificationCommandResultV1Schema,
  VerificationSuiteManifestV1Schema,
  verificationSuiteCommands,
  type VerificationCommandResultV1,
  type VerificationSuiteCommand,
  type VerificationSuiteManifestV1,
} from '../domain/verification-evidence.js';
import { DeliveryCommandRunner } from './delivery-command-runner.js';
import { writeVerificationCommandFailure } from '../observability/runner-log.js';
import {
  executeGitCommand,
  type GitCommandExecutor,
} from './git-repository-writer.js';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SUITE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export type VerificationExecutionErrorCode =
  | 'invalid_context'
  | 'invalid_policy'
  | 'invalid_selection'
  | 'head_changed'
  | 'report_failed';

export class VerificationExecutionError extends Error {
  constructor(readonly code: VerificationExecutionErrorCode) {
    super(`verification execution failed: ${code}`);
    this.name = 'VerificationExecutionError';
  }
}

export interface VerificationEvidenceReporter {
  start(manifest: VerificationSuiteManifestV1): Promise<{
    suiteId: string;
    created: boolean;
    status: 'running' | 'failed' | 'completed';
    commands: VerificationSuiteCommand[];
  }>;
  record(
    suiteId: string,
    result: VerificationCommandResultV1,
  ): Promise<{
    evidenceId: string;
    created: boolean;
    suiteStatus: 'running' | 'failed' | 'completed';
  }>;
}

export interface VerificationExecutionContext {
  repositoryPath: string;
  expectedHeadSha: string;
  deliveryPolicy: ParsedDeliveryPolicy;
  targetedCommandRefs: readonly string[];
  /**
   * Plan-authorized required verify refs. When provided, only these run — the
   * plan policy deliberately limits verification to what is affordable in the
   * sandbox (e.g. verify:smoke) and excludes heavy suites (verify:all, the full
   * go test suite that needs infra the sandbox lacks). When omitted, falls back
   * to every verify command in the delivery policy (legacy behavior). Refs are
   * still intersected with the trusted policy below, so only policy-defined
   * commands can execute.
   */
  requiredVerifyCommandRefs?: readonly string[];
  reporter: VerificationEvidenceReporter;
}

export interface VerificationExecutionDependencies {
  commandExecutor?: CommandExecutor;
  gitExecutor?: GitCommandExecutor;
  monotonicNow?: () => number;
}

export type VerificationExecutionResult =
  | {
      suiteId: string;
      status: 'passed';
      evidenceIds: string[];
    }
  | {
      suiteId: string;
      status: 'failed';
      failedCommandRef: string;
      evidenceIds: string[];
    };

/** Trusted Runner sequence: selected targeted tests, then every policy required verify. */
export class VerificationExecutionRunner {
  private readonly context: VerificationExecutionContext;
  private readonly commandExecutor: CommandExecutor | undefined;
  private readonly gitExecutor: GitCommandExecutor;
  private readonly monotonicNow: () => number;

  constructor(
    context: VerificationExecutionContext,
    dependencies: VerificationExecutionDependencies = {},
  ) {
    if (
      !isAbsolute(context.repositoryPath) ||
      resolve(context.repositoryPath) !== context.repositoryPath ||
      !SHA_PATTERN.test(context.expectedHeadSha) ||
      typeof context.reporter?.start !== 'function' ||
      typeof context.reporter?.record !== 'function'
    ) {
      throw new VerificationExecutionError('invalid_context');
    }
    this.context = {
      ...context,
      deliveryPolicy: {
        policy: structuredClone(context.deliveryPolicy.policy),
        digest: context.deliveryPolicy.digest,
      },
      targetedCommandRefs: [...context.targetedCommandRefs],
    };
    this.commandExecutor = dependencies.commandExecutor;
    this.gitExecutor = dependencies.gitExecutor ?? executeGitCommand;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }

  async run(): Promise<VerificationExecutionResult> {
    const manifest = await this.manifest();
    await this.assertHead();
    let started;
    try {
      started = await this.context.reporter.start(manifest);
    } catch {
      throw new VerificationExecutionError('report_failed');
    }
    const expectedCommands = verificationSuiteCommands(manifest);
    if (
      !SUITE_ID_PATTERN.test(started.suiteId) ||
      typeof started.created !== 'boolean' ||
      started.status !== 'running' ||
      started.commands.length !== expectedCommands.length ||
      started.commands.some((command, index) =>
        command.position !== expectedCommands[index]?.position ||
        command.phase !== expectedCommands[index]?.phase ||
        command.commandRef !== expectedCommands[index]?.commandRef)
    ) {
      throw new VerificationExecutionError('report_failed');
    }

    const commandRunner = this.commandExecutor === undefined
      ? new DeliveryCommandRunner(
        this.context.deliveryPolicy.policy,
        this.context.repositoryPath,
      )
      : new DeliveryCommandRunner(
        this.context.deliveryPolicy.policy,
        this.context.repositoryPath,
        this.commandExecutor,
      );
    const evidenceIds: string[] = [];
    for (const command of expectedCommands) {
      await this.assertHead();
      const startedAt = this.monotonicNow();
      let exitCode: number;
      let commandStderr = '';
      try {
        const commandResult = await commandRunner.run(command.commandRef);
        exitCode = commandResult.exitCode;
        commandStderr = commandResult.stderr ?? '';
      } catch {
        exitCode = 127;
      }
      if (exitCode !== 0) {
        writeVerificationCommandFailure(command.commandRef, exitCode, commandStderr);
      }
      const durationMs = this.duration(startedAt, this.monotonicNow());
      await this.assertHead();
      const parsedResult = VerificationCommandResultV1Schema.safeParse({
        schemaVersion: '1',
        ...command,
        exitCode,
        durationMs,
        headSha: this.context.expectedHeadSha,
        ...(exitCode !== 0 && commandStderr.length > 0
          ? { outputTail: commandStderr.slice(-4000) }
          : {}),
      });
      if (!parsedResult.success) throw new VerificationExecutionError('invalid_context');
      const result = parsedResult.data;
      let recorded;
      try {
        recorded = await this.context.reporter.record(started.suiteId, result);
      } catch {
        throw new VerificationExecutionError('report_failed');
      }
      if (
        !SUITE_ID_PATTERN.test(recorded.evidenceId) ||
        typeof recorded.created !== 'boolean' ||
        !['running', 'failed', 'completed'].includes(recorded.suiteStatus)
      ) {
        throw new VerificationExecutionError('report_failed');
      }
      const expectedSuiteStatus = exitCode !== 0
        ? 'failed'
        : command.position === expectedCommands.length - 1
          ? 'completed'
          : 'running';
      if (recorded.suiteStatus !== expectedSuiteStatus) {
        throw new VerificationExecutionError('report_failed');
      }
      evidenceIds.push(recorded.evidenceId);
      if (exitCode !== 0) {
        return {
          suiteId: started.suiteId,
          status: 'failed',
          failedCommandRef: command.commandRef,
          evidenceIds,
        };
      }
    }
    return { suiteId: started.suiteId, status: 'passed', evidenceIds };
  }

  private async manifest(): Promise<VerificationSuiteManifestV1> {
    const policy = DeliveryPolicyV1Schema.safeParse(this.context.deliveryPolicy.policy);
    if (
      !policy.success ||
      !/^sha256:[a-f0-9]{64}$/.test(this.context.deliveryPolicy.digest) ||
      await canonicalSha256(this.context.deliveryPolicy.policy) !== this.context.deliveryPolicy.digest
    ) {
      throw new VerificationExecutionError('invalid_policy');
    }
    const selected = [...this.context.targetedCommandRefs];
    const targeted = new Set(Object.keys(policy.data.commands.targeted).map((id) => `test:${id}`));
    if (
      selected.length === 0 ||
      new Set(selected).size !== selected.length ||
      !selected.every((ref) => targeted.has(ref))
    ) {
      throw new VerificationExecutionError('invalid_selection');
    }
    const policyVerify = new Set(Object.keys(policy.data.commands.verify).map((id) => `verify:${id}`));
    const requiredVerifyCommandRefs = this.context.requiredVerifyCommandRefs === undefined
      ? [...policyVerify].sort()
      : (() => {
          const selectedVerify = [...this.context.requiredVerifyCommandRefs];
          if (
            new Set(selectedVerify).size !== selectedVerify.length ||
            !selectedVerify.every((ref) => policyVerify.has(ref))
          ) {
            throw new VerificationExecutionError('invalid_selection');
          }
          return selectedVerify.sort();
        })();
    const parsed = VerificationSuiteManifestV1Schema.safeParse({
      schemaVersion: '1',
      headSha: this.context.expectedHeadSha,
      policyDigest: this.context.deliveryPolicy.digest,
      targetedCommandRefs: selected,
      requiredVerifyCommandRefs,
    });
    if (!parsed.success) throw new VerificationExecutionError('invalid_selection');
    return parsed.data;
  }

  private async assertHead(): Promise<void> {
    let result;
    try {
      result = await this.gitExecutor({
        repositoryPath: this.context.repositoryPath,
        args: ['rev-parse', '--verify', 'HEAD'],
      });
    } catch {
      throw new VerificationExecutionError('head_changed');
    }
    if (
      result.exitCode !== 0 ||
      result.stdout.trim() !== this.context.expectedHeadSha ||
      /[\r\n].+/.test(result.stdout.trim())
    ) {
      throw new VerificationExecutionError('head_changed');
    }
  }

  private duration(startedAt: number, endedAt: number): number {
    const duration = Math.ceil(endedAt - startedAt);
    if (!Number.isFinite(duration) || duration < 0 || duration > 3_600_000) {
      throw new VerificationExecutionError('invalid_context');
    }
    return duration;
  }
}
