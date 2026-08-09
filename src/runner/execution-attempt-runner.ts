import { isAbsolute, resolve } from 'node:path';
import {
  CodexExecutionAdapterError,
  type CodexExecutionFailureKind,
  type ExecutionAgent,
} from '../agent/codex-execution-adapter.js';
import { DeliveryPolicyV1Schema, type ParsedDeliveryPolicy } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import type {
  AttemptedPath,
  FailureCode,
  FailureSite,
  HumanInputCode,
} from '../domain/attempt-failure.js';
import {
  ProtectedPathApprovalRequired,
  RepositoryCommitError,
  type GitRepositoryWriter,
  type PushedRepositoryBranch,
  type RepositoryCommit,
  type RepositoryCommitFailureStage,
} from './git-repository-writer.js';
import {
  VerificationExecutionRunner,
  type VerificationEvidenceReporter,
} from './verification-execution-runner.js';
import { DeliveryCommandRunner } from './delivery-command-runner.js';
import type { PatchProposal } from '../domain/patch-proposal.js';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface ExecutionAttemptFailure {
  failureCode: FailureCode;
  failureSite: FailureSite;
  attemptedPaths: AttemptedPath[];
  neededHumanInput: HumanInputCode;
}

export type ExecutionAttemptFailureKind =
  | CodexExecutionFailureKind
  | 'unknown'
  | 'credential_unavailable'
  | 'repository_patch_failed'
  | 'repository_commit_failed'
  | 'repository_push_failed'
  | 'head_report_failed';

export class ExecutionAttemptError extends Error {
  constructor(
    readonly kind: ExecutionAttemptFailureKind,
    readonly failureStage?: RepositoryCommitFailureStage,
  ) {
    super('execution Attempt failed');
    this.name = 'ExecutionAttemptError';
  }
}

export interface ExecutionHeadReporter {
  record(input: {
    parentSha: string;
    headSha: string;
    branch: string;
  }): Promise<void>;
}

export interface ExecutionFailureReporter {
  report(failure: ExecutionAttemptFailure): Promise<void>;
}

export interface PlanRevisionRequestResult {
  revisionId: string;
  analysisAttemptId: string;
  dispatchOutboxId: string;
  runVersion: number;
}

export interface PlanRevisionReporter {
  request(): Promise<PlanRevisionRequestResult>;
}

export interface ExecutionRepositoryWriter {
  prepareBranch(): Promise<{ branch: string; baseSha: string }>;
  refreshCredential?(): Promise<void>;
  applyPatchProposal?(proposal: PatchProposal): Promise<void>;
  commitAll(): Promise<RepositoryCommit>;
  push(input: { targetBranch: string; force: boolean }): Promise<PushedRepositoryBranch>;
}

export interface ExecutionAttemptRunnerContext {
  repositoryPath: string;
  checkoutSha: string;
  planVersion: number;
  planItemId: string;
  targetedCommandRefs: readonly string[];
  deliveryPolicy: ParsedDeliveryPolicy;
  repositoryWriter: ExecutionRepositoryWriter | GitRepositoryWriter;
  agent: Pick<ExecutionAgent, 'apply'>;
  agentInput: Parameters<ExecutionAgent['apply']>[0];
  headReporter: ExecutionHeadReporter;
  evidenceReporter: VerificationEvidenceReporter;
  failureReporter: ExecutionFailureReporter;
  planRevisionReporter?: PlanRevisionReporter;
}

export type ExecutionAttemptResult =
  | {
      status: 'passed';
      branch: string;
      headSha: string;
      suiteId: string;
      evidenceIds: string[];
    }
  | {
      status: 'failed';
      branch: string;
      headSha: string;
      suiteId: string;
      failedCommandRef: string;
      evidenceIds: string[];
    }
  | {
      status: 'replanning';
      revisionId: string;
      analysisAttemptId: string;
      dispatchOutboxId: string;
      runVersion: number;
    }
  | {
      status: 'blocked';
      reason: 'content_conflict';
      sourceBranch: string;
      targetBranch: string;
      oldBaseSha: string;
      newBaseSha: string;
      sourceHeadSha: string;
    };

/** Trusted execution sequence: new branch → Agent edit → bot commit/push → exact-head verification. */
export class ExecutionAttemptRunner {
  private readonly context: ExecutionAttemptRunnerContext;

