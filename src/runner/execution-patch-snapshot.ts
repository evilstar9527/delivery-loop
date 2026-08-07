import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  MAX_PATCH_CHANGES,
  MAX_PATCH_TOTAL_BYTES,
  patchContentDigest,
  patchPathIsSafe,
} from '../domain/patch-proposal.js';
import { isProtectedRepositoryPath } from '../domain/protected-path-change.js';
import { SecretScanner } from '../security/redaction.js';
import { executeGitCommand } from './git-repository-writer.js';

export interface ExecutionPatchSnapshotV1 {
  schemaVersion: '1';
  files: Array<{ path: string; baseDigest: string; content: string }>;
}

export type ExecutionPatchSnapshotErrorKind =
  | 'no_candidates'
  | 'ambiguous_candidates'
  | 'unsafe_candidate'
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
  const references = input.referencedText.join('\n');
  const paths = listed.stdout.split('\n').filter((path) =>
    path !== '' && patchPathIsSafe(path) && references.includes(path) &&
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
    if (totalBytes > MAX_PATCH_TOTAL_BYTES) {
      throw new ExecutionPatchSnapshotError('unsafe_candidate');
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
    if (new SecretScanner({ secrets: input.runtimeSecrets }).scan(file).length > 0) {
      throw new ExecutionPatchSnapshotError('unsafe_candidate');
    }
    files.push(file);
  }
  return { schemaVersion: '1', files };
}
