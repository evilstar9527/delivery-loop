import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildExecutionPatchSnapshot,
  buildOptionalExecutionPatchSnapshot,
  ExecutionPatchSnapshotError,
} from '../src/runner/execution-patch-snapshot.js';
import { patchContentDigest } from '../src/domain/patch-proposal.js';

const exec = promisify(execFile);

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-patch-snapshot-'));
  await exec('git', ['init', '-q'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await exec('git', ['add', '.'], { cwd: root });
  return root;
}

describe('execution patch snapshot', () => {
  it('binds one explicitly referenced tracked UTF-8 file', async () => {
    const root = await repository({ 'docs/Vision.md': 'current vision\n', 'README.md': 'other\n' });
    await expect(buildExecutionPatchSnapshot({
      repositoryPath: root,
      referencedText: ['Update docs/Vision.md only.'],
      protectedPaths: [],
      runtimeSecrets: [],
    })).resolves.toEqual({
      schemaVersion: '1',
      files: [{
        path: 'docs/Vision.md',
        baseDigest: await patchContentDigest('current vision\n'),
        content: 'current vision\n',
      }],
    });
  });

  it('rejects missing, protected, and credential-shaped candidates', async () => {
    const cases = [
      { files: { 'README.md': 'other\n' }, text: 'docs/Vision.md', protected: [] },
      { files: { 'docs/Vision.md': 'vision\n' }, text: 'docs/Vision.md', protected: ['docs/**'] },
      { files: { 'docs/Vision.md': 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n' }, text: 'docs/Vision.md', protected: [] },
    ];
    for (const scenario of cases) {
      const root = await repository(scenario.files);
      await expect(buildExecutionPatchSnapshot({
        repositoryPath: root,
        referencedText: [scenario.text],
        protectedPaths: scenario.protected,
        runtimeSecrets: [],
      })).rejects.toBeInstanceOf(ExecutionPatchSnapshotError);
    }
  });

  it('keeps the optional fallback for the real two-file snapshot within 128/256 KiB', async () => {
    const files = {
      'src/storage/task-query-store.ts': 'a'.repeat(72_529),
      'test/workflow/task-query-api.test.ts': 'b'.repeat(15_271),
    };
    const root = await repository(files);
    const snapshot = await buildOptionalExecutionPatchSnapshot({
      repositoryPath: root,
      referencedText: Object.keys(files).map((path) => `Update ${path}.`),
      protectedPaths: [],
      runtimeSecrets: [],
    });
    expect(snapshot?.files.map(({ path, content }) => [path, content.length])).toEqual([
      ['src/storage/task-query-store.ts', 72_529],
      ['test/workflow/task-query-api.test.ts', 15_271],
    ]);
  });

  it('disables only the optional fallback when one file or the aggregate exceeds 128/256 KiB', async () => {
    for (const files of [
      { 'src/large.ts': 'x'.repeat(128 * 1024 + 1) },
      { 'src/a.ts': 'a'.repeat(128 * 1024), 'src/b.ts': 'b'.repeat(128 * 1024), 'src/c.ts': 'c' },
    ]) {
      const root = await repository(files);
      const referencedText = Object.keys(files).map((path) => `Update ${path}.`);
      const input = {
        repositoryPath: root,
        referencedText,
        protectedPaths: [],
        runtimeSecrets: [],
      };
      await expect(buildExecutionPatchSnapshot(input)).rejects.toMatchObject({
        name: 'ExecutionPatchSnapshotError',
        kind: 'fallback_too_large',
      });
      await expect(buildOptionalExecutionPatchSnapshot(input)).resolves.toBeUndefined();
    }
  });

  it('disables the optional fallback for credential-shaped repository content', async () => {
    const root = await repository({
      'src/unsafe.ts': 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n',
    });
    const input = {
      repositoryPath: root,
      referencedText: ['Update src/unsafe.ts.'],
      protectedPaths: [],
      runtimeSecrets: [],
    };
    await expect(buildExecutionPatchSnapshot(input)).rejects.toMatchObject({
      name: 'ExecutionPatchSnapshotError',
      kind: 'unsafe_candidate',
    });
    await expect(buildOptionalExecutionPatchSnapshot(input)).resolves.toBeUndefined();
  });

  it('does not downgrade a registered runtime Secret to an optional fallback miss', async () => {
    const runtimeSecret = 'runtime-secret-canary-123456789';
    const root = await repository({
      'src/leaked.ts': `export const leaked = '${runtimeSecret}';\n`,
    });
    const input = {
      repositoryPath: root,
      referencedText: ['Update src/leaked.ts.'],
      protectedPaths: [],
      runtimeSecrets: [runtimeSecret],
    };
    await expect(buildExecutionPatchSnapshot(input)).rejects.toMatchObject({
      name: 'ExecutionPatchSnapshotError',
      kind: 'runtime_secret_detected',
    });
    await expect(buildOptionalExecutionPatchSnapshot(input)).rejects.toMatchObject({
      name: 'ExecutionPatchSnapshotError',
      kind: 'runtime_secret_detected',
    });
  });

  it('classifies a missing explicit path separately from unsafe snapshot candidates', async () => {
    const root = await repository({ 'src/worker.ts': 'export const ready = true;\n' });
    for (const referencedText of [
      ['Fix the stuck event identity without widening the change.'],
      ['Only update src/worker.ts.generated.'],
    ]) {
      await expect(buildExecutionPatchSnapshot({
        repositoryPath: root,
        referencedText,
        protectedPaths: [],
        runtimeSecrets: [],
      })).rejects.toMatchObject({
        name: 'ExecutionPatchSnapshotError',
        kind: 'no_candidates',
      });
    }
  });
});
