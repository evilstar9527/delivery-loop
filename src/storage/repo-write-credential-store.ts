import { canonicalSha256 } from '../domain/digest.js';
import { isExactExecutionToolActions } from '../domain/tool-bridge.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

const ISSUE_LEASE_MS = 30_000;
const REVOCATION_LEASE_MS = 30_000;
const MAX_TOKEN_LENGTH = 2_000;

export interface GitHubWriteCredential {
  token: string;
  expiresAt: string;
}

export interface GitHubWriteCredentialProvider {
  issueWriteCredential(repository: string): Promise<GitHubWriteCredential>;
  revokeWriteCredential(token: string): Promise<void>;
}

export type RepoWriteCredentialErrorCode =
  | 'not_found'
  | 'state_conflict'
  | 'policy_denied'
  | 'approval_required'
  | 'credential_issuing'
  | 'credential_conflict'
  | 'provider_unavailable';

export class RepoWriteCredentialError extends Error {
  constructor(readonly code: RepoWriteCredentialErrorCode) {
    super(`repo_write credential operation failed: ${code}`);
    this.name = 'RepoWriteCredentialError';
  }
}

export interface IssuedRepoWriteCredential {
  credentialId: string;
  repository: string;
  token: string;
  expiresAt: string;
  githubExpiresAt: string;
  approvalId: string;
  permissions: { contents: 'write'; pullRequests: 'write' };
  created: boolean;
}

export interface RepoWriteCredentialStoreOptions {
  encryptionKey: string;
  generateLeaseToken?: () => string;
}

interface AuthorizationContextRow {
  attempt_id: string;
  run_id: string;
  attempt_mode: string;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  repository: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  run_state: string;
  task_revision: string;
  base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  task_repository: string;
  allow_repository_write: number;
  plan_digest: string | null;
  plan_status: string | null;
  progress_status: string | null;
  active_attempt_id: string | null;
  has_repo_write_effect: number;
}

interface ApprovalRow {
  approval_id: string;
  decision: string;
  expires_at: string;
  created_at: string;
}

interface CredentialRow {
  credential_id: string;
  run_id: string;
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  approval_id: string;
  repository: string;
  lease_generation: number;
  status: string;
  issue_lease_token: string | null;
  issue_lease_expires_at: string | null;
  token_digest: string | null;
  token_ciphertext: string | null;
  token_iv: string | null;
  github_expires_at: string | null;
  authorization_expires_at: string | null;
  revocation_lease_token: string | null;
  revocation_lease_expires_at: string | null;
}

interface RevocationCandidateRow extends CredentialRow {
  revoked_at: string | null;
}

function decodeBase64(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error('GitHub credential encryption key is invalid');
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) {
    throw new Error('GitHub credential encryption key is invalid');
  }
  return bytes;
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class CredentialCipher {
  private readonly rawKey: Uint8Array;

  constructor(encodedKey: string) {
    this.rawKey = decodeBase64(encodedKey);
  }

  private async key(): Promise<CryptoKey> {
    const rawKey = new ArrayBuffer(this.rawKey.byteLength);
    new Uint8Array(rawKey).set(this.rawKey);
    return await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async encrypt(token: string, credentialId: string): Promise<{ ciphertext: string; iv: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(credentialId),
      },
      await this.key(),
      new TextEncoder().encode(token),
    );
    return {
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      iv: encodeBase64(iv),
    };
  }

  async decrypt(ciphertext: string, iv: string, credentialId: string): Promise<string> {
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: Uint8Array.from(atob(iv), (character) => character.charCodeAt(0)),
          additionalData: new TextEncoder().encode(credentialId),
        },
        await this.key(),
        Uint8Array.from(atob(ciphertext), (character) => character.charCodeAt(0)),
      );
    } catch {
      throw new RepoWriteCredentialError('credential_conflict');
    }
    return new TextDecoder().decode(plaintext);
  }
}

function validTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RepoWriteCredentialError('credential_conflict');
  return timestamp;
}

function credentialPermissions(): { contents: 'write'; pullRequests: 'write' } {
  return { contents: 'write', pullRequests: 'write' };
}

/** Issues an encrypted-at-rest GitHub token only for one exact approved repo_write Attempt. */
export class RepoWriteCredentialStore {
  private readonly cipher: CredentialCipher;
  private readonly generateLeaseToken: () => string;

