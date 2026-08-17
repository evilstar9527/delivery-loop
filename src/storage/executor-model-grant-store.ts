import { canonicalSha256 } from '../domain/digest.js';
import { assertFrozenExecutionSpec } from '../executor/core/executor-registry.js';
import type { FrozenExecutionSpec } from '../executor/core/executor-plugin.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';
import {
  CredentialCipher,
  RepoWriteCredentialError,
} from './repo-write-credential-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export class ExecutorModelGrantError extends Error {
  constructor(readonly code: 'invalid_request' | 'not_found' | 'state_conflict') {
    super(`Executor model grant failed: ${code}`);
    this.name = 'ExecutorModelGrantError';
  }
}

export interface ExecutorModelGrantAuthorization {
  reservationId: string;
  profileId: string;
  provider: string;
  model: string;
}

interface ContextRow {
  execution_role: string;
  execution_status: string;
  execution_lease_generation: number;
  execution_created_at: string;
  spec_json: string;
  attempt_status: string;
  attempt_lease_generation: number;
  attempt_lease_expires_at: string | null;
  reservation_id: string;
  profile_id: string;
  reservation_status: string;
  reservation_expires_at: string;
  reservation_created_at: string;
  provider: string;
  model: string;
}

interface GrantRow {
  grant_id: string;
  reservation_id: string;
  execution_id: string;
  attempt_id: string;
  lease_generation: number;
  token_digest: string;
  token_ciphertext: string;
  token_iv: string;
  expires_at: string;
}

interface AuthorizedGrantRow {
  reservation_id: string;
  profile_id: string;
  provider: string;
  model: string;
  spec_json: string;
  lease_generation: number;
}

function frozenSpec(raw: string): FrozenExecutionSpec {
  try {
    const parsed = JSON.parse(raw) as FrozenExecutionSpec;
    assertFrozenExecutionSpec(parsed);
    return parsed;
  } catch {
    throw new ExecutorModelGrantError('state_conflict');
  }
}

export class ExecutorModelGrantStore {
  private readonly cipher: CredentialCipher;

  constructor(
    private readonly db: D1Database,
    encryptionKey: string,
    private readonly generateToken: () => string = () => crypto.randomUUID(),
  ) {
    this.cipher = new CredentialCipher(encryptionKey);
  }

