import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  listAnalysisWritableRepositoryPaths,
} from '../src/runner/analysis-repository-paths.js';

const exec = promisify(execFile);

describe('analysis writable repository path inventory', () => {
  it('returns only exact-base tracked regular paths allowed by delivery policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-analysis-paths-'));
    await Promise.all([
      mkdir(join(root, 'src'), { recursive: true }),
      mkdir(join(root, 'docs/private'), { recursive: true }),
      mkdir(join(root, '.github/workflows'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'src/request.ts'), 'export const request = true;\n'),
      writeFile(join(root, 'docs/private/internal.md'), 'private\n'),
      writeFile(join(root, '.github/workflows/ci.yml'), 'name: ci\n'),
      writeFile(
        join(root, 'delivery.yaml'),
        [
          "schemaVersion: '1'",
          'commands:',
          '  setup:',
          '    install:',
          '      argv: [pnpm, install]',
          '      timeoutSeconds: 60',
          '  targeted:',
          '    unit:',
          '      argv: [pnpm, test]',
          '      timeoutSeconds: 60',
          '  verify:',
          '    all:',
          '      argv: [pnpm, test]',
          '      timeoutSeconds: 60',
          'protectedPaths:',
          '  - delivery.yaml',
          '  - .github/workflows/**',
          '  - CODEOWNERS',
          '  - docs/private/**',
          'deployment:',
          '  mode: none',
          '',
        ].join('\n'),
      ),
      symlink('request.ts', join(root, 'src/request-link.ts')),
    ]);
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'],
      { cwd: root },
    );
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
    await writeFile(join(root, 'src/untracked.ts'), 'export const untracked = true;\n');

    await expect(
      listAnalysisWritableRepositoryPaths(root, stdout.trim()),
    ).resolves.toEqual(['src/request.ts']);

    await exec('git', ['add', 'src/untracked.ts'], { cwd: root });
    await expect(
      listAnalysisWritableRepositoryPaths(root, stdout.trim()),
    ).rejects.toMatchObject({ name: 'AnalysisRepositoryPathsError' });
  });
});
