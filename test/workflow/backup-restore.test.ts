/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { computeBackupManifestDigest } from '../../src/domain/backup-recovery.js';
import { R2BackupManager } from '../../src/backup/r2-backup-manager.js';
import {
  BackupRestoreCoordinator,
  BackupRestoreError,
  BackupSnapshotStore,
} from '../../src/storage/backup-restore-store.js';
import {
  RepoWriteCredentialRevoker,
  type GitHubWriteCredentialProvider,
} from '../../src/storage/repo-write-credential-store.js';

const NOW = new Date('2026-07-26T12:00:00.000Z');
const OLD = '2026-06-20T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ACTIVE_TOKEN = 'restored-active-attempt-token';
const WRITE_TOKEN = 'restored-github-write-token';
const ENCRYPTION_KEY_BYTES = new Uint8Array(32).fill(7);
const ENCRYPTION_KEY = btoa(String.fromCharCode(...ENCRYPTION_KEY_BYTES));

async function clearBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function encryptedCredential(
  token: string,
  credentialId: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(12).fill(9);
  const key = await crypto.subtle.importKey(
    'raw',
    ENCRYPTION_KEY_BYTES,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(credentialId),
  }, key, new TextEncoder().encode(token));
  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

async function seedRun(
  suffix: 'active' | 'old',
  state: 'executing' | 'succeeded',
  createdAt: string,
): Promise<{ taskId: string; runId: string; attemptId: string; planId: string }> {
  const taskId = `task_restore_${suffix}`;
  const runId = `run_restore_${suffix}`;
  const attemptId = `attempt_restore_${suffix}`;
  const planId = `plan_restore_${suffix}`;
  const itemId = `item_restore_${suffix}`;
  const taskKey = `tasks/${taskId}.json`;
  await env.TASK_OBJECTS.put(taskKey, JSON.stringify({ schemaVersion: '1', id: taskId }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { taskDigest: DIGEST },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'restore-tenant', ?, '1', ?, ?, 'user', ?,
                 'example/restore-repo', 'main', 'test', 'bug', 'restore test',
                 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(
      taskId,
      taskId,
      DIGEST,
      `r2://${taskKey}`,
      `user:${suffix}`,
      createdAt,
      createdAt,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, ?, 4, ?, 1, ?, ?, ?)`,
    ).bind(runId, taskId, DIGEST, SHA, runId, state, planId, DIGEST, createdAt, createdAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, plan_id, plan_version, plan_item_id,
         head_sha, version, lease_generation, lease_expires_at, heartbeat_at,
         created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', ?, ?, 'example/restore-repo',
                 'example/restore-repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, ?, 1, ?, ?, 2, 1, ?, ?, ?, ?)`,
    ).bind(
      attemptId,
      runId,
      state === 'executing' ? 'running' : 'completed',
      SHA,
      suffix === 'active' ? '7001' : '7002',
      planId,
      itemId,
      SHA,
      state === 'executing' ? '2099-01-01T00:00:00.000Z' : null,
      createdAt,
      createdAt,
      createdAt,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, ?, ?, 'restore objective', ?, ?)`,
    ).bind(
      planId,
      runId,
      SHA,
      DIGEST,
      state === 'executing' ? 'active' : 'completed',
      attemptId,
      createdAt,
      createdAt,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'restore item', 'restore item objective', 1, 0)`,
    ).bind(planId, itemId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(planId, itemId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, ?, ?, 2, ?)`,
    ).bind(planId, itemId, state === 'executing' ? 'in_progress' : 'passed', attemptId, createdAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES (?, ?, '1', ?, 1, ?, ?, 'repo_write', 'user:approver',
                 'approve', ?, '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      `approval_restore_${suffix}`,
      runId,
      planId,
      DIGEST,
      SHA,
      `sha256:${suffix === 'active' ? 'c' : 'd'}`.padEnd(71, suffix === 'active' ? 'c' : 'd'),
      createdAt,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES (?, ?, ?, ?, 1, ?, 'commit', 'passed', ?, 'restore evidence',
                 'verified', ?, ?)`,
    ).bind(`evidence_restore_${suffix}`, runId, attemptId, planId, itemId, SHA, createdAt, createdAt),
  ]);
  return { taskId, runId, attemptId, planId };
}

