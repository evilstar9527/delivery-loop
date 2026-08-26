import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionAgent } from '../agent/codex-execution-adapter.js';
import { CodexExecutionAdapterError } from '../agent/codex-execution-adapter.js';
import type { ParsedDeliveryPolicy } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  MAX_PATCH_CHANGES,
  MAX_PATCH_FILE_BYTES,
  PatchProposalSchema,
  patchContentDigest,
  patchContentIsUtf8,
  patchPathIsSafe,
  type PatchProposal,
  type PatchProposalV1,
} from '../domain/patch-proposal.js';
import type { ExecutorWorkPatchUpload } from './executor-patch-client.js';
import { validateExecutionPatchProposal } from './execution-patch-policy.js';
import type {
  ExecutionFailureReporter,
  PlanRevisionReporter,
} from './execution-attempt-runner.js';
import { DeliveryCommandRunner } from './delivery-command-runner.js';
import { executeGitCommand } from './git-repository-writer.js';
import { writeVerificationCommandFailure } from '../observability/runner-log.js';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export class ExecutorWorkAttemptError extends Error {
  constructor(readonly kind: 'invalid_output' | 'patch_failed' | 'verification_failed' | 'upload_failed') {
    super(`Executor work Attempt failed: ${kind}`);
    this.name = 'ExecutorWorkAttemptError';
  }
}

export type ExecutorWorkAttemptResult =
  | { status: 'patch_uploaded'; patch: ExecutorWorkPatchUpload }
  | { status: 'failed'; failedCommandRef: string }
  | {
      status: 'replanning';
      revisionId: string;
      analysisAttemptId: string;
      dispatchOutboxId: string;
      runVersion: number;
    };

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function exactHead(repositoryPath: string, checkoutSha: string): Promise<void> {
  const [head, symbolic] = await Promise.all([
    executeGitCommand({
      repositoryPath,
      args: ['rev-parse', '--verify', 'HEAD'],
    }),
    executeGitCommand({
      repositoryPath,
      args: ['symbolic-ref', '--quiet', 'HEAD'],
    }),
  ]);
  if (
    head.exitCode !== 0 || head.stdout.trim() !== checkoutSha ||
    symbolic.exitCode !== 1 || symbolic.stdout !== ''
  ) {
    throw new ExecutorWorkAttemptError('patch_failed');
  }
}

async function readUtf8File(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_PATCH_FILE_BYTES) throw new ExecutorWorkAttemptError('patch_failed');
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ExecutorWorkAttemptError('patch_failed');
  }
}

async function readGitBlob(
  repositoryPath: string,
  checkoutSha: string,
  path: string,
): Promise<string> {
  try {
    const result = await execFileAsync('git', ['show', `${checkoutSha}:${path}`], {
      cwd: repositoryPath,
      encoding: 'buffer',
      timeout: 30_000,
      maxBuffer: MAX_PATCH_FILE_BYTES + 1,
      windowsHide: true,
      env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0' },
    });
    return decoder.decode(result.stdout);
  } catch {
    throw new ExecutorWorkAttemptError('patch_failed');
  }
}

function parseRawChanges(raw: string): Array<{ status: 'A' | 'M'; path: string }> {
  const fields = raw.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new ExecutorWorkAttemptError('patch_failed');
  const changes: Array<{ status: 'A' | 'M'; path: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index];
    const path = fields[index + 1];
    const parsed = metadata?.match(
      /^:(000000|100644) (100644) [a-f0-9]{40} [a-f0-9]{40} ([AM])$/,
    );
    const status = parsed?.[3];
    if (
      (status !== 'A' && status !== 'M') || path === undefined || !patchPathIsSafe(path) ||
      (status === 'A' ? parsed?.[1] !== '000000' : parsed?.[1] !== '100644')
    ) {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    changes.push({ status, path });
  }
  return changes;
}

