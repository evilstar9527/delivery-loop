import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentSession } from '../agent/codex-session-adapter.js';
import {
  AgentCheckpointV1Schema,
  computeAgentCheckpointDigest,
  type AgentCheckpointV1,
} from '../domain/checkpoint.js';
import { executeGitCommand } from './git-repository-writer.js';

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_CHECKPOINT_BYTES = 256 * 1_024;

export interface AgentRecoveryContext {
  attemptId: string;
  runId: string;
  planVersion: number;
  planItemId: string;
  checkpointDigest: string;
  checkpointFilePath: string;
  contextFilePath: string;
  outputFilePath: string;
  completedPlanItemIds: string[];
}

export interface AgentRecoveryInput {
  repositoryPath: string;
  timeoutMs: number;
  context: AgentRecoveryContext;
}

export interface AgentRecoveryResult {
  session: AgentSession;
  skippedPlanItemIds: string[];
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await executeGitCommand({
    repositoryPath,
    args,
  });
  if (result.exitCode !== 0) throw new Error('Git recovery command failed');
  return result.stdout.trim();
}

async function gitStdout(repositoryPath: string, args: string[]): Promise<string> {
  return await git(repositoryPath, args);
}

async function readCheckpoint(path: string, expectedDigest: string): Promise<AgentCheckpointV1> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error('Recovery checkpoint is unavailable');
  }
  if (
    !metadata.isFile() ||
    metadata.size > MAX_CHECKPOINT_BYTES ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error('Recovery checkpoint is invalid');
  }
  let checkpoint: AgentCheckpointV1;
  try {
    checkpoint = AgentCheckpointV1Schema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    throw new Error('Recovery checkpoint is invalid');
  }
  if ((await computeAgentCheckpointDigest(checkpoint)) !== expectedDigest) {
    throw new Error('Recovery checkpoint is invalid');
  }
  return checkpoint;
}

/** Restores the Git source of truth before starting a fresh semantic-resume Agent session. */
export class AgentRecoveryRunner {
  constructor(private readonly adapter: AgentAdapter) {}

  async resume(input: AgentRecoveryInput): Promise<AgentRecoveryResult> {
    this.assertContext(input.context, input.timeoutMs);
    if (input.context.completedPlanItemIds.includes(input.context.planItemId)) {
      throw new Error('Recovery target Plan Item is already passed');
    }
    const repositoryPath = resolve(input.repositoryPath);
    const checkpointFilePath = resolve(input.context.checkpointFilePath);
    const checkpoint = await readCheckpoint(
      checkpointFilePath,
      input.context.checkpointDigest,
    );
    if (
      checkpoint.planVersion !== input.context.planVersion ||
      checkpoint.planItemId !== input.context.planItemId
    ) {
      throw new Error('Recovery checkpoint binding changed');
    }

    if ((await gitStdout(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all'])) !== '') {
      throw new Error('Recovery repository is not clean');
    }
    await git(repositoryPath, ['cat-file', '-e', `${checkpoint.headSha}^{commit}`]);
    await git(repositoryPath, ['checkout', '--detach', checkpoint.headSha]);
    const restoredHead = await gitStdout(repositoryPath, ['rev-parse', '--verify', 'HEAD']);
    if (restoredHead !== checkpoint.headSha) throw new Error('Recovery Git head mismatch');

    const session = await this.adapter.resume({
      attemptId: input.context.attemptId,
      workspacePath: repositoryPath,
      contextFilePath: resolve(input.context.contextFilePath),
      checkpointFilePath,
      checkpointDigest: input.context.checkpointDigest,
      outputFilePath: resolve(input.context.outputFilePath),
      timeoutMs: input.timeoutMs,
      expectedPlanVersion: input.context.planVersion,
      expectedPlanItemId: input.context.planItemId,
      expectedHeadSha: checkpoint.headSha,
    });
    return {
      session,
      skippedPlanItemIds: [...input.context.completedPlanItemIds],
    };
  }

  private assertContext(context: AgentRecoveryContext, timeoutMs: number): void {
    if (
      !RESOURCE_ID_PATTERN.test(context.attemptId) ||
      !RESOURCE_ID_PATTERN.test(context.runId) ||
      !RESOURCE_ID_PATTERN.test(context.planItemId) ||
      !Number.isSafeInteger(context.planVersion) ||
      context.planVersion <= 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(context.checkpointDigest) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      new Set(context.completedPlanItemIds).size !== context.completedPlanItemIds.length ||
      !context.completedPlanItemIds.every((itemId) => RESOURCE_ID_PATTERN.test(itemId))
    ) {
      throw new Error('Recovery context is invalid');
    }
  }
}
