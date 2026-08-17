import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('data retention production wiring', () => {
  it('uses a dedicated raw bucket, the one-minute Cron, and excludes raw bodies from backup', () => {
    const wrangler = JSON.parse(
      readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    ) as {
      triggers: { crons: string[] };
      r2_buckets: Array<{ binding: string; bucket_name: string }>;
    };
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const backup = readFileSync(
      new URL('../src/backup/r2-backup-manager.ts', import.meta.url),
      'utf8',
    );

    expect(wrangler.triggers.crons).toContain('* * * * *');
    expect(wrangler.r2_buckets).toContainEqual({
      binding: 'RAW_AGENT_OBJECTS',
      bucket_name: 'delivery-loop-raw-agent-objects',
    });
    expect(wrangler.r2_buckets).toContainEqual({
      binding: 'EXECUTOR_PATCH_OBJECTS',
      bucket_name: 'delivery-loop-executor-patches',
    });
    expect(worker).toContain(".run('execute', 'scheduled', 25)");
    expect(backup).not.toContain('RAW_AGENT_OBJECTS');
    expect(backup).not.toContain('EXECUTOR_PATCH_OBJECTS');
  });
});