/** Reconstructs a content proposal from the exact frozen HEAD plus uncommitted worktree. */
export async function captureExecutorWorkPatch(input: {
  repositoryPath: string;
  checkoutSha: string;
  protectedPaths: readonly string[];
  runtimeSecrets: readonly string[];
}): Promise<PatchProposalV1> {
  await exactHead(input.repositoryPath, input.checkoutSha);
  const [tracked, untracked] = await Promise.all([
    executeGitCommand({
      repositoryPath: input.repositoryPath,
      args: ['diff', '--raw', '-z', '--abbrev=40', '--no-renames', 'HEAD', '--'],
      maxOutputBytes: 256 * 1_024,
    }),
    executeGitCommand({
      repositoryPath: input.repositoryPath,
      args: ['ls-files', '--others', '--exclude-standard', '-z'],
      maxOutputBytes: 256 * 1_024,
    }),
  ]);
  if (tracked.exitCode !== 0 || tracked.stderr !== '' || untracked.exitCode !== 0 || untracked.stderr !== '') {
    throw new ExecutorWorkAttemptError('patch_failed');
  }
  const changed = parseRawChanges(tracked.stdout);
  for (const path of untracked.stdout.split('\0').filter((entry) => entry !== '')) {
    if (!patchPathIsSafe(path)) throw new ExecutorWorkAttemptError('patch_failed');
    changed.push({ status: 'A', path });
  }
  changed.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (
    changed.length < 1 || changed.length > MAX_PATCH_CHANGES ||
    new Set(changed.map((change) => change.path)).size !== changed.length
  ) throw new ExecutorWorkAttemptError('patch_failed');
  let root: string;
  try {
    root = await realpath(input.repositoryPath);
  } catch {
    throw new ExecutorWorkAttemptError('patch_failed');
  }
  const changes: PatchProposalV1['changes'] = [];
  for (const change of changed) {
    const absolutePath = resolve(root, change.path);
    let metadata;
    let canonicalPath: string;
    let content: string;
    try {
      [metadata, canonicalPath, content] = await Promise.all([
        lstat(absolutePath),
        realpath(absolutePath),
        readUtf8File(absolutePath),
      ]);
    } catch {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || !inside(root, canonicalPath) ||
      !patchContentIsUtf8(content)
    ) throw new ExecutorWorkAttemptError('patch_failed');
    changes.push({
      path: change.path,
      baseDigest: change.status === 'A'
        ? null
        : await patchContentDigest(
            await readGitBlob(input.repositoryPath, input.checkoutSha, change.path),
          ),
      content,
    });
  }
  const proposal = validateExecutionPatchProposal(
    { schemaVersion: '1', changes },
    input.protectedPaths,
    input.runtimeSecrets,
  );
  const parsed = PatchProposalSchema.safeParse(proposal);
  if (!parsed.success || parsed.data.schemaVersion !== '1') {
    throw new ExecutorWorkAttemptError('patch_failed');
  }
  return parsed.data;
}