  constructor(context: ExecutionAttemptRunnerContext) {
    const policy = DeliveryPolicyV1Schema.safeParse(context.deliveryPolicy.policy);
    if (
      !isAbsolute(context.repositoryPath) ||
      resolve(context.repositoryPath) !== context.repositoryPath ||
      !SHA_PATTERN.test(context.checkoutSha) ||
      !Number.isSafeInteger(context.planVersion) ||
      context.planVersion <= 0 ||
      !ID_PATTERN.test(context.planItemId) ||
      context.targetedCommandRefs.length === 0 ||
      new Set(context.targetedCommandRefs).size !== context.targetedCommandRefs.length ||
      !context.targetedCommandRefs.every((ref) => /^test:[A-Za-z0-9_-]{1,64}$/.test(ref)) ||
      !policy.success ||
      !/^sha256:[a-f0-9]{64}$/.test(context.deliveryPolicy.digest) ||
      typeof context.repositoryWriter?.prepareBranch !== 'function' ||
      typeof context.repositoryWriter?.commitAll !== 'function' ||
      typeof context.repositoryWriter?.push !== 'function' ||
      typeof context.agent?.apply !== 'function' ||
      !context.agentInput ||
      !ID_PATTERN.test(context.agentInput.attemptId) ||
      context.agentInput.workspacePath !== context.repositoryPath ||
      !isAbsolute(context.agentInput.contextFilePath) ||
      !isAbsolute(context.agentInput.outputFilePath) ||
      resolve(context.agentInput.contextFilePath) !== context.agentInput.contextFilePath ||
      resolve(context.agentInput.outputFilePath) !== context.agentInput.outputFilePath ||
      context.agentInput.contextFilePath === context.agentInput.outputFilePath ||
      !Number.isSafeInteger(context.agentInput.timeoutMs) ||
      context.agentInput.timeoutMs <= 0 ||
      typeof context.agentInput.allowPlanRevision !== 'boolean' ||
      (context.agentInput.allowPlanRevision !== (context.planRevisionReporter !== undefined)) ||
      (context.planRevisionReporter !== undefined &&
        typeof context.planRevisionReporter.request !== 'function') ||
      typeof context.headReporter?.record !== 'function' ||
      typeof context.evidenceReporter?.start !== 'function' ||
      typeof context.evidenceReporter?.record !== 'function' ||
      typeof context.failureReporter?.report !== 'function'
    ) {
      throw new Error('execution Attempt context is invalid');
    }
    this.context = {
      ...context,
      targetedCommandRefs: [...context.targetedCommandRefs],
      deliveryPolicy: {
        policy: structuredClone(context.deliveryPolicy.policy),
        digest: context.deliveryPolicy.digest,
      },
    };
  }

  private async fail(
    kind: ExecutionAttemptFailureKind,
    failure: ExecutionAttemptFailure,
    failureStage?: RepositoryCommitFailureStage,
  ): Promise<never> {
    try {
      await this.context.failureReporter.report(failure);
    } catch {
      // Preserve the already-safe stage classification even if terminal reporting fails.
    }
    throw new ExecutionAttemptError(kind, failureStage);
  }

