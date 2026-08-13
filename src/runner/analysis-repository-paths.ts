import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { patchPathIsSafe } from '../domain/patch-proposal.js';
import { isProtectedRepositoryPath } from '../domain/protected-path-change.js';
import {
  ANALYSIS_REPOSITORY_MAX_TRACKED_PATH_BYTES,
  ANALYSIS_REPOSITORY_MAX_TRACKED_PATHS,
} from '../domain/analysis-repository-inventory.js';
import { SecretScanner } from '../security/redaction.js';
import { loadDeliveryPolicyAtCommit } from './delivery-policy-loader.js';
import { executeGitCommand } from './git-repository-writer.js';

const BASE_SHA_PATTERN = /^[a-f0-9]{40}$/;
export class AnalysisRepositoryPathsError extends Error {
  constructor() {
    super('analysis repository path inventory is unavailable');
    this.name = 'AnalysisRepositoryPathsError';
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Returns only regular, non-symlink tracked paths writable under the exact
 * base commit's delivery policy. The inventory stays inside the trusted
 * Runner and is never added to the model prompt or persisted.
 */
export async function listAnalysisWritableRepositoryPaths(
  repositoryPath: string,
  baseSha: string,
): Promise<readonly string[]> {
  try {
    if (!isAbsolute(repositoryPath) || !BASE_SHA_PATTERN.test(baseSha)) {
      throw new AnalysisRepositoryPathsError();
    }
    const root = await realpath(repositoryPath);
    const [head, indexState, listed, deliveryPolicy] = await Promise.all([
      executeGitCommand({ repositoryPath: root, args: ['rev-parse', 'HEAD'] }),
      executeGitCommand({
        repositoryPath: root,
        args: ['diff-index', '--quiet', baseSha, '--'],
      }),
      executeGitCommand({
        repositoryPath: root,
        args: ['ls-files', '-z'],
        maxOutputBytes: ANALYSIS_REPOSITORY_MAX_TRACKED_PATH_BYTES,
      }),
      loadDeliveryPolicyAtCommit(root, baseSha),
    ]);
    if (
      head.exitCode !== 0 || head.stderr !== '' || head.stdout.trim() !== baseSha ||
      indexState.exitCode !== 0 || indexState.stdout !== '' || indexState.stderr !== '' ||
      listed.exitCode !== 0 || listed.stderr !== '' ||
      new TextEncoder().encode(listed.stdout).byteLength >
        ANALYSIS_REPOSITORY_MAX_TRACKED_PATH_BYTES
    ) throw new AnalysisRepositoryPathsError();
    const tracked = listed.stdout.endsWith('\0')
      ? listed.stdout.slice(0, -1).split('\0')
      : listed.stdout === '' ? [] : listed.stdout.split('\0');
    if (tracked.length < 1 || tracked.length > ANALYSIS_REPOSITORY_MAX_TRACKED_PATHS) {
      throw new AnalysisRepositoryPathsError();
    }

    const writable: string[] = [];
    const secretScanner = new SecretScanner();
    for (const path of [...new Set(tracked)].sort()) {
      if (
        !patchPathIsSafe(path) ||
        isProtectedRepositoryPath(path, deliveryPolicy.policy.protectedPaths) ||
        secretScanner.scan(path).length > 0
      ) continue;
      const absolutePath = resolve(root, path);
      let metadata;
      let canonicalPath: string;
      try {
        [metadata, canonicalPath] = await Promise.all([
          lstat(absolutePath),
          realpath(absolutePath),
        ]);
      } catch {
        continue;
      }
      if (
        metadata.isFile() && !metadata.isSymbolicLink() && isInside(root, canonicalPath)
      ) writable.push(path);
    }
    if (writable.length < 1) throw new AnalysisRepositoryPathsError();
    return writable;
  } catch (error) {
    if (error instanceof AnalysisRepositoryPathsError) throw error;
    throw new AnalysisRepositoryPathsError();
  }
}
