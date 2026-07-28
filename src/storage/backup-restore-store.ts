import {
  assertBackupManifest,
  BackupDigestSchema,
  BackupIdSchema,
  type BackupManifestV1,
} from '../domain/backup-recovery.js';
import { R2BackupError } from '../backup/r2-backup-manager.js';
import type {
  BackupR2Reference,
  R2BackupManager,
} from '../backup/r2-backup-manager.js';

const RESTORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export type BackupRestoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'manifest_conflict'
  | 'state_conflict'
  | 'object_conflict'
  | 'credential_pending'
  | 'consistency_conflict';

export class BackupRestoreError extends Error {
  constructor(readonly code: BackupRestoreErrorCode) {
    super(`backup restore failed: ${code}`);
    this.name = 'BackupRestoreError';
  }
}

interface SnapshotRow {
  backup_id: string;
  manifest_digest: string;
  d1_bookmark: string;
  d1_export_digest: string;
  d1_export_size: number;
  r2_descriptor_set_digest: string;
  r2_object_count: number;
  r2_total_bytes: number;
  created_at: string;
  sealed_at: string;
}

interface RestoreRow {
  restore_id: string;
  backup_id: string;
  manifest_digest: string;
  restore_generation: number;
  status: 'fencing' | 'restoring' | 'ready';
  requested_at: string;
  fenced_at: string | null;
  completed_at: string | null;
}

interface CountRow {
  count: number;
}

interface ConsistencyCountRow {
  total: number;
  invalid: number;
}

interface ReferenceRow {
  reference_id: string;
  bucket: 'task' | 'checkpoint';
  object_key: string;
  expected_digest: string;
  metadata_key: 'taskDigest' | 'checkpointDigest' | 'bodyDigest' | 'contextDigest';
}

export type RestoreCheckCategory =
  | 'task'
  | 'run'
  | 'plan'
  | 'approval'
  | 'evidence'
  | 'audit'
  | 'foreign_keys'
  | 'r2'
  | 'token';

export interface RestoreConsistencyCheck {
  category: RestoreCheckCategory;
  passed: true;
  checkedCount: number;
  checkedAt: string;
}

export interface RestoreProjection {
  restoreId: string;
  backupId: string;
  manifestDigest: string;
  restoreGeneration: number;
  status: RestoreRow['status'];
  requestedAt: string;
  fencedAt: string | null;
  completedAt: string | null;
  checks: RestoreConsistencyCheck[];
}

export interface BackupSnapshotProjection {
  backupId: string;
  manifestDigest: string;
  bookmark: string;
  d1ExportDigest: string;
  d1ExportSize: number;
  r2DescriptorSetDigest: string;
  r2ObjectCount: number;
  r2TotalBytes: number;
  createdAt: string;
  sealedAt: string;
}

function validDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new BackupRestoreError('invalid_request');
  return now.toISOString();
}

function snapshotProjection(row: SnapshotRow): BackupSnapshotProjection {
  return {
    backupId: row.backup_id,
    manifestDigest: row.manifest_digest,
    bookmark: row.d1_bookmark,
    d1ExportDigest: row.d1_export_digest,
    d1ExportSize: row.d1_export_size,
    r2DescriptorSetDigest: row.r2_descriptor_set_digest,
    r2ObjectCount: row.r2_object_count,
    r2TotalBytes: row.r2_total_bytes,
    createdAt: row.created_at,
    sealedAt: row.sealed_at,
  };
}

/** Immutable D1 index for manifests whose bodies live in the private backup bucket. */
export class BackupSnapshotStore {
  constructor(private readonly db: D1Database) {}

