import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  analysisSourceSnapshotSupportsRootCause,
  AnalysisSourceSnapshotError,
  buildAnalysisSourceSnapshot,
} from '../src/runner/analysis-source-snapshot.js';

const exec = promisify(execFile);

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'delivery-loop-analysis-source-'));
  await exec('git', ['init', '-q'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await exec('git', ['add', '.'], { cwd: root });
  return root;
}

describe('analysis source snapshot', () => {
  it('binds a diagnostic event value to an exact tracked source line', async () => {
    const root = await repository({
      'src/transport.ts': [
        'export function classifyTransport() {',
        "  return 'credential_transport_unavailable';",
        '}',
      ].join('\n'),
      'test/transport.test.ts': "expect(value).toBe('credential_transport_unavailable');\n",
    });

    const snapshot = await buildAnalysisSourceSnapshot({
      repositoryPath: root,
      diagnosticContext: {
        trace: { result: { source: { failureKind: 'credential_transport_unavailable' } } },
      },
      runtimeSecrets: [],
    });
    expect(snapshot).toEqual({
      schemaVersion: '1',
      matches: [{
        path: 'src/transport.ts',
        line: 2,
        excerpt: "return 'credential_transport_unavailable';",
      }, {
        path: 'test/transport.test.ts',
        line: 1,
        excerpt: "expect(value).toBe('credential_transport_unavailable');",
      }],
    });
    expect(analysisSourceSnapshotSupportsRootCause(snapshot, {
      summary: 'The transport classifier emitted the observed failure.',
      confidence: 'high',
      codeRefs: [{ path: 'src/transport.ts', line: 2, symbol: 'credential_transport_unavailable' }],
    })).toBe(true);
    expect(analysisSourceSnapshotSupportsRootCause(snapshot, {
      summary: 'An unsupported location must fail.',
      confidence: 'low',
      codeRefs: [{ path: 'src/transport.ts', line: 3 }],
    })).toBe(false);
    expect(analysisSourceSnapshotSupportsRootCause(snapshot, {
      summary: 'An empty location set must fail.',
      confidence: 'low',
      codeRefs: [],
    })).toBe(false);
  });

  it('extracts bounded code candidates from a Tool Bridge plaintext result', async () => {
    const root = await repository({
      'src/chat/name.go': [
        'package chat',
        'func normalizeCharacterName() string {',
        '  return "multi_role_character_name"',
        '}',
      ].join('\n'),
    });
    const snapshot = await buildAnalysisSourceSnapshot({
      repositoryPath: root,
      diagnosticContext: {
        trace: {
          result: {
            result: `${'unrelated telemetry '.repeat(500)} ` +
              'handler normalizeCharacterName emitted multi_role_character_name',
          },
        },
      },
      runtimeSecrets: [],
    });
    expect(snapshot.matches).toEqual([{
      path: 'src/chat/name.go',
      line: 3,
      excerpt: 'return "multi_role_character_name"',
    }, {
      path: 'src/chat/name.go',
      line: 2,
      excerpt: 'func normalizeCharacterName() string {',
    }]);

    await expect(buildAnalysisSourceSnapshot({
      repositoryPath: root,
      diagnosticContext: { result: 'x'.repeat(256 * 1_024 + 1) },
      runtimeSecrets: [],
    })).rejects.toBeInstanceOf(AnalysisSourceSnapshotError);

    await expect(buildAnalysisSourceSnapshot({
      repositoryPath: root,
      diagnosticContext: {
        result: Array.from({ length: 1_001 }, (_, index) => `candidate_${index}`).join(' '),
      },
      runtimeSecrets: [],
    })).rejects.toBeInstanceOf(AnalysisSourceSnapshotError);
  });

  it('supports the production target inventory while rejecting missing matches, symlinks, Secrets, and oversized inventories', async () => {
    const missing = await repository({ 'src/other.ts': 'export const other = true;\n' });
    await expect(buildAnalysisSourceSnapshot({
      repositoryPath: missing,
      diagnosticContext: { source: { event: 'unmapped_event_name' } },
      runtimeSecrets: [],
    })).rejects.toBeInstanceOf(AnalysisSourceSnapshotError);

    const linked = await repository({ 'outside.ts': "export const event = 'linked_event';\n" });
    await symlink(join(linked, 'outside.ts'), join(linked, 'src-link.ts'));
    await exec('git', ['add', 'src-link.ts'], { cwd: linked });
    await expect(buildAnalysisSourceSnapshot({
      repositoryPath: linked,
      diagnosticContext: { source: { event: 'linked_event' } },
      runtimeSecrets: [],
    })).rejects.toBeInstanceOf(AnalysisSourceSnapshotError);

    const secret = 'CANARY_ANALYSIS_SOURCE_RUNTIME_SECRET';
    const leaked = await repository({
      'src/leak.ts': `export const event = 'secret_event'; // ${secret}\n`,
    });
    await expect(buildAnalysisSourceSnapshot({
      repositoryPath: leaked,
      diagnosticContext: { source: { event: 'secret_event' } },
      runtimeSecrets: [secret],
    })).rejects.toBeInstanceOf(AnalysisSourceSnapshotError);

    const productionSizedFiles = Object.fromEntries(Array.from(
      { length: 2_216 },
      (_, index) => [
        `src/file-${index}.ts`,
        `export const event = '${index === 0 ? 'bounded_event' : `unrelated_${index}`}';\n`,
      ],
    ));
    const productionSized = await repository(productionSizedFiles);
    await expect(buildAnalysisSourceSnapshot({
      repositoryPath: productionSized,
      diagnosticContext: { source: { event: 'bounded_event' } },
      runtimeSecrets: [],
    })).resolves.toMatchObject({ schemaVersion: '1', matches: expect.any(Array) });

    const oversizedFiles = Object.fromEntries(Array.from(
      { length: 5_001 },
      (_, index) => [`src/file-${index}.ts`, "export const event = 'bounded_event';\n"],
    ));
    const oversized = await repository(oversizedFiles);
    await expect(buildAnalysisSourceSnapshot({
      repositoryPath: oversized,
      diagnosticContext: { source: { event: 'bounded_event' } },
      runtimeSecrets: [],
    })).rejects.toBeInstanceOf(AnalysisSourceSnapshotError);
  });
});
