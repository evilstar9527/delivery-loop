import { canonicalSha256 } from '../domain/digest.js';
import {
  EXECUTION_TOOL_ACTIONS,
  TRIAGE_TOOL_ACTIONS,
  isExactExecutionToolActions,
  isExactTriageToolActions,
} from '../domain/tool-bridge.js';
import type { GitHubOidcClaims } from '../auth/github-oidc.js';
import { parseGitHubAgentWorkflowRef } from '../domain/github-agent-executor.js';
import type { VerifiedExecutorIdentity } from '../executor/core/executor-plugin.js';

const TOKEN_TTL_MS = 5 * 60 * 1_000;

type AttemptExchangeErrorCode =
  | 'attempt_not_found'
  | 'attempt_binding_mismatch'
  | 'attempt_lease_inactive'
  | 'oidc_replayed'
  | 'identity_replayed';

export class AttemptExchangeError extends Error {
  constructor(readonly code: AttemptExchangeErrorCode) {
    super(`Attempt token exchange failed: ${code}`);
    this.name = 'AttemptExchangeError';
  }
}

interface ExchangeAttemptRow {
  attempt_id: string;
  mode: string;
  status: string;
  repository: string | null;
  workflow_ref: string | null;
  github_run_id: string | null;
  github_head_sha: string | null;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
}

interface AttemptTokenRow {
  oidc_token_digest: string;
  token_digest: string;
  tool_token_digest: string | null;
  scopes_json: string;
  expires_at: string;
  identity_kind: string;
  execution_id: string | null;
}

interface ExecutorExchangeAttemptRow extends ExchangeAttemptRow {
  execution_id: string;
  execution_role: string;
  execution_status: string;
  provider_kind: string;
}

export interface AttemptExchangeResult {
  attemptToken: string;
  expiresAt: string;
  attemptVersion: number;
  leaseGeneration: number;
  grant: { toolBridgeToken: string; expiresAt: string; scopes: string[] };
}

function opaqueToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
}

/** Binds verified GitHub claims to a live D1 Attempt and performs one-time token issuance. */
export class AttemptExchangeStore {
  constructor(private readonly db: D1Database) {}

  async exchange(
    attemptId: string,
    oidcToken: string,
    claims: GitHubOidcClaims,
    now = new Date(),
  ): Promise<AttemptExchangeResult> {
    const attempt = await this.db
      .prepare(
        `SELECT attempt_id, mode, status, repository, workflow_ref,
                github_run_id, github_head_sha, version, lease_generation, lease_expires_at
         FROM attempts WHERE attempt_id = ?`,
      )
      .bind(attemptId)
      .first<ExchangeAttemptRow>();
    if (attempt === null) throw new AttemptExchangeError('attempt_not_found');
    const executor = parseGitHubAgentWorkflowRef(attempt.workflow_ref);
    if (
      attempt.repository === null ||
      executor === null ||
      attempt.github_run_id === null ||
      attempt.github_head_sha === null ||
      claims.repository !== executor.repository ||
      claims.workflowRef !== attempt.workflow_ref ||
      claims.sha !== attempt.github_head_sha ||
      claims.runId !== attempt.github_run_id
    ) {
      throw new AttemptExchangeError('attempt_binding_mismatch');
    }
    const leaseExpiry =
      attempt.lease_expires_at === null ? Number.NaN : Date.parse(attempt.lease_expires_at);
    if (
      !['analysis', 'implement', 'review_fix'].includes(attempt.mode) ||
      (attempt.status !== 'starting' && attempt.status !== 'running') ||
      attempt.lease_generation <= 0 ||
      !Number.isFinite(leaseExpiry) ||
      leaseExpiry <= now.getTime()
    ) {
      throw new AttemptExchangeError('attempt_lease_inactive');
    }

    return await this.issue(
      attempt,
      await canonicalSha256(oidcToken),
      'github_oidc',
      null,
      'oidc_replayed',
      now,
    );
  }

