import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DeliveryPolicyV1Schema, type ParsedDeliveryPolicy } from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  ProtectedPathChangeReportV1Schema,
  computeProtectedPathDiffDigest,
  isProtectedRepositoryPath,
  type ProtectedPathChangeReportV1,
  type ProtectedPathChangeType,
  type ProtectedPathChangeV1,
} from '../domain/protected-path-change.js';
import {
  PatchProposalV1Schema,
  patchContentDigest,
  patchContentIsUtf8,
  type PatchProposalV1,
} from '../domain/patch-proposal.js';

export type { ProtectedPathChangeReportV1 } from '../domain/protected-path-change.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_GIT_OUTPUT_BYTES = 64 * 1_024;
const GIT_TIMEOUT_MS = 30_000;

export const BOT_COMMIT_NAME = 'Delivery Loop Bot';
export const BOT_COMMIT_EMAIL = 'delivery-loop[bot]@users.noreply.github.com';

export interface GitCommandRequest {
  repositoryPath: string;
  args: string[];
  environment?: Readonly<Record<string, string>>;
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandExecutor = (
  request: GitCommandRequest,
) => Promise<GitCommandResult>;

export interface GitRepositoryWriterContext {
  repositoryPath: string;
  repository: string;
  taskId: string;
  attemptId: string;
  baseSha: string;
  baseBranch: string;
  targetBranch?: string;
  targetBranchMode?: 'new' | 'existing_fast_forward';
  protectedBranches: readonly string[];
  deliveryPolicy: ParsedDeliveryPolicy;
  onProtectedPathApprovalRequired: (
    report: ProtectedPathChangeReportV1,
  ) => Promise<void>;
  credential: {
    credentialId: string;
    repository: string;
    approvalId: string;
    token: string;
    expiresAt: string;
    permissions: { contents: 'write'; pullRequests: 'write' };
  };
}

export interface PreparedRepositoryBranch {
  branch: string;
  baseSha: string;
}

export interface RepositoryCommit {
  branch: string;
  commitSha: string;
  authorName: typeof BOT_COMMIT_NAME;
  authorEmail: typeof BOT_COMMIT_EMAIL;
}

export interface PushRepositoryBranchInput {
  targetBranch: string;
  force: boolean;
}

export interface PushedRepositoryBranch {
  branch: string;
  commitSha: string;
}

interface PreparedPatchChange {
  absolutePath: string;
  content: string;
  create: boolean;
}

export class RepositoryWritePolicyError extends Error {
  constructor() {
    super('repository write policy denied');
    this.name = 'RepositoryWritePolicyError';
  }
}

export class ProtectedPathApprovalRequired extends Error {
  readonly report: ProtectedPathChangeReportV1;

  constructor(report: ProtectedPathChangeReportV1) {
    super('protected path changes require approval');
    this.name = 'ProtectedPathApprovalRequired';
    this.report = structuredClone(report);
  }
}

function pathIsMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

interface StagedChange {
  path: string;
  previousPath?: string;
  changeType: ProtectedPathChangeType;
}

interface LineStats {
  additions: number | null;
  deletions: number | null;
}

function safeBranchName(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 240 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('\\') ||
    value.includes('[') ||
    /[\0-\x20~^:?*]/.test(value)
  ) {
    return false;
  }
  return value.split('/').every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.endsWith('.lock'),
  );
}

