/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BackupManifestV1Schema,
  computeBackupManifestDigest,
} from '../../src/domain/backup-recovery.js';
import {
  R2BackupError,
  R2BackupManager,
} from '../../src/backup/r2-backup-manager.js';

const BACKUP_ID = 'backup_round66_r2';

async function clear(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

beforeEach(async () => {
  await Promise.all([
    clear(env.TASK_OBJECTS),
    clear(env.CHECKPOINT_OBJECTS),
    clear(env.BACKUP_OBJECTS),
  ]);
});

describe('content-verified R2 backup set', () => {
  it('backs up both private buckets and restores deleted objects with metadata', async () => {
    await env.TASK_OBJECTS.put('tasks/task-1.json', 'TASK_CANARY_CONTENT', {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { taskDigest: `sha256:${'a'.repeat(64)}` },
    });
    await env.TASK_OBJECTS.put('review-feedback/review-1.json', 'REVIEW_CONTENT', {
      customMetadata: { bodyDigest: `sha256:${'b'.repeat(64)}` },
    });
    await env.CHECKPOINT_OBJECTS.put('checkpoints/checkpoint-1.json', 'CHECKPOINT_CONTENT', {
      customMetadata: { payloadDigest: `sha256:${'c'.repeat(64)}` },
    });
    const manager = new R2BackupManager(env.BACKUP_OBJECTS, {
      task: env.TASK_OBJECTS,
      checkpoint: env.CHECKPOINT_OBJECTS,
    });
    const objects = await manager.backupAll(BACKUP_ID);
    expect(objects).toMatchObject({ objectCount: 3, totalBytes: 51 });
    expect(objects.descriptorSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const d1Dump = await manager.storeD1Export(
      BACKUP_ID,
      new Response('CREATE TABLE restored(id TEXT);').body!,
    );
    const body = {
      schemaVersion: '1' as const,
      backupId: BACKUP_ID,
      createdAt: '2026-07-26T10:00:00.000Z',
      d1: {
        bookmark: '00000085-0000024c-backup',
        ...d1Dump,
      },
      r2: objects,
    };
    const manifest = {
      ...body,
      digest: await computeBackupManifestDigest(body),
    };
    expect(BackupManifestV1Schema.parse(manifest)).toEqual(manifest);
    const manifestRef = await manager.storeManifest(manifest);
    expect(manifestRef).toMatchObject({
      key: `backups/${BACKUP_ID}/manifest.json`,
      digest: manifest.digest,
    });
    expect(JSON.stringify(manifest)).not.toContain('TASK_CANARY_CONTENT');

    await Promise.all([
      clear(env.TASK_OBJECTS),
      clear(env.CHECKPOINT_OBJECTS),
    ]);
    const restored = await manager.restoreAll(BACKUP_ID, manifest.r2);
    expect(restored).toEqual({ objectCount: 3, totalBytes: 51 });
    const task = await env.TASK_OBJECTS.get('tasks/task-1.json');
    expect(await task?.text()).toBe('TASK_CANARY_CONTENT');
    expect(task?.httpMetadata?.contentType).toBe('application/json; charset=utf-8');
    expect(task?.customMetadata).toEqual({ taskDigest: `sha256:${'a'.repeat(64)}` });
    await expect(manager.verifyAll(BACKUP_ID, manifest.r2)).resolves.toEqual(restored);
  });

  it('rejects a tampered backup object, descriptor set, manifest, or missing source object', async () => {
    await env.TASK_OBJECTS.put('tasks/task-tamper.json', 'ORIGINAL');
    const manager = new R2BackupManager(env.BACKUP_OBJECTS, {
      task: env.TASK_OBJECTS,
      checkpoint: env.CHECKPOINT_OBJECTS,
    });
    const summary = await manager.backupAll(BACKUP_ID);
    const descriptors = await env.BACKUP_OBJECTS.list({
      prefix: `backups/${BACKUP_ID}/descriptors/`,
    });
    expect(descriptors.objects).toHaveLength(1);
    const descriptor = JSON.parse(
      await (await env.BACKUP_OBJECTS.get(descriptors.objects[0]!.key))!.text(),
    ) as { backupKey: string };
    await env.BACKUP_OBJECTS.put(descriptor.backupKey, 'TAMPERED');
    await expect(manager.restoreAll(BACKUP_ID, summary)).rejects.toSatisfy((error: unknown) =>
      error instanceof R2BackupError && error.code === 'content_conflict');

    await env.BACKUP_OBJECTS.delete(descriptors.objects[0]!.key);
    await expect(manager.verifyAll(BACKUP_ID, summary)).rejects.toMatchObject({
      code: 'descriptor_conflict',
    });
  });
});
