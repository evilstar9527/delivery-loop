import { canonicalSha256 } from '../domain/digest.js';
import { RunnerAttemptError } from './runner-attempt-store.js';

// The fixed pre-heartbeat startup stages a runner reports, in order. Kept in
// sync with the migration's CHECK and the runner's own emission points.
export const RUNNER_STARTUP_STAGES = [
  'exchanged',
  'checked_out',
  'snapshotted',
  'context_loaded',
  'workspace_prepared',
  'reserving_model',
  'reserved_model',
  'launching_heartbeat',
] as const;

export type RunnerStartupStage = (typeof RUNNER_STARTUP_STAGES)[number];

export function isRunnerStartupStage(value: unknown): value is RunnerStartupStage {
  return typeof value === 'string' &&
    (RUNNER_STARTUP_STAGES as readonly string[]).includes(value);
}

/**
 * Append-only record of how far a runner progressed through startup. Auth is
 * deliberately light — a valid, non-revoked, non-expired attempt token is
 * required (so stages cannot be spoofed), but NOT the strict running/lease
 * checks the heartbeat uses: this is observability that must succeed across the
 * exact edge states (a frozen or lease-lapsed attempt) we are trying to see.
 */
export class RunnerStartupStageStore {
  constructor(private readonly db: D1Database) {}

  async record(
    attemptId: string,
    rawToken: string,
    stage: RunnerStartupStage,
    now = new Date(),
  ): Promise<void> {
    if (!isRunnerStartupStage(stage)) throw new RunnerAttemptError('invalid_token');
    const tokenDigest = await canonicalSha256(rawToken);
    const nowIso = now.toISOString();
    const authorized = await this.db
      .prepare(
        `SELECT 1 AS ok
         FROM attempt_tokens
         WHERE attempt_id = ?
           AND token_digest = ?
           AND revoked_at IS NULL
           AND expires_at > ?
         LIMIT 1`,
      )
      .bind(attemptId, tokenDigest, nowIso)
      .first<{ ok: number }>();
    if (authorized === null) throw new RunnerAttemptError('invalid_token');
    // One row per (attempt, stage, timestamp). A deterministic id keyed on the
    // timestamp keeps repeated stages (e.g. reserving_model per invocation)
    // distinct while staying idempotent under an at-least-once POST retry.
    const identity = await canonicalSha256({ attemptId, stage, at: nowIso });
    const id = `runner_stage_${identity.slice('sha256:'.length, 'sha256:'.length + 48)}`;
    await this.db
      .prepare(
        `INSERT INTO runner_startup_stages (id, attempt_id, stage, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(id, attemptId, stage, nowIso)
      .run();
  }
}
