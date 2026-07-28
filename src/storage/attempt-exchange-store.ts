import { canonicalSha256 } from '../domain/digest.js';
import {
  EXECUTION_TOOL_ACTIONS,
  TRIAGE_TOOL_ACTIONS,
  isExactExecutionToolActions,
  isExactTriageToolActions,
} from '../domain/tool-bridge.js';
import type { GitHubOidcClaims } from '../auth/github-oidc.js';

const TOKEN_TTL_MS = 5 * 60 * 1_000;

type AttemptExchangeErrorCode =
  | 'attempt_not_found'
  | 'attempt_binding_mismatch'
  | 'attempt_lease_inactive'
  | 'oidc_replayed';

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
  base_sha: string;
  repository: string | null;
  workflow_ref: string | null;
  github_run_id: string | null;
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
        `SELECT attempt_id, mode, status, base_sha, repository, workflow_ref,
                github_run_id, version, lease_generation, lease_expires_at
         FROM attempts WHERE attempt_id = ?`,
      )
      .bind(attemptId)
      .first<ExchangeAttemptRow>();
    if (attempt === null) throw new AttemptExchangeError('attempt_not_found');
    if (
      attempt.repository === null ||
      attempt.workflow_ref === null ||
      attempt.github_run_id === null ||
      claims.repository !== attempt.repository ||
      claims.workflowRef !== attempt.workflow_ref ||
      claims.sha !== attempt.base_sha ||
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

    const attemptToken = opaqueToken();
    const toolBridgeToken = opaqueToken();
    const [oidcTokenDigest, tokenDigest, toolTokenDigest] = await Promise.all([
      canonicalSha256(oidcToken),
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
             lease_generation, scopes_json, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          attemptId,
          oidcTokenDigest,
          tokenDigest,
          toolTokenDigest,
          attempt.lease_generation,
          JSON.stringify(scopes),
          expiresAt,
          nowIso,
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
                 AND lease_generation = ? AND revoked_at IS NULL AND expires_at > ?
             )`,
        )
        .bind(
          nowIso,
          nowIso,
          attemptId,
          attempt.version,
          attempt.lease_generation,
          nowIso,
          oidcTokenDigest,
          tokenDigest,
          toolTokenDigest,
          attempt.lease_generation,
          nowIso,
        ),
    ]);

    const persisted = await this.db
      .prepare(
        `SELECT oidc_token_digest, token_digest, tool_token_digest, scopes_json, expires_at
         FROM attempt_tokens WHERE attempt_id = ? AND lease_generation = ?`,
      )
      .bind(attemptId, attempt.lease_generation)
      .first<AttemptTokenRow>();
    if (
      persisted === null ||
      persisted.oidc_token_digest !== oidcTokenDigest ||
      persisted.token_digest !== tokenDigest ||
      persisted.tool_token_digest !== toolTokenDigest
    ) {
      throw new AttemptExchangeError('oidc_replayed');
    }
    const activeAttempt = await this.db
      .prepare(
        `SELECT status, version, lease_generation FROM attempts WHERE attempt_id = ?`,
      )
      .bind(attemptId)
      .first<{ status: string; version: number; lease_generation: number }>();
    if (activeAttempt === null || activeAttempt.status !== 'running') {
      throw new AttemptExchangeError('attempt_lease_inactive');
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
