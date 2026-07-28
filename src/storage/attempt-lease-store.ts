import { canonicalSha256 } from '../domain/digest.js';

const WRITE_MODES = "('implement', 'review_fix', 'deploy')";

export interface AcquiredAttemptLease {
  acquired: true;
  attemptId: string;
  runId: string;
  version: number;
  leaseGeneration: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface AttemptLeaseNotAcquired {
  acquired: false;
  reason: 'lease_conflict' | 'not_found';
}

export type AttemptLeaseAcquireResult = AcquiredAttemptLease | AttemptLeaseNotAcquired;

export interface AttemptLeaseHeartbeatInput {
  attemptId: string;
  runId: string;
  expectedVersion: number;
  leaseGeneration: number;
  leaseToken: string;
}

export interface RenewedAttemptLease {
  renewed: true;
  version: number;
  leaseGeneration: number;
  leaseExpiresAt: string;
}

export interface AttemptLeaseNotRenewed {
  renewed: false;
  reason: 'lease_conflict' | 'not_found';
}

export type AttemptLeaseHeartbeatResult = RenewedAttemptLease | AttemptLeaseNotRenewed;

interface AttemptLeaseStoreOptions {
  now?: () => Date;
  generateLeaseToken?: () => string;
  leaseMs?: number;
}

interface AttemptLeaseRow {
  attempt_id: string;
  run_id: string;
  version: number;
  lease_generation: number;
  lease_token_digest: string | null;
  lease_expires_at: string | null;
}

/**
 * D1 adapter for the one-active-write-attempt invariant.
 *
 * The conditional UPDATE + `meta.changes` conflict check is copied from Watt's
 * D1 structured/vector providers. Attempt-specific generation, expiry and token
 * digest predicates extend that CAS skeleton with runner fencing.
 */
export class AttemptLeaseStore {
  private readonly now: () => Date;
  private readonly generateLeaseToken: () => string;
  private readonly leaseMs: number;

  constructor(
    private readonly db: D1Database,
    options: AttemptLeaseStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateLeaseToken = options.generateLeaseToken ?? (() => crypto.randomUUID());
    this.leaseMs = options.leaseMs ?? 45_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error('attempt lease duration must be a positive integer');
    }
  }

  async acquireWriteLease(
    runId: string,
    attemptId: string,
    expectedVersion: number,
  ): Promise<AttemptLeaseAcquireResult> {
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseToken = this.generateLeaseToken();
    if (leaseToken.length === 0) throw new Error('attempt lease token must not be empty');
    const leaseTokenDigest = await canonicalSha256(leaseToken);
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();

    const result = await this.db
      .prepare(
        `UPDATE attempts
         SET status = 'running',
             version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = ?,
             lease_expires_at = ?,
             heartbeat_at = ?,
             updated_at = ?
         WHERE attempt_id = ?
           AND run_id = ?
           AND version = ?
           AND mode IN ${WRITE_MODES}
           AND status IN ('pending', 'starting', 'running')
           AND (
             lease_token_digest IS NULL
             OR lease_expires_at IS NULL
             OR lease_expires_at <= ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM attempts AS active_attempt
             WHERE active_attempt.run_id = ?
               AND active_attempt.attempt_id <> ?
               AND active_attempt.mode IN ${WRITE_MODES}
               AND active_attempt.status IN ('starting', 'running')
               AND active_attempt.lease_token_digest IS NOT NULL
               AND active_attempt.lease_expires_at > ?
           )`,
      )
      .bind(
        leaseTokenDigest,
        leaseExpiresAt,
        nowIso,
        nowIso,
        attemptId,
        runId,
        expectedVersion,
        nowIso,
        runId,
        attemptId,
        nowIso,
      )
      .run();

    // Copied Watt CAS discipline: zero changed rows is a conflict, never success.
    if (result.meta.changes !== 1) return await this.acquireConflict(attemptId, runId);

    const row = await this.read(attemptId, runId);
    if (
      row === null ||
      row.version !== expectedVersion + 1 ||
      row.lease_token_digest !== leaseTokenDigest ||
      row.lease_expires_at !== leaseExpiresAt
    ) {
      return { acquired: false, reason: 'lease_conflict' };
    }
    return {
      acquired: true,
      attemptId,
      runId,
      version: row.version,
      leaseGeneration: row.lease_generation,
      leaseToken,
      leaseExpiresAt,
    };
  }

  async heartbeat(input: AttemptLeaseHeartbeatInput): Promise<AttemptLeaseHeartbeatResult> {
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const leaseTokenDigest = await canonicalSha256(input.leaseToken);
    const result = await this.db
      .prepare(
        `UPDATE attempts
         SET version = version + 1,
             lease_expires_at = ?,
             heartbeat_at = ?,
             updated_at = ?
         WHERE attempt_id = ?
           AND run_id = ?
           AND version = ?
           AND status = 'running'
           AND mode IN ${WRITE_MODES}
           AND lease_generation = ?
           AND lease_token_digest = ?
           AND lease_expires_at > ?`,
      )
      .bind(
        leaseExpiresAt,
        nowIso,
        nowIso,
        input.attemptId,
        input.runId,
        input.expectedVersion,
        input.leaseGeneration,
        leaseTokenDigest,
        nowIso,
      )
      .run();
    if (result.meta.changes !== 1) {
      const row = await this.read(input.attemptId, input.runId);
      return {
        renewed: false,
        reason: row === null ? 'not_found' : 'lease_conflict',
      };
    }
    return {
      renewed: true,
      version: input.expectedVersion + 1,
      leaseGeneration: input.leaseGeneration,
      leaseExpiresAt,
    };
  }

  private async acquireConflict(
    attemptId: string,
    runId: string,
  ): Promise<AttemptLeaseNotAcquired> {
    return {
      acquired: false,
      reason: (await this.read(attemptId, runId)) === null ? 'not_found' : 'lease_conflict',
    };
  }

  private async read(attemptId: string, runId: string): Promise<AttemptLeaseRow | null> {
    return await this.db
      .prepare(
        `SELECT attempt_id, run_id, version, lease_generation,
                lease_token_digest, lease_expires_at
         FROM attempts
         WHERE attempt_id = ? AND run_id = ?`,
      )
      .bind(attemptId, runId)
      .first<AttemptLeaseRow>();
  }
}