  async run(): Promise<ExecutionAttemptResult> {
    if (await canonicalSha256(this.context.deliveryPolicy.policy) !== this.context.deliveryPolicy.digest) {
      throw new Error('execution delivery policy binding changed');
    }
    const setup = new DeliveryCommandRunner(
      this.context.deliveryPolicy.policy,
      this.context.repositoryPath,
    );
    for (const id of Object.keys(this.context.deliveryPolicy.policy.commands.setup).sort()) {
      if ((await setup.run(`setup:${id}`)).exitCode !== 0) {
        throw new Error('execution setup command failed');
      }
    }
    const prepared = await this.context.repositoryWriter.prepareBranch();
    if (prepared.baseSha !== this.context.checkoutSha) {
      throw new Error('execution checkout binding changed');
    }
    let decision;
    try {
      decision = await this.context.agent.apply(this.context.agentInput);
      if (
        decision?.schemaVersion !== '1' ||
        (decision.action !== 'apply_fix' && decision.action !== 'request_replan' &&
          decision.action !== 'apply_patch')
      ) throw new Error('invalid decision');
    } catch (error) {
      const kind = error instanceof CodexExecutionAdapterError ? error.kind : 'unknown';
      const failureCode = kind === 'process_nonzero_exit'
        ? 'command_nonzero_exit'
        : kind === 'process_unavailable' || kind === 'process_timeout' || kind === 'unknown'
          ? 'unknown_failure'
          : 'invalid_agent_output';
      return this.fail(kind, {
        failureCode,
        failureSite: 'agent_output',
        attemptedPaths: ['code_change'],
        neededHumanInput: 'manual_investigation',
      });
    }
    if (decision.action === 'request_replan') {
      const reporter = this.context.planRevisionReporter;
      if (reporter === undefined) throw new Error('execution Plan revision is not allowed');
      const revision = await reporter.request();
      if (
        !ID_PATTERN.test(revision.revisionId) ||
        !ID_PATTERN.test(revision.analysisAttemptId) ||
        !ID_PATTERN.test(revision.dispatchOutboxId) ||
        !Number.isSafeInteger(revision.runVersion) ||
        revision.runVersion <= 0
      ) throw new Error('execution Plan revision response is invalid');
      return { status: 'replanning', ...revision };
    }
    try {
      await this.context.repositoryWriter.refreshCredential?.();
    } catch {
      return this.fail('credential_unavailable', {
        failureCode: 'tool_unavailable',
        failureSite: 'external_reconciliation',
        attemptedPaths: ['external_reconciliation'],
        neededHumanInput: 'resolve_external_dependency',
      });
    }
    if (decision.action === 'apply_patch') {
      try {
        if (typeof this.context.repositoryWriter.applyPatchProposal !== 'function') {
          throw new Error('patch proposal application is unavailable');
        }
        await this.context.repositoryWriter.applyPatchProposal(decision.proposal);
      } catch {
        return this.fail('repository_patch_failed', {
          failureCode: 'unknown_failure',
          failureSite: 'repo_snapshot',
          attemptedPaths: ['code_change'],
          neededHumanInput: 'manual_investigation',
        });
      }
    }
    let commit: RepositoryCommit;
    try {
      commit = await this.context.repositoryWriter.commitAll();
    } catch (error) {
      if (error instanceof ProtectedPathApprovalRequired) throw error;
      return this.fail('repository_commit_failed', {
        failureCode: 'unknown_failure',
        failureSite: 'repo_snapshot',
        attemptedPaths: ['code_change'],
        neededHumanInput: 'manual_investigation',
      }, error instanceof RepositoryCommitError ? error.stage : 'unknown');
    }
    if (commit.branch !== prepared.branch || !SHA_PATTERN.test(commit.commitSha)) {
      return this.fail('repository_commit_failed', {
        failureCode: 'unknown_failure',
        failureSite: 'repo_snapshot',
        attemptedPaths: ['code_change'],
        neededHumanInput: 'manual_investigation',
      }, 'result_binding');
    }
    let pushed: PushedRepositoryBranch;
    try {
      pushed = await this.context.repositoryWriter.push({
        targetBranch: commit.branch,
        force: false,
      });
      if (pushed.branch !== commit.branch || pushed.commitSha !== commit.commitSha) {
        throw new Error('invalid push binding');
      }
    } catch {
      return this.fail('repository_push_failed', {
        failureCode: 'tool_unavailable',
        failureSite: 'external_reconciliation',
        attemptedPaths: ['code_change', 'external_reconciliation'],
        neededHumanInput: 'resolve_external_dependency',
      });
    }
    try {
      await this.context.headReporter.record({
        parentSha: this.context.checkoutSha,
        headSha: pushed.commitSha,
        branch: pushed.branch,
      });
    } catch {
      return this.fail('head_report_failed', {
        failureCode: 'unknown_failure',
        failureSite: 'external_reconciliation',
        attemptedPaths: ['code_change', 'external_reconciliation'],
        neededHumanInput: 'manual_investigation',
      });
    }

    const verification = await new VerificationExecutionRunner({
      repositoryPath: this.context.repositoryPath,
      expectedHeadSha: pushed.commitSha,
      deliveryPolicy: this.context.deliveryPolicy,
      targetedCommandRefs: this.context.targetedCommandRefs,
      reporter: this.context.evidenceReporter,
    }).run();
    if (verification.status === 'failed') {
      const targeted = verification.failedCommandRef.startsWith('test:');
      await this.context.failureReporter.report({
        failureCode: 'verification_nonzero_exit',
        failureSite: targeted ? 'targeted_verification' : 'full_verification',
        attemptedPaths: targeted
          ? ['code_change', 'targeted_test']
          : ['code_change', 'targeted_test', 'full_verification'],
        neededHumanInput: 'manual_investigation',
      });
      return {
        status: 'failed',
        branch: pushed.branch,
        headSha: pushed.commitSha,
        suiteId: verification.suiteId,
        failedCommandRef: verification.failedCommandRef,
        evidenceIds: verification.evidenceIds,
      };
    }
    return {
      status: 'passed',
      branch: pushed.branch,
      headSha: pushed.commitSha,
      suiteId: verification.suiteId,
      evidenceIds: verification.evidenceIds,
    };
  }
}
