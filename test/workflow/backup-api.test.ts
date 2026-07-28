/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { R2BackupManager } from '../../src/backup/r2-backup-manager.js';
import { computeBackupManifestDigest } from '../../src/domain/backup-recovery.js';
import { BackupSnapshotStore } from '../../src/storage/backup-restore-store.js';

const OPERATIONS_TOKEN = 'test-operations-token';
const AUTHORIZATION = { authorization: `Bearer ${OPERATIONS_TOKEN}` };

async function clear(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function seedBackup(): Promise<{ backupId: string; manifestDigest: string }> {
  const backupId = 'backup_api_round66';
  const manager = new R2BackupManager(env.BACKUP_OBJECTS, {
    task: env.TASK_OBJECTS,
    checkpoint: env.CHECKPOINT_OBJECTS,
  });
  const r2 = await manager.backupAll(backupId);
  const d1 = await manager.storeD1Export(backupId, new Response('D1_API_DUMP').body!);
  const body = {
    schemaVersion: '1' as const,
    backupId,
    createdAt: '2026-07-26T02:00:00.000Z',
    d1: { bookmark: '00000085-backup-api', ...d1 },
    r2,
  };
  const manifest = { ...body, digest: await computeBackupManifestDigest(body) };
  await manager.storeManifest(manifest);
  await new BackupSnapshotStore(env.DB_CONTROL).seal(
    manifest,
    new Date('2026-07-26T02:01:00.000Z'),
  );
  return { backupId, manifestDigest: manifest.digest };
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM restore_consistency_checks'),
    env.DB_CONTROL.prepare('DELETE FROM restore_token_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM restore_run_fences'),
    env.DB_CONTROL.prepare(
      `UPDATE control_plane_recovery_state
       SET restore_generation = 0, serving_state = 'active', current_restore_id = NULL,
           updated_at = '2026-07-26T00:00:00.000Z' WHERE singleton = 1`,
    ),
    env.DB_CONTROL.prepare('DELETE FROM restore_drills'),
    env.DB_CONTROL.prepare('DELETE FROM backup_snapshots'),
  ]);
  await Promise.all([
    clear(env.TASK_OBJECTS),
    clear(env.CHECKPOINT_OBJECTS),
    clear(env.BACKUP_OBJECTS),
  ]);
});

describe('operations-only backup and restore API', () => {
  it('strictly fences serving, exposes safe status, and reopens only after checks pass', async () => {
    const backup = await seedBackup();
    expect((await SELF.fetch('https://delivery-loop.test/v1/backups')).status).toBe(401);
    const listed = await SELF.fetch('https://delivery-loop.test/v1/backups', {
      headers: AUTHORIZATION,
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      schemaVersion: '1',
      backups: [{ backupId: backup.backupId, manifestDigest: backup.manifestDigest }],
    });

    const rejected = await SELF.fetch(
      'https://delivery-loop.test/v1/restores/restore_api_round66/fence',
      {
        method: 'POST',
        headers: { ...AUTHORIZATION, 'content-type': 'application/json' },
        body: JSON.stringify({ ...backup, sql: 'DROP TABLE tasks' }),
      },
    );
    expect(rejected.status).toBe(400);

    const fenced = await SELF.fetch(
      'https://delivery-loop.test/v1/restores/restore_api_round66/fence',
      {
        method: 'POST',
        headers: { ...AUTHORIZATION, 'content-type': 'application/json' },
        body: JSON.stringify(backup),
      },
    );
    expect(fenced.status).toBe(202);
    expect(await fenced.json()).toMatchObject({
      accepted: true,
      restoreId: 'restore_api_round66',
      status: 'restoring',
      restoreGeneration: 1,
    });
    expect((await SELF.fetch('https://delivery-loop.test/v1/tasks/not-found')).status).toBe(503);
    expect((await SELF.fetch('https://delivery-loop.test/healthz')).status).toBe(200);

    const status = await SELF.fetch(
      'https://delivery-loop.test/v1/restores/restore_api_round66',
      { headers: AUTHORIZATION },
    );
    expect(status.status).toBe(200);
    expect(JSON.stringify(await status.json())).not.toContain('D1_API_DUMP');

    const completed = await SELF.fetch(
      'https://delivery-loop.test/v1/restores/restore_api_round66/complete',
      {
        method: 'POST',
        headers: { ...AUTHORIZATION, 'content-type': 'application/json' },
        body: JSON.stringify(backup),
      },
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      completed: true,
      status: 'ready',
      checks: expect.arrayContaining([
        expect.objectContaining({ category: 'foreign_keys', passed: true }),
        expect.objectContaining({ category: 'r2', passed: true }),
        expect.objectContaining({ category: 'token', passed: true }),
      ]),
    });
    expect((await SELF.fetch('https://delivery-loop.test/v1/tasks/not-found')).status).not.toBe(503);
  });
});