  constructor(
    private readonly db: D1Database,
    private readonly provider: GitHubWriteCredentialProvider,
    options: RepoWriteCredentialStoreOptions,
  ) {
    this.cipher = new CredentialCipher(options.encryptionKey);
    this.generateLeaseToken = options.generateLeaseToken ?? (() => crypto.randomUUID());
  }

  async issue(
    authorization: RunnerAuthorization,
    now = new Date(),
  ): Promise<IssuedRepoWriteCredential> {
    const context = await this.authorizationContext(authorization, now);
    const approval = await this.currentApproval(context, now);
    const credentialId = await this.credentialId(authorization);
    const existing = await this.readCredential(credentialId);
    if (existing !== null) {
      return await this.handleExisting(existing, authorization, context, approval, now);
    }

    const issueLeaseToken = this.generateLeaseToken();
    if (issueLeaseToken.length === 0) throw new RepoWriteCredentialError('credential_conflict');
    const nowIso = now.toISOString();
    const issueLeaseExpiresAt = new Date(now.getTime() + ISSUE_LEASE_MS).toISOString();
    const inserted = await this.db
      .prepare(
        `INSERT INTO github_write_credentials (
           credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           approval_id, repository, lease_generation, status, issue_lease_token,
           issue_lease_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issuing', ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        credentialId,
        authorization.runId,
        authorization.attemptId,
        context.plan_id,
        context.plan_version,
        context.plan_item_id,
        approval.approval_id,
        context.task_repository,
        authorization.leaseGeneration,
        issueLeaseToken,
        issueLeaseExpiresAt,
        nowIso,
        nowIso,
      )
      .run();
    if (inserted.meta.changes !== 1) {
      const raced = await this.readCredential(credentialId);
      if (raced === null) throw new RepoWriteCredentialError('credential_conflict');
      return await this.handleExisting(raced, authorization, context, approval, now);
    }

    return await this.issueReserved(
      credentialId,
      issueLeaseToken,
      authorization,
      context,
      approval,
      now,
    );
  }

  private async issueReserved(
    credentialId: string,
    issueLeaseToken: string,
    authorization: RunnerAuthorization,
    context: AuthorizationContextRow,
    approval: ApprovalRow,
    now: Date,
  ): Promise<IssuedRepoWriteCredential> {
    const nowIso = now.toISOString();
    let issued: GitHubWriteCredential;
    try {
      issued = await this.provider.issueWriteCredential(context.task_repository);
    } catch {
      await this.markIssuanceFailed(credentialId, issueLeaseToken, nowIso);
      throw new RepoWriteCredentialError('provider_unavailable');
    }
    if (
      issued.token.length < 1 ||
      issued.token.length > MAX_TOKEN_LENGTH ||
      /[\0\r\n]/.test(issued.token) ||
      validTimestamp(issued.expiresAt) <= now.getTime()
    ) {
      await this.safeRevoke(issued.token);
      await this.markIssuanceFailed(credentialId, issueLeaseToken, nowIso);
      throw new RepoWriteCredentialError('provider_unavailable');
    }

    const authorizationExpiresAt = new Date(Math.min(
      validTimestamp(issued.expiresAt),
      validTimestamp(approval.expires_at),
      validTimestamp(authorization.leaseExpiresAt),
    )).toISOString();
    if (authorizationExpiresAt <= nowIso) {
      await this.safeRevoke(issued.token);
      await this.markIssuanceFailed(credentialId, issueLeaseToken, nowIso);
      throw new RepoWriteCredentialError('approval_required');
    }
    const [tokenDigest, encrypted] = await Promise.all([
      canonicalSha256(issued.token),
      this.cipher.encrypt(issued.token, credentialId),
    ]);
    const finalized = await this.db
      .prepare(
        `UPDATE github_write_credentials
         SET status = 'active', issue_lease_token = NULL, issue_lease_expires_at = NULL,
             token_digest = ?, token_ciphertext = ?, token_iv = ?,
             github_expires_at = ?, authorization_expires_at = ?,
             last_error_code = NULL, updated_at = ?
         WHERE credential_id = ? AND status = 'issuing' AND issue_lease_token = ?
           AND issue_lease_expires_at > ?
           AND EXISTS (
             SELECT 1
             FROM attempts
             JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
               AND attempt_tokens.lease_generation = attempts.lease_generation
             JOIN runs ON runs.run_id = attempts.run_id
             JOIN tasks ON tasks.task_id = runs.task_id
             JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
             JOIN plan_item_progress
               ON plan_item_progress.plan_id = attempts.plan_id
              AND plan_item_progress.item_id = attempts.plan_item_id
             JOIN approvals ON approvals.approval_id = ?
             WHERE attempts.attempt_id = ?
               AND attempts.status = 'running'
               AND attempts.version = ?
               AND attempts.lease_generation = ?
               AND attempts.lease_expires_at > ?
               AND attempt_tokens.revoked_at IS NULL AND attempt_tokens.expires_at > ?
               AND runs.state = 'executing'
               AND runs.active_plan_id = attempts.plan_id
               AND runs.active_plan_version = attempts.plan_version
               AND runs.active_plan_digest = execution_plans.digest
               AND tasks.allow_repository_write = 1
               AND tasks.target_repository = attempts.repository
               AND execution_plans.status = 'active'
               AND plan_item_progress.status = 'in_progress'
               AND plan_item_progress.active_attempt_id = attempts.attempt_id
               AND approvals.run_id = runs.run_id
               AND approvals.task_revision = runs.task_revision
               AND approvals.plan_id = execution_plans.plan_id
               AND approvals.plan_version = execution_plans.plan_version
               AND approvals.plan_digest = execution_plans.digest
               AND approvals.base_sha = runs.base_sha
               AND approvals.effect = 'repo_write'
               AND approvals.decision = 'approve' AND approvals.expires_at > ?
               AND NOT EXISTS (
                 SELECT 1 FROM invalidated_approvals
                 WHERE invalidated_approvals.approval_id = approvals.approval_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM approvals AS newer
                 WHERE newer.run_id = approvals.run_id
                   AND newer.task_revision = approvals.task_revision
                   AND newer.plan_id = approvals.plan_id
                   AND newer.plan_version = approvals.plan_version
                   AND newer.plan_digest = approvals.plan_digest
                   AND newer.base_sha = approvals.base_sha
                   AND newer.effect = approvals.effect
                   AND newer.decision = 'reject'
                   AND (
                     newer.created_at > approvals.created_at
                     OR (newer.created_at = approvals.created_at
                         AND newer.approval_id > approvals.approval_id)
                   )
               )
               AND EXISTS (
                 SELECT 1 FROM plan_item_effects
                 WHERE plan_item_effects.plan_id = attempts.plan_id
                   AND plan_item_effects.item_id = attempts.plan_item_id
                   AND plan_item_effects.effect = 'repo_write'
               )
           )`,
      )
      .bind(
        tokenDigest,
        encrypted.ciphertext,
        encrypted.iv,
        new Date(validTimestamp(issued.expiresAt)).toISOString(),
        authorizationExpiresAt,
        nowIso,
        credentialId,
        issueLeaseToken,
        nowIso,
        approval.approval_id,
        authorization.attemptId,
        authorization.version,
        authorization.leaseGeneration,
        nowIso,
        nowIso,
        nowIso,
      )
      .run();
    if (finalized.meta.changes !== 1) {
      const revoked = await this.safeRevoke(issued.token);
      if (revoked) {
        await this.db
          .prepare(
            `UPDATE github_write_credentials
             SET status = 'revoked', issue_lease_token = NULL,
                 issue_lease_expires_at = NULL, revoked_at = ?,
                 last_error_code = 'authorization_changed', updated_at = ?
             WHERE credential_id = ? AND status = 'issuing'
               AND issue_lease_token = ?`,
          )
          .bind(nowIso, nowIso, credentialId, issueLeaseToken)
          .run();
      } else {
        await this.db
          .prepare(
            `UPDATE github_write_credentials
             SET status = 'revocation_pending', issue_lease_token = NULL,
                 issue_lease_expires_at = NULL, token_digest = ?,
                 token_ciphertext = ?, token_iv = ?, github_expires_at = ?,
                 authorization_expires_at = ?, last_error_code = 'authorization_changed',
                 updated_at = ?
             WHERE credential_id = ? AND status = 'issuing'
               AND issue_lease_token = ?`,
          )
          .bind(
            tokenDigest,
            encrypted.ciphertext,
            encrypted.iv,
            new Date(validTimestamp(issued.expiresAt)).toISOString(),
            nowIso,
            nowIso,
            credentialId,
            issueLeaseToken,
          )
          .run();
      }
      throw new RepoWriteCredentialError('credential_conflict');
    }
    return this.result(
      (await this.readCredential(credentialId))!,
      issued.token,
      true,
    );
  }

  private async handleExisting(
    row: CredentialRow,
    authorization: RunnerAuthorization,
    context: AuthorizationContextRow,
    approval: ApprovalRow,
    now: Date,
  ): Promise<IssuedRepoWriteCredential> {
    if (
      row.run_id !== authorization.runId ||
      row.attempt_id !== authorization.attemptId ||
      row.plan_id !== context.plan_id ||
      row.plan_version !== context.plan_version ||
      row.plan_item_id !== context.plan_item_id ||
      row.repository !== context.task_repository ||
      row.lease_generation !== authorization.leaseGeneration
    ) {
      throw new RepoWriteCredentialError('credential_conflict');
    }
    if (row.status === 'issuing' && (row.issue_lease_expires_at ?? '') > now.toISOString()) {
      throw new RepoWriteCredentialError('credential_issuing');
    }
    if (
      row.status === 'issuance_failed' ||
      (row.status === 'issuing' && (row.issue_lease_expires_at ?? '') <= now.toISOString())
    ) {
      const issueLeaseToken = this.generateLeaseToken();
      const claimed = await this.db
        .prepare(
          `UPDATE github_write_credentials
           SET status = 'issuing', approval_id = ?, issue_lease_token = ?,
               issue_lease_expires_at = ?, last_error_code = NULL, updated_at = ?
           WHERE credential_id = ?
             AND (
               status = 'issuance_failed'
               OR (status = 'issuing' AND issue_lease_expires_at <= ?)
             )`,
        )
        .bind(
          approval.approval_id,
          issueLeaseToken,
          new Date(now.getTime() + ISSUE_LEASE_MS).toISOString(),
          now.toISOString(),
          row.credential_id,
          now.toISOString(),
        )
        .run();
      if (claimed.meta.changes !== 1) {
        throw new RepoWriteCredentialError('credential_issuing');
      }
      return await this.issueReserved(
        row.credential_id,
        issueLeaseToken,
        authorization,
        context,
        approval,
        now,
      );
    }
    if (row.status !== 'active') throw new RepoWriteCredentialError('state_conflict');
    if (
      row.authorization_expires_at === null ||
      row.authorization_expires_at <= now.toISOString() ||
      row.token_ciphertext === null ||
      row.token_iv === null ||
      row.token_digest === null
    ) {
      throw new RepoWriteCredentialError('state_conflict');
    }
    const token = await this.cipher.decrypt(row.token_ciphertext, row.token_iv, row.credential_id);
    if (await canonicalSha256(token) !== row.token_digest) {
      throw new RepoWriteCredentialError('credential_conflict');
    }
    return this.result(row, token, false);
  }

  private async authorizationContext(
    authorization: RunnerAuthorization,
    now: Date,
  ): Promise<AuthorizationContextRow> {
    const row = await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.mode AS attempt_mode,
                attempts.status AS attempt_status, attempts.version AS attempt_version,
                attempts.lease_generation, attempts.lease_expires_at,
                attempts.repository, attempts.plan_id, attempts.plan_version,
                attempts.plan_item_id, runs.state AS run_state, runs.task_revision,
                runs.base_sha, runs.active_plan_id, runs.active_plan_version,
                runs.active_plan_digest, tasks.target_repository AS task_repository,
                tasks.allow_repository_write, execution_plans.digest AS plan_digest,
                execution_plans.status AS plan_status,
                plan_item_progress.status AS progress_status,
                plan_item_progress.active_attempt_id,
                EXISTS (
                  SELECT 1 FROM plan_item_effects
                  WHERE plan_item_effects.plan_id = attempts.plan_id
                    AND plan_item_effects.item_id = attempts.plan_item_id
                    AND plan_item_effects.effect = 'repo_write'
                ) AS has_repo_write_effect
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         LEFT JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
      )
      .bind(authorization.attemptId, authorization.runId)
      .first<AuthorizationContextRow>();
    if (row === null) throw new RepoWriteCredentialError('not_found');
    if (
      row.attempt_status !== 'running' ||
      row.attempt_version !== authorization.version ||
      row.lease_generation !== authorization.leaseGeneration ||
      row.lease_expires_at !== authorization.leaseExpiresAt ||
      row.lease_expires_at <= now.toISOString()
    ) {
      // authorize() already checked time. Exact row equality here prevents a stale caller snapshot.
      throw new RepoWriteCredentialError('state_conflict');
    }
    if (
      (row.attempt_mode !== 'implement' && row.attempt_mode !== 'review_fix') ||
      row.run_state !== 'executing' ||
      row.plan_id === null ||
      row.plan_version === null ||
      row.plan_item_id === null ||
      row.active_plan_id !== row.plan_id ||
      row.active_plan_version !== row.plan_version ||
      row.active_plan_digest !== row.plan_digest ||
      row.plan_status !== 'active' ||
      row.progress_status !== 'in_progress' ||
      row.active_attempt_id !== row.attempt_id ||
      row.repository !== row.task_repository ||
      row.base_sha === null ||
      row.has_repo_write_effect !== 1
    ) {
      throw new RepoWriteCredentialError('state_conflict');
    }
    if (row.allow_repository_write !== 1) {
      throw new RepoWriteCredentialError('policy_denied');
    }
    if (!isExactExecutionToolActions(authorization.scopes)) {
      throw new RepoWriteCredentialError('policy_denied');
    }
    return row;
  }

  private async currentApproval(
    context: AuthorizationContextRow,
    now: Date,
  ): Promise<ApprovalRow> {
    const approval = await this.db
      .prepare(
        `SELECT approval_id, decision, expires_at, created_at
         FROM approvals
         WHERE run_id = ? AND task_revision = ? AND plan_id = ?
           AND plan_version = ? AND plan_digest = ? AND base_sha = ?
           AND effect = 'repo_write'
           AND NOT EXISTS (
             SELECT 1 FROM invalidated_approvals
             WHERE invalidated_approvals.approval_id = approvals.approval_id
           )
         ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
      )
      .bind(
        context.run_id,
        context.task_revision,
        context.plan_id,
        context.plan_version,
        context.plan_digest,
        context.base_sha,
      )
      .first<ApprovalRow>();
    if (
      approval === null ||
      approval.decision !== 'approve' ||
      approval.created_at > now.toISOString() ||
      approval.expires_at <= now.toISOString() ||
      !Number.isFinite(Date.parse(approval.expires_at))
    ) {
      throw new RepoWriteCredentialError('approval_required');
    }
    return approval;
  }

