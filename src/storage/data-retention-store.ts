import { isExpired } from '../retention/ttl.js';

export const RAW_AGENT_RETENTION_POLICY = 'security-v1-raw-30d';
export const RAW_AGENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_BATCH_LIMIT = 100;
const CURSOR_NAME = 'raw_agent_artifacts';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RawAgentArtifactCategory = 'raw_session' | 'raw_transcript';
export type DataRetentionMode = 'dry_run' | 'execute';
export type DataRetentionSource = 'scheduled' | 'operations';
export type DataRetentionFailureCode =
  | 'metadata_conflict'
  | 'policy_conflict'
  | 'storage_unavailable'
  | 'verification_failed';

export interface RetentionObjectHead {
  etag: string;
  size: number;
  customMetadata?: Record<string, string>;
}

export interface RetentionObjectBucket {
  head(key: string): Promise<RetentionObjectHead | null>;
  delete(key: string): Promise<void>;
}

interface RawArtifactRow {
  object_id: string;
  object_identity_digest: string;
  category: RawAgentArtifactCategory;
  ciphertext_digest: string;
  size_bytes: number;
  r2_etag: string;
  policy_version: string;
  created_at: string;
  expires_at: string;
  deletion_state: 'active' | 'deleting' | 'retry';
  retry_count: number;
}

interface CursorRow {
  last_expires_at: string | null;
  last_object_id: string | null;
}

interface CountRow {
  category: RawAgentArtifactCategory;
  count: number;
}

export interface DataRetentionScanResult {
  scanId: string;
  mode: DataRetentionMode;
  source: DataRetentionSource;
  policyVersion: typeof RAW_AGENT_RETENTION_POLICY;
  candidateCount: number;
  claimedCount: number;
  deletedCount: number;
  alreadyAbsentCount: number;
  failedCount: number;
  rawSessionCount: number;
  rawTranscriptCount: number;
  startedAt: string;
  completedAt: string;
}

interface DataRetentionStoreOptions {
  now?: () => Date;
  generateId?: () => string;
}

function iso(date: Date): string {
  return date.toISOString();
}

function expectedExpiresAt(createdAt: string): string | null {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;
  return new Date(created + RAW_AGENT_RETENTION_SECONDS * 1000).toISOString();
}

export function rawAgentObjectKey(
  category: RawAgentArtifactCategory,
  objectId: string,
): string {
  if (!UUID_PATTERN.test(objectId)) throw new Error('invalid raw Agent object identity');
  const prefix = category === 'raw_session' ? 'raw-sessions' : 'raw-transcripts';
  return `${prefix}/${objectId}.ciphertext`;
}

/**
 * D1-fenced cleanup of explicitly registered raw Agent ciphertext.
 *
 * The conditional UPDATE + meta.changes winner check and prepare/bind style are
 * copied from Watt's D1 stores at commit
 * 476e3cdd2490d725fde174e7c697ebf00899edc6. The bounded cursor is adapted from
 * Watt's R2 purgeNamespace loop, but this implementation deliberately derives
 * one exact key per registry row instead of accepting or enumerating a prefix.
 */
export class DataRetentionStore {
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(
    private readonly db: D1Database,
    private readonly bucket: RetentionObjectBucket,
    options: DataRetentionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
  }

