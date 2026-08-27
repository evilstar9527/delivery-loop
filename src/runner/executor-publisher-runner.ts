import { isAbsolute, resolve } from 'node:path';
import type { ParsedDeliveryPolicy } from '../domain/delivery-policy.js';
import { canonicalSha256, sha256Bytes } from '../domain/digest.js';
import { PatchProposalSchema, type PatchProposal } from '../domain/patch-proposal.js';
import { DeliveryCommandRunner } from './delivery-command-runner.js';
import {
  GitRepositoryWriter,
  type GitRepositoryWriteCredential,
} from './git-repository-writer.js';
import {
  VerificationExecutionRunner,
  type VerificationEvidenceReporter,
} from './verification-execution-runner.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class ExecutorPublisherRunnerError extends Error {
  constructor(readonly code:
    | 'invalid_context'
    | 'checkout_failed'
    | 'setup_failed'
    | 'patch_failed'
    | 'commit_failed'
    | 'push_failed'
    | 'head_report_failed'
    | 'verification_failed'
    | 'completion_failed') {
    super(`Executor publisher failed: ${code}`);
    this.name = 'ExecutorPublisherRunnerError';
  }
}

export interface ExecutorPublisherRunnerInput {
  repositoryPath: string;
  repository: string;
  taskId: string;
  attemptId: string;
  publisherExecutionId: string;
  publicationId: string;
  checkoutSha: string;
  baseBranch: string;
  targetBranch: string;
  targetBranchMode: 'new' | 'existing_fast_forward';
  planVersion: number;
  planItemId: string;
  targetedCommandRefs: readonly string[];
  requiredVerifyCommandRefs: readonly string[];
  deliveryPolicy: ParsedDeliveryPolicy;
  proposal: PatchProposal;
  patchDigest: string;
  credential: GitRepositoryWriteCredential;
}

export interface ExecutorPublisherCompletionReporter {
  complete(input: {
    publicationId: string;
    publisherExecutionId: string;
    recomputedPatchDigest: string;
    headSha: string;
    branch: string;
    suiteId: string;
    evidenceIds: readonly string[];
  }): Promise<void>;
}

export interface ExecutorPublisherRunnerDependencies {
  checkout(): Promise<void>;
  headReporter: {
    record(input: { parentSha: string; headSha: string; branch: string }): Promise<void>;
  };
  evidenceReporter: VerificationEvidenceReporter;
  completionReporter: ExecutorPublisherCompletionReporter;
  createWriter?: (input: ExecutorPublisherRunnerInput) => GitRepositoryWriter;
}

export type ExecutorPublisherRunnerResult = {
  status: 'passed';
  branch: string;
  headSha: string;
  suiteId: string;
  evidenceIds: string[];
};

function validInput(input: ExecutorPublisherRunnerInput): boolean {
  const proposal = PatchProposalSchema.safeParse(input.proposal);
  return isAbsolute(input.repositoryPath) && resolve(input.repositoryPath) === input.repositoryPath &&
    REPOSITORY_PATTERN.test(input.repository) && ID_PATTERN.test(input.taskId) &&
    ID_PATTERN.test(input.attemptId) && ID_PATTERN.test(input.publisherExecutionId) &&
    ID_PATTERN.test(input.publicationId) && SHA_PATTERN.test(input.checkoutSha) &&
    input.baseBranch.length > 0 && input.baseBranch.length <= 240 &&
    input.targetBranch.length > 0 && input.targetBranch.length <= 240 &&
    Number.isSafeInteger(input.planVersion) && input.planVersion > 0 &&
    ID_PATTERN.test(input.planItemId) && input.targetedCommandRefs.length > 0 &&
    new Set(input.targetedCommandRefs).size === input.targetedCommandRefs.length &&
    input.targetedCommandRefs.every((ref) => /^test:[A-Za-z0-9_-]{1,64}$/.test(ref)) &&
    DIGEST_PATTERN.test(input.patchDigest) && proposal.success &&
    input.credential.repository === input.repository &&
    input.credential.permissions.contents === 'write';
}

/** Clean publisher sequence; it never invokes an Agent or accepts an unfrozen branch. */
export class ExecutorPublisherRunner {
  constructor(
    private readonly input: ExecutorPublisherRunnerInput,
    private readonly dependencies: ExecutorPublisherRunnerDependencies,
  ) {
    if (
      !validInput(input) || typeof dependencies.checkout !== 'function' ||
      typeof dependencies.headReporter?.record !== 'function' ||
      typeof dependencies.evidenceReporter?.start !== 'function' ||
      typeof dependencies.evidenceReporter?.record !== 'function' ||
      typeof dependencies.completionReporter?.complete !== 'function'
    ) throw new ExecutorPublisherRunnerError('invalid_context');
  }

