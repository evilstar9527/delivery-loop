import { isAbsolute, resolve } from 'node:path';
import type { CommandExecutor } from '../agent/command-runtime.js';
import { DeliveryPolicyV1Schema, type ParsedDeliveryPolicy } from '../domain/delivery-policy.js';
import {
  BOT_COMMIT_EMAIL,
  BOT_COMMIT_NAME,
  executeGitCommand,
  repositoryAttemptBranch,
  type GitCommandExecutor,
  type GitCommandResult,
} from './git-repository-writer.js';
import {
  VerificationExecutionRunner,
  type VerificationEvidenceReporter,
} from './verification-execution-runner.js';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_REPLAY_COMMITS = 1_000;

export interface BaseRebaseContext {
  repositoryPath: string;
  taskId: string;
  sourceAttemptId: string;
  targetAttemptId: string;
  sourceBranch: string;
  oldBaseSha: string;
  newBaseSha: string;
  sourceHeadSha: string;
  deliveryPolicy: ParsedDeliveryPolicy;
  targetedCommandRefs: readonly string[];
  reporter: VerificationEvidenceReporter;
}

export interface BaseRebaseRunnerDependencies {
  gitExecutor?: GitCommandExecutor;
  commandExecutor?: CommandExecutor;
  monotonicNow?: () => number;
  onRebased?: (result: {
    sourceBranch: string;
    targetBranch: string;
    sourceHeadSha: string;
    oldBaseSha: string;
    newBaseSha: string;
    headSha: string;
    created: boolean;
  }) => Promise<void>;
}

