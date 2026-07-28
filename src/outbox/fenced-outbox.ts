export type OutboxDeliveryResult = 'settled' | 'retry' | 'busy' | 'missing';

export interface FencedOutboxRecord {
  outboxId: string;
  runId: string;
  kind: string;
  destination: string;
  payloadRef: string;
  attemptCount: number;
}

export interface OutboxEffectOutcome {
  /** A safe terminal reason when reconciliation proves no external effect is needed. */
  settledCode?: string;
}

export interface FencedOutboxProcessorOptions {
  now?: () => Date;
  generateLeaseToken?: () => string;
  leaseMs?: number;
  unavailableErrorCode?: string;
  onRetry?: (input: {
    outboxId: string;
    runId: string;
    kind: string;
    payloadRef: string;
    attemptCount: number;
    errorCode: string;
    observedAt: string;
  }) => Promise<void>;
}

interface OutboxRow {
  outbox_id: string;
  run_id: string;
  kind: string;
  destination: string;
  payload_ref: string;
  delivery_state: string;
  lease_token: string | null;
  attempt_count: number;
}

export class OutboxEffectError extends Error {
  constructor(readonly code: string) {
    super(`outbox effect failed: ${code}`);
    this.name = 'OutboxEffectError';
  }
}

/**
 * Shared pending → delivering → settled processor.
 *
 * This is the Watt delivery pattern already proven by Workflow outbox tests,
 * extracted once so every external destination uses the same fencing rules.
 */
export class FencedOutboxProcessor {
  private readonly now: () => Date;
  private readonly generateLeaseToken: () => string;
  private readonly leaseMs: number;
  private readonly unavailableErrorCode: string;
  private readonly onRetry: FencedOutboxProcessorOptions['onRetry'];

  constructor(
    private readonly db: D1Database,
    private readonly destination: string,
    private readonly perform: (
      outbox: FencedOutboxRecord,
    ) => Promise<OutboxEffectOutcome | void>,
    options: FencedOutboxProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateLeaseToken = options.generateLeaseToken ?? (() => crypto.randomUUID());
    this.leaseMs = options.leaseMs ?? 30_000;
    this.unavailableErrorCode = options.unavailableErrorCode ?? 'destination_unavailable';
    this.onRetry = options.onRetry;
    if (destination.length === 0) throw new Error('outbox destination must not be empty');
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error('outbox lease duration must be a positive integer');
    }
  }

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseToken = this.generateLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const claimed = await this.db
      .prepare(
        `UPDATE outbox
         SET delivery_state = 'delivering',
             attempt_count = attempt_count + 1,
             lease_token = ?,
             lease_expires_at = ?,
             updated_at = ?
         WHERE outbox_id = ?
           AND destination = ?
           AND NOT EXISTS (
             SELECT 1 FROM outbox_dead_letters
             WHERE outbox_dead_letters.outbox_id = outbox.outbox_id
               AND outbox_dead_letters.status = 'open'
           )
           AND (
             delivery_state = 'pending'
             OR (
               delivery_state = 'delivering'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?
             )
           )`,
      )
      .bind(leaseToken, leaseExpiresAt, nowIso, outboxId, this.destination, nowIso)
      .run();
    if (claimed.meta.changes !== 1) {
      const current = await this.db
        .prepare('SELECT destination, delivery_state FROM outbox WHERE outbox_id = ?')
        .bind(outboxId)
        .first<{ destination: string; delivery_state: string }>();
      if (current === null) return 'missing';
      return current.destination === this.destination && current.delivery_state === 'settled'
        ? 'settled'
        : 'busy';
    }

    const row = await this.db
      .prepare(
        `SELECT outbox_id, run_id, kind, destination, payload_ref,
                delivery_state, lease_token, attempt_count
         FROM outbox WHERE outbox_id = ?`,
      )
      .bind(outboxId)
      .first<OutboxRow>();
    if (
      row === null ||
      row.destination !== this.destination ||
      row.delivery_state !== 'delivering' ||
      row.lease_token !== leaseToken
    ) {
      return 'busy';
    }

    try {
      const outcome = await this.perform({
        outboxId: row.outbox_id,
        runId: row.run_id,
        kind: row.kind,
        destination: row.destination,
        payloadRef: row.payload_ref,
        attemptCount: row.attempt_count,
      });
      const settledCode = outcome === undefined ? null : outcome.settledCode ?? null;
      if (
        settledCode !== null &&
        !/^[a-z][a-z0-9_]{0,63}$/.test(settledCode)
      ) {
        throw new OutboxEffectError('settled_code_invalid');
      }
      const settled = await this.db
        .prepare(
          `UPDATE outbox
           SET delivery_state = 'settled',
               lease_token = NULL,
               lease_expires_at = NULL,
               last_error_code = ?,
               updated_at = ?
           WHERE outbox_id = ?
             AND destination = ?
             AND delivery_state = 'delivering'
             AND lease_token = ?`,
        )
        .bind(
          settledCode,
          this.now().toISOString(),
          outboxId,
          this.destination,
          leaseToken,
        )
        .run();
      if (settled.meta.changes !== 1) throw new OutboxEffectError('lease_lost');
      return 'settled';
    } catch (error) {
      const errorCode =
        error instanceof OutboxEffectError ? error.code : this.unavailableErrorCode;
      const observedAt = this.now().toISOString();
      try {
        const retried = await this.db
          .prepare(
            `UPDATE outbox
             SET delivery_state = 'pending',
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 last_error_code = ?,
                 updated_at = ?
             WHERE outbox_id = ?
               AND destination = ?
               AND delivery_state = 'delivering'
               AND lease_token = ?`,
          )
          .bind(errorCode, observedAt, outboxId, this.destination, leaseToken)
          .run();
        if (retried.meta.changes === 1 && this.onRetry !== undefined) {
          try {
            await this.onRetry({
              outboxId,
              runId: row.run_id,
              kind: row.kind,
              payloadRef: row.payload_ref,
              attemptCount: row.attempt_count,
              errorCode,
              observedAt,
            });
          } catch {
            // Retry evidence is best-effort and cannot change outbox semantics.
          }
        }
      } catch {
        // The unchanged delivering row is reclaimable after lease_expires_at.
      }
      return 'retry';
    }
  }

  async drain(limit = 25): Promise<OutboxDeliveryResult[]> {
    const nowIso = this.now().toISOString();
    const { results } = await this.db
      .prepare(
        `SELECT outbox_id
         FROM outbox
         WHERE destination = ?
           AND NOT EXISTS (
             SELECT 1 FROM outbox_dead_letters
             WHERE outbox_dead_letters.outbox_id = outbox.outbox_id
               AND outbox_dead_letters.status = 'open'
           )
           AND (
             delivery_state = 'pending'
             OR (
               delivery_state = 'delivering'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?
             )
           )
         ORDER BY created_at, outbox_id
         LIMIT ?`,
      )
      .bind(this.destination, nowIso, Math.max(1, Math.min(limit, 100)))
      .all<{ outbox_id: string }>();
    const deliveries: OutboxDeliveryResult[] = [];
    for (const row of results) deliveries.push(await this.deliver(row.outbox_id));
    return deliveries;
  }
}
