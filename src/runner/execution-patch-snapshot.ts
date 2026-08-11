import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  MAX_PATCH_CHANGES,
  MAX_PATCH_FILE_BYTES,
  MAX_PATCH_TOTAL_BYTES,
  patchContentDigest,
  patchPathIsSafe,
} from '../domain/patch-proposal.js';
import { isProtectedRepositoryPath } from '../domain/protected-path-change.js';
import { explicitlyReferencesRepositoryPath } from '../domain/plan.js';
import { SecretScanner } from '../security/redaction.js';
import { executeGitCommand } from './git-repository-writer.js';

export interface ExecutionPatchSnapshotV1 {
  schemaVersion: '1';
  files: Array<{ path: string; baseDigest: string; content: string }>;
}

export type ExecutionPatchSnapshotErrorKind =
  | 'no_candidates'
  | 'ambiguous_candidates'
  | 'fallback_too_large'
  | 'unsafe_candidate'
  | 'runtime_secret_detected'
  | 'unavailable';

export class ExecutionPatchSnapshotError extends Error {
  constructor(readonly kind: ExecutionPatchSnapshotErrorKind) {
    super('execution patch snapshot is unavailable');
    this.name = 'ExecutionPatchSnapshotError';
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Materializes only tracked files explicitly named by the approved Item/task text.
 * The snapshot is model context, never write authority; the writer rechecks every digest.
 */
export async function buildExecutionPatchSnapshot(input: {
  repositoryPath: string;
  referencedText: readonly string[];
  protectedPaths: readonly string[];
  runtimeSecrets: readonly string[];
}): Promise<ExecutionPatchSnapshotV1> {
  let root: string;
  try {
    root = await realpath(input.repositoryPath);
  } catch {
    throw new ExecutionPatchSnapshotError('unavailable');
  }
  const listed = await executeGitCommand({ repositoryPath: root, args: ['ls-files'] });
  if (listed.exitCode !== 0 || listed.stderr !== '') {
    throw new ExecutionPatchSnapshotError('unavailable');
  }
  const paths = listed.stdout.split('\n').filter((path) =>
    path !== '' && patchPathIsSafe(path) &&
    input.referencedText.some((text) => explicitlyReferencesRepositoryPath(text, [path])) &&
    !isProtectedRepositoryPath(path, input.protectedPaths),
  ).sort();
  if (paths.length < 1) throw new ExecutionPatchSnapshotError('no_candidates');
  if (paths.length > MAX_PATCH_CHANGES) {
    throw new ExecutionPatchSnapshotError('ambiguous_candidates');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: ExecutionPatchSnapshotV1['files'] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const absolutePath = resolve(root, path);
    let metadata;
    let canonicalPath: string;
    let bytes: Uint8Array;
    try {
      [metadata, canonicalPath, bytes] = await Promise.all([
        lstat(absolutePath),
        realpath(absolutePath),
        readFile(absolutePath),
      ]);
    } catch {
      throw new ExecutionPatchSnapshotError('unsafe_candidate');
    }
    if (
      !metadata.isFile() || metadata.isSymbolicLink() ||
      !isInside(root, canonicalPath)
    ) throw new ExecutionPatchSnapshotError('unsafe_candidate');
    totalBytes += bytes.byteLength;
    if (
      bytes.byteLength > MAX_PATCH_FILE_BYTES ||
      totalBytes > MAX_PATCH_TOTAL_BYTES
    ) {
      throw new ExecutionPatchSnapshotError('fallback_too_large');
    }
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      throw new ExecutionPatchSnapshotError('unsafe_candidate');
    }
    if (new TextEncoder().encode(content).byteLength !== bytes.byteLength) {
      throw new ExecutionPatchSnapshotError('unsafe_candidate');
    }
    const file = { path, baseDigest: await patchContentDigest(content), content };
    const secretFindings = new SecretScanner({ secrets: input.runtimeSecrets }).scan(file);
    if (secretFindings.some((finding) => finding.kind === 'registered_secret')) {
      throw new ExecutionPatchSnapshotError('runtime_secret_detected');
    }
    if (secretFindings.length > 0) {
      throw new ExecutionPatchSnapshotError('unsafe_candidate');
    }
    files.push(file);
  }
  return { schemaVersion: '1', files };
}

/**
 * The full-content patch snapshot is an optional second-invocation recovery aid.
 * A valid Plan may target a file that is too large for that bounded fallback;
 * the primary workspace Agent must still be allowed to make the approved edit.
 */
export async function buildOptionalExecutionPatchSnapshot(
  input: Parameters<typeof buildExecutionPatchSnapshot>[0],
): Promise<ExecutionPatchSnapshotV1 | undefined> {
  try {
    return await buildExecutionPatchSnapshot(input);
  } catch (error) {
    if (
      error instanceof ExecutionPatchSnapshotError &&
      error.kind !== 'runtime_secret_detected'
    ) return undefined;
    throw error;
  }
}