export type BaseRebaseResult =
  | {
      status: 'passed';
      created: boolean;
      sourceBranch: string;
      targetBranch: string;
      oldBaseSha: string;
      newBaseSha: string;
      sourceHeadSha: string;
      headSha: string;
      suiteId: string;
      evidenceIds: string[];
    }
  | {
      status: 'failed';
      created: boolean;
      sourceBranch: string;
      targetBranch: string;
      oldBaseSha: string;
      newBaseSha: string;
      sourceHeadSha: string;
      headSha: string;
      suiteId: string;
      failedCommandRef: string;
      evidenceIds: string[];
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

export class BaseRebasePolicyError extends Error {
  constructor() {
    super('base rebase policy denied');
    this.name = 'BaseRebasePolicyError';
  }
}

/**
 * Replays a trusted, unpublished bot branch onto a pure fast-forward base.
 * The source ref is immutable; a separate Attempt-derived branch receives the replay.
 */
export class BaseRebaseRunner {
  private readonly context: BaseRebaseContext;
  private readonly targetBranch: string;
  private readonly gitExecutor: GitCommandExecutor;

  constructor(
    context: BaseRebaseContext,
    private readonly dependencies: BaseRebaseRunnerDependencies = {},
  ) {
    const targetBranch = this.validate(context);
    this.context = {
      ...context,
      deliveryPolicy: {
        policy: structuredClone(context.deliveryPolicy.policy),
        digest: context.deliveryPolicy.digest,
      },
      targetedCommandRefs: [...context.targetedCommandRefs],
    };
    this.targetBranch = targetBranch;
    this.gitExecutor = dependencies.gitExecutor ?? executeGitCommand;
  }

  async run(): Promise<BaseRebaseResult> {
    await this.assertClean();
    await this.assertScalar(['rev-parse', '--verify', this.context.sourceBranch],
      this.context.sourceHeadSha);
    await this.assertAncestor(this.context.oldBaseSha, this.context.newBaseSha);
    await this.assertAncestor(this.context.oldBaseSha, this.context.sourceHeadSha);
    const sourceCommitCount = await this.assertLinearBotCommits(
      this.context.oldBaseSha,
      this.context.sourceHeadSha,
    );
    if (sourceCommitCount === 0) throw new BaseRebasePolicyError();

    const existing = await this.git([
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${this.targetBranch}`,
    ]);
    let created: boolean;
    let headSha: string;
    let replayNeeded = false;
    if (existing.exitCode === 0) {
      created = false;
      headSha = await this.scalar(['rev-parse', '--verify', this.targetBranch]);
      await this.required(['switch', this.targetBranch]);
      if (headSha === this.context.sourceHeadSha) replayNeeded = true;
      else await this.assertReplayProjection(headSha, sourceCommitCount);
    } else if (existing.exitCode === 1) {
      created = true;
      await this.required([
        'switch',
        '--create',
        this.targetBranch,
        '--no-track',
        this.context.sourceHeadSha,
      ]);
      headSha = this.context.sourceHeadSha;
      replayNeeded = true;
    } else {
      throw new BaseRebasePolicyError();
    }

    if (replayNeeded) {
      const replay = await this.git([
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'rebase.autoStash=false',
        'rebase',
        '--no-autostash',
        '--onto',
        this.context.newBaseSha,
        this.context.oldBaseSha,
        this.targetBranch,
      ], {
        GIT_AUTHOR_NAME: BOT_COMMIT_NAME,
        GIT_AUTHOR_EMAIL: BOT_COMMIT_EMAIL,
        GIT_COMMITTER_NAME: BOT_COMMIT_NAME,
        GIT_COMMITTER_EMAIL: BOT_COMMIT_EMAIL,
      });
      if (replay.exitCode !== 0) {
        const aborted = await this.git(['rebase', '--abort']);
        if (aborted.exitCode !== 0) throw new BaseRebasePolicyError();
        await this.assertClean();
        await this.assertScalar(
          ['rev-parse', '--verify', this.targetBranch],
          this.context.sourceHeadSha,
        );
        await this.assertScalar(
          ['rev-parse', '--verify', this.context.sourceBranch],
          this.context.sourceHeadSha,
        );
        return {
          status: 'blocked',
          reason: 'content_conflict',
          ...this.identity(),
        };
      }
      headSha = await this.scalar(['rev-parse', '--verify', 'HEAD']);
      await this.assertReplayProjection(headSha, sourceCommitCount);
    }

    await this.assertClean();
    await this.assertScalar(['branch', '--show-current'], this.targetBranch);
    await this.assertScalar(
      ['rev-parse', '--verify', this.context.sourceBranch],
      this.context.sourceHeadSha,
    );
    if (this.dependencies.onRebased !== undefined) {
      await this.dependencies.onRebased({
        ...this.identity(),
        headSha,
        created,
      });
    }
    const verification = await new VerificationExecutionRunner({
      repositoryPath: this.context.repositoryPath,
      expectedHeadSha: headSha,
      deliveryPolicy: this.context.deliveryPolicy,
      targetedCommandRefs: this.context.targetedCommandRefs,
      reporter: this.context.reporter,
    }, {
      gitExecutor: this.gitExecutor,
      ...(this.dependencies.commandExecutor === undefined
        ? {}
        : { commandExecutor: this.dependencies.commandExecutor }),
      ...(this.dependencies.monotonicNow === undefined
        ? {}
        : { monotonicNow: this.dependencies.monotonicNow }),
    }).run();
    return verification.status === 'passed'
      ? {
          status: 'passed',
          created,
          ...this.identity(),
          headSha,
          suiteId: verification.suiteId,
          evidenceIds: verification.evidenceIds,
        }
      : {
          status: 'failed',
          created,
          ...this.identity(),
          headSha,
          suiteId: verification.suiteId,
          failedCommandRef: verification.failedCommandRef,
          evidenceIds: verification.evidenceIds,
        };
  }

  private validate(context: BaseRebaseContext): string {
    let sourceBranch: string;
    let targetBranch: string;
    try {
      sourceBranch = repositoryAttemptBranch(context.taskId, context.sourceAttemptId);
      targetBranch = repositoryAttemptBranch(context.taskId, context.targetAttemptId);
    } catch {
      throw new BaseRebasePolicyError();
    }
    const policy = DeliveryPolicyV1Schema.safeParse(context.deliveryPolicy?.policy);
    if (
      !isAbsolute(context.repositoryPath) ||
      resolve(context.repositoryPath) !== context.repositoryPath ||
      context.sourceBranch !== sourceBranch ||
      targetBranch === sourceBranch ||
      !SHA_PATTERN.test(context.oldBaseSha) ||
      !SHA_PATTERN.test(context.newBaseSha) ||
      !SHA_PATTERN.test(context.sourceHeadSha) ||
      context.oldBaseSha === context.newBaseSha ||
      !policy.success ||
      !/^sha256:[a-f0-9]{64}$/.test(context.deliveryPolicy.digest) ||
      !Array.isArray(context.targetedCommandRefs) ||
      typeof context.reporter?.start !== 'function' ||
      typeof context.reporter?.record !== 'function'
    ) throw new BaseRebasePolicyError();
    return targetBranch;
  }

  private identity(): Omit<Extract<BaseRebaseResult, { status: 'blocked' }>, 'status' | 'reason'> {
    return {
      sourceBranch: this.context.sourceBranch,
      targetBranch: this.targetBranch,
      oldBaseSha: this.context.oldBaseSha,
      newBaseSha: this.context.newBaseSha,
      sourceHeadSha: this.context.sourceHeadSha,
    };
  }

  private async assertReplayProjection(headSha: string, sourceCommitCount: number): Promise<void> {
    if (!SHA_PATTERN.test(headSha)) throw new BaseRebasePolicyError();
    await this.assertAncestor(this.context.newBaseSha, headSha);
    const targetCommitCount = await this.commitCount(this.context.newBaseSha, headSha);
    if (targetCommitCount !== sourceCommitCount) throw new BaseRebasePolicyError();
    await this.assertLinearBotCommits(this.context.newBaseSha, headSha);
    const cherry = await this.required([
      'cherry',
      headSha,
      this.context.sourceHeadSha,
    ]);
    const sourcePatches = cherry.stdout.trim() === '' ? [] : cherry.stdout.trim().split('\n');
    if (
      sourcePatches.length !== sourceCommitCount ||
      sourcePatches.some((line) => !line.startsWith('- '))
    ) throw new BaseRebasePolicyError();
  }

  private async assertLinearBotCommits(baseSha: string, headSha: string): Promise<number> {
    const count = await this.commitCount(baseSha, headSha);
    if (count > MAX_REPLAY_COMMITS) throw new BaseRebasePolicyError();
    const list = await this.required([
      'rev-list',
      '--reverse',
      '--topo-order',
      `${baseSha}..${headSha}`,
    ]);
    const commits = list.stdout.trim() === '' ? [] : list.stdout.trim().split('\n');
    if (commits.length !== count || commits.some((commit) => !SHA_PATTERN.test(commit))) {
      throw new BaseRebasePolicyError();
    }
    let expectedParent = baseSha;
    for (const commit of commits) {
      const metadata = await this.required([
        'show',
        '--no-patch',
        '--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce',
        commit,
      ]);
      const fields = metadata.stdout.trimEnd().split('\0');
      if (
        fields.length !== 6 ||
        fields[0] !== commit ||
        fields[1] !== expectedParent ||
        fields[2] !== BOT_COMMIT_NAME ||
        fields[3] !== BOT_COMMIT_EMAIL ||
        fields[4] !== BOT_COMMIT_NAME ||
        fields[5] !== BOT_COMMIT_EMAIL
      ) throw new BaseRebasePolicyError();
      expectedParent = commit;
    }
    return count;
  }

  private async commitCount(baseSha: string, headSha: string): Promise<number> {
    const value = await this.scalar(['rev-list', '--count', `${baseSha}..${headSha}`]);
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) throw new BaseRebasePolicyError();
    return count;
  }

  private async assertAncestor(ancestor: string, descendant: string): Promise<void> {
    const result = await this.git(['merge-base', '--is-ancestor', ancestor, descendant]);
    if (result.exitCode !== 0) throw new BaseRebasePolicyError();
  }

  private async assertClean(): Promise<void> {
    await this.assertScalar(['status', '--porcelain=v1', '--untracked-files=all'], '');
  }

  private async assertScalar(args: string[], expected: string): Promise<void> {
    if (await this.scalar(args) !== expected) throw new BaseRebasePolicyError();
  }

  private async scalar(args: string[]): Promise<string> {
    const result = await this.required(args);
    const value = result.stdout.trim();
    if (value.includes('\n') || value.includes('\r')) throw new BaseRebasePolicyError();
    return value;
  }

  private async required(
    args: string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<GitCommandResult> {
    const result = await this.git(args, environment);
    if (result.exitCode !== 0) throw new BaseRebasePolicyError();
    return result;
  }

  private async git(
    args: string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<GitCommandResult> {
    try {
      return await this.gitExecutor({
        repositoryPath: this.context.repositoryPath,
        args,
        ...(environment === undefined ? {} : { environment }),
      });
    } catch {
      throw new BaseRebasePolicyError();
    }
  }
}
