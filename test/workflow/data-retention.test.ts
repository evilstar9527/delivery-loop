/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256, sha256Bytes } from '../../src/domain/digest.js';
import {
  DataRetentionStore,
  rawAgentObjectKey,
  type RawAgentArtifactCategory,
  type RetentionObjectBucket,
} from '../../src/storage/data-retention-store.js';

const NOW = '2026-07-26T16:00:00.000Z';
const OPERATIONS_TOKEN = 'test-operations-token';
const SECRET_CANARY = 'RAW_SESSION_SECRET_CANARY_MUST_BE_DELETED';

async function clear(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function seedRawArtifact(input: {
  objectId: string;
  category: RawAgentArtifactCategory;
  expiresAt: string;
  metadataConflict?: boolean;
}): Promise<string> {
  const bytes = new TextEncoder().encode(`${SECRET_CANARY}:${input.objectId}`);
  const ciphertextDigest = await sha256Bytes(bytes);
  const objectIdentityDigest = await canonicalSha256({
    bucket: 'raw_agent_objects',
    category: input.category,
    objectId: input.objectId,
  });
  const key = rawAgentObjectKey(input.category, input.objectId);
  const object = await env.RAW_AGENT_OBJECTS.put(key, bytes, {
    customMetadata: {
      schemaVersion: '1',
      retentionClass: input.metadataConflict ? 'structured_evidence' : input.category,
      objectId: input.objectId,
      ciphertextDigest,
      encryption: 'AES-256-GCM',
    },
  });
  if (object === null) throw new Error('failed to seed raw artifact');
  await env.DB_CONTROL.prepare(
    `INSERT INTO raw_agent_artifacts (
       object_id, object_identity_digest, category, ciphertext_digest,
       size_bytes, r2_etag, created_at, expires_at, deletion_state,
       retry_count, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z', ?, 'active', 0,
               '2026-06-01T00:00:00.000Z')`,
  ).bind(
    input.objectId,
    objectIdentityDigest,
    input.category,
    ciphertextDigest,
    bytes.byteLength,
    object.etag,
    input.expiresAt,
  ).run();
  return key;
}

async function seedStructuredEvidence(): Promise<void> {
  const digest = `sha256:${'a'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES ('task_retention_evidence', 'manual', 'tenant-retention',
                 'source-retention', 'revision-1', ?, 'r2://tasks/retention.json',
                 'user', 'user:retention', 'example/repo', 'main', 'none', 'bug',
                 'retention evidence', 'p1', 1, 0, 0, 0, 1, ?, ?)`,
    ).bind(digest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, workflow_instance_id,
         state, version, created_at, updated_at
       ) VALUES ('run_retention_evidence', 'task_retention_evidence', 'revision-1',
                 ?, 'run_retention_evidence', 'succeeded', 1, ?, ?)`,
    ).bind(digest, NOW, NOW),
  ]);
  await env.DB_CONTROL.prepare(
    `INSERT INTO evidence (
       evidence_id, run_id, kind, status, summary, verification_status,
       observed_at, created_at
     ) VALUES ('evidence_retention_structured', 'run_retention_evidence', 'test',
               'passed', 'structured projection survives retention', 'verified', ?, ?)`,
  ).bind(NOW, NOW).run();
}

async function scalar(sql: string): Promise<number> {
  const row = await env.DB_CONTROL.prepare(sql).first<{ count: number }>();
  return row?.count ?? 0;
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM data_retention_deletion_audit'),
    env.DB_CONTROL.prepare('DELETE FROM data_retention_scans'),
    env.DB_CONTROL.prepare('DELETE FROM raw_agent_artifacts'),
    env.DB_CONTROL.prepare('DELETE FROM data_retention_cursor'),
    env.DB_CONTROL.prepare("DELETE FROM evidence WHERE evidence_id = 'evidence_retention_structured'"),
    env.DB_CONTROL.prepare("DELETE FROM runs WHERE run_id = 'run_retention_evidence'"),
    env.DB_CONTROL.prepare("DELETE FROM tasks WHERE task_id = 'task_retention_evidence'"),
  ]);
  await Promise.all([
    clear(env.RAW_AGENT_OBJECTS),
    clear(env.TASK_OBJECTS),
    clear(env.CHECKPOINT_OBJECTS),
    clear(env.BACKUP_OBJECTS),
  ]);
});

describe('raw Agent data retention', () => {
  it('dry-runs without deletion, then removes only expired raw data and preserves structured evidence', async () => {
    const expiredSession = await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000001',
      category: 'raw_session',
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    const expiredTranscript = await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000002',
      category: 'raw_transcript',
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    const liveSession = await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000003',
      category: 'raw_session',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    await seedStructuredEvidence();
    await Promise.all([
      env.TASK_OBJECTS.put('tasks/retention.json', 'TASK_BODY'),
      env.CHECKPOINT_OBJECTS.put('checkpoints/retention.json', 'CHECKPOINT_BODY'),
      env.BACKUP_OBJECTS.put('backups/retention/manifest.json', 'BACKUP_BODY'),
    ]);

    const store = new DataRetentionStore(env.DB_CONTROL, env.RAW_AGENT_OBJECTS, {
      now: () => new Date(NOW),
    });
    const preview = await store.run('dry_run', 'operations', 25);
    expect(preview).toMatchObject({
      mode: 'dry_run',
      candidateCount: 2,
      deletedCount: 0,
      failedCount: 0,
    });
    await expect(env.RAW_AGENT_OBJECTS.head(expiredSession)).resolves.not.toBeNull();
    await expect(env.RAW_AGENT_OBJECTS.head(expiredTranscript)).resolves.not.toBeNull();
    expect(await scalar('SELECT COUNT(*) AS count FROM data_retention_deletion_audit')).toBe(0);
    expect(await scalar('SELECT COUNT(*) AS count FROM data_retention_cursor')).toBe(0);

    const executed = await store.run('execute', 'scheduled', 25);
    expect(executed).toMatchObject({ candidateCount: 2, deletedCount: 2, failedCount: 0 });
    await expect(env.RAW_AGENT_OBJECTS.head(expiredSession)).resolves.toBeNull();
    await expect(env.RAW_AGENT_OBJECTS.head(expiredTranscript)).resolves.toBeNull();
    await expect(env.RAW_AGENT_OBJECTS.head(liveSession)).resolves.not.toBeNull();
    await expect(env.TASK_OBJECTS.head('tasks/retention.json')).resolves.not.toBeNull();
    await expect(env.CHECKPOINT_OBJECTS.head('checkpoints/retention.json')).resolves.not.toBeNull();
    await expect(env.BACKUP_OBJECTS.head('backups/retention/manifest.json')).resolves.not.toBeNull();
    expect(await scalar(
      "SELECT COUNT(*) AS count FROM evidence WHERE evidence_id = 'evidence_retention_structured'",
    )).toBe(1);

    const audits = await env.DB_CONTROL.prepare(
      `SELECT object_identity_digest, category, policy_version, result
       FROM data_retention_deletion_audit ORDER BY category`,
    ).all<Record<string, string>>();
    expect(audits.results).toHaveLength(2);
    expect(audits.results.every((row) => row.result === 'deleted')).toBe(true);
    expect(JSON.stringify(audits.results)).not.toContain(SECRET_CANARY);
    const auditColumns = await env.DB_CONTROL.prepare(
      "SELECT name FROM pragma_table_info('data_retention_deletion_audit') ORDER BY cid",
    ).all<{ name: string }>();
    expect(auditColumns.results.map((column) => column.name)).not.toContain('object_key');
    await expect(env.DB_CONTROL.prepare(
      "UPDATE data_retention_deletion_audit SET result = 'failed' WHERE result = 'deleted'",
    ).run()).rejects.toThrow('data_retention_deletion_audit_is_immutable');
  });

  it('uses a fenced claim so 20 concurrent scans issue one delete and one completed audit', async () => {
    await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000010',
      category: 'raw_transcript',
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    let deleteCalls = 0;
    const countedBucket: RetentionObjectBucket = {
      head: (key) => env.RAW_AGENT_OBJECTS.head(key),
      delete: async (key) => {
        deleteCalls += 1;
        await env.RAW_AGENT_OBJECTS.delete(key);
      },
    };
    const scans = await Promise.all(Array.from({ length: 20 }, async () =>
      await new DataRetentionStore(env.DB_CONTROL, countedBucket, {
        now: () => new Date(NOW),
      }).run('execute', 'scheduled', 25)
    ));
    expect(scans.reduce((sum, scan) => sum + scan.deletedCount, 0)).toBe(1);
    expect(deleteCalls).toBe(1);
    expect(await scalar(
      "SELECT COUNT(*) AS count FROM data_retention_deletion_audit WHERE result IN ('deleted', 'already_absent')",
    )).toBe(1);
  });

  it('fails closed on metadata/storage uncertainty, retries safely, and advances the bounded cursor', async () => {
    const conflicted = await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000020',
      category: 'raw_session',
      expiresAt: '2026-07-01T00:00:00.000Z',
      metadataConflict: true,
    });
    const retryable = await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000021',
      category: 'raw_transcript',
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    let failOnce = true;
    const uncertainBucket: RetentionObjectBucket = {
      head: (key) => env.RAW_AGENT_OBJECTS.head(key),
      delete: async (key) => {
        if (key === retryable && failOnce) {
          failOnce = false;
          throw new Error(`ambiguous upstream failure ${SECRET_CANARY}`);
        }
        await env.RAW_AGENT_OBJECTS.delete(key);
      },
    };
    const store = new DataRetentionStore(env.DB_CONTROL, uncertainBucket, {
      now: () => new Date(NOW),
    });
    const first = await store.run('execute', 'scheduled', 1);
    const second = await store.run('execute', 'scheduled', 1);
    const third = await store.run('execute', 'scheduled', 1);
    const fourth = await store.run('execute', 'scheduled', 1);
    const scans = [first, second, third, fourth];
    expect(scans.reduce((sum, scan) => sum + scan.failedCount, 0)).toBe(3);
    expect(scans.reduce((sum, scan) => sum + scan.deletedCount, 0)).toBe(1);
    await expect(env.RAW_AGENT_OBJECTS.head(conflicted)).resolves.not.toBeNull();
    await expect(env.RAW_AGENT_OBJECTS.head(retryable)).resolves.toBeNull();
    const audits = await env.DB_CONTROL.prepare(
      `SELECT result, failure_code FROM data_retention_deletion_audit ORDER BY created_at, audit_id`,
    ).all<{ result: string; failure_code: string | null }>();
    expect(audits.results.map((row) => row.result).sort()).toEqual([
      'deleted', 'failed', 'failed', 'failed',
    ]);
    expect(audits.results.filter((row) => row.failure_code === null)).toHaveLength(1);
    expect(audits.results.filter((row) => row.failure_code === 'metadata_conflict')).toHaveLength(2);
    expect(audits.results.filter((row) => row.failure_code === 'storage_unavailable')).toHaveLength(1);
    expect(JSON.stringify(audits.results)).not.toContain(SECRET_CANARY);
  });

  it('repairs a crash after R2 deletion by recording already_absent without a second delete', async () => {
    const key = await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000025',
      category: 'raw_session',
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    await env.RAW_AGENT_OBJECTS.delete(key);
    let deleteCalls = 0;
    const countedBucket: RetentionObjectBucket = {
      head: (objectKey) => env.RAW_AGENT_OBJECTS.head(objectKey),
      delete: async (objectKey) => {
        deleteCalls += 1;
        await env.RAW_AGENT_OBJECTS.delete(objectKey);
      },
    };
    const result = await new DataRetentionStore(env.DB_CONTROL, countedBucket, {
      now: () => new Date(NOW),
    }).run('execute', 'scheduled', 25);
    expect(result).toMatchObject({ deletedCount: 0, alreadyAbsentCount: 1, failedCount: 0 });
    expect(deleteCalls).toBe(0);
    expect(await scalar(
      "SELECT COUNT(*) AS count FROM data_retention_deletion_audit WHERE result = 'already_absent'",
    )).toBe(1);
  });

  it('exposes only a strict operations dry-run/execute API without bucket, key, prefix, or time controls', async () => {
    const key = await seedRawArtifact({
      objectId: '00000000-0000-4000-8000-000000000030',
      category: 'raw_session',
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    const request = (body: unknown, suffix = '') => SELF.fetch(
      `https://delivery-loop.test/v1/data-retention/scans${suffix}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${OPERATIONS_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    expect((await SELF.fetch('https://delivery-loop.test/v1/data-retention/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'dry_run' }),
    })).status).toBe(401);
    expect((await request({ mode: 'dry_run' }, '?prefix=raw')).status).toBe(400);
    expect((await request({
      mode: 'execute',
      bucket: 'TASK_OBJECTS',
      objectKey: 'tasks/retention.json',
      before: '2099-01-01T00:00:00.000Z',
    })).status).toBe(400);

    const preview = await request({ mode: 'dry_run' });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      schemaVersion: '1',
      scan: { mode: 'dry_run', candidateCount: 1, deletedCount: 0 },
    });
    await expect(env.RAW_AGENT_OBJECTS.head(key)).resolves.not.toBeNull();

    const executed = await request({ mode: 'execute' });
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({
      schemaVersion: '1',
      scan: { mode: 'execute', deletedCount: 1, failedCount: 0 },
    });
    await expect(env.RAW_AGENT_OBJECTS.head(key)).resolves.toBeNull();
  });
});
