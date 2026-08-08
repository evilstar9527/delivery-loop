import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildExecutionPatchSnapshot,
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

  it('rejects missing, protected, oversized, and credential-shaped candidates', async () => {
    const cases = [
      { files: { 'README.md': 'other\n' }, text: 'docs/Vision.md', protected: [] },
      { files: { 'docs/Vision.md': 'vision\n' }, text: 'docs/Vision.md', protected: ['docs/**'] },
      { files: { 'docs/Vision.md': 'x'.repeat(12 * 1024 + 1) }, text: 'docs/Vision.md', protected: [] },
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