  async seal(rawManifest: BackupManifestV1, now = new Date()): Promise<BackupSnapshotProjection> {
    const nowIso = validDate(now);
    let manifest: BackupManifestV1;
    try {
      manifest = await assertBackupManifest(rawManifest);
    } catch {
      throw new BackupRestoreError('manifest_conflict');
    }
    try {
      await this.db.prepare(
        `INSERT INTO backup_snapshots (
           backup_id, manifest_digest, manifest_key, d1_bookmark,
           d1_export_key, d1_export_digest, d1_export_size,
           r2_descriptor_prefix, r2_descriptor_set_digest, r2_object_count,
           r2_total_bytes, status, created_at, sealed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?, ?)
         ON CONFLICT(backup_id) DO NOTHING`,
      ).bind(
        manifest.backupId,
        manifest.digest,
        `backups/${manifest.backupId}/manifest.json`,
        manifest.d1.bookmark,
        manifest.d1.key,
        manifest.d1.digest,
        manifest.d1.size,
        manifest.r2.descriptorPrefix,
        manifest.r2.descriptorSetDigest,
        manifest.r2.objectCount,
        manifest.r2.totalBytes,
        manifest.createdAt,
        nowIso,
      ).run();
    } catch {
      throw new BackupRestoreError('manifest_conflict');
    }
    const persisted = await this.get(manifest.backupId);
    if (
      persisted === null ||
      persisted.manifestDigest !== manifest.digest ||
      persisted.bookmark !== manifest.d1.bookmark ||
      persisted.d1ExportDigest !== manifest.d1.digest ||
      persisted.d1ExportSize !== manifest.d1.size ||
      persisted.r2DescriptorSetDigest !== manifest.r2.descriptorSetDigest ||
      persisted.r2ObjectCount !== manifest.r2.objectCount ||
      persisted.r2TotalBytes !== manifest.r2.totalBytes ||
      persisted.createdAt !== manifest.createdAt
    ) throw new BackupRestoreError('manifest_conflict');
    return persisted;
  }

  async get(rawBackupId: string): Promise<BackupSnapshotProjection | null> {
    const parsed = BackupIdSchema.safeParse(rawBackupId);
    if (!parsed.success) throw new BackupRestoreError('invalid_request');
    const row = await this.db.prepare(
      `SELECT backup_id, manifest_digest, d1_bookmark, d1_export_digest,
              d1_export_size, r2_descriptor_set_digest, r2_object_count,
              r2_total_bytes, created_at, sealed_at
       FROM backup_snapshots WHERE backup_id = ? AND status = 'sealed'`,
    ).bind(parsed.data).first<SnapshotRow>();
    return row === null ? null : snapshotProjection(row);
  }

  async list(limit = 50): Promise<BackupSnapshotProjection[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BackupRestoreError('invalid_request');
    }
    const rows = await this.db.prepare(
      `SELECT backup_id, manifest_digest, d1_bookmark, d1_export_digest,
              d1_export_size, r2_descriptor_set_digest, r2_object_count,
              r2_total_bytes, created_at, sealed_at
       FROM backup_snapshots WHERE status = 'sealed'
       ORDER BY created_at DESC, backup_id DESC LIMIT ?`,
    ).bind(limit).all<SnapshotRow>();
    return rows.results.map(snapshotProjection);
  }
}

