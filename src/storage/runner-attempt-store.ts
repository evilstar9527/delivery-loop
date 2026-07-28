import { canonicalSha256 } from '../domain/digest.js';
import {
  AttemptResultSignalV1Schema,
  attemptResultEventName,
  type AttemptResultSignalV1,
} from '../domain/workflow-event.js';

const HEARTBEAT_LEASE_MS = 90_000;

type RunnerAttemptErrorCode = 'invalid_token' | 'state_conflict' | 'result_conflict';

export class RunnerAttemptError extends Error {
  constructor(readonly code: RunnerAttemptErrorCode) {
    super(`Runner Attempt operation failed: ${code}`);
    this.name = 'RunnerAttemptError';
  }
}

interface RunnerAuthRow {
  attempt_id: string;
  run_id: string;
  mode: string;
  status: string;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  token_id: string;
  token_digest: string;
  tool_token_digest: string | null;
  token_expires_at: string;
  revoked_at: string | null;
  scopes_json: string;
}

export interface RunnerAuthorization {
  attemptId: string;
  runId: string;
  mode: 'analysis' | 'implement' | 'review_fix';
  status: 'running';
  version: number;
  leaseGeneration: number;
  leaseExpiresAt: string;
  scopes: string[];
}

interface CompletionProjectionRow {
  version: number;
  result_event_id: string | null;
  result_sequence: number | null;
  result_payload_ref: string | null;
  result_digest: string | null;
  token_revoked_at: string | null;
  signal_id: string | null;
  outbox_id: string | null;
  revocation_id: string | null;
}

export interface RunnerHeartbeatInput {
  expectedVersion: number;
  leaseGeneration: number;
}

export interface RunnerHeartbeatResult {
  attemptToken: string;
  toolBridgeToken: string;
  version: number;
  leaseGeneration: number;
  expiresAt: string;
}

export interface RunnerCompletionInput {
  schemaVersion: '1';
  eventId: string;
  sequence: number;
  payloadRef: string;
  digest: string;
  occurredAt: string;
  expectedVersion: number;
  leaseGeneration: number;
}

export interface RunnerCompletionResult {
  signalId: string;
  outboxId: string;
}

function opaqueToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
}

/** Authenticated Runner mutation adapter: opaque token + Attempt CAS + generation fencing. */
export class RunnerAttemptStore {
  constructor(private readonly db: D1Database) {}