function validateContext(context: GitRepositoryWriterContext): void {
  const credentialExpiry = Date.parse(context.credential.expiresAt);
  const deliveryPolicy = DeliveryPolicyV1Schema.safeParse(context.deliveryPolicy.policy);
  if (
    !isAbsolute(context.repositoryPath) ||
    resolve(context.repositoryPath) !== context.repositoryPath ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ||
    !ID_PATTERN.test(context.taskId) ||
    !ID_PATTERN.test(context.attemptId) ||
    !SHA_PATTERN.test(context.baseSha) ||
    !safeBranchName(context.baseBranch) ||
    context.protectedBranches.length > 100 ||
    new Set(context.protectedBranches).size !== context.protectedBranches.length ||
    !context.protectedBranches.every(safeBranchName) ||
    !deliveryPolicy.success ||
    !/^sha256:[a-f0-9]{64}$/.test(context.deliveryPolicy.digest) ||
    typeof context.onProtectedPathApprovalRequired !== 'function' ||
    !ID_PATTERN.test(context.credential.credentialId) ||
    !ID_PATTERN.test(context.credential.approvalId) ||
    context.credential.repository !== context.repository ||
    context.credential.token.length < 1 ||
    context.credential.token.length > 2_000 ||
    /[\0\r\n]/.test(context.credential.token) ||
    !Number.isFinite(credentialExpiry) ||
    credentialExpiry <= Date.now() ||
    context.credential.permissions.contents !== 'write' ||
    context.credential.permissions.pullRequests !== 'write' ||
    (context.targetBranch === undefined) !== (context.targetBranchMode === undefined) ||
    (context.targetBranch !== undefined && !safeBranchName(context.targetBranch)) ||
    (context.targetBranchMode !== undefined &&
      context.targetBranchMode !== 'new' &&
      context.targetBranchMode !== 'existing_fast_forward')
  ) {
    throw new RepositoryWritePolicyError();
  }
}

function fixedGitEnvironment(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    ...overrides,
  };
}

export const executeGitCommand: GitCommandExecutor = async (
  request,
): Promise<GitCommandResult> => await new Promise((resolvePromise, rejectPromise) => {
  execFile(
    'git',
    request.args,
    {
      cwd: request.repositoryPath,
      encoding: 'utf8',
      env: fixedGitEnvironment(request.environment),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === 'number') {
        resolvePromise({ exitCode: error.code, stdout, stderr });
        return;
      }
      rejectPromise(new Error('fixed Git command failed'));
    },
  );
});

export function repositoryAttemptBranch(taskId: string, attemptId: string): string {
  if (!ID_PATTERN.test(taskId) || !ID_PATTERN.test(attemptId)) {
    throw new Error('repository write identity is invalid');
  }
  return `agent/${taskId}/${attemptId}`;
}

function pushInput(input: unknown): PushRepositoryBranchInput {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== 'force,targetBranch'
  ) {
    throw new RepositoryWritePolicyError();
  }
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.targetBranch !== 'string' ||
    !safeBranchName(candidate.targetBranch) ||
    typeof candidate.force !== 'boolean'
  ) {
    throw new RepositoryWritePolicyError();
  }
  return {
    targetBranch: candidate.targetBranch,
    force: candidate.force,
  };
}

/** Fixed-argv Git boundary used only after the repo_write capability is approved. */
export class GitRepositoryWriter {
  private readonly context: GitRepositoryWriterContext;
  private readonly branch: string;
  private readonly branchMode: 'new' | 'existing_fast_forward';
  private readonly protectedBranches: ReadonlySet<string>;

  constructor(
    context: GitRepositoryWriterContext,
    private readonly executor: GitCommandExecutor = executeGitCommand,
  ) {
    validateContext(context);
    const derivedBranch = repositoryAttemptBranch(context.taskId, context.attemptId);
    const branchMode = context.targetBranchMode ?? 'new';
    const branch = context.targetBranch ?? derivedBranch;
    if (
      (branchMode === 'new' && branch !== derivedBranch) ||
      (branchMode === 'existing_fast_forward' && (
        branch === derivedBranch ||
        !branch.startsWith(`agent/${context.taskId}/`)
      ))
    ) {
      throw new RepositoryWritePolicyError();
    }
    this.context = {
      ...context,
      protectedBranches: [...context.protectedBranches],
      deliveryPolicy: {
        policy: structuredClone(context.deliveryPolicy.policy),
        digest: context.deliveryPolicy.digest,
      },
      credential: { ...context.credential, permissions: { ...context.credential.permissions } },
    };
    this.branch = branch;
    this.branchMode = branchMode;
    this.protectedBranches = new Set([
      'main',
      'master',
      context.baseBranch,
      ...context.protectedBranches,
    ]);
  }

