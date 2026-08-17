import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EXECUTOR_CODEX_COMMAND } from '../src/agent/executor-codex-command.js';

describe('executor image command contract', () => {
  it('build-verifies the absolute Codex binary used by executor runners', async () => {
    expect(EXECUTOR_CODEX_COMMAND).toBe('/opt/delivery-agent/node_modules/.bin/codex');
    const dockerfile = await readFile(
      new URL('../executor-image/Dockerfile', import.meta.url),
      'utf8',
    );
    expect(dockerfile).toContain('codex-0.145.0-linux-x64.tgz');
    expect(dockerfile).toContain('@esbuild/linux-x64/-/linux-x64-0.28.1.tgz');
    expect(dockerfile).toContain('sha512sum --check --strict');
    expect(dockerfile).toContain("pnpm exec tsx -e 'const value: number = 1;");
    expect(dockerfile).toContain(`test -x ${EXECUTOR_CODEX_COMMAND}`);
    expect(dockerfile).toContain(`${EXECUTOR_CODEX_COMMAND} --version`);
  });
});