function applyEdits(current: string, edits: readonly { oldText: string; newText: string }[]): string {
  let result = current;
  for (const edit of edits) {
    const position = result.indexOf(edit.oldText);
    if (position < 0 || result.indexOf(edit.oldText, position + edit.oldText.length) >= 0) {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    result = `${result.slice(0, position)}${edit.newText}${result.slice(position + edit.oldText.length)}`;
  }
  return result;
}

/** Applies the already policy-validated proposal without Git credential or arbitrary command. */
export async function applyExecutorWorkPatch(input: {
  repositoryPath: string;
  proposal: PatchProposal;
  protectedPaths: readonly string[];
  runtimeSecrets: readonly string[];
}): Promise<void> {
  const proposal = validateExecutionPatchProposal(
    input.proposal,
    input.protectedPaths,
    input.runtimeSecrets,
  );
  let root: string;
  try {
    root = await realpath(input.repositoryPath);
  } catch {
    throw new ExecutorWorkAttemptError('patch_failed');
  }
  const prepared: Array<{ path: string; content: string; create: boolean }> = [];
  const prepareExisting = async (
    change: { path: string; baseDigest: string },
    nextContent: (current: string) => string,
  ): Promise<void> => {
    const absolutePath = resolve(root, change.path);
    if (!inside(root, absolutePath)) throw new ExecutorWorkAttemptError('patch_failed');
    let metadata;
    let canonicalPath: string;
    let current: string;
    try {
      [metadata, canonicalPath, current] = await Promise.all([
        lstat(absolutePath),
        realpath(absolutePath),
        readUtf8File(absolutePath),
      ]);
    } catch {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !inside(root, canonicalPath)) {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    if (await patchContentDigest(current) !== change.baseDigest) {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    const content = nextContent(current);
    if (!patchContentIsUtf8(content)) throw new ExecutorWorkAttemptError('patch_failed');
    prepared.push({ path: absolutePath, content, create: false });
  };
  if (proposal.schemaVersion === '1') {
    for (const change of proposal.changes) {
      if (change.baseDigest !== null) {
        await prepareExisting(
          { path: change.path, baseDigest: change.baseDigest },
          () => change.content,
        );
        continue;
      }
      const absolutePath = resolve(root, change.path);
      if (!inside(root, absolutePath)) throw new ExecutorWorkAttemptError('patch_failed');
      try {
        await lstat(absolutePath);
        throw new ExecutorWorkAttemptError('patch_failed');
      } catch (error) {
        if (error instanceof ExecutorWorkAttemptError) throw error;
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw new ExecutorWorkAttemptError('patch_failed');
        }
      }
      const parent = await realpath(dirname(absolutePath)).catch(() => null);
      if (parent === null || !inside(root, parent)) {
        throw new ExecutorWorkAttemptError('patch_failed');
      }
      prepared.push({ path: absolutePath, content: change.content, create: true });
    }
  } else {
    for (const change of proposal.changes) {
      await prepareExisting(change, (current) => applyEdits(current, change.edits));
    }
  }
  for (const change of prepared) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        change.path,
        change.create
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
          : constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o644,
      );
      await handle.writeFile(change.content, 'utf8');
    } catch {
      throw new ExecutorWorkAttemptError('patch_failed');
    } finally {
      await handle?.close();
    }
  }
}

export interface ExecutorWorkAttemptRunnerContext {
  repositoryPath: string;
  checkoutSha: string;
  targetedCommandRefs: readonly string[];
  deliveryPolicy: ParsedDeliveryPolicy;
  runtimeSecrets: readonly string[];
  agent: Pick<ExecutionAgent, 'apply'>;
  agentInput: Parameters<ExecutionAgent['apply']>[0];
  failureReporter: ExecutionFailureReporter;
  uploadPatch(proposal: PatchProposal): Promise<ExecutorWorkPatchUpload>;
  planRevisionReporter?: PlanRevisionReporter;
}

/** Credential-free work lane: edit -> local verification -> immutable patch upload. */
export class ExecutorWorkAttemptRunner {
  constructor(private readonly context: ExecutorWorkAttemptRunnerContext) {
    if (
      !isAbsolute(context.repositoryPath) || !SHA_PATTERN.test(context.checkoutSha) ||
      context.targetedCommandRefs.length < 1 || typeof context.agent?.apply !== 'function' ||
      typeof context.uploadPatch !== 'function' || typeof context.failureReporter?.report !== 'function'
    ) throw new Error('executor work Attempt context is invalid');
  }