  async prepareBranch(): Promise<PreparedRepositoryBranch> {
    this.assertCredentialActive();
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all']);
    if (status.exitCode !== 0 || status.stdout !== '') throw new RepositoryWritePolicyError();
    const head = await this.requiredScalar(['rev-parse', '--verify', 'HEAD']);
    if (head !== this.context.baseSha) throw new RepositoryWritePolicyError();

    if (this.branchMode === 'existing_fast_forward') {
      const remote = await this.required([
        'ls-remote',
        '--exit-code',
        'origin',
        `refs/heads/${this.branch}`,
      ], this.credentialGitEnvironment());
      const expected = `${this.context.baseSha}\trefs/heads/${this.branch}`;
      if (remote.stdout.trim() !== expected) throw new RepositoryWritePolicyError();
      await this.required([
        'switch',
        '--force-create',
        this.branch,
        '--no-track',
        this.context.baseSha,
      ]);
      if (
        await this.currentBranch() !== this.branch ||
        await this.requiredScalar(['rev-parse', '--verify', 'HEAD']) !== this.context.baseSha
      ) {
        throw new RepositoryWritePolicyError();
      }
      return { branch: this.branch, baseSha: this.context.baseSha };
    }

    const existing = await this.git([
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${this.branch}`,
    ]);
    if (existing.exitCode === 0) {
      const ancestor = await this.git([
        'merge-base',
        '--is-ancestor',
        this.context.baseSha,
        this.branch,
      ]);
      if (ancestor.exitCode !== 0) throw new RepositoryWritePolicyError();
      await this.required(['switch', this.branch]);
    } else if (existing.exitCode === 1) {
      await this.required([
        'switch',
        '--create',
        this.branch,
        '--no-track',
        this.context.baseSha,
      ]);
    } else {
      throw new RepositoryWritePolicyError();
    }
    if (await this.currentBranch() !== this.branch) throw new RepositoryWritePolicyError();
    return { branch: this.branch, baseSha: this.context.baseSha };
  }

  /** Applies a fully preconditioned text proposal without exposing arbitrary filesystem argv. */
  async applyPatchProposal(rawProposal: PatchProposalV1): Promise<void> {
    this.assertCredentialActive();
    const parsed = PatchProposalV1Schema.safeParse(rawProposal);
    if (!parsed.success) throw new RepositoryWritePolicyError();
    await this.assertCurrentBranch();
    if (await this.requiredScalar(['rev-parse', '--verify', 'HEAD']) !== this.context.baseSha) {
      throw new RepositoryWritePolicyError();
    }
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all']);
    if (status.exitCode !== 0 || status.stdout !== '') throw new RepositoryWritePolicyError();

    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(this.context.repositoryPath);
    } catch {
      throw new RepositoryWritePolicyError();
    }
    const prepared: PreparedPatchChange[] = [];
    for (const change of parsed.data.changes) {
      if (isProtectedRepositoryPath(change.path, this.context.deliveryPolicy.policy.protectedPaths)) {
        throw new RepositoryWritePolicyError();
      }
      const absolutePath = resolve(repositoryRoot, change.path);
      if (!this.isInside(repositoryRoot, absolutePath)) throw new RepositoryWritePolicyError();
      await this.assertNoSymlinkComponents(
        repositoryRoot,
        change.path,
        change.baseDigest !== null,
      );
      if (change.baseDigest === null) {
        try {
          await lstat(absolutePath);
          throw new RepositoryWritePolicyError();
        } catch (error) {
          if (error instanceof RepositoryWritePolicyError) throw error;
          if (!pathIsMissing(error)) throw new RepositoryWritePolicyError();
        }
        let parentMetadata;
        let parentPath: string;
        try {
          [parentMetadata, parentPath] = await Promise.all([
            lstat(dirname(absolutePath)),
            realpath(dirname(absolutePath)),
          ]);
        } catch {
          throw new RepositoryWritePolicyError();
        }
        if (
          !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() ||
          !this.isInside(repositoryRoot, parentPath)
        ) throw new RepositoryWritePolicyError();
        prepared.push({ absolutePath, content: change.content, create: true });
        continue;
      }
      let metadata;
      let canonicalPath: string;
      let current: string;
      try {
        [metadata, canonicalPath, current] = await Promise.all([
          lstat(absolutePath),
          realpath(absolutePath),
          readFile(absolutePath, 'utf8'),
        ]);
      } catch {
        throw new RepositoryWritePolicyError();
      }
      if (
        !metadata.isFile() || metadata.isSymbolicLink() ||
        !this.isInside(repositoryRoot, canonicalPath) ||
        !patchContentIsUtf8(current) ||
        await patchContentDigest(current) !== change.baseDigest ||
        await patchContentDigest(change.content) === change.baseDigest
      ) throw new RepositoryWritePolicyError();
      prepared.push({ absolutePath, content: change.content, create: false });
    }

    for (const change of prepared) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(
          change.absolutePath,
          change.create
            ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
            : constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o644,
        );
        await handle.writeFile(change.content, 'utf8');
      } catch {
        throw new RepositoryWritePolicyError();
      } finally {
        await handle?.close();
      }
    }
    for (const change of prepared) {
      let content: string;
      try {
        content = await readFile(change.absolutePath, 'utf8');
      } catch {
        throw new RepositoryWritePolicyError();
      }
      if (await patchContentDigest(content) !== await patchContentDigest(change.content)) {
        throw new RepositoryWritePolicyError();
      }
    }
    if (
      await this.currentBranch() !== this.branch ||
      await this.requiredScalar(['rev-parse', '--verify', 'HEAD']) !== this.context.baseSha
    ) throw new RepositoryWritePolicyError();
    const changed = await this.git(['status', '--porcelain=v1', '--untracked-files=all']);
    if (changed.exitCode !== 0 || changed.stdout === '') throw new RepositoryWritePolicyError();
  }

  async commitAll(): Promise<RepositoryCommit> {
    this.assertCredentialActive();
    await this.assertCurrentBranch();
    if (await this.requiredScalar(['rev-parse', '--verify', 'HEAD']) !== this.context.baseSha) {
      throw new RepositoryWritePolicyError();
    }
    await this.required(['add', '--all', '--']);
    const staged = await this.git(['diff', '--cached', '--quiet', '--exit-code']);
    if (staged.exitCode === 0 || staged.exitCode > 1) {
      throw new RepositoryWritePolicyError();
    }
    const protectedPathReport = await this.protectedPathReport();
    if (protectedPathReport !== null) {
      try {
        await this.context.onProtectedPathApprovalRequired(protectedPathReport);
      } catch {
        throw new RepositoryWritePolicyError();
      }
      throw new ProtectedPathApprovalRequired(protectedPathReport);
    }
    const message = `delivery-loop(${this.context.taskId}): ${this.context.attemptId}`;
    const identityEnvironment = {
      GIT_AUTHOR_NAME: BOT_COMMIT_NAME,
      GIT_AUTHOR_EMAIL: BOT_COMMIT_EMAIL,
      GIT_COMMITTER_NAME: BOT_COMMIT_NAME,
      GIT_COMMITTER_EMAIL: BOT_COMMIT_EMAIL,
    } as const;
    await this.required([
      '-c',
      `user.name=${BOT_COMMIT_NAME}`,
      '-c',
      `user.email=${BOT_COMMIT_EMAIL}`,
      '-c',
      'user.useConfigOnly=true',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '--no-verify',
      `--author=${BOT_COMMIT_NAME} <${BOT_COMMIT_EMAIL}>`,
      '-m',
      message,
      '--',
    ], identityEnvironment);
    const fields = (await this.requiredScalar([
      'show',
      '-s',
      '--format=%H%x00%an%x00%ae%x00%cn%x00%ce',
      'HEAD',
    ])).split('\0');
    if (
      fields.length !== 5 ||
      !SHA_PATTERN.test(fields[0] ?? '') ||
      fields[1] !== BOT_COMMIT_NAME ||
      fields[2] !== BOT_COMMIT_EMAIL ||
      fields[3] !== BOT_COMMIT_NAME ||
      fields[4] !== BOT_COMMIT_EMAIL
    ) {
      throw new RepositoryWritePolicyError();
    }
    if (await this.requiredScalar(['rev-parse', '--verify', 'HEAD^']) !== this.context.baseSha) {
      throw new RepositoryWritePolicyError();
    }
    return {
      branch: this.branch,
      commitSha: fields[0]!,
      authorName: BOT_COMMIT_NAME,
      authorEmail: BOT_COMMIT_EMAIL,
    };
  }

  async push(rawInput: unknown): Promise<PushedRepositoryBranch> {
    this.assertCredentialActive();
    const input = pushInput(rawInput);
    if (
      input.force ||
      input.targetBranch !== this.branch ||
      this.protectedBranches.has(input.targetBranch)
    ) {
      throw new RepositoryWritePolicyError();
    }
    await this.assertCurrentBranch();
    const commitSha = await this.requiredScalar(['rev-parse', '--verify', 'HEAD']);
    if (!SHA_PATTERN.test(commitSha)) throw new RepositoryWritePolicyError();
    await this.required([
      'push',
      '--porcelain',
      'origin',
      `refs/heads/${this.branch}:refs/heads/${input.targetBranch}`,
    ], this.credentialGitEnvironment());
    return { branch: input.targetBranch, commitSha };
  }

  private async assertCurrentBranch(): Promise<void> {
    if (await this.currentBranch() !== this.branch) throw new RepositoryWritePolicyError();
  }

  private isInside(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  }

  private async assertNoSymlinkComponents(
    repositoryRoot: string,
    path: string,
    includeLeaf: boolean,
  ): Promise<void> {
    const segments = path.split('/');
    const count = includeLeaf ? segments.length : segments.length - 1;
    let current = repositoryRoot;
    for (let index = 0; index < count; index += 1) {
      current = resolve(current, segments[index]!);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch {
        throw new RepositoryWritePolicyError();
      }
      if (
        metadata.isSymbolicLink() ||
        (index < count - 1 && !metadata.isDirectory())
      ) throw new RepositoryWritePolicyError();
    }
  }

  private async protectedPathReport(): Promise<ProtectedPathChangeReportV1 | null> {
    if (await canonicalSha256(this.context.deliveryPolicy.policy) !== this.context.deliveryPolicy.digest) {
      throw new RepositoryWritePolicyError();
    }
    const changes = this.parseNameStatus((await this.required([
      'diff',
      '--cached',
      '--name-status',
      '-z',
      '--find-renames=50%',
      '--',
    ])).stdout);
    const stats = this.parseNumstat((await this.required([
      'diff',
      '--cached',
      '--numstat',
      '-z',
      '--no-renames',
      '--',
    ])).stdout);
    const protectedChanges = changes
      .filter((change) =>
        isProtectedRepositoryPath(
          change.path,
          this.context.deliveryPolicy.policy.protectedPaths,
        ) || (
          change.previousPath !== undefined &&
          isProtectedRepositoryPath(
            change.previousPath,
            this.context.deliveryPolicy.policy.protectedPaths,
          )
        ),
      )
      .map((change): ProtectedPathChangeV1 => {
        const current = stats.get(change.path);
        const previous = change.previousPath === undefined
          ? undefined
          : stats.get(change.previousPath);
        return {
          path: change.path,
          ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
          changeType: change.changeType,
          additions: current?.additions ?? null,
          deletions: change.previousPath === undefined
            ? (current?.deletions ?? null)
            : (previous?.deletions ?? null),
        };
      })
      .sort((left, right) =>
        left.path.localeCompare(right.path) ||
        (left.previousPath ?? '').localeCompare(right.previousPath ?? ''),
      );
    if (protectedChanges.length === 0) return null;
    const stagedTreeSha = await this.requiredScalar(['write-tree']);
    const report = {
      schemaVersion: '1' as const,
      baseSha: this.context.baseSha,
      stagedTreeSha,
      policyDigest: this.context.deliveryPolicy.digest,
      diffDigest: await computeProtectedPathDiffDigest(this.context.baseSha, stagedTreeSha),
      totalChangedFiles: changes.length,
      protectedChanges,
    };
    const parsed = ProtectedPathChangeReportV1Schema.safeParse(report);
    if (!parsed.success) throw new RepositoryWritePolicyError();
    return parsed.data;
  }

  private parseNameStatus(output: string): StagedChange[] {
    const fields = output.split('\0');
    if (fields.at(-1) !== '') throw new RepositoryWritePolicyError();
    fields.pop();
    const changes: StagedChange[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      if (status === undefined || !/^(?:[AMDTU]|R\d{1,3}|C\d{1,3})$/.test(status)) {
        throw new RepositoryWritePolicyError();
      }
      const code = status[0]!;
      const previousPath = code === 'R' || code === 'C' ? fields[index++] : undefined;
      const path = fields[index++];
      if (
        path === undefined ||
        !this.safeRepositoryPath(path) ||
        (previousPath !== undefined && !this.safeRepositoryPath(previousPath))
      ) {
        throw new RepositoryWritePolicyError();
      }
      const changeType: ProtectedPathChangeType = code === 'A'
        ? 'added'
        : code === 'M'
          ? 'modified'
          : code === 'D'
            ? 'deleted'
            : code === 'R'
              ? 'renamed'
              : code === 'C'
                ? 'copied'
                : code === 'T'
                  ? 'type_changed'
                  : 'unmerged';
      changes.push({ path, ...(previousPath === undefined ? {} : { previousPath }), changeType });
    }
    return changes;
  }

  private parseNumstat(output: string): Map<string, LineStats> {
    const records = output.split('\0');
    if (records.at(-1) !== '') throw new RepositoryWritePolicyError();
    records.pop();
    const stats = new Map<string, LineStats>();
    for (const record of records) {
      const firstTab = record.indexOf('\t');
      const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
      if (firstTab < 1 || secondTab < firstTab + 2) throw new RepositoryWritePolicyError();
      const additions = record.slice(0, firstTab);
      const deletions = record.slice(firstTab + 1, secondTab);
      const path = record.slice(secondTab + 1);
      if (!this.safeRepositoryPath(path)) throw new RepositoryWritePolicyError();
      const parseCount = (value: string): number | null => {
        if (value === '-') return null;
        if (!/^\d+$/.test(value)) throw new RepositoryWritePolicyError();
        const count = Number(value);
        if (!Number.isSafeInteger(count) || count < 0) throw new RepositoryWritePolicyError();
        return count;
      };
      stats.set(path, { additions: parseCount(additions), deletions: parseCount(deletions) });
    }
    return stats;
  }

  private safeRepositoryPath(path: string): boolean {
    return (
      path.length > 0 &&
      path.length <= 500 &&
      !path.startsWith('/') &&
      !path.includes('\\') &&
      ![...path].some((character) => character.charCodeAt(0) < 32) &&
      !path.split('/').includes('..')
    );
  }

  private assertCredentialActive(): void {
    if (Date.parse(this.context.credential.expiresAt) <= Date.now()) {
      throw new RepositoryWritePolicyError();
    }
  }

  private credentialGitEnvironment(): Readonly<Record<string, string>> {
    const authorization = Buffer.from(
      `x-access-token:${this.context.credential.token}`,
      'utf8',
    ).toString('base64');
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    };
  }

  private async currentBranch(): Promise<string> {
    return await this.requiredScalar(['branch', '--show-current']);
  }

  private async git(
    args: string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<GitCommandResult> {
    try {
      return await this.executor({
        repositoryPath: this.context.repositoryPath,
        args,
        ...(environment === undefined ? {} : { environment }),
      });
    } catch {
      throw new RepositoryWritePolicyError();
    }
  }

  private async required(
    args: string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<GitCommandResult> {
    const result = await this.git(args, environment);
    if (result.exitCode !== 0) throw new RepositoryWritePolicyError();
    return result;
  }

  private async requiredScalar(args: string[]): Promise<string> {
    const result = await this.required(args);
    const value = result.stdout.trim();
    if (value.length === 0 || value.length > 1_000 || /[\r\n]/.test(value)) {
      throw new RepositoryWritePolicyError();
    }
    return value;
  }
}