  async run(
    mode: DataRetentionMode,
    source: DataRetentionSource,
    requestedLimit = 25,
  ): Promise<DataRetentionScanResult> {
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), MAX_BATCH_LIMIT))
      : 25;
    const scanId = this.generateId();
    const startedAt = iso(this.now());
    await this.db.prepare(
      `INSERT INTO data_retention_scans (
         scan_id, mode, source, policy_version, status, batch_limit, started_at
       ) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).bind(scanId, mode, source, RAW_AGENT_RETENTION_POLICY, limit, startedAt).run();

    if (mode === 'dry_run') {
      return await this.preview(scanId, source, limit, startedAt);
    }
    return await this.execute(scanId, source, limit, startedAt);
  }

  private async preview(
    scanId: string,
    source: DataRetentionSource,
    limit: number,
    startedAt: string,
  ): Promise<DataRetentionScanResult> {
    const now = iso(this.now());
    const rows = await this.db.prepare(
      `SELECT category, COUNT(*) AS count
       FROM raw_agent_artifacts
       WHERE expires_at <= ?
         AND (
           deletion_state IN ('active', 'retry')
           OR (deletion_state = 'deleting' AND delete_claim_expires_at <= ?)
         )
       GROUP BY category`,
    ).bind(now, now).all<CountRow>();
    const rawSessionCount = rows.results.find((row) => row.category === 'raw_session')?.count ?? 0;
    const rawTranscriptCount = rows.results.find((row) => row.category === 'raw_transcript')?.count ?? 0;
    return await this.finishScan({
      scanId,
      mode: 'dry_run',
      source,
      policyVersion: RAW_AGENT_RETENTION_POLICY,
      candidateCount: rawSessionCount + rawTranscriptCount,
      claimedCount: 0,
      deletedCount: 0,
      alreadyAbsentCount: 0,
      failedCount: 0,
      rawSessionCount,
      rawTranscriptCount,
      startedAt,
      completedAt: now,
    }, limit);
  }

  private async execute(
    scanId: string,
    source: DataRetentionSource,
    limit: number,
    startedAt: string,
  ): Promise<DataRetentionScanResult> {
    const candidates = await this.nextCandidates(limit);
    let claimedCount = 0;
    let deletedCount = 0;
    let alreadyAbsentCount = 0;
    let failedCount = 0;
    let rawSessionCount = 0;
    let rawTranscriptCount = 0;

    for (const candidate of candidates) {
      if (candidate.category === 'raw_session') rawSessionCount += 1;
      else rawTranscriptCount += 1;
      const claimId = this.generateId();
      if (!await this.claim(candidate.object_id, claimId)) continue;
      claimedCount += 1;
      const outcome = await this.deleteClaimed(scanId, candidate, claimId);
      if (outcome === 'deleted') deletedCount += 1;
      else if (outcome === 'already_absent') alreadyAbsentCount += 1;
      else failedCount += 1;
    }

    return await this.finishScan({
      scanId,
      mode: 'execute',
      source,
      policyVersion: RAW_AGENT_RETENTION_POLICY,
      candidateCount: candidates.length,
      claimedCount,
      deletedCount,
      alreadyAbsentCount,
      failedCount,
      rawSessionCount,
      rawTranscriptCount,
      startedAt,
      completedAt: iso(this.now()),
    }, limit);
  }

  private async nextCandidates(limit: number): Promise<RawArtifactRow[]> {
    const now = iso(this.now());
    const cursor = await this.db.prepare(
      `SELECT last_expires_at, last_object_id
       FROM data_retention_cursor WHERE cursor_name = ?`,
    ).bind(CURSOR_NAME).first<CursorRow>();
    let candidates = await this.queryCandidates(now, limit, cursor ?? null);
    if (candidates.length === 0 && cursor !== null && cursor.last_expires_at !== null) {
      candidates = await this.queryCandidates(now, limit, null);
    }
    await this.advanceCursor(cursor ?? null, candidates.at(-1) ?? null, now);
    return candidates;
  }

  private async queryCandidates(
    now: string,
    limit: number,
    cursor: CursorRow | null,
  ): Promise<RawArtifactRow[]> {
    const after = cursor !== null &&
      cursor.last_expires_at !== null && cursor.last_object_id !== null;
    const statement = this.db.prepare(
      `SELECT object_id, object_identity_digest, category, ciphertext_digest,
              size_bytes, r2_etag, policy_version, created_at, expires_at,
              deletion_state, retry_count
       FROM raw_agent_artifacts
       WHERE expires_at <= ?
         AND (
           deletion_state IN ('active', 'retry')
           OR (deletion_state = 'deleting' AND delete_claim_expires_at <= ?)
         )
         ${after ? 'AND (expires_at > ? OR (expires_at = ? AND object_id > ?))' : ''}
       ORDER BY expires_at, object_id
       LIMIT ?`,
    );
    const bound = after
      ? statement.bind(
        now,
        now,
        cursor!.last_expires_at,
        cursor!.last_expires_at,
        cursor!.last_object_id,
        limit,
      )
      : statement.bind(now, now, limit);
    const rows = await bound.all<RawArtifactRow>();
    return rows.results;
  }

  private async advanceCursor(
    observed: CursorRow | null,
    last: RawArtifactRow | null,
    now: string,
  ): Promise<void> {
    const nextExpiresAt = last?.expires_at ?? null;
    const nextObjectId = last?.object_id ?? null;
    if (observed === null) {
      await this.db.prepare(
        `INSERT OR IGNORE INTO data_retention_cursor (
           cursor_name, last_expires_at, last_object_id, updated_at
         ) VALUES (?, ?, ?, ?)`,
      ).bind(CURSOR_NAME, nextExpiresAt, nextObjectId, now).run();
      return;
    }
    await this.db.prepare(
      `UPDATE data_retention_cursor
       SET last_expires_at = ?, last_object_id = ?, updated_at = ?
       WHERE cursor_name = ?
         AND last_expires_at IS ?
         AND last_object_id IS ?`,
    ).bind(
      nextExpiresAt,
      nextObjectId,
      now,
      CURSOR_NAME,
      observed.last_expires_at,
      observed.last_object_id,
    ).run();
  }

  private async claim(objectId: string, claimId: string): Promise<boolean> {
    const now = this.now();
    const claimed = await this.db.prepare(
      `UPDATE raw_agent_artifacts
       SET deletion_state = 'deleting', delete_claim_id = ?,
           delete_claim_expires_at = ?, updated_at = ?
       WHERE object_id = ?
         AND expires_at <= ?
         AND (
           deletion_state IN ('active', 'retry')
           OR (deletion_state = 'deleting' AND delete_claim_expires_at <= ?)
         )`,
    ).bind(
      claimId,
      iso(new Date(now.getTime() + CLAIM_TTL_MS)),
      iso(now),
      objectId,
      iso(now),
      iso(now),
    ).run();
    // Copied Watt fencing rule: the external effect belongs only to the one
    // conditional-update winner.
    return claimed.meta.changes === 1;
  }

  private async deleteClaimed(
    scanId: string,
    row: RawArtifactRow,
    claimId: string,
  ): Promise<'deleted' | 'already_absent' | 'failed'> {
    const expectedExpiry = expectedExpiresAt(row.created_at);
    if (
      row.policy_version !== RAW_AGENT_RETENTION_POLICY ||
      expectedExpiry !== row.expires_at ||
      !isExpired(row.created_at, RAW_AGENT_RETENTION_SECONDS, this.now().getTime())
    ) {
      await this.fail(scanId, row, claimId, 'policy_conflict');
      return 'failed';
    }

    let key: string;
    try {
      key = rawAgentObjectKey(row.category, row.object_id);
    } catch {
      await this.fail(scanId, row, claimId, 'policy_conflict');
      return 'failed';
    }
    try {
      const before = await this.bucket.head(key);
      if (before === null) {
        await this.complete(scanId, row, claimId, 'already_absent');
        return 'already_absent';
      }
      if (!this.metadataMatches(before, row)) {
        await this.fail(scanId, row, claimId, 'metadata_conflict');
        return 'failed';
      }
      await this.bucket.delete(key);
      if (await this.bucket.head(key) !== null) {
        await this.fail(scanId, row, claimId, 'verification_failed');
        return 'failed';
      }
      await this.complete(scanId, row, claimId, 'deleted');
      return 'deleted';
    } catch {
      // Raw upstream errors are deliberately discarded. The stable failure
      // class is enough to retry and audit without persisting payload content.
      await this.fail(scanId, row, claimId, 'storage_unavailable');
      return 'failed';
    }
  }

  private metadataMatches(head: RetentionObjectHead, row: RawArtifactRow): boolean {
    const metadata = head.customMetadata;
    return head.etag === row.r2_etag && head.size === row.size_bytes &&
      metadata?.schemaVersion === '1' && metadata.retentionClass === row.category &&
      metadata.objectId === row.object_id && metadata.ciphertextDigest === row.ciphertext_digest &&
      metadata.encryption === 'AES-256-GCM';
  }

  private async complete(
    scanId: string,
    row: RawArtifactRow,
    claimId: string,
    result: 'deleted' | 'already_absent',
  ): Promise<void> {
    const now = iso(this.now());
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO data_retention_deletion_audit (
           audit_id, scan_id, object_identity_digest, category, policy_version,
           expires_at, attempt_ordinal, result, failure_code, created_at
         )
         SELECT ?, ?, object_identity_digest, category, policy_version,
                expires_at, retry_count + 1, ?, NULL, ?
         FROM raw_agent_artifacts
         WHERE object_id = ? AND deletion_state = 'deleting' AND delete_claim_id = ?`,
      ).bind(this.generateId(), scanId, result, now, row.object_id, claimId),
      this.db.prepare(
        `UPDATE raw_agent_artifacts
         SET deletion_state = 'deleted', delete_claim_id = NULL,
             delete_claim_expires_at = NULL, deleted_at = ?,
             last_failure_code = NULL, updated_at = ?
         WHERE object_id = ? AND deletion_state = 'deleting' AND delete_claim_id = ?`,
      ).bind(now, now, row.object_id, claimId),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new Error('retention completion fencing conflict');
    }
  }

  private async fail(
    scanId: string,
    row: RawArtifactRow,
    claimId: string,
    failureCode: DataRetentionFailureCode,
  ): Promise<void> {
    const now = iso(this.now());
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO data_retention_deletion_audit (
           audit_id, scan_id, object_identity_digest, category, policy_version,
           expires_at, attempt_ordinal, result, failure_code, created_at
         )
         SELECT ?, ?, object_identity_digest, category, policy_version,
                expires_at, retry_count + 1, 'failed', ?, ?
         FROM raw_agent_artifacts
         WHERE object_id = ? AND deletion_state = 'deleting' AND delete_claim_id = ?`,
      ).bind(this.generateId(), scanId, failureCode, now, row.object_id, claimId),
      this.db.prepare(
        `UPDATE raw_agent_artifacts
         SET deletion_state = 'retry', delete_claim_id = NULL,
             delete_claim_expires_at = NULL, retry_count = retry_count + 1,
             last_failure_code = ?, updated_at = ?
         WHERE object_id = ? AND deletion_state = 'deleting' AND delete_claim_id = ?`,
      ).bind(failureCode, now, row.object_id, claimId),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new Error('retention failure fencing conflict');
    }
  }

  private async finishScan(
    result: DataRetentionScanResult,
    limit: number,
  ): Promise<DataRetentionScanResult> {
    const completed = await this.db.prepare(
      `UPDATE data_retention_scans
       SET status = 'completed', candidate_count = ?, claimed_count = ?,
           deleted_count = ?, already_absent_count = ?, failed_count = ?,
           raw_session_count = ?, raw_transcript_count = ?, completed_at = ?
       WHERE scan_id = ? AND status = 'running' AND batch_limit = ?`,
    ).bind(
      result.candidateCount,
      result.claimedCount,
      result.deletedCount,
      result.alreadyAbsentCount,
      result.failedCount,
      result.rawSessionCount,
      result.rawTranscriptCount,
      result.completedAt,
      result.scanId,
      limit,
    ).run();
    if (completed.meta.changes !== 1) throw new Error('retention scan completion conflict');
    return result;
  }
}
