import { canonicalSha256 } from '../domain/digest.js';
import { EXECUTION_TOOL_ACTIONS } from '../domain/tool-bridge.js';
import type { VerifiedExecutorIdentity } from '../executor/core/executor-plugin.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';
import {
  CredentialCipher,
  type GitHubWriteCredentialProvider,
} from './repo-write-credential-store.js';

const ISSUE_LEASE_MS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export class ExecutorPublisherCredentialError extends Error {
  constructor(readonly code:
    | 'invalid_request'
    | 'not_found'
    | 'state_conflict'
    | 'policy_denied'
    | 'approval_required'
    | 'credential_issuing'
    | 'credential_conflict'
    | 'provider_unavailable') {
    super(`Executor publisher credential failed: ${code}`);
    this.name = 'ExecutorPublisherCredentialError';
  }
}

export interface ExecutorPublisherCredential {
  credentialId: string;
  publicationId: string;
  publisherExecutionId: string;
  repository: string;
  targetBranch: string;
  approvalId: string;
  token: string;
  expiresAt: string;
  permissions: { contents: 'write'; pullRequests: 'write' };
  created: boolean;
}

interface ContextRow {
  publication_id: string;
  publication_status: string;
  publisher_execution_id: string;
  target_branch: string;
  repository: string;
  expected_patch_digest: string;
  checkout_sha: string;
  execution_status: string;
  execution_role: string;
  execution_lease_generation: number;
  attempt_id: string;
  attempt_run_id: string;
  attempt_mode: 'implement' | 'review_fix';
  attempt_status: string;
  attempt_version: number;
  attempt_lease_generation: number;
  attempt_lease_expires_at: string | null;
  attempt_repository: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  run_state: string;
  task_revision: string;
  base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_digest: string | null;
  plan_status: string | null;
  progress_status: string | null;
  active_attempt_id: string | null;
  allow_repository_write: number;
  has_repo_write_effect: number;
  task_id: string;
}

interface ApprovalRow {
  approval_id: string;
  expires_at: string;
}

interface CredentialRow {
  credential_id: string;
  publication_id: string;
  publisher_execution_id: string;
  attempt_id: string;
  approval_id: string;
  repository: string;
  target_branch: string;
  lease_generation: number;
  status: string;
  issue_lease_token: string | null;
  issue_lease_expires_at: string | null;
  token_digest: string | null;
  token_ciphertext: string | null;
  token_iv: string | null;
  github_expires_at: string | null;
  authorization_expires_at: string | null;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ExecutorPublisherCredentialError('credential_conflict');
  return parsed;
}

export class ExecutorPublisherCredentialStore {
  private readonly cipher: CredentialCipher;
  private readonly generateLeaseToken: () => string;

  constructor(
    private readonly db: D1Database,
    private readonly provider: GitHubWriteCredentialProvider,
    options: { encryptionKey: string; generateLeaseToken?: () => string },
  ) {
    this.cipher = new CredentialCipher(options.encryptionKey);
    this.generateLeaseToken = options.generateLeaseToken ?? (() => crypto.randomUUID());
  }

