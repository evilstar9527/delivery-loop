import { canonicalSha256 } from '../domain/digest.js';
import { assertFrozenExecutionSpec } from '../executor/core/executor-registry.js';
import type { FrozenExecutionSpec } from '../executor/core/executor-plugin.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export type ExecutorRepositoryAuthorizationErrorCode =
  | 'invalid_token'
  | 'state_conflict';

export class ExecutorRepositoryAuthorizationError extends Error {
  constructor(readonly code: ExecutorRepositoryAuthorizationErrorCode) {
    super(`Executor repository authorization failed: ${code}`);
    this.name = 'ExecutorRepositoryAuthorizationError';
  }
}

export interface ExecutorRepositoryAuthorization {
  attemptId: string;
  executionId: string;
  leaseGeneration: number;
  repository: string;
  checkoutSha: string;
}

interface AuthorizationRow {
  attempt_id: string;
  run_id: string;
  mode: string;
  attempt_status: string;
  lease_generation: number;
  lease_expires_at: string | null;
  repository: string | null;
  token_expires_at: string;
  token_identity_kind: string;
  token_execution_id: string | null;
  execution_status: string;
  execution_role: string;
  execution_lease_generation: number;
  spec_json: string;
}

function parseSpec(raw: string): FrozenExecutionSpec {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
    assertFrozenExecutionSpec(value as FrozenExecutionSpec);
  } catch {
    throw new ExecutorRepositoryAuthorizationError('state_conflict');
  }
  return value as FrozenExecutionSpec;
}

/** Authorizes repository reads only for the exact live executor work grant. */
export class ExecutorRepositoryAuthorizationStore {
  constructor(private readonly db: D1Database) {}

  async authorize(
    attemptId: string,
    rawToken: string,
    executionId: string,
    now = new Date(),
  ): Promise<ExecutorRepositoryAuthorization> {
    if (
      !ID_PATTERN.test(attemptId) || !ID_PATTERN.test(executionId) ||
      rawToken.length < 1 || rawToken.length > 4_096 || !Number.isFinite(now.getTime())
    ) throw new ExecutorRepositoryAuthorizationError('invalid_token');
    const nowIso = now.toISOString();
    const tokenDigest = await canonicalSha256(rawToken);
    const row = await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.run_id, attempts.mode,
              attempts.status AS attempt_status, attempts.lease_generation,
              attempts.lease_expires_at, attempts.repository,
              attempt_tokens.expires_at AS token_expires_at,
              attempt_tokens.identity_kind AS token_identity_kind,
              attempt_tokens.execution_id AS token_execution_id,
              execution.status AS execution_status,
              execution.execution_role, execution.lease_generation AS execution_lease_generation,
              execution.spec_json
       FROM attempts
       JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
        AND attempt_tokens.lease_generation = attempts.lease_generation
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = attempt_tokens.execution_id
        AND execution.attempt_id = attempts.attempt_id
        AND execution.lease_generation = attempts.lease_generation
       WHERE attempts.attempt_id = ? AND attempt_tokens.token_digest = ?
         AND attempt_tokens.identity_kind = 'executor'
         AND attempt_tokens.execution_id = ?
         AND attempt_tokens.revoked_at IS NULL AND attempt_tokens.expires_at > ?`,
    ).bind(attemptId, tokenDigest, executionId, nowIso).first<AuthorizationRow>();
    if (row === null) throw new ExecutorRepositoryAuthorizationError('invalid_token');
    if (
      row.attempt_status !== 'running' ||
      row.lease_expires_at === null || row.lease_expires_at <= nowIso ||
      row.token_expires_at <= nowIso || row.token_identity_kind !== 'executor' ||
      row.token_execution_id !== executionId || row.execution_role !== 'work' ||
      !['starting', 'running'].includes(row.execution_status) ||
      row.execution_lease_generation !== row.lease_generation ||
      row.repository === null || !['analysis', 'implement', 'review_fix'].includes(row.mode)
    ) throw new ExecutorRepositoryAuthorizationError('state_conflict');
    const spec = parseSpec(row.spec_json);
    if (
      spec.role !== 'work' || spec.executionId !== executionId ||
      spec.attemptId !== attemptId || spec.runId !== row.run_id ||
      spec.leaseGeneration !== row.lease_generation || spec.mode !== row.mode ||
      spec.repository !== row.repository
    ) throw new ExecutorRepositoryAuthorizationError('state_conflict');
    return {
      attemptId,
      executionId,
      leaseGeneration: row.lease_generation,
      repository: row.repository,
      checkoutSha: spec.checkoutSha,
    };
  }
}