  async run(): Promise<ExecutorWorkAttemptResult> {
    await exactHead(this.context.repositoryPath, this.context.checkoutSha);
    const initialStatus = await executeGitCommand({
      repositoryPath: this.context.repositoryPath,
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
    });
    if (initialStatus.exitCode !== 0 || initialStatus.stdout !== '') {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    const commands = new DeliveryCommandRunner(
      this.context.deliveryPolicy.policy,
      this.context.repositoryPath,
    );
    for (const id of Object.keys(this.context.deliveryPolicy.policy.commands.setup).sort()) {
      if ((await commands.run(`setup:${id}`)).exitCode !== 0) {
        throw new ExecutorWorkAttemptError('verification_failed');
      }
    }
    const afterSetup = await executeGitCommand({
      repositoryPath: this.context.repositoryPath,
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
    });
    if (afterSetup.exitCode !== 0 || afterSetup.stdout !== '') {
      throw new ExecutorWorkAttemptError('patch_failed');
    }
    let decision;
    try {
      decision = await this.context.agent.apply(this.context.agentInput);
    } catch (error) {
      throw new ExecutorWorkAttemptError(
        error instanceof CodexExecutionAdapterError && error.kind === 'decision_invalid'
          ? 'invalid_output'
          : 'patch_failed',
      );
    }
    if (decision.action === 'request_replan') {
      if (this.context.planRevisionReporter === undefined) {
        throw new ExecutorWorkAttemptError('invalid_output');
      }
      return { status: 'replanning', ...await this.context.planRevisionReporter.request() };
    }
    if (decision.action === 'apply_patch') {
      await applyExecutorWorkPatch({
        repositoryPath: this.context.repositoryPath,
        proposal: decision.proposal,
        protectedPaths: this.context.deliveryPolicy.policy.protectedPaths,
        runtimeSecrets: this.context.runtimeSecrets,
      });
    }
    const capture = async () => await captureExecutorWorkPatch({
      repositoryPath: this.context.repositoryPath,
      checkoutSha: this.context.checkoutSha,
      protectedPaths: this.context.deliveryPolicy.policy.protectedPaths,
      runtimeSecrets: this.context.runtimeSecrets,
    });
    let proposal = await capture();
    let proposalDigest = await canonicalSha256(proposal);
    const verificationRefs = [
      ...this.context.targetedCommandRefs,
      ...Object.keys(this.context.deliveryPolicy.policy.commands.verify)
        .sort().map((id) => `verify:${id}`),
    ];
    for (const commandRef of verificationRefs) {
      await exactHead(this.context.repositoryPath, this.context.checkoutSha);
      const result = await commands.run(commandRef);
      const after = await capture();
      if (await canonicalSha256(after) !== proposalDigest) {
        throw new ExecutorWorkAttemptError('patch_failed');
      }
      if (result.exitCode !== 0) {
        const targeted = commandRef.startsWith('test:');
        // Surface the failed command's output (e.g. Go compiler errors) — the
        // failure report keeps only the classification. Sanctioned sink, bounded,
        // secret-scrubbed. This is the executor-proxy work path the pilot uses.
        writeVerificationCommandFailure(commandRef, result.exitCode, result.stderr ?? '');
        await this.context.failureReporter.report({
          failureCode: 'verification_nonzero_exit',
          failureSite: targeted ? 'targeted_verification' : 'full_verification',
          attemptedPaths: targeted
            ? ['code_change', 'targeted_test']
            : ['code_change', 'targeted_test', 'full_verification'],
          neededHumanInput: 'manual_investigation',
        });
        return { status: 'failed', failedCommandRef: commandRef };
      }
      proposal = after;
      proposalDigest = await canonicalSha256(proposal);
    }
    try {
      return { status: 'patch_uploaded', patch: await this.context.uploadPatch(proposal) };
    } catch {
      await this.context.failureReporter.report({
        failureCode: 'tool_unavailable',
        failureSite: 'external_reconciliation',
        attemptedPaths: ['code_change', 'targeted_test', 'full_verification', 'external_reconciliation'],
        neededHumanInput: 'resolve_external_dependency',
      });
      throw new ExecutorWorkAttemptError('upload_failed');
    }
  }
}
