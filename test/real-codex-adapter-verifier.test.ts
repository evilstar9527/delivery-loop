import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AgentSessionResultV1Schema } from '../src/domain/agent-session-result.js';

describe('real Codex adapter opt-in verifier', () => {
  it('defaults to prerequisite exit 2 before authentication or model use', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_CODEX_ADAPTER_E2E;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-real-codex-adapter.ts'],
      {
        cwd: resolve('.'),
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('real-codex-adapter-e2e: opt-in missing');
    expect(result.stderr).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('uses one strict fixed provider result schema and a named package entry', () => {
    expect(AgentSessionResultV1Schema.parse({
      schemaVersion: '1',
      status: 'checkpoint_ready',
    })).toEqual({ schemaVersion: '1', status: 'checkpoint_ready' });
    expect(() => AgentSessionResultV1Schema.parse({
      schemaVersion: '1',
      status: 'checkpoint_ready',
      summary: 'untrusted free text',
    })).toThrow();
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['e2e:codex-adapter'])
      .toBe('tsx scripts/verify-real-codex-adapter.ts');
    const verifier = readFileSync(resolve('scripts/verify-real-codex-adapter.ts'), 'utf8');
    expect(verifier).toContain('process.env.CODEX_API_KEY');
    expect(verifier).toContain('process.env.OPENAI_BASE_URL');
    expect(verifier).toContain('process.env.DELIVERY_LOOP_CODEX_ADAPTER_MODEL');
  });
});