async function seedRestoreFixture(): Promise<{
  active: Awaited<ReturnType<typeof seedRun>>;
  old: Awaited<ReturnType<typeof seedRun>>;
  manifest: { backupId: string; digest: string };
  credentialId: string;
}> {
  const active = await seedRun('active', 'executing', NOW.toISOString());
  const old = await seedRun('old', 'succeeded', OLD);
  const tokenDigest = await canonicalSha256(ACTIVE_TOKEN);
  const toolDigest = await canonicalSha256(`${ACTIVE_TOKEN}-tool`);
  const credentialId = 'credential_restore_active';
  const encrypted = await encryptedCredential(WRITE_TOKEN, credentialId);
  await env.CHECKPOINT_OBJECTS.put('checkpoints/restore-active.json', '{}', {
    customMetadata: { checkpointDigest: DIGEST },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO checkpoints (
         checkpoint_id, attempt_id, sequence, plan_id, plan_version, plan_item_id,
         head_sha, payload_ref, payload_digest, summary, next_step, created_at
       ) VALUES ('checkpoint_restore_active', ?, 1, ?, 1, 'item_restore_active', ?,
                 'r2://checkpoints/restore-active.json', ?, 'safe summary',
                 'resume after restore', ?)`,
    ).bind(active.attemptId, active.planId, SHA, DIGEST, NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token_restore_active', ?, ?, ?, ?, 1, '["repo:read"]',
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      active.attemptId,
      `sha256:${'e'.repeat(64)}`,
      tokenDigest,
      toolDigest,
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_write_credentials (
         credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         approval_id, repository, lease_generation, status, token_digest,
         token_ciphertext, token_iv, github_expires_at, authorization_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'item_restore_active', 'approval_restore_active',
                 'example/restore-repo', 1, 'active', ?, ?, ?,
                 '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(
      credentialId,
      active.runId,
      active.attemptId,
      active.planId,
      await canonicalSha256(WRITE_TOKEN),
      encrypted.ciphertext,
      encrypted.iv,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, attempt_count, lease_token, lease_expires_at,
         created_at, updated_at
       ) VALUES ('outbox_restore_active', ?, 'execution_dispatch', 'github_actions',
                 ?, 'restore-active-dispatch', 'delivering', 1, 'LEASE_CANARY',
                 '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(
      active.runId,
      `d1://attempts/${active.attemptId}`,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO workflow_instance_reconciliation_state (
         run_id, run_version, d1_state, platform_status, fact_digest, checked_at, updated_at
       ) VALUES (?, 4, 'succeeded', 'complete', ?, ?, ?)`,
    ).bind(old.runId, `sha256:${'f'.repeat(64)}`, OLD, OLD),
  ]);

  const manager = new R2BackupManager(env.BACKUP_OBJECTS, {
    task: env.TASK_OBJECTS,
    checkpoint: env.CHECKPOINT_OBJECTS,
  });
  const r2 = await manager.backupAll('backup_restore_fixture');
  const d1 = await manager.storeD1Export(
    'backup_restore_fixture',
    new Response('D1_EXPORT_FIXTURE').body!,
  );
  const body = {
    schemaVersion: '1' as const,
    backupId: 'backup_restore_fixture',
    createdAt: NOW.toISOString(),
    d1: { bookmark: '00000085-restore-fixture', ...d1 },
    r2,
  };
  const manifest = { ...body, digest: await computeBackupManifestDigest(body) };
  await manager.storeManifest(manifest);
  await new BackupSnapshotStore(env.DB_CONTROL).seal(manifest, NOW);
  return {
    active,
    old,
    manifest: { backupId: manifest.backupId, digest: manifest.digest },
    credentialId,
  };
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM restore_consistency_checks'),
    env.DB_CONTROL.prepare('DELETE FROM restore_token_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM restore_run_fences'),
    env.DB_CONTROL.prepare('DELETE FROM restore_drills'),
    env.DB_CONTROL.prepare("UPDATE control_plane_recovery_state SET restore_generation = 0, serving_state = 'active', current_restore_id = NULL, updated_at = '2026-07-26T00:00:00.000Z' WHERE singleton = 1"),
    env.DB_CONTROL.prepare('DELETE FROM backup_snapshots'),
    env.DB_CONTROL.prepare('DELETE FROM quota_concurrency_reservations'),
    env.DB_CONTROL.prepare('DELETE FROM quota_model_reservations'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_instance_reconciliation_state'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await Promise.all([
    clearBucket(env.TASK_OBJECTS),
    clearBucket(env.CHECKPOINT_OBJECTS),
    clearBucket(env.BACKUP_OBJECTS),
  ]);
});

describe('D1/R2 restore fence and consistency drill', () => {
  it('restores immutable objects, revokes every active token, and preserves 30-day audit', async () => {
    const fixture = await seedRestoreFixture();
    const coordinator = new BackupRestoreCoordinator(
      env.DB_CONTROL,
      new R2BackupManager(env.BACKUP_OBJECTS, {
        task: env.TASK_OBJECTS,
        checkpoint: env.CHECKPOINT_OBJECTS,
      }),
    );
    const outcomes = await Promise.all(Array.from({ length: 20 }, () =>
      coordinator.fenceAndRestore({
        restoreId: 'restore_round66',
        backupId: fixture.manifest.backupId,
        manifestDigest: fixture.manifest.digest,
      }, NOW)));
    expect(outcomes.every((outcome) => outcome.restoreGeneration === 1)).toBe(true);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, lease_generation, lease_expires_at
       FROM attempts WHERE attempt_id = ?`,
    ).bind(fixture.active.attemptId).first()).toEqual({
      status: 'lost',
      lease_generation: 2,
      lease_expires_at: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE token_id = 'token_restore_active'`,
    ).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).bind(fixture.active.runId).first()).toEqual({ state: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM execution_plans WHERE plan_id = ?`,
    ).bind(fixture.active.planId).first()).toEqual({ status: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, lease_token, lease_expires_at
       FROM outbox WHERE outbox_id = 'outbox_restore_active'`,
    ).first()).toEqual({ delivery_state: 'pending', lease_token: null, lease_expires_at: null });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM github_write_credentials WHERE credential_id = ?`,
    ).bind(fixture.credentialId).first()).toEqual({ status: 'revocation_pending' });

    const oldTokenResponse = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${fixture.active.attemptId}/context`,
      { headers: { authorization: `Bearer ${ACTIVE_TOKEN}` } },
    );
    expect(oldTokenResponse.status).toBe(401);

    const revoked: string[] = [];
    const provider: GitHubWriteCredentialProvider = {
      issueWriteCredential: async () => { throw new Error('not used'); },
      revokeWriteCredential: async (token) => { revoked.push(token); },
    };
    await new RepoWriteCredentialRevoker(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
      now: () => NOW,
      generateLeaseToken: () => 'restore-revocation-lease',
    }).scan();
    expect(revoked).toEqual([WRITE_TOKEN]);

    const completed = await coordinator.complete('restore_round66', NOW);
    expect(completed).toMatchObject({ status: 'ready', restoreGeneration: 1 });
    expect(completed.checks.map((check) => check.category).sort()).toEqual([
      'approval', 'audit', 'evidence', 'foreign_keys', 'plan', 'r2', 'run', 'task', 'token',
    ]);
    const longTerm = await coordinator.auditLongTermRun(fixture.old.runId, NOW);
    expect(longTerm).toMatchObject({
      runId: fixture.old.runId,
      state: 'succeeded',
      platformStatus: 'complete',
      ageDays: expect.any(Number),
      taskDigest: DIGEST,
      planDigest: DIGEST,
      approvalCount: 1,
      evidenceCount: 1,
    });
    expect(longTerm.ageDays).toBeGreaterThan(30);
    expect(JSON.stringify(completed)).not.toContain(ACTIVE_TOKEN);
    expect(JSON.stringify(completed)).not.toContain(WRITE_TOKEN);
    expect(JSON.stringify(completed)).not.toContain('LEASE_CANARY');
  });

  it('does not fence on a forged manifest and cannot become ready with missing R2 or credentials', async () => {
    const fixture = await seedRestoreFixture();
    const manager = new R2BackupManager(env.BACKUP_OBJECTS, {
      task: env.TASK_OBJECTS,
      checkpoint: env.CHECKPOINT_OBJECTS,
    });
    const coordinator = new BackupRestoreCoordinator(env.DB_CONTROL, manager);
    await expect(coordinator.fenceAndRestore({
      restoreId: 'restore_forged',
      backupId: fixture.manifest.backupId,
      manifestDigest: `sha256:${'0'.repeat(64)}`,
    }, NOW)).rejects.toSatisfy((error: unknown) =>
      error instanceof BackupRestoreError && error.code === 'manifest_conflict');
    expect(await env.DB_CONTROL.prepare(
      `SELECT revoked_at FROM attempt_tokens WHERE token_id = 'token_restore_active'`,
    ).first()).toEqual({ revoked_at: null });

    await coordinator.fenceAndRestore({
      restoreId: 'restore_incomplete',
      backupId: fixture.manifest.backupId,
      manifestDigest: fixture.manifest.digest,
    }, NOW);
    await env.TASK_OBJECTS.delete(`tasks/${fixture.old.taskId}.json`);
    await expect(coordinator.complete('restore_incomplete', NOW))
      .rejects.toMatchObject({ code: 'object_conflict' });
    await manager.restoreAll(
      fixture.manifest.backupId,
      (await manager.loadManifest(fixture.manifest.backupId, fixture.manifest.digest)).r2,
    );
    await expect(coordinator.complete('restore_incomplete', NOW))
      .rejects.toMatchObject({ code: 'credential_pending' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT serving_state FROM control_plane_recovery_state WHERE singleton = 1`,
    ).first()).toEqual({ serving_state: 'restoring' });
  });
});
