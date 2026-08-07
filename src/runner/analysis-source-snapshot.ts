import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { z } from 'zod';
import type { DiagnosticRootCauseV1Schema } from '../domain/diagnostic-evidence.js';
import { patchPathIsSafe } from '../domain/patch-proposal.js';
import { SecretScanner } from '../security/redaction.js';
import { executeGitCommand } from './git-repository-writer.js';

const MAX_TRACKED_FILES = 2_000;
const MAX_SOURCE_FILE_BYTES = 256 * 1_024;
const MAX_SCANNED_BYTES = 16 * 1_024 * 1_024;
const MAX_CONTEXT_NODES = 10_000;
const MAX_CONTEXT_DEPTH = 20;
const MAX_CANDIDATES = 100;
const MAX_MATCHES = 8;
const MAX_INTERNAL_MATCHES = 1_000;
const MAX_EXCERPT_BYTES = 1_000;
const MAX_SNAPSHOT_BYTES = 12 * 1_024;
const SOURCE_PATH_PATTERN = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|php|py|rb|rs|swift|ts|tsx)$/i;
const CANDIDATE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]{3,159}$/;

export interface AnalysisSourceSnapshotV1 {
  schemaVersion: '1';
  matches: Array<{ path: string; line: number; excerpt: string }>;
}

export class AnalysisSourceSnapshotError extends Error {
  constructor() {
    super('analysis source snapshot is unavailable');
    this.name = 'AnalysisSourceSnapshotError';
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function diagnosticCandidates(value: unknown): string[] {
  const values = new Set<string>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_CONTEXT_NODES || depth > MAX_CONTEXT_DEPTH) {
      throw new AnalysisSourceSnapshotError();
    }
    if (typeof candidate === 'string') {
      if (CANDIDATE_PATTERN.test(candidate)) values.add(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (typeof candidate === 'object' && candidate !== null) {
      for (const item of Object.values(candidate)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return [...values]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}

function sourcePathRank(path: string): number {
  if (path.startsWith('src/')) return 0;
  if (/^(?:app|apps|package|packages)\//.test(path)) return 1;
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|\.)/.test(path)) return 3;
  return 2;
}

/**
 * Finds exact tracked source lines containing bounded values from an already
 * scanned diagnostic result. The snapshot is model context, never authority.
 */
export async function buildAnalysisSourceSnapshot(input: {
  repositoryPath: string;
  diagnosticContext: unknown;
  runtimeSecrets: readonly string[];
}): Promise<AnalysisSourceSnapshotV1> {
  let root: string;
  try {
    root = await realpath(input.repositoryPath);
  } catch {
    throw new AnalysisSourceSnapshotError();
  }
  const candidates = diagnosticCandidates(input.diagnosticContext);
  if (candidates.length === 0) throw new AnalysisSourceSnapshotError();
  let listed;
  try {
    listed = await executeGitCommand({ repositoryPath: root, args: ['ls-files', '-z'] });
  } catch {
    throw new AnalysisSourceSnapshotError();
  }
  if (listed.exitCode !== 0 || listed.stderr !== '') throw new AnalysisSourceSnapshotError();
  const paths = listed.stdout.endsWith('\0')
    ? listed.stdout.slice(0, -1).split('\0')
    : listed.stdout === '' ? [] : listed.stdout.split('\0');
  if (paths.length < 1 || paths.length > MAX_TRACKED_FILES) {
    throw new AnalysisSourceSnapshotError();
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const matches = new Map<string, {
    path: string;
    line: number;
    excerpt: string;
    score: number;
  }>();
  let scannedBytes = 0;
  for (const path of paths) {
    if (!patchPathIsSafe(path)) throw new AnalysisSourceSnapshotError();
    const absolutePath = resolve(root, path);
    let metadata;
    let canonicalPath: string;
    try {
      [metadata, canonicalPath] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
    } catch {
      throw new AnalysisSourceSnapshotError();
    }
    if (metadata.isSymbolicLink() || !isInside(root, canonicalPath)) {
      throw new AnalysisSourceSnapshotError();
    }
    if (!metadata.isFile() || !SOURCE_PATH_PATTERN.test(path)) continue;
    if (metadata.size > MAX_SOURCE_FILE_BYTES) continue;
    scannedBytes += metadata.size;
    if (scannedBytes > MAX_SCANNED_BYTES) throw new AnalysisSourceSnapshotError();
    let content: string;
    try {
      content = decoder.decode(await readFile(absolutePath));
    } catch {
      throw new AnalysisSourceSnapshotError();
    }
    for (const [index, line] of content.split('\n').entries()) {
      const excerpt = line.trim();
      if (excerpt === '' || new TextEncoder().encode(excerpt).byteLength > MAX_EXCERPT_BYTES) {
        continue;
      }
      const matched = candidates.find((candidate) => line.includes(candidate));
      if (matched === undefined) continue;
      const key = `${path}\0${index + 1}`;
      const current = matches.get(key);
      if (current === undefined || matched.length > current.score) {
        matches.set(key, { path, line: index + 1, excerpt, score: matched.length });
        if (matches.size > MAX_INTERNAL_MATCHES) throw new AnalysisSourceSnapshotError();
      }
    }
  }

  const ordered = [...matches.values()].sort((left, right) =>
    right.score - left.score ||
    sourcePathRank(left.path) - sourcePathRank(right.path) ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line));
  const selected: AnalysisSourceSnapshotV1['matches'] = [];
  for (const { path, line, excerpt } of ordered) {
    const candidate = { path, line, excerpt };
    const next = { schemaVersion: '1' as const, matches: [...selected, candidate] };
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_SNAPSHOT_BYTES) break;
    selected.push(candidate);
    if (selected.length === MAX_MATCHES) break;
  }
  const snapshot = { schemaVersion: '1' as const, matches: selected };
  if (
    selected.length === 0 ||
    new SecretScanner({ secrets: [...input.runtimeSecrets] }).scan(snapshot).length > 0
  ) throw new AnalysisSourceSnapshotError();
  return snapshot;
}

export function analysisSourceSnapshotSupportsRootCause(
  snapshot: AnalysisSourceSnapshotV1,
  rootCause: z.infer<typeof DiagnosticRootCauseV1Schema>,
): boolean {
  return rootCause.codeRefs.length > 0 && rootCause.codeRefs.every((ref) => snapshot.matches.some((match) =>
    match.path === ref.path &&
    (ref.line === undefined || match.line === ref.line) &&
    (ref.symbol === undefined || match.excerpt.includes(ref.symbol))));
}