  private async credentialId(authorization: RunnerAuthorization): Promise<string> {
    const digest = await canonicalSha256({
      attemptId: authorization.attemptId,
      leaseGeneration: authorization.leaseGeneration,
      effect: 'repo_write',
    });
    return `github_write_${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`;
  }

  private async readCredential(credentialId: string): Promise<CredentialRow | null> {
    return await this.db
      .prepare('SELECT * FROM github_write_credentials WHERE credential_id = ?')
      .bind(credentialId)
      .first<CredentialRow>();
  }

  private async markIssuanceFailed(
    credentialId: string,
    issueLeaseToken: string,
    nowIso: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_write_credentials
         SET status = 'issuance_failed', issue_lease_token = NULL,
             issue_lease_expires_at = NULL, last_error_code = 'provider_unavailable',
             updated_at = ?
         WHERE credential_id = ? AND status = 'issuing' AND issue_lease_token = ?`,
      )
      .bind(nowIso, credentialId, issueLeaseToken)
      .run();
  }

  private async safeRevoke(token: string): Promise<boolean> {
    try {
      await this.provider.revokeWriteCredential(token);
      return true;
    } catch {
      // The durable row remains failed/conflicted; no Secret enters the error path.
      return false;
    }
  }

  private result(
    row: CredentialRow,
    token: string,
    created: boolean,
  ): IssuedRepoWriteCredential {
    if (row.authorization_expires_at === null || row.github_expires_at === null) {
      throw new RepoWriteCredentialError('credential_conflict');
    }
    return {
      credentialId: row.credential_id,
      repository: row.repository,
      token,
      expiresAt: row.authorization_expires_at,
      githubExpiresAt: row.github_expires_at,
      approvalId: row.approval_id,
      permissions: credentialPermissions(),
      created,
    };
  }
}

export interface RepoWriteCredentialRevokerOptions {
  encryptionKey: string;
  now?: () => Date;
  generateLeaseToken?: () => string;
}

export interface RepoWriteRevocationResult {
  attemptId: string;
  disposition: 'revoked' | 'expired';
}

/** Reconciles approval/Attempt expiry with GitHub's external token state. */
export class RepoWriteCredentialRevoker {
  private readonly cipher: CredentialCipher;
  private readonly now: () => Date;
  private readonly generateLeaseToken: () => string;

  constructor(
    private readonly db: D1Database,
    private readonly provider: GitHubWriteCredentialProvider,
    options: RepoWriteCredentialRevokerOptions,
  ) {
    this.cipher = new CredentialCipher(options.encryptionKey);
    this.now = options.now ?? (() => new Date());
    this.generateLeaseToken = options.generateLeaseToken ?? (() => crypto.randomUUID());
  }

  async scan(limit = 25): Promise<RepoWriteRevocationResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('repo_write credential revoke limit is invalid');
    }
    const candidates = await this.db
      .prepare(
        `SELECT * FROM github_write_credentials
         WHERE status IN ('active', 'revocation_pending')
            OR (status = 'revoking' AND revocation_lease_expires_at <= ?)
         ORDER BY authorization_expires_at, credential_id LIMIT ?`,
      )
      .bind(this.now().toISOString(), limit)
      .all<RevocationCandidateRow>();
    const results: RepoWriteRevocationResult[] = [];
    for (const candidate of candidates.results) {
      const result = await this.revokeIfNeeded(candidate);
      if (result !== null) results.push(result);
    }
    return results;
  }

  private async revokeIfNeeded(
    candidate: RevocationCandidateRow,
  ): Promise<RepoWriteRevocationResult | null> {
    const now = this.now();
    const nowIso = now.toISOString();
    if ((candidate.github_expires_at ?? '') <= nowIso) {
      const expired = await this.db
        .prepare(
          `UPDATE github_write_credentials
           SET status = 'expired', token_ciphertext = NULL, token_iv = NULL,
               issue_lease_token = NULL, issue_lease_expires_at = NULL,
               updated_at = ?
           WHERE credential_id = ?
             AND (
               status IN ('active', 'revocation_pending')
               OR (status = 'revoking' AND revocation_lease_expires_at <= ?)
             )`,
        )
        .bind(nowIso, candidate.credential_id, nowIso)
        .run();
      return expired.meta.changes === 1
        ? { attemptId: candidate.attempt_id, disposition: 'expired' }
        : null;
    }
    if (
      candidate.status !== 'revoking' &&
      (candidate.authorization_expires_at ?? '') > nowIso &&
      await this.stillAuthorized(candidate, nowIso)
    ) {
      return null;
    }
    if (candidate.token_ciphertext === null || candidate.token_iv === null) {
      throw new RepoWriteCredentialError('credential_conflict');
    }
    const revocationLeaseToken = this.generateLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + REVOCATION_LEASE_MS).toISOString();
    const claimed = await this.db
      .prepare(
        `UPDATE github_write_credentials
         SET status = 'revoking', revocation_lease_token = ?,
             revocation_lease_expires_at = ?, updated_at = ?
         WHERE credential_id = ?
           AND (
             status IN ('active', 'revocation_pending')
             OR (status = 'revoking' AND revocation_lease_expires_at <= ?)
           )`,
      )
      .bind(
        revocationLeaseToken,
        leaseExpiresAt,
        nowIso,
        candidate.credential_id,
        nowIso,
      )
      .run();
    if (claimed.meta.changes !== 1) return null;
    const token = await this.cipher.decrypt(
      candidate.token_ciphertext,
      candidate.token_iv,
      candidate.credential_id,
    );
    try {
      await this.provider.revokeWriteCredential(token);
    } catch {
      await this.db
        .prepare(
          `UPDATE github_write_credentials
           SET status = 'revocation_pending', revocation_lease_token = NULL,
               revocation_lease_expires_at = NULL,
               last_error_code = 'provider_unavailable', updated_at = ?
           WHERE credential_id = ? AND status = 'revoking'
             AND revocation_lease_token = ?`,
        )
        .bind(nowIso, candidate.credential_id, revocationLeaseToken)
        .run();
      return null;
    }
    const revoked = await this.db
      .prepare(
        `UPDATE github_write_credentials
         SET status = 'revoked', token_ciphertext = NULL, token_iv = NULL,
             revocation_lease_token = NULL, revocation_lease_expires_at = NULL,
             revoked_at = ?, last_error_code = NULL, updated_at = ?
         WHERE credential_id = ? AND status = 'revoking'
           AND revocation_lease_token = ?`,
      )
      .bind(nowIso, nowIso, candidate.credential_id, revocationLeaseToken)
      .run();
    return revoked.meta.changes === 1
      ? { attemptId: candidate.attempt_id, disposition: 'revoked' }
      : null;
  }

  private async stillAuthorized(candidate: CredentialRow, nowIso: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM github_write_credentials
         JOIN attempts ON attempts.attempt_id = github_write_credentials.attempt_id
         JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
           AND attempt_tokens.lease_generation = github_write_credentials.lease_generation
         JOIN runs ON runs.run_id = github_write_credentials.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans ON execution_plans.plan_id = github_write_credentials.plan_id
         JOIN plan_item_progress
           ON plan_item_progress.plan_id = github_write_credentials.plan_id
          AND plan_item_progress.item_id = github_write_credentials.plan_item_id
         JOIN approvals ON approvals.approval_id = github_write_credentials.approval_id
         WHERE github_write_credentials.credential_id = ?
           AND attempts.status = 'running'
           AND attempts.lease_generation = github_write_credentials.lease_generation
           AND attempts.lease_expires_at > ?
           AND attempts.repository = github_write_credentials.repository
           AND attempts.plan_id = github_write_credentials.plan_id
           AND attempts.plan_version = github_write_credentials.plan_version
           AND attempts.plan_item_id = github_write_credentials.plan_item_id
           AND attempt_tokens.revoked_at IS NULL AND attempt_tokens.expires_at > ?
           AND runs.state = 'executing'
           AND runs.active_plan_id = github_write_credentials.plan_id
           AND runs.active_plan_version = github_write_credentials.plan_version
           AND runs.active_plan_digest = execution_plans.digest
           AND execution_plans.status = 'active'
           AND plan_item_progress.status = 'in_progress'
           AND plan_item_progress.active_attempt_id = attempts.attempt_id
           AND tasks.allow_repository_write = 1
           AND tasks.target_repository = github_write_credentials.repository
           AND EXISTS (
             SELECT 1 FROM plan_item_effects
             WHERE plan_item_effects.plan_id = github_write_credentials.plan_id
               AND plan_item_effects.item_id = github_write_credentials.plan_item_id
               AND plan_item_effects.effect = 'repo_write'
           )
           AND approvals.decision = 'approve' AND approvals.expires_at > ?
           AND approvals.created_at <= ?
           AND approvals.run_id = runs.run_id
           AND approvals.task_revision = runs.task_revision
           AND approvals.plan_id = execution_plans.plan_id
           AND approvals.plan_version = execution_plans.plan_version
           AND approvals.plan_digest = execution_plans.digest
           AND approvals.base_sha = runs.base_sha
           AND approvals.effect = 'repo_write'
           AND NOT EXISTS (
             SELECT 1 FROM invalidated_approvals
             WHERE invalidated_approvals.approval_id = approvals.approval_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM approvals AS newer
             WHERE newer.run_id = approvals.run_id
               AND newer.task_revision = approvals.task_revision
               AND newer.plan_id = approvals.plan_id
               AND newer.plan_version = approvals.plan_version
               AND newer.plan_digest = approvals.plan_digest
               AND newer.base_sha = approvals.base_sha
               AND newer.effect = approvals.effect
               AND newer.decision = 'reject'
               AND (
                 newer.created_at > approvals.created_at
                 OR (newer.created_at = approvals.created_at
                     AND newer.approval_id > approvals.approval_id)
               )
           )`,
      )
      .bind(candidate.credential_id, nowIso, nowIso, nowIso, nowIso)
      .first<{ count: number }>();
    return row?.count === 1;
  }
}