  async authorize(
    attemptId: string,
    rawToken: string,
    now = new Date(),
  ): Promise<RunnerAuthorization> {
    const auth = await this.authenticate(attemptId, await canonicalSha256(rawToken), now);
    let scopes: unknown;
    try {
      scopes = JSON.parse(auth.scopes_json) as unknown;
    } catch {
      throw new RunnerAttemptError('invalid_token');
    }
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) {
      throw new RunnerAttemptError('invalid_token');
    }
    return {
      attemptId: auth.attempt_id,
      runId: auth.run_id,
      mode: this.runnerMode(auth.mode),
      status: 'running',
      version: auth.version,
      leaseGeneration: auth.lease_generation,
      leaseExpiresAt: auth.lease_expires_at!,
      scopes,
    };
  }

  async authorizeTool(
    attemptId: string,
    rawToken: string,
    now = new Date(),
  ): Promise<RunnerAuthorization> {
    const auth = await this.authenticateTool(attemptId, await canonicalSha256(rawToken), now);
    let scopes: unknown;
    try {
      scopes = JSON.parse(auth.scopes_json) as unknown;
    } catch {
      throw new RunnerAttemptError('invalid_token');
    }
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) {
      throw new RunnerAttemptError('invalid_token');
    }
    return {
      attemptId: auth.attempt_id,
      runId: auth.run_id,
      mode: this.runnerMode(auth.mode),
      status: 'running',
      version: auth.version,
      leaseGeneration: auth.lease_generation,
      leaseExpiresAt: auth.lease_expires_at!,
      scopes,
    };
  }

  async heartbeat(
    attemptId: string,
    rawToken: string,
    input: RunnerHeartbeatInput,
    now = new Date(),
  ): Promise<RunnerHeartbeatResult> {
    const tokenDigest = await canonicalSha256(rawToken);
    const auth = await this.authenticate(attemptId, tokenDigest, now);
    if (
      auth.version !== input.expectedVersion ||
      auth.lease_generation !== input.leaseGeneration ||
      auth.heartbeat_at === null
    ) {
      throw new RunnerAttemptError('state_conflict');
    }

    const nextToken = opaqueToken();
    const nextToolToken = opaqueToken();
    const [nextTokenDigest, nextToolTokenDigest] = await Promise.all([
      canonicalSha256(nextToken),
      canonicalSha256(nextToolToken),
    ]);
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + HEARTBEAT_LEASE_MS).toISOString();
    const heartbeatIdentity = await canonicalSha256({
      attemptId,
      leaseGeneration: input.leaseGeneration,
      attemptVersion: input.expectedVersion + 1,
    });
    const heartbeatId =
      `heartbeat_${heartbeatIdentity.slice('sha256:'.length, 'sha256:'.length + 54)}`;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE attempts
           SET version = version + 1,
               lease_expires_at = ?,
               heartbeat_at = ?,
               updated_at = ?
           WHERE attempt_id = ?
             AND status = 'running'
             AND version = ?
             AND lease_generation = ?
             AND lease_expires_at > ?
             AND EXISTS (
               SELECT 1 FROM attempt_tokens
               WHERE token_id = ?
                 AND attempt_id = attempts.attempt_id
                 AND token_digest = ?
                 AND lease_generation = ?
                 AND revoked_at IS NULL
                 AND expires_at > ?
             )`,
        )
        .bind(
          expiresAt,
          nowIso,
          nowIso,
          attemptId,
          input.expectedVersion,
          input.leaseGeneration,
          nowIso,
          auth.token_id,
          tokenDigest,
          input.leaseGeneration,
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE attempt_tokens
           SET token_digest = ?, tool_token_digest = ?, expires_at = ?
           WHERE token_id = ?
             AND attempt_id = ?
             AND token_digest = ?
             AND lease_generation = ?
             AND revoked_at IS NULL
             AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = ?
                 AND version = ?
                 AND lease_generation = ?
                 AND heartbeat_at = ?
                 AND lease_expires_at = ?
             )`,
        )
        .bind(
          nextTokenDigest,
          nextToolTokenDigest,
          expiresAt,
          auth.token_id,
          attemptId,
          tokenDigest,
          input.leaseGeneration,
          nowIso,
          attemptId,
          input.expectedVersion + 1,
          input.leaseGeneration,
          nowIso,
          expiresAt,
        ),
      this.db
        .prepare(
          `INSERT INTO attempt_heartbeat_receipts (
             heartbeat_id, run_id, attempt_id, lease_generation,
             previous_attempt_version, attempt_version, previous_heartbeat_at,
             heartbeat_at, lease_expires_at, created_at
           )
           SELECT ?, attempts.run_id, attempts.attempt_id, attempts.lease_generation,
                  ?, attempts.version, ?, attempts.heartbeat_at,
                  attempts.lease_expires_at, ?
           FROM attempts
           JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
           WHERE attempts.attempt_id = ?
             AND attempts.status = 'running'
             AND attempts.version = ?
             AND attempts.lease_generation = ?
             AND attempts.heartbeat_at = ?
             AND attempts.lease_expires_at = ?
             AND attempt_tokens.token_id = ?
             AND attempt_tokens.token_digest = ?
             AND attempt_tokens.tool_token_digest = ?
             AND attempt_tokens.expires_at = ?
             AND attempt_tokens.revoked_at IS NULL
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          heartbeatId,
          input.expectedVersion,
          auth.heartbeat_at,
          nowIso,
          attemptId,
          input.expectedVersion + 1,
          input.leaseGeneration,
          nowIso,
          expiresAt,
          auth.token_id,
          nextTokenDigest,
          nextToolTokenDigest,
          expiresAt,
        ),
    ]);

    const persisted = await this.db
      .prepare(
        `SELECT attempts.version, attempts.lease_generation, attempts.lease_expires_at,
                attempt_tokens.token_digest, attempt_tokens.tool_token_digest,
                attempt_tokens.expires_at,
                receipts.heartbeat_id, receipts.previous_attempt_version,
                receipts.previous_heartbeat_at, receipts.heartbeat_at AS receipt_heartbeat_at
         FROM attempts
         JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
         LEFT JOIN attempt_heartbeat_receipts AS receipts
           ON receipts.attempt_id = attempts.attempt_id
          AND receipts.attempt_version = attempts.version
         WHERE attempts.attempt_id = ? AND attempt_tokens.token_id = ?`,
      )
      .bind(attemptId, auth.token_id)
      .first<{
        version: number;
        lease_generation: number;
        lease_expires_at: string | null;
        token_digest: string;
        tool_token_digest: string | null;
        expires_at: string;
        heartbeat_id: string | null;
        previous_attempt_version: number | null;
        previous_heartbeat_at: string | null;
        receipt_heartbeat_at: string | null;
      }>();
    if (
      persisted === null ||
      persisted.version !== input.expectedVersion + 1 ||
      persisted.lease_generation !== input.leaseGeneration ||
      persisted.lease_expires_at !== expiresAt ||
      persisted.token_digest !== nextTokenDigest ||
      persisted.tool_token_digest !== nextToolTokenDigest ||
      persisted.expires_at !== expiresAt ||
      persisted.heartbeat_id !== heartbeatId ||
      persisted.previous_attempt_version !== input.expectedVersion ||
      persisted.previous_heartbeat_at !== auth.heartbeat_at ||
      persisted.receipt_heartbeat_at !== nowIso
    ) {
      throw new RunnerAttemptError('state_conflict');
    }
    return {
      attemptToken: nextToken,
      toolBridgeToken: nextToolToken,
      version: persisted.version,
      leaseGeneration: persisted.lease_generation,
      expiresAt,
    };
  }

  async complete(
    attemptId: string,
    rawToken: string,
    input: RunnerCompletionInput,
    now = new Date(),
  ): Promise<RunnerCompletionResult> {
    const tokenDigest = await canonicalSha256(rawToken);
    const auth = await this.authenticate(attemptId, tokenDigest, now);
    if (
      auth.version !== input.expectedVersion ||
      auth.lease_generation !== input.leaseGeneration
    ) {
      throw new RunnerAttemptError('state_conflict');
    }
    const signal = AttemptResultSignalV1Schema.parse({
      schemaVersion: input.schemaVersion,
      eventId: input.eventId,
      runId: auth.run_id,
      type: 'attempt_completed',
      attemptId,
      sequence: input.sequence,
      payloadRef: input.payloadRef,
      digest: input.digest,
      occurredAt: input.occurredAt,
    } satisfies AttemptResultSignalV1);
    const identityDigest = await canonicalSha256({
      runId: signal.runId,
      eventId: signal.eventId,
    });
    const suffix = identityDigest.slice('sha256:'.length, 'sha256:'.length + 56);
    const signalId = `signal_${suffix}`;
    const outboxId = `outbox_signal_${suffix}`;
    const revocationId = `revoke_complete_${attemptId}_${input.leaseGeneration}`;
    const workflowEventType = attemptResultEventName(attemptId);
    const nowIso = now.toISOString();

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO workflow_signals (
             signal_id, run_id, event_id, workflow_event_type, signal_type,
             attempt_id, sequence, payload_ref, digest, occurred_at, created_at
           )
           SELECT ?, attempts.run_id, ?, ?, 'attempt_completed', attempts.attempt_id,
                  ?, ?, ?, ?, ?
           FROM attempts
           JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
           WHERE attempts.attempt_id = ?
             AND attempts.run_id = ?
             AND attempts.status = 'running'
             AND attempts.version = ?
             AND attempts.lease_generation = ?
             AND attempts.lease_expires_at > ?
             AND attempts.result_event_id IS NULL
             AND attempt_tokens.token_id = ?
             AND attempt_tokens.token_digest = ?
             AND attempt_tokens.lease_generation = ?
             AND attempt_tokens.revoked_at IS NULL
             AND attempt_tokens.expires_at > ?
             AND EXISTS (
               SELECT 1 FROM execution_plans
               WHERE plan_id = substr(?, length('d1://execution-plans/') + 1)
                 AND run_id = attempts.run_id
                 AND created_by_attempt_id = attempts.attempt_id
                 AND digest = ?
                 AND status IN ('validated', 'active')
             )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          signalId,
          signal.eventId,
          workflowEventType,
          signal.sequence,
          signal.payloadRef,
          signal.digest,
          signal.occurredAt,
          nowIso,
          attemptId,
          auth.run_id,
          input.expectedVersion,
          input.leaseGeneration,
          nowIso,
          auth.token_id,
          tokenDigest,
          input.leaseGeneration,
          nowIso,
          signal.payloadRef,
          signal.digest,
        ),
      this.db
        .prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, ?, 'workflow_signal', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM workflow_signals
             WHERE signal_id = ? AND run_id = ? AND event_id = ?
               AND attempt_id = ? AND sequence = ? AND payload_ref = ? AND digest = ?
           )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          outboxId,
          auth.run_id,
          `d1://workflow-signals/${signalId}`,
          `workflow-signal:${auth.run_id}:${signal.eventId}`,
          nowIso,
          nowIso,
          signalId,
          auth.run_id,
          signal.eventId,
          attemptId,
          signal.sequence,
          signal.payloadRef,
          signal.digest,
        ),
      this.db
        .prepare(
          `UPDATE attempts
           SET version = version + 1,
               result_event_id = ?,
               result_sequence = ?,
               result_payload_ref = ?,
               result_digest = ?,
               result_reported_at = ?,
               updated_at = ?
           WHERE attempt_id = ?
             AND status = 'running'
             AND version = ?
             AND lease_generation = ?
             AND lease_expires_at > ?
             AND result_event_id IS NULL
             AND EXISTS (
               SELECT 1 FROM workflow_signals
               WHERE signal_id = ? AND run_id = ? AND event_id = ?
                 AND attempt_id = ? AND sequence = ? AND payload_ref = ? AND digest = ?
             )
             AND EXISTS (
               SELECT 1 FROM attempt_tokens
               WHERE token_id = ? AND attempt_id = attempts.attempt_id
                 AND token_digest = ? AND lease_generation = ?
                 AND revoked_at IS NULL AND expires_at > ?
             )`,
        )
        .bind(
          signal.eventId,
          signal.sequence,
          signal.payloadRef,
          signal.digest,
          nowIso,
          nowIso,
          attemptId,
          input.expectedVersion,
          input.leaseGeneration,
          nowIso,
          signalId,
          auth.run_id,
          signal.eventId,
          attemptId,
          signal.sequence,
          signal.payloadRef,
          signal.digest,
          auth.token_id,
          tokenDigest,
          input.leaseGeneration,
          nowIso,
        ),
      this.db
        .prepare(
          `UPDATE attempt_tokens
           SET revoked_at = ?
           WHERE token_id = ? AND attempt_id = ? AND token_digest = ?
             AND lease_generation = ? AND revoked_at IS NULL AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM attempts
               WHERE attempt_id = ? AND version = ?
                 AND result_event_id = ? AND result_sequence = ?
                 AND result_payload_ref = ? AND result_digest = ?
             )`,
        )
        .bind(
          nowIso,
          auth.token_id,
          attemptId,
          tokenDigest,
          input.leaseGeneration,
          nowIso,
          attemptId,
          input.expectedVersion + 1,
          signal.eventId,
          signal.sequence,
          signal.payloadRef,
          signal.digest,
        ),
      this.db
        .prepare(
          `INSERT INTO attempt_revocations (
             revocation_id, run_id, attempt_id, reason, revoked_lease_generation,
             attempt_version, occurred_at, created_at
           )
           SELECT ?, attempts.run_id, attempts.attempt_id, 'completed',
                  attempts.lease_generation, attempts.version, ?, ?
           FROM attempts
           JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
           WHERE attempts.attempt_id = ? AND attempts.run_id = ?
             AND attempts.version = ? AND attempts.result_event_id = ?
             AND attempt_tokens.token_id = ? AND attempt_tokens.revoked_at = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          revocationId,
          nowIso,
          nowIso,
          attemptId,
          auth.run_id,
          input.expectedVersion + 1,
          signal.eventId,
          auth.token_id,
          nowIso,
        ),
    ]);

    const projection = await this.db
      .prepare(
        `SELECT attempts.version, attempts.result_event_id, attempts.result_sequence,
                attempts.result_payload_ref, attempts.result_digest,
                attempt_tokens.revoked_at AS token_revoked_at,
                workflow_signals.signal_id, outbox.outbox_id,
                attempt_revocations.revocation_id
         FROM attempts
         JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
         LEFT JOIN workflow_signals
           ON workflow_signals.run_id = attempts.run_id
          AND workflow_signals.event_id = attempts.result_event_id
         LEFT JOIN outbox
           ON outbox.payload_ref = 'd1://workflow-signals/' || workflow_signals.signal_id
         LEFT JOIN attempt_revocations
           ON attempt_revocations.attempt_id = attempts.attempt_id
          AND attempt_revocations.reason = 'completed'
          AND attempt_revocations.revoked_lease_generation = attempts.lease_generation
         WHERE attempts.attempt_id = ? AND attempt_tokens.token_id = ?`,
      )
      .bind(attemptId, auth.token_id)
      .first<CompletionProjectionRow>();
    if (
      projection === null ||
      projection.version !== input.expectedVersion + 1 ||
      projection.result_event_id !== signal.eventId ||
      projection.result_sequence !== signal.sequence ||
      projection.result_payload_ref !== signal.payloadRef ||
      projection.result_digest !== signal.digest ||
      projection.token_revoked_at === null ||
      projection.signal_id !== signalId ||
      projection.outbox_id !== outboxId ||
      projection.revocation_id !== revocationId
    ) {
      throw new RunnerAttemptError('result_conflict');
    }
    return { signalId, outboxId };
  }

  private async authenticate(
    attemptId: string,
    tokenDigest: string,
    now: Date,
  ): Promise<RunnerAuthRow> {
    const row = await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.mode, attempts.status, attempts.version,
                attempts.lease_generation, attempts.lease_expires_at, attempts.heartbeat_at,
                attempt_tokens.token_id, attempt_tokens.token_digest,
                attempt_tokens.tool_token_digest,
                attempt_tokens.expires_at AS token_expires_at, attempt_tokens.revoked_at,
                attempt_tokens.scopes_json
         FROM attempts
         JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
         WHERE attempts.attempt_id = ?
           AND attempt_tokens.token_digest = ?
           AND attempt_tokens.revoked_at IS NULL
           AND attempt_tokens.expires_at > ?`,
      )
      .bind(attemptId, tokenDigest, now.toISOString())
      .first<RunnerAuthRow>();
    if (row === null) throw new RunnerAttemptError('invalid_token');
    if (
      row.status !== 'running' ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= now.toISOString() ||
      row.lease_generation <= 0
    ) {
      throw new RunnerAttemptError('state_conflict');
    }
    return row;
  }

  private async authenticateTool(
    attemptId: string,
    tokenDigest: string,
    now: Date,
  ): Promise<RunnerAuthRow> {
    const row = await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.mode, attempts.status, attempts.version,
                attempts.lease_generation, attempts.lease_expires_at, attempts.heartbeat_at,
                attempt_tokens.token_id, attempt_tokens.token_digest,
                attempt_tokens.tool_token_digest,
                attempt_tokens.expires_at AS token_expires_at, attempt_tokens.revoked_at,
                attempt_tokens.scopes_json
         FROM attempts
         JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
         WHERE attempts.attempt_id = ?
           AND attempt_tokens.tool_token_digest = ?
           AND attempt_tokens.revoked_at IS NULL
           AND attempt_tokens.expires_at > ?`,
      )
      .bind(attemptId, tokenDigest, now.toISOString())
      .first<RunnerAuthRow>();
    if (row === null) throw new RunnerAttemptError('invalid_token');
    if (
      row.status !== 'running' ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= now.toISOString() ||
      row.lease_generation <= 0
    ) {
      throw new RunnerAttemptError('state_conflict');
    }
    return row;
  }

  private runnerMode(value: string): RunnerAuthorization['mode'] {
    if (value !== 'analysis' && value !== 'implement' && value !== 'review_fix') {
      throw new RunnerAttemptError('state_conflict');
    }
    return value;
  }
}
