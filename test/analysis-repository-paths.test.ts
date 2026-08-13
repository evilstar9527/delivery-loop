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

  it('accepts the production-shaped 2,132-file repository above the former 64 KiB ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-analysis-capacity-'));
    await mkdir(join(root, 'src/generated'), { recursive: true });
    const paths = Array.from(
      { length: 2_131 },
      (_, index) => `src/generated/${String(index).padStart(4, '0')}_repository_capacity_fixture.ts`,
    );
    await Promise.all([
      ...paths.map(async (path) => await writeFile(join(root, path), '')),
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
          'deployment:',
          '  mode: none',
          '',
        ].join('\n'),
      ),
    ]);
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'],
      { cwd: root },
    );
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
    const { stdout: listed } = await exec('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 512 * 1_024,
    });
    expect(Buffer.byteLength(listed)).toBeGreaterThan(64 * 1_024);

    const writable = await listAnalysisWritableRepositoryPaths(root, stdout.trim());
    expect(writable).toHaveLength(2_131);
    expect(writable[0]).toBe(paths[0]);
    expect(writable.at(-1)).toBe(paths.at(-1));
  });

  it.each([
    { count: 5_001, longNames: false, label: 'more than 5,000 tracked paths' },
    { count: 4_000, longNames: true, label: 'more than 256 KiB of path names' },
  ])('rejects $label', async ({ count, longNames }) => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-loop-analysis-limit-'));
    await mkdir(join(root, 'src/generated'), { recursive: true });
    const paths = Array.from({ length: count }, (_, index) =>
      longNames
        ? `src/generated/${String(index).padStart(4, '0')}_${'long_repository_path_'.repeat(3)}.ts`
        : `src/generated/f${String(index).padStart(4, '0')}.ts`);
    await Promise.all([
      ...paths.map(async (path) => await writeFile(join(root, path), '')),
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
          'deployment:',
          '  mode: none',
          '',
        ].join('\n'),
      ),
    ]);
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'],
      { cwd: root },
    );
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });

    await expect(
      listAnalysisWritableRepositoryPaths(root, stdout.trim()),
    ).rejects.toMatchObject({ name: 'AnalysisRepositoryPathsError' });
  });
});