  async exchangeExecutorIdentity(
    attemptId: string,
    identity: VerifiedExecutorIdentity,
    now = new Date(),
  ): Promise<AttemptExchangeResult> {
    const attempt = await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.mode, attempts.status, attempts.repository,
              attempts.workflow_ref, attempts.github_run_id, attempts.github_head_sha,
              attempts.version, attempts.lease_generation, attempts.lease_expires_at,
              execution.execution_id, execution.execution_role,
              execution.status AS execution_status, execution.provider_kind
       FROM attempts
       JOIN attempt_execution_instances AS execution
         ON execution.attempt_id = attempts.attempt_id
        AND execution.execution_id = ?
       WHERE attempts.attempt_id = ?`,
    ).bind(identity.executionId, attemptId).first<ExecutorExchangeAttemptRow>();
    if (attempt === null) throw new AttemptExchangeError('attempt_not_found');
    if (
      identity.attemptId !== attempt.attempt_id ||
      identity.leaseGeneration !== attempt.lease_generation ||
      identity.repository !== attempt.repository ||
      identity.kind !== attempt.provider_kind ||
      identity.role !== attempt.execution_role ||
      identity.role !== 'work' ||
      !['starting', 'running'].includes(attempt.execution_status)
    ) throw new AttemptExchangeError('attempt_binding_mismatch');
    const assertionDigest = await canonicalSha256({
      schemaVersion: '1',
      kind: identity.kind,
      executionId: identity.executionId,
      attemptId: identity.attemptId,
      leaseGeneration: identity.leaseGeneration,
      role: identity.role,
      repository: identity.repository,
      providerSubject: identity.providerSubject,
    });
    return await this.issue(
      attempt,
      assertionDigest,
      'executor',
      identity.executionId,
      'identity_replayed',
      now,
    );
  }

  private async issue(
    attempt: ExchangeAttemptRow,
    identityDigest: string,
    identityKind: 'github_oidc' | 'executor',
    executionId: string | null,
    replayCode: 'oidc_replayed' | 'identity_replayed',
    now: Date,
  ): Promise<AttemptExchangeResult> {
    const leaseExpiry = attempt.lease_expires_at === null
      ? Number.NaN
      : Date.parse(attempt.lease_expires_at);
    if (
      !['analysis', 'implement', 'review_fix'].includes(attempt.mode) ||
      (attempt.status !== 'starting' && attempt.status !== 'running') ||
      attempt.lease_generation <= 0 || !Number.isFinite(leaseExpiry) ||
      leaseExpiry <= now.getTime()
    ) throw new AttemptExchangeError('attempt_lease_inactive');
    const attemptToken = opaqueToken();
    const toolBridgeToken = opaqueToken();
    const [tokenDigest, toolTokenDigest] = await Promise.all([
      canonicalSha256(attemptToken),
      canonicalSha256(toolBridgeToken),
    ]);
    const expiresAt = new Date(Math.min(leaseExpiry, now.getTime() + TOKEN_TTL_MS)).toISOString();
    const scopes = attempt.mode === 'analysis'
      ? [...TRIAGE_TOOL_ACTIONS]
      : [...EXECUTION_TOOL_ACTIONS];
    const nowIso = now.toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO attempt_tokens (
             token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
             lease_generation, scopes_json, expires_at, created_at, identity_kind, execution_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          attempt.attempt_id,
          identityDigest,
          tokenDigest,
          toolTokenDigest,
          attempt.lease_generation,
          JSON.stringify(scopes),
          expiresAt,
          nowIso,
          identityKind,
          executionId,
        ),
      this.db
        .prepare(
          `UPDATE attempts
           SET status = 'running', version = version + 1,
               heartbeat_at = ?, updated_at = ?
           WHERE attempt_id = ? AND status = 'starting'
             AND version = ? AND lease_generation = ? AND lease_expires_at > ?
             AND EXISTS (
               SELECT 1 FROM attempt_tokens
               WHERE attempt_id = attempts.attempt_id
                 AND oidc_token_digest = ? AND token_digest = ?
                 AND tool_token_digest = ?
                 AND identity_kind = ? AND execution_id IS ?
                 AND lease_generation = ? AND revoked_at IS NULL AND expires_at > ?
             )`,
        )
        .bind(
          nowIso,
          nowIso,
          attempt.attempt_id,
          attempt.version,
          attempt.lease_generation,
          nowIso,
          identityDigest,
          tokenDigest,
          toolTokenDigest,
          identityKind,
          executionId,
          attempt.lease_generation,
          nowIso,
        ),
      ...(identityKind !== 'executor' || executionId === null
        ? []
        : [this.db.prepare(
          `UPDATE attempt_execution_instances
           SET status = 'running', updated_at = ?
           WHERE execution_id = ? AND attempt_id = ? AND execution_role = 'work'
             AND status = 'starting' AND lease_generation = ?
             AND EXISTS (
               SELECT 1 FROM attempt_tokens
               WHERE attempt_id = attempt_execution_instances.attempt_id
                 AND identity_kind = 'executor' AND execution_id = ?
                 AND lease_generation = ? AND revoked_at IS NULL AND expires_at > ?
             )`,
        ).bind(
          nowIso,
          executionId,
          attempt.attempt_id,
          attempt.lease_generation,
          executionId,
          attempt.lease_generation,
          nowIso,
        )]),
    ]);

    const persisted = await this.db
      .prepare(
        `SELECT oidc_token_digest, token_digest, tool_token_digest, scopes_json, expires_at,
                identity_kind, execution_id
         FROM attempt_tokens WHERE attempt_id = ? AND lease_generation = ?`,
      )
      .bind(attempt.attempt_id, attempt.lease_generation)
      .first<AttemptTokenRow>();
    if (
      persisted === null ||
      persisted.oidc_token_digest !== identityDigest ||
      persisted.token_digest !== tokenDigest ||
      persisted.tool_token_digest !== toolTokenDigest ||
      persisted.identity_kind !== identityKind ||
      persisted.execution_id !== executionId
    ) {
      throw new AttemptExchangeError(replayCode);
    }
    const activeAttempt = await this.db
      .prepare(
        `SELECT status, version, lease_generation FROM attempts WHERE attempt_id = ?`,
      )
      .bind(attempt.attempt_id)
      .first<{ status: string; version: number; lease_generation: number }>();
    if (activeAttempt === null || activeAttempt.status !== 'running') {
      throw new AttemptExchangeError('attempt_lease_inactive');
    }
    if (identityKind === 'executor' && executionId !== null) {
      const activeExecution = await this.db.prepare(
        `SELECT status FROM attempt_execution_instances
         WHERE execution_id = ? AND attempt_id = ? AND lease_generation = ?`,
      ).bind(
        executionId,
        attempt.attempt_id,
        attempt.lease_generation,
      ).first<{ status: string }>();
      if (activeExecution?.status !== 'running') {
        throw new AttemptExchangeError('attempt_lease_inactive');
      }
    }
    let persistedScopes: unknown;
    try {
      persistedScopes = JSON.parse(persisted.scopes_json) as unknown;
    } catch {
      throw new AttemptExchangeError('attempt_binding_mismatch');
    }
    let safeScopes: string[];
    if (attempt.mode === 'analysis') {
      if (!isExactTriageToolActions(persistedScopes)) {
        throw new AttemptExchangeError('attempt_binding_mismatch');
      }
      safeScopes = persistedScopes;
    } else {
      if (!isExactExecutionToolActions(persistedScopes)) {
        throw new AttemptExchangeError('attempt_binding_mismatch');
      }
      safeScopes = persistedScopes;
    }
    return {
      attemptToken,
      expiresAt: persisted.expires_at,
      attemptVersion: activeAttempt.version,
      leaseGeneration: activeAttempt.lease_generation,
      grant: {
        toolBridgeToken,
        expiresAt: persisted.expires_at,
        scopes: safeScopes,
      },
    };
  }
}