  async issue(input: {
    authorization: RunnerAuthorization;
    executionId: string;
    reservationId: string;
    now?: Date;
  }): Promise<{ grantId: string; reservationId: string; token: string; expiresAt: string; created: boolean }> {
    const now = input.now ?? new Date();
    if (!ID_PATTERN.test(input.executionId) || !ID_PATTERN.test(input.reservationId)) {
      throw new ExecutorModelGrantError('invalid_request');
    }
    const context = await this.context(
      input.authorization.attemptId, input.executionId, input.reservationId, now,
    );
    this.assertContext(context, input.authorization, input.executionId, now);
    const digest = await canonicalSha256({
      schemaVersion: '1',
      executionId: input.executionId,
      reservationId: input.reservationId,
    });
    const grantId = `model-grant-${digest.slice(7, 47)}`;
    const existing = await this.grant(grantId);
    if (existing !== null) {
      this.assertGrantBinding(existing, input.authorization, input.executionId, input.reservationId);
      return await this.result(existing, false, now);
    }
    const token = this.generateToken();
    if (token.length < 16 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new ExecutorModelGrantError('state_conflict');
    }
    const encrypted = await this.cipher.encrypt(token, grantId);
    const reservationExpiresAt = Date.parse(context.reservation_expires_at);
    const leaseExpiresAt = Date.parse(input.authorization.leaseExpiresAt);
    if (!Number.isFinite(reservationExpiresAt) || !Number.isFinite(leaseExpiresAt)) {
      throw new ExecutorModelGrantError('state_conflict');
    }
    const expiresAt = new Date(Math.min(reservationExpiresAt, leaseExpiresAt)).toISOString();
    const inserted = await this.db.prepare(
      `INSERT INTO executor_model_grants (
         grant_id, reservation_id, execution_id, attempt_id, lease_generation,
         token_digest, token_ciphertext, token_iv, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(
      grantId, input.reservationId, input.executionId, input.authorization.attemptId,
      input.authorization.leaseGeneration, await canonicalSha256(token), encrypted.ciphertext,
      encrypted.iv, expiresAt, now.toISOString(),
    ).run();
    const persisted = await this.grant(grantId);
    if (persisted === null) throw new ExecutorModelGrantError('state_conflict');
    this.assertGrantBinding(
      persisted,
      input.authorization,
      input.executionId,
      input.reservationId,
    );
    return inserted.meta.changes === 1
      ? { grantId, reservationId: input.reservationId, token, expiresAt, created: true }
      : await this.result(persisted, false, now);
  }

  async authorize(input: {
    attemptId: string;
    executionId: string;
    rawToken: string;
    now?: Date;
  }): Promise<ExecutorModelGrantAuthorization> {
    const now = input.now ?? new Date();
    if (
      !ID_PATTERN.test(input.attemptId) || !ID_PATTERN.test(input.executionId) ||
      input.rawToken.length < 16 || input.rawToken.length > 2_000
    ) throw new ExecutorModelGrantError('invalid_request');
    const row = await this.db.prepare(
      `SELECT grants.reservation_id, reservations.profile_id, profiles.provider, profiles.model,
              execution.spec_json, grants.lease_generation
       FROM executor_model_grants AS grants
       JOIN quota_model_reservations AS reservations
         ON reservations.reservation_id = grants.reservation_id
       JOIN quota_model_profiles AS profiles ON profiles.profile_id = reservations.profile_id
       JOIN attempt_execution_instances AS execution ON execution.execution_id = grants.execution_id
       JOIN attempts ON attempts.attempt_id = grants.attempt_id
       WHERE grants.attempt_id = ? AND grants.execution_id = ? AND grants.token_digest = ?
         AND reservations.attempt_id = grants.attempt_id
         AND grants.expires_at > ? AND reservations.status = 'reserved'
         AND reservations.expires_at > ? AND execution.execution_role = 'work'
         AND execution.status = 'running' AND execution.lease_generation = grants.lease_generation
         AND attempts.status = 'running' AND attempts.lease_generation = grants.lease_generation
         AND attempts.lease_expires_at > ?`,
    ).bind(
      input.attemptId, input.executionId, await canonicalSha256(input.rawToken),
      now.toISOString(), now.toISOString(), now.toISOString(),
    ).first<AuthorizedGrantRow>();
    if (row === null) throw new ExecutorModelGrantError('not_found');
    const spec = frozenSpec(row.spec_json);
    if (
      spec.executionId !== input.executionId || spec.attemptId !== input.attemptId ||
      spec.role !== 'work' || spec.leaseGeneration !== row.lease_generation ||
      spec.modelProfileId !== row.profile_id
    ) throw new ExecutorModelGrantError('state_conflict');
    return {
      reservationId: row.reservation_id,
      profileId: row.profile_id,
      provider: row.provider,
      model: row.model,
    };
  }

  private async context(
    attemptId: string,
    executionId: string,
    reservationId: string,
    now: Date,
  ): Promise<ContextRow> {
    const row = await this.db.prepare(
      `SELECT execution.execution_role, execution.status AS execution_status,
              execution.lease_generation AS execution_lease_generation,
              execution.created_at AS execution_created_at, execution.spec_json,
              attempts.status AS attempt_status,
              attempts.lease_generation AS attempt_lease_generation,
              attempts.lease_expires_at AS attempt_lease_expires_at,
              reservations.reservation_id, reservations.profile_id,
              reservations.status AS reservation_status,
              reservations.expires_at AS reservation_expires_at,
              reservations.created_at AS reservation_created_at,
              profiles.provider, profiles.model
       FROM attempt_execution_instances AS execution
       JOIN attempts ON attempts.attempt_id = execution.attempt_id
       JOIN quota_model_reservations AS reservations ON reservations.attempt_id = attempts.attempt_id
       JOIN quota_model_profiles AS profiles ON profiles.profile_id = reservations.profile_id
       WHERE execution.execution_id = ? AND attempts.attempt_id = ?
         AND reservations.reservation_id = ? AND reservations.expires_at > ?`,
    ).bind(executionId, attemptId, reservationId, now.toISOString()).first<ContextRow>();
    if (row === null) throw new ExecutorModelGrantError('not_found');
    return row;
  }

  private assertContext(
    row: ContextRow,
    authorization: RunnerAuthorization,
    executionId: string,
    now: Date,
  ): void {
    const spec = frozenSpec(row.spec_json);
    if (
      row.execution_role !== 'work' || row.execution_status !== 'running' ||
      row.execution_lease_generation !== authorization.leaseGeneration ||
      row.attempt_status !== 'running' ||
      row.attempt_lease_generation !== authorization.leaseGeneration ||
      row.attempt_lease_expires_at !== authorization.leaseExpiresAt ||
      row.attempt_lease_expires_at <= now.toISOString() || row.reservation_status !== 'reserved' ||
      row.reservation_created_at < row.execution_created_at ||
      spec.executionId !== executionId || spec.attemptId !== authorization.attemptId ||
      spec.role !== 'work' || spec.leaseGeneration !== authorization.leaseGeneration ||
      spec.modelProfileId !== row.profile_id
    ) throw new ExecutorModelGrantError('state_conflict');
  }

  private async grant(grantId: string): Promise<GrantRow | null> {
    return await this.db.prepare(
      `SELECT grant_id, reservation_id, execution_id, attempt_id, lease_generation,
              token_digest, token_ciphertext, token_iv, expires_at
       FROM executor_model_grants WHERE grant_id = ?`,
    ).bind(grantId).first<GrantRow>();
  }

  private assertGrantBinding(
    row: GrantRow,
    authorization: RunnerAuthorization,
    executionId: string,
    reservationId: string,
  ): void {
    if (
      row.execution_id !== executionId || row.reservation_id !== reservationId ||
      row.attempt_id !== authorization.attemptId ||
      row.lease_generation !== authorization.leaseGeneration
    ) throw new ExecutorModelGrantError('state_conflict');
  }

  private async result(row: GrantRow, created: boolean, now: Date) {
    if (row.expires_at <= now.toISOString()) throw new ExecutorModelGrantError('state_conflict');
    let token: string;
    try {
      token = await this.cipher.decrypt(
        row.token_ciphertext,
        row.token_iv,
        row.grant_id,
      );
    } catch (error) {
      if (error instanceof RepoWriteCredentialError) {
        throw new ExecutorModelGrantError('state_conflict');
      }
      throw error;
    }
    if (
      token.length < 16 || token.length > 2_000 || /[\0\r\n]/.test(token) ||
      await canonicalSha256(token) !== row.token_digest
    ) throw new ExecutorModelGrantError('state_conflict');
    return {
      grantId: row.grant_id,
      reservationId: row.reservation_id,
      token,
      expiresAt: row.expires_at,
      created,
    };
  }
}