  async issue(
    identity: VerifiedExecutorIdentity,
    publicationId: string,
    now = new Date(),
  ): Promise<ExecutorPublisherCredential> {
    if (
      identity.role !== 'publisher' || !ID_PATTERN.test(publicationId) ||
      !Number.isFinite(now.getTime())
    ) throw new ExecutorPublisherCredentialError('invalid_request');
    if (this.provider.writeCredentialPersistence === 'provider_reference') {
      throw new ExecutorPublisherCredentialError('policy_denied');
    }
    const context = await this.context(identity, publicationId, now);
    const approval = await this.approval(context, now);
    const digest = await canonicalSha256({ schemaVersion: '1', publicationId });
    const credentialId = `publisher-credential-${digest.slice(7, 47)}`;
    const existing = await this.credential(credentialId);
    if (existing !== null) return await this.existing(
      existing, identity, context, approval, now,
    );
    const lease = this.generateLeaseToken();
    if (lease.length < 1 || lease.length > 500) {
      throw new ExecutorPublisherCredentialError('credential_conflict');
    }
    const nowIso = now.toISOString();
    const inserted = await this.db.prepare(
      `INSERT INTO executor_publisher_write_credentials (
         credential_id, publication_id, publisher_execution_id, attempt_id,
         approval_id, repository, target_branch, lease_generation, status,
         issue_lease_token, issue_lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issuing', ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      credentialId,
      publicationId,
      identity.executionId,
      identity.attemptId,
      approval.approval_id,
      context.repository,
      context.target_branch,
      identity.leaseGeneration,
      lease,
      new Date(now.getTime() + ISSUE_LEASE_MS).toISOString(),
      nowIso,
      nowIso,
    ).run();
    if (inserted.meta.changes !== 1) {
      const raced = await this.credential(credentialId);
      if (raced === null) throw new ExecutorPublisherCredentialError('credential_conflict');
      return await this.existing(raced, identity, context, approval, now);
    }
    return await this.issueReserved(
      credentialId, lease, identity, publicationId, context, approval, now,
    );
  }

  private async issueReserved(
    credentialId: string,
    lease: string,
    identity: VerifiedExecutorIdentity,
    publicationId: string,
    context: ContextRow,
    approval: ApprovalRow,
    now: Date,
  ): Promise<ExecutorPublisherCredential> {
    const nowIso = now.toISOString();
    let issued: { token: string; expiresAt: string };
    try {
      issued = await this.provider.issueWriteCredential(context.repository);
    } catch {
      throw new ExecutorPublisherCredentialError('provider_unavailable');
    }
    if (
      issued.token.length < 1 || issued.token.length > 2_000 || /[\0\r\n]/.test(issued.token) ||
      timestamp(issued.expiresAt) <= now.getTime()
    ) throw new ExecutorPublisherCredentialError('provider_unavailable');
    const authorizationExpiresAt = new Date(Math.min(
      timestamp(issued.expiresAt),
      timestamp(approval.expires_at),
      timestamp(context.attempt_lease_expires_at!),
    )).toISOString();
    if (authorizationExpiresAt <= nowIso) {
      throw new ExecutorPublisherCredentialError('approval_required');
    }
    const encrypted = await this.cipher.encrypt(issued.token, credentialId);
    const tokenDigest = await canonicalSha256(issued.token);
    await this.context(identity, publicationId, now);
    const activated = await this.db.prepare(
      `UPDATE executor_publisher_write_credentials
       SET status = 'active', issue_lease_token = NULL, issue_lease_expires_at = NULL,
           token_digest = ?, token_ciphertext = ?, token_iv = ?, github_expires_at = ?,
           authorization_expires_at = ?, updated_at = ?
       WHERE credential_id = ? AND status = 'issuing' AND issue_lease_token = ?
         AND issue_lease_expires_at > ?`,
    ).bind(
      tokenDigest,
      encrypted.ciphertext,
      encrypted.iv,
      new Date(timestamp(issued.expiresAt)).toISOString(),
      authorizationExpiresAt,
      nowIso,
      credentialId,
      lease,
      nowIso,
    ).run();
    if (activated.meta.changes !== 1) {
      try { await this.provider.revokeWriteCredential(issued.token); } catch { /* best effort */ }
      throw new ExecutorPublisherCredentialError('credential_conflict');
    }
    return this.result((await this.credential(credentialId))!, issued.token, true);
  }

  async authorizeAttempt(
    identity: VerifiedExecutorIdentity,
    publicationId: string,
    now = new Date(),
  ): Promise<RunnerAuthorization> {
    const context = await this.context(identity, publicationId, now);
    return {
      attemptId: context.attempt_id,
      runId: context.attempt_run_id,
      mode: context.attempt_mode,
      status: 'running',
      version: context.attempt_version,
      leaseGeneration: context.attempt_lease_generation,
      leaseExpiresAt: context.attempt_lease_expires_at!,
      scopes: [...EXECUTION_TOOL_ACTIONS],
    };
  }

  async authorizeRepositoryRead(
    identity: VerifiedExecutorIdentity,
    now = new Date(),
  ): Promise<{
    publicationId: string;
    repository: string;
    checkoutSha: string;
    targetBranch: string;
    targetBranchMode: 'new' | 'existing_fast_forward';
  }> {
    if (identity.role !== 'publisher' || !Number.isFinite(now.getTime())) {
      throw new ExecutorPublisherCredentialError('invalid_request');
    }
    const publication = await this.db.prepare(
      `SELECT publication_id
       FROM executor_patch_publications
       WHERE publisher_execution_id = ? AND attempt_id = ?`,
    ).bind(identity.executionId, identity.attemptId).first<{ publication_id: string }>();
    if (publication === null) throw new ExecutorPublisherCredentialError('not_found');
    const context = await this.context(identity, publication.publication_id, now);
    const derivedBranch = `agent/${context.task_id}/${context.attempt_id}`;
    return {
      publicationId: context.publication_id,
      repository: context.repository,
      checkoutSha: context.checkout_sha,
      targetBranch: context.target_branch,
      targetBranchMode: context.target_branch === derivedBranch
        ? 'new'
        : 'existing_fast_forward',
    };
  }

  async authorizePush(input: {
    attemptId: string;
    publisherExecutionId: string;
    rawToken: string;
    now?: Date;
  }): Promise<{
    repository: string;
    checkoutSha: string;
    targetBranch: string;
    targetBranchMode: 'new' | 'existing_fast_forward';
  }> {
    const now = input.now ?? new Date();
    if (
      !ID_PATTERN.test(input.attemptId) || !ID_PATTERN.test(input.publisherExecutionId) ||
      input.rawToken.length < 1 || input.rawToken.length > 2_000
    ) throw new ExecutorPublisherCredentialError('invalid_request');
    const digest = await canonicalSha256(input.rawToken);
    const row = await this.db.prepare(
      `SELECT publication.publication_id, patch.checkout_sha,
              credential.repository, credential.target_branch,
              tasks.task_id
       FROM executor_publisher_write_credentials AS credential
       JOIN executor_patch_publications AS publication
         ON publication.publication_id = credential.publication_id
        AND publication.publisher_execution_id = credential.publisher_execution_id
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = credential.publisher_execution_id
       JOIN attempts ON attempts.attempt_id = credential.attempt_id
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN executor_patch_artifacts AS patch ON patch.patch_id = publication.patch_id
       WHERE credential.attempt_id = ? AND credential.publisher_execution_id = ?
         AND credential.token_digest = ? AND credential.status = 'active'
         AND credential.authorization_expires_at > ? AND credential.github_expires_at > ?
         AND publication.status = 'running' AND execution.status IN ('starting', 'running')
         AND execution.execution_role = 'publisher'
         AND attempts.status = 'running'
         AND attempts.lease_generation = credential.lease_generation
         AND attempts.lease_expires_at > ?`,
    ).bind(
      input.attemptId,
      input.publisherExecutionId,
      digest,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ).first<{
      publication_id: string;
      checkout_sha: string;
      repository: string;
      target_branch: string;
      task_id: string;
    }>();
    if (row === null) throw new ExecutorPublisherCredentialError('policy_denied');
    const derivedBranch = `agent/${row.task_id}/${input.attemptId}`;
    return {
      repository: row.repository,
      checkoutSha: row.checkout_sha,
      targetBranch: row.target_branch,
      targetBranchMode: row.target_branch === derivedBranch
        ? 'new'
        : 'existing_fast_forward',
    };
  }

  async revoke(publicationId: string, publisherExecutionId: string, now = new Date()): Promise<void> {
    const row = await this.db.prepare(
      `SELECT credential_id, token_ciphertext, token_iv, status
       FROM executor_publisher_write_credentials
       WHERE publication_id = ? AND publisher_execution_id = ?`,
    ).bind(publicationId, publisherExecutionId).first<{
      credential_id: string;
      token_ciphertext: string | null;
      token_iv: string | null;
      status: string;
    }>();
    if (row === null) throw new ExecutorPublisherCredentialError('not_found');
    if (row.status === 'revoked' || row.status === 'expired') return;
    if (row.status !== 'active' || row.token_ciphertext === null || row.token_iv === null) {
      throw new ExecutorPublisherCredentialError('credential_conflict');
    }
    const token = await this.cipher.decrypt(row.token_ciphertext, row.token_iv, row.credential_id);
    try {
      await this.provider.revokeWriteCredential(token);
    } catch {
      throw new ExecutorPublisherCredentialError('provider_unavailable');
    }
    const updated = await this.db.prepare(
      `UPDATE executor_publisher_write_credentials
       SET status = 'revoked', revoked_at = ?, updated_at = ?
       WHERE credential_id = ? AND status = 'active'`,
    ).bind(now.toISOString(), now.toISOString(), row.credential_id).run();
    if (updated.meta.changes !== 1) throw new ExecutorPublisherCredentialError('credential_conflict');
  }

  private async context(
    identity: VerifiedExecutorIdentity,
    publicationId: string,
    now: Date,
  ): Promise<ContextRow> {
    const row = await this.db.prepare(
      `SELECT publication.publication_id, publication.status AS publication_status,
              publication.publisher_execution_id, publication.target_branch,
              publication.repository, publication.expected_patch_digest,
              patch.checkout_sha,
              execution.status AS execution_status, execution.execution_role,
              execution.lease_generation AS execution_lease_generation,
              attempts.attempt_id, attempts.run_id AS attempt_run_id,
              attempts.mode AS attempt_mode, attempts.status AS attempt_status,
              attempts.version AS attempt_version,
              attempts.lease_generation AS attempt_lease_generation,
              attempts.lease_expires_at AS attempt_lease_expires_at,
              attempts.repository AS attempt_repository, attempts.plan_id,
              attempts.plan_version, attempts.plan_item_id,
              runs.state AS run_state, runs.task_revision, runs.base_sha,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              plans.digest AS plan_digest, plans.status AS plan_status,
              progress.status AS progress_status, progress.active_attempt_id,
              tasks.allow_repository_write, tasks.task_id,
              EXISTS (
                SELECT 1 FROM plan_item_effects AS effects
                WHERE effects.plan_id = attempts.plan_id
                  AND effects.item_id = attempts.plan_item_id
                  AND effects.effect = 'repo_write'
              ) AS has_repo_write_effect
       FROM executor_patch_publications AS publication
       JOIN executor_patch_artifacts AS patch ON patch.patch_id = publication.patch_id
       JOIN attempt_execution_instances AS execution
         ON execution.execution_id = publication.publisher_execution_id
       JOIN attempts ON attempts.attempt_id = publication.attempt_id
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = attempts.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = attempts.plan_id AND progress.item_id = attempts.plan_item_id
       WHERE publication.publication_id = ? AND publication.publisher_execution_id = ?`,
    ).bind(publicationId, identity.executionId).first<ContextRow>();
    if (row === null) throw new ExecutorPublisherCredentialError('not_found');
    const nowIso = now.toISOString();
    if (
      identity.attemptId !== row.attempt_id ||
      identity.leaseGeneration !== row.execution_lease_generation ||
      identity.repository !== row.repository || identity.role !== 'publisher' ||
      row.publication_status !== 'running' || row.execution_role !== 'publisher' ||
      !['starting', 'running'].includes(row.execution_status) ||
      row.attempt_status !== 'running' ||
      row.attempt_lease_generation !== identity.leaseGeneration ||
      row.attempt_lease_expires_at === null || row.attempt_lease_expires_at <= nowIso ||
      row.attempt_repository !== row.repository || row.plan_id === null ||
      row.plan_version === null || row.plan_item_id === null ||
      row.run_state !== 'executing' || row.active_plan_id !== row.plan_id ||
      row.active_plan_version !== row.plan_version || row.active_plan_digest !== row.plan_digest ||
      row.plan_status !== 'active' || row.progress_status !== 'in_progress' ||
      row.active_attempt_id !== row.attempt_id || row.allow_repository_write !== 1 ||
      row.has_repo_write_effect !== 1
    ) throw new ExecutorPublisherCredentialError('state_conflict');
    return row;
  }

  private async approval(context: ContextRow, now: Date): Promise<ApprovalRow> {
    const row = await this.db.prepare(
      `SELECT approvals.approval_id, approvals.expires_at
       FROM approvals
       WHERE approvals.run_id = (
         SELECT run_id FROM attempts WHERE attempt_id = ?
       ) AND approvals.task_revision = ? AND approvals.plan_id = ?
         AND approvals.plan_version = ? AND approvals.plan_digest = ?
         AND approvals.base_sha = ? AND approvals.effect = 'repo_write'
         AND approvals.decision = 'approve' AND approvals.created_at <= ?
         AND approvals.expires_at > ?
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
             AND newer.effect = approvals.effect AND newer.decision = 'reject'
             AND (newer.created_at > approvals.created_at OR
                  (newer.created_at = approvals.created_at
                   AND newer.approval_id > approvals.approval_id))
         )
       ORDER BY approvals.created_at DESC, approvals.approval_id DESC LIMIT 1`,
    ).bind(
      context.attempt_id,
      context.task_revision,
      context.plan_id,
      context.plan_version,
      context.plan_digest,
      context.base_sha,
      now.toISOString(),
      now.toISOString(),
    ).first<ApprovalRow>();
    if (row === null) throw new ExecutorPublisherCredentialError('approval_required');
    return row;
  }

  private async credential(credentialId: string): Promise<CredentialRow | null> {
    return await this.db.prepare(
      `SELECT credential_id, publication_id, publisher_execution_id, attempt_id,
              approval_id, repository, target_branch, lease_generation, status,
              issue_lease_token, issue_lease_expires_at, token_digest,
              token_ciphertext, token_iv, github_expires_at, authorization_expires_at
       FROM executor_publisher_write_credentials WHERE credential_id = ?`,
    ).bind(credentialId).first<CredentialRow>();
  }

  private async existing(
    row: CredentialRow,
    identity: VerifiedExecutorIdentity,
    context: ContextRow,
    approval: ApprovalRow,
    now: Date,
  ): Promise<ExecutorPublisherCredential> {
    if (
      row.publication_id !== context.publication_id ||
      row.publisher_execution_id !== context.publisher_execution_id ||
      row.attempt_id !== context.attempt_id || row.approval_id !== approval.approval_id ||
      row.repository !== context.repository || row.target_branch !== context.target_branch ||
      row.lease_generation !== context.attempt_lease_generation
    ) throw new ExecutorPublisherCredentialError('credential_conflict');
    if (row.status === 'issuing') {
      if ((row.issue_lease_expires_at ?? '') > now.toISOString()) {
        throw new ExecutorPublisherCredentialError('credential_issuing');
      }
      const lease = this.generateLeaseToken();
      if (lease.length < 1 || lease.length > 500) {
        throw new ExecutorPublisherCredentialError('credential_conflict');
      }
      const claimed = await this.db.prepare(
        `UPDATE executor_publisher_write_credentials
         SET issue_lease_token = ?, issue_lease_expires_at = ?, updated_at = ?
         WHERE credential_id = ? AND status = 'issuing'
           AND issue_lease_expires_at <= ? AND token_digest IS NULL`,
      ).bind(
        lease,
        new Date(now.getTime() + ISSUE_LEASE_MS).toISOString(),
        now.toISOString(),
        row.credential_id,
        now.toISOString(),
      ).run();
      if (claimed.meta.changes !== 1) {
        throw new ExecutorPublisherCredentialError('credential_issuing');
      }
      return await this.issueReserved(
        row.credential_id, lease, identity, row.publication_id, context, approval, now,
      );
    }
    if (
      row.status !== 'active' || row.token_ciphertext === null || row.token_iv === null ||
      row.github_expires_at === null || row.authorization_expires_at === null ||
      row.authorization_expires_at <= now.toISOString()
    ) throw new ExecutorPublisherCredentialError('policy_denied');
    return this.result(
      row,
      await this.cipher.decrypt(row.token_ciphertext, row.token_iv, row.credential_id),
      false,
    );
  }

  private result(row: CredentialRow, token: string, created: boolean): ExecutorPublisherCredential {
    return {
      credentialId: row.credential_id,
      publicationId: row.publication_id,
      publisherExecutionId: row.publisher_execution_id,
      repository: row.repository,
      targetBranch: row.target_branch,
      approvalId: row.approval_id,
      token,
      expiresAt: row.authorization_expires_at!,
      permissions: { contents: 'write', pullRequests: 'write' },
      created,
    };
  }
}