  async run(): Promise<ExecutorPublisherRunnerResult> {
    try {
      await this.dependencies.checkout();
    } catch {
      throw new ExecutorPublisherRunnerError('checkout_failed');
    }
    const proposal = PatchProposalSchema.parse(this.input.proposal);
    const recomputedPatchDigest = await sha256Bytes(
      new TextEncoder().encode(JSON.stringify(proposal)),
    );
    if (
      recomputedPatchDigest !== this.input.patchDigest ||
      await canonicalSha256(this.input.deliveryPolicy.policy) !== this.input.deliveryPolicy.digest
    ) throw new ExecutorPublisherRunnerError('invalid_context');

    const setup = new DeliveryCommandRunner(
      this.input.deliveryPolicy.policy,
      this.input.repositoryPath,
    );
    for (const id of Object.keys(this.input.deliveryPolicy.policy.commands.setup).sort()) {
      if ((await setup.run(`setup:${id}`)).exitCode !== 0) {
        throw new ExecutorPublisherRunnerError('setup_failed');
      }
    }
    const writer = this.dependencies.createWriter?.(this.input) ?? new GitRepositoryWriter({
      repositoryPath: this.input.repositoryPath,
      repository: this.input.repository,
      taskId: this.input.taskId,
      attemptId: this.input.attemptId,
      baseSha: this.input.checkoutSha,
      baseBranch: this.input.baseBranch,
      targetBranch: this.input.targetBranch,
      targetBranchMode: this.input.targetBranchMode,
      protectedBranches: [],
      deliveryPolicy: this.input.deliveryPolicy,
      onProtectedPathApprovalRequired: async () => {
        throw new ExecutorPublisherRunnerError('patch_failed');
      },
      credential: this.input.credential,
    });
    let prepared: Awaited<ReturnType<GitRepositoryWriter['prepareBranch']>>;
    try {
      prepared = await writer.prepareBranch();
      if (
        prepared.baseSha !== this.input.checkoutSha ||
        prepared.branch !== this.input.targetBranch
      ) throw new Error('publisher branch binding mismatch');
      await writer.applyPatchProposal(proposal);
    } catch {
      throw new ExecutorPublisherRunnerError('patch_failed');
    }
    let commit: Awaited<ReturnType<GitRepositoryWriter['commitAll']>>;
    try {
      commit = await writer.commitAll();
      if (commit.branch !== this.input.targetBranch || !SHA_PATTERN.test(commit.commitSha)) {
        throw new Error('publisher commit binding mismatch');
      }
    } catch {
      throw new ExecutorPublisherRunnerError('commit_failed');
    }
    try {
      const pushed = await writer.push({ targetBranch: this.input.targetBranch, force: false });
      if (pushed.branch !== commit.branch || pushed.commitSha !== commit.commitSha) {
        throw new Error('publisher push binding mismatch');
      }
    } catch {
      throw new ExecutorPublisherRunnerError('push_failed');
    }
    try {
      await this.dependencies.headReporter.record({
        parentSha: this.input.checkoutSha,
        headSha: commit.commitSha,
        branch: commit.branch,
      });
    } catch {
      throw new ExecutorPublisherRunnerError('head_report_failed');
    }
    let verification;
    try {
      verification = await new VerificationExecutionRunner({
        repositoryPath: this.input.repositoryPath,
        expectedHeadSha: commit.commitSha,
        deliveryPolicy: this.input.deliveryPolicy,
        targetedCommandRefs: this.input.targetedCommandRefs,
        requiredVerifyCommandRefs: this.input.requiredVerifyCommandRefs,
        reporter: this.dependencies.evidenceReporter,
      }).run();
    } catch {
      throw new ExecutorPublisherRunnerError('verification_failed');
    }
    if (verification.status !== 'passed') {
      throw new ExecutorPublisherRunnerError('verification_failed');
    }
    try {
      await this.dependencies.completionReporter.complete({
        publicationId: this.input.publicationId,
        publisherExecutionId: this.input.publisherExecutionId,
        recomputedPatchDigest,
        headSha: commit.commitSha,
        branch: commit.branch,
        suiteId: verification.suiteId,
        evidenceIds: verification.evidenceIds,
      });
    } catch {
      throw new ExecutorPublisherRunnerError('completion_failed');
    }
    return {
      status: 'passed',
      branch: commit.branch,
      headSha: commit.commitSha,
      suiteId: verification.suiteId,
      evidenceIds: verification.evidenceIds,
    };
  }
}