export class BackupRestoreCoordinator {
  private readonly snapshots: BackupSnapshotStore;

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2BackupManager,
  ) {
    this.snapshots = new BackupSnapshotStore(db);
  }

  async fenceAndRestore(
    input: { restoreId: string; backupId: string; manifestDigest: string },
    now = new Date(),
  ): Promise<RestoreProjection & { created: boolean }> {
    const nowIso = validDate(now);
    if (
      !RESTORE_ID_PATTERN.test(input.restoreId) ||
      !BackupIdSchema.safeParse(input.backupId).success ||
      !BackupDigestSchema.safeParse(input.manifestDigest).success
    ) throw new BackupRestoreError('invalid_request');

    const manifest = await this.loadVerifiedManifest(input.backupId, input.manifestDigest);
    // D1 exports are taken before this index row is sealed. Re-registering the
    // verified R2 manifest makes recovery from that export self-hosting.
    await this.snapshots.seal(manifest, now);

    let results: D1Result<unknown>[];
    try {
      const guard =
        `EXISTS (
           SELECT 1 FROM restore_drills
           WHERE restore_id = ? AND status = 'fencing' AND fenced_at IS NULL
         ) AND EXISTS (
           SELECT 1 FROM control_plane_recovery_state
           WHERE singleton = 1 AND serving_state = 'restoring'
             AND current_restore_id = ?
         )`;
      results = await this.db.batch([
        this.db.prepare(
          `INSERT OR IGNORE INTO restore_drills (
             restore_id, backup_id, manifest_digest, restore_generation,
             status, requested_at, fenced_at, completed_at
           )
           SELECT ?, snapshots.backup_id, snapshots.manifest_digest,
                  recovery.restore_generation + 1, 'fencing', ?, NULL, NULL
           FROM backup_snapshots AS snapshots
           JOIN control_plane_recovery_state AS recovery ON recovery.singleton = 1
           WHERE snapshots.backup_id = ? AND snapshots.manifest_digest = ?
             AND recovery.serving_state = 'active'
             AND recovery.current_restore_id IS NULL`,
        ).bind(
          input.restoreId,
          nowIso,
          input.backupId,
          input.manifestDigest,
        ),
        this.db.prepare(
          `UPDATE control_plane_recovery_state
           SET restore_generation = restore_generation + 1,
               serving_state = 'restoring', current_restore_id = ?, updated_at = ?
           WHERE singleton = 1 AND serving_state = 'active'
             AND current_restore_id IS NULL
             AND EXISTS (
               SELECT 1 FROM restore_drills
               WHERE restore_id = ? AND status = 'fencing' AND fenced_at IS NULL
             )`,
        ).bind(input.restoreId, nowIso, input.restoreId),
        this.db.prepare(
          `INSERT OR IGNORE INTO restore_run_fences (
             restore_id, run_id, from_state, from_version, fenced_version, fenced_at
           )
           SELECT ?, run_id, state, version, version + 1, ? FROM runs
           WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
             AND ${guard}`,
        ).bind(input.restoreId, nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `INSERT OR IGNORE INTO restore_token_revocations (
             restore_id, token_id, attempt_id, lease_generation, revoked_at
           )
           SELECT ?, token_id, attempt_id, lease_generation, ? FROM attempt_tokens
           WHERE revoked_at IS NULL AND expires_at > ? AND ${guard}`,
        ).bind(
          input.restoreId,
          nowIso,
          nowIso,
          input.restoreId,
          input.restoreId,
        ),
        this.db.prepare(
          `UPDATE attempt_tokens SET revoked_at = ?
           WHERE revoked_at IS NULL AND expires_at > ? AND ${guard}`,
        ).bind(nowIso, nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE attempts
           SET status = 'lost', version = version + 1,
               lease_generation = lease_generation + 1,
               lease_token_digest = NULL, lease_expires_at = NULL,
               heartbeat_at = ?, updated_at = ?
           WHERE status IN ('pending', 'starting', 'running', 'cancel_requested')
             AND ${guard}`,
        ).bind(nowIso, nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE plan_item_progress
           SET status = 'blocked', active_attempt_id = NULL,
               version = version + 1, updated_at = ?
           WHERE status IN ('pending', 'ready', 'in_progress') AND ${guard}`,
        ).bind(nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE execution_plans SET status = 'blocked', updated_at = ?
           WHERE status IN ('approved', 'active') AND ${guard}`,
        ).bind(nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE github_write_credentials
           SET status = 'revocation_pending', issue_lease_token = NULL,
               issue_lease_expires_at = NULL, revocation_lease_token = NULL,
               revocation_lease_expires_at = NULL, updated_at = ?
           WHERE status IN ('issuing', 'active', 'revoking') AND ${guard}`,
        ).bind(nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE outbox
           SET delivery_state = 'pending', lease_token = NULL,
               lease_expires_at = NULL, last_error_code = 'restore_fenced',
               updated_at = ?
           WHERE delivery_state = 'delivering' AND ${guard}`,
        ).bind(nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE quota_concurrency_reservations
           SET released_at = ?, release_reason = 'expired', updated_at = ?
           WHERE released_at IS NULL AND ${guard}`,
        ).bind(nowIso, nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE quota_model_reservations SET status = 'expired', updated_at = ?
           WHERE status = 'reserved' AND ${guard}`,
        ).bind(nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE runs SET state = 'blocked', version = version + 1, updated_at = ?
           WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
             AND ${guard}`,
        ).bind(nowIso, input.restoreId, input.restoreId),
        this.db.prepare(
          `UPDATE restore_drills SET status = 'restoring', fenced_at = ?
           WHERE restore_id = ? AND status = 'fencing' AND fenced_at IS NULL
             AND EXISTS (
               SELECT 1 FROM control_plane_recovery_state
               WHERE singleton = 1 AND serving_state = 'restoring'
                 AND current_restore_id = restore_drills.restore_id
             )`,
        ).bind(nowIso, input.restoreId),
      ]);
    } catch {
      throw new BackupRestoreError('state_conflict');
    }

    const restore = await this.restoreRow(input.restoreId);
    if (
      restore === null || restore.backup_id !== input.backupId ||
      restore.manifest_digest !== input.manifestDigest
    ) throw new BackupRestoreError('state_conflict');
    try {
      await this.objects.restoreAll(manifest.backupId, manifest.r2);
    } catch (error) {
      if (error instanceof R2BackupError) throw new BackupRestoreError('object_conflict');
      throw error;
    }
    return {
      ...await this.projection(restore),
      created: results[0]?.meta.changes === 1,
    };
  }

  async complete(rawRestoreId: string, now = new Date()): Promise<RestoreProjection> {
    const nowIso = validDate(now);
    if (!RESTORE_ID_PATTERN.test(rawRestoreId)) {
      throw new BackupRestoreError('invalid_request');
    }
    const restore = await this.restoreRow(rawRestoreId);
    if (restore === null) throw new BackupRestoreError('not_found');
    if (restore.status === 'ready') return await this.projection(restore);
    if (restore.status !== 'restoring') throw new BackupRestoreError('state_conflict');
    const manifest = await this.loadVerifiedManifest(
      restore.backup_id,
      restore.manifest_digest,
    );

    let r2Count: number;
    try {
      await this.objects.verifyD1Export(manifest.d1);
      const verified = await this.objects.verifyAll(manifest.backupId, manifest.r2);
      const references = await this.r2References();
      await this.objects.verifyReferences(manifest.backupId, manifest.r2, references);
      r2Count = verified.objectCount + references.length + 1;
    } catch (error) {
      if (error instanceof R2BackupError) throw new BackupRestoreError('object_conflict');
      throw error;
    }

    if (await this.count(
      `SELECT COUNT(*) AS count FROM github_write_credentials
       WHERE status IN ('issuing', 'active', 'revocation_pending', 'revoking')`,
    ) > 0) throw new BackupRestoreError('credential_pending');

    const checks = await this.consistencyChecks(rawRestoreId, nowIso, r2Count);
    try {
      const statements = checks.map((check) => this.db.prepare(
        `INSERT OR IGNORE INTO restore_consistency_checks (
           restore_id, category, passed, checked_count, checked_at
         ) VALUES (?, ?, 1, ?, ?)`,
      ).bind(rawRestoreId, check.category, check.checkedCount, nowIso));
      const results = await this.db.batch([
        ...statements,
        this.db.prepare(
          `UPDATE control_plane_recovery_state
           SET serving_state = 'active', current_restore_id = NULL, updated_at = ?
           WHERE singleton = 1 AND serving_state = 'restoring'
             AND current_restore_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM github_write_credentials
               WHERE status IN ('issuing', 'active', 'revocation_pending', 'revoking')
             )
             AND NOT EXISTS (
               SELECT 1 FROM attempt_tokens
               WHERE revoked_at IS NULL AND expires_at > ?
             )`,
        ).bind(nowIso, rawRestoreId, nowIso),
        this.db.prepare(
          `UPDATE restore_drills SET status = 'ready', completed_at = ?
           WHERE restore_id = ? AND status = 'restoring'
             AND EXISTS (
               SELECT 1 FROM control_plane_recovery_state
               WHERE singleton = 1 AND serving_state = 'active'
                 AND current_restore_id IS NULL
             )`,
        ).bind(nowIso, rawRestoreId),
      ]);
      if (results.at(-2)?.meta.changes !== 1 || results.at(-1)?.meta.changes !== 1) {
        throw new BackupRestoreError('state_conflict');
      }
    } catch (error) {
      if (error instanceof BackupRestoreError) throw error;
      throw new BackupRestoreError('state_conflict');
    }
    const completed = await this.restoreRow(rawRestoreId);
    if (completed === null || completed.status !== 'ready') {
      throw new BackupRestoreError('state_conflict');
    }
    return await this.projection(completed);
  }

  async get(rawRestoreId: string): Promise<RestoreProjection | null> {
    if (!RESTORE_ID_PATTERN.test(rawRestoreId)) {
      throw new BackupRestoreError('invalid_request');
    }
    const row = await this.restoreRow(rawRestoreId);
    return row === null ? null : await this.projection(row);
  }

  async servingState(): Promise<{ servingState: 'active' | 'restoring'; restoreGeneration: number }> {
    const row = await this.db.prepare(
      `SELECT serving_state, restore_generation
       FROM control_plane_recovery_state WHERE singleton = 1`,
    ).first<{ serving_state: 'active' | 'restoring'; restore_generation: number }>();
    if (row === null) throw new BackupRestoreError('state_conflict');
    return { servingState: row.serving_state, restoreGeneration: row.restore_generation };
  }

  async auditLongTermRun(runId: string, now = new Date()): Promise<{
    runId: string;
    state: string;
    platformStatus: string | null;
    ageDays: number;
    taskDigest: string;
    planDigest: string | null;
    approvalCount: number;
    evidenceCount: number;
  }> {
    const nowIso = validDate(now);
    if (!RESTORE_ID_PATTERN.test(runId)) throw new BackupRestoreError('invalid_request');
    const row = await this.db.prepare(
      `SELECT runs.run_id, runs.state, runs.created_at, tasks.task_digest,
              plans.digest AS plan_digest,
              reconciliation.platform_status,
              (SELECT COUNT(*) FROM approvals WHERE approvals.run_id = runs.run_id)
                AS approval_count,
              (SELECT COUNT(*) FROM evidence WHERE evidence.run_id = runs.run_id)
                AS evidence_count
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       LEFT JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       LEFT JOIN workflow_instance_reconciliation_state AS reconciliation
         ON reconciliation.run_id = runs.run_id
       WHERE runs.run_id = ?`,
    ).bind(runId).first<{
      run_id: string;
      state: string;
      created_at: string;
      task_digest: string;
      plan_digest: string | null;
      platform_status: string | null;
      approval_count: number;
      evidence_count: number;
    }>();
    if (row === null) throw new BackupRestoreError('not_found');
    const ageDays = (Date.parse(nowIso) - Date.parse(row.created_at)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0) {
      throw new BackupRestoreError('consistency_conflict');
    }
    return {
      runId: row.run_id,
      state: row.state,
      platformStatus: row.platform_status,
      ageDays,
      taskDigest: row.task_digest,
      planDigest: row.plan_digest,
      approvalCount: row.approval_count,
      evidenceCount: row.evidence_count,
    };
  }

  private async loadVerifiedManifest(
    backupId: string,
    manifestDigest: string,
  ): Promise<BackupManifestV1> {
    try {
      const manifest = await this.objects.loadManifest(backupId, manifestDigest);
      await this.objects.verifyD1Export(manifest.d1);
      return manifest;
    } catch (error) {
      if (error instanceof R2BackupError) {
        throw new BackupRestoreError(
          error.code === 'manifest_conflict' ? 'manifest_conflict' : 'object_conflict',
        );
      }
      throw error;
    }
  }

  private async consistencyChecks(
    restoreId: string,
    nowIso: string,
    r2Count: number,
  ): Promise<RestoreConsistencyCheck[]> {
    const queryChecks: Array<{
      category: Exclude<RestoreCheckCategory, 'foreign_keys' | 'r2' | 'token'>;
      sql: string;
      bindings?: string[];
    }> = [
      {
        category: 'task',
        sql: `SELECT COUNT(*) AS total,
                     SUM(CASE WHEN payload_ref NOT LIKE 'r2://%'
                              OR length(task_digest) <> 71 THEN 1 ELSE 0 END) AS invalid
              FROM tasks`,
      },
      {
        category: 'run',
        sql: `SELECT COUNT(*) AS total,
                     SUM(CASE WHEN tasks.task_id IS NULL
                              OR runs.task_revision <> tasks.task_revision
                              OR runs.task_digest <> tasks.task_digest
                              OR runs.state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked')
                              THEN 1 ELSE 0 END) AS invalid
              FROM runs LEFT JOIN tasks ON tasks.task_id = runs.task_id`,
      },
      {
        category: 'plan',
        sql: `SELECT COUNT(*) AS total,
                     SUM(CASE WHEN runs.run_id IS NULL OR execution_plans.status = 'active'
                              OR execution_plans.task_revision <> runs.task_revision
                              THEN 1 ELSE 0 END) AS invalid
              FROM execution_plans
              LEFT JOIN runs ON runs.run_id = execution_plans.run_id`,
      },
      {
        category: 'approval',
        sql: `SELECT COUNT(*) AS total,
                     SUM(CASE WHEN runs.run_id IS NULL OR plans.plan_id IS NULL
                              OR approvals.task_revision <> runs.task_revision
                              OR approvals.plan_version <> plans.plan_version
                              OR approvals.plan_digest <> plans.digest
                              OR approvals.base_sha <> runs.base_sha
                              THEN 1 ELSE 0 END) AS invalid
              FROM approvals
              LEFT JOIN runs ON runs.run_id = approvals.run_id
              LEFT JOIN execution_plans AS plans ON plans.plan_id = approvals.plan_id`,
      },
      {
        category: 'evidence',
        sql: `SELECT COUNT(*) AS total,
                     SUM(CASE WHEN runs.run_id IS NULL
                              OR (evidence.attempt_id IS NOT NULL AND attempts.attempt_id IS NULL)
                              OR (evidence.plan_id IS NOT NULL AND plans.plan_id IS NULL)
                              THEN 1 ELSE 0 END) AS invalid
              FROM evidence
              LEFT JOIN runs ON runs.run_id = evidence.run_id
              LEFT JOIN attempts ON attempts.attempt_id = evidence.attempt_id
              LEFT JOIN execution_plans AS plans ON plans.plan_id = evidence.plan_id`,
      },
      {
        category: 'audit',
        sql: `SELECT
                (SELECT COUNT(*) FROM restore_run_fences WHERE restore_id = ?) +
                (SELECT COUNT(*) FROM restore_token_revocations WHERE restore_id = ?) AS total,
                (SELECT COUNT(*) FROM restore_run_fences AS fences
                 JOIN runs ON runs.run_id = fences.run_id
                 WHERE fences.restore_id = ? AND (
                   runs.state <> 'blocked' OR runs.version <> fences.fenced_version
                 )) +
                (SELECT COUNT(*) FROM restore_token_revocations AS revocations
                 JOIN attempt_tokens AS tokens ON tokens.token_id = revocations.token_id
                 WHERE revocations.restore_id = ? AND tokens.revoked_at IS NULL) AS invalid`,
        bindings: [restoreId, restoreId, restoreId, restoreId],
      },
    ];
    const checks: RestoreConsistencyCheck[] = [];
    for (const query of queryChecks) {
      const row = await this.db.prepare(query.sql)
        .bind(...(query.bindings ?? []))
        .first<ConsistencyCountRow>();
      if (row === null || Number(row.invalid ?? 0) !== 0) {
        throw new BackupRestoreError('consistency_conflict');
      }
      checks.push({
        category: query.category,
        passed: true,
        checkedCount: Number(row.total ?? 0),
        checkedAt: nowIso,
      });
    }

    const foreignKeys = await this.db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.results.length > 0) throw new BackupRestoreError('consistency_conflict');
    checks.push({
      category: 'foreign_keys',
      passed: true,
      checkedCount: 0,
      checkedAt: nowIso,
    });
    checks.push({ category: 'r2', passed: true, checkedCount: r2Count, checkedAt: nowIso });

    const tokenInvalid = await this.count(
      `SELECT
         (SELECT COUNT(*) FROM attempt_tokens
          WHERE revoked_at IS NULL AND expires_at > ?) +
         (SELECT COUNT(*) FROM attempts
          WHERE status IN ('pending', 'starting', 'running', 'cancel_requested')) +
         (SELECT COUNT(*) FROM outbox WHERE delivery_state = 'delivering') +
         (SELECT COUNT(*) FROM quota_concurrency_reservations WHERE released_at IS NULL) +
         (SELECT COUNT(*) FROM quota_model_reservations WHERE status = 'reserved') AS count`,
      [nowIso],
    );
    if (tokenInvalid !== 0) throw new BackupRestoreError('consistency_conflict');
    const tokenCount = await this.count(
      `SELECT COUNT(*) AS count FROM restore_token_revocations WHERE restore_id = ?`,
      [restoreId],
    );
    checks.push({
      category: 'token',
      passed: true,
      checkedCount: tokenCount,
      checkedAt: nowIso,
    });
    return checks;
  }

  private async r2References(): Promise<BackupR2Reference[]> {
    const rows = await this.db.prepare(
      `SELECT reference_id, bucket, object_key, expected_digest, metadata_key
       FROM backup_r2_references ORDER BY bucket, object_key, reference_id`,
    ).all<ReferenceRow>();
    return rows.results.map((row) => ({
      referenceId: row.reference_id,
      bucket: row.bucket,
      objectKey: row.object_key,
      expectedDigest: row.expected_digest,
      metadataKey: row.metadata_key,
    }));
  }

  private async projection(row: RestoreRow): Promise<RestoreProjection> {
    const checks = await this.db.prepare(
      `SELECT category, checked_count, checked_at
       FROM restore_consistency_checks WHERE restore_id = ? ORDER BY category`,
    ).bind(row.restore_id).all<{
      category: RestoreCheckCategory;
      checked_count: number;
      checked_at: string;
    }>();
    return {
      restoreId: row.restore_id,
      backupId: row.backup_id,
      manifestDigest: row.manifest_digest,
      restoreGeneration: row.restore_generation,
      status: row.status,
      requestedAt: row.requested_at,
      fencedAt: row.fenced_at,
      completedAt: row.completed_at,
      checks: checks.results.map((check) => ({
        category: check.category,
        passed: true,
        checkedCount: check.checked_count,
        checkedAt: check.checked_at,
      })),
    };
  }

  private async restoreRow(restoreId: string): Promise<RestoreRow | null> {
    return await this.db.prepare(
      `SELECT restore_id, backup_id, manifest_digest, restore_generation,
              status, requested_at, fenced_at, completed_at
       FROM restore_drills WHERE restore_id = ?`,
    ).bind(restoreId).first<RestoreRow>();
  }

  private async count(sql: string, bindings: readonly unknown[] = []): Promise<number> {
    const row = await this.db.prepare(sql).bind(...bindings).first<CountRow>();
    if (row === null || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new BackupRestoreError('consistency_conflict');
    }
    return row.count;
  }
}
