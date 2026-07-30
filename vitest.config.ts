import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/workflow/**', '.claude/worktree/**', 'node_modules/**'],
    // Git-backed integration fixtures spawn multiple child processes; cap file
    // concurrency so the five-second behavioral timeout measures the code path,
    // not host-wide process oversubscription.
    maxWorkers: 4,
  },
});
