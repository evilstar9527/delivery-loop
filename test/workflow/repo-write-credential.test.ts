/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { EXECUTION_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';
import { GitHubPatTokenProvider } from '../../src/auth/github-pat-token.js';
import { attemptApi } from '../../src/http/attempt-api.js';
import type { RunnerAuthorization } from '../../src/storage/runner-attempt-store.js';
import {
  RepoWriteCredentialError,
  RepoWriteCredentialRevoker,
  RepoWriteCredentialStore,
  type GitHubWriteCredential,
  type GitHubWriteCredentialProvider,
} from '../../src/storage/repo-write-credential-store.js';

const NOW = new Date('2026-07-25T10:00:00.000Z');
const RUN_ID = 'run-repo-write-credential';
const ATTEMPT_ID = 'attempt-repo-write-credential';
const PLAN_ID = 'plan-repo-write-credential';
const ITEM_ID = 'change';
const REPOSITORY = 'example/delivery-target';
const BASE_SHA = 'd'.repeat(40);
const PLAN_DIGEST = `sha256:${'e'.repeat(64)}`;
const RAW_TOKEN = 'github-write-token-canary-plaintext';
const RAW_RUNNER_TOKEN = 'repo-write-runner-token';
const ENCRYPTION_KEY = btoa('0123456789abcdef0123456789abcdef');

const AUTHORIZATION: RunnerAuthorization = {
  attemptId: ATTEMPT_ID,
  runId: RUN_ID,
  mode: 'implement',
  status: 'running',
  version: 2,
  leaseGeneration: 1,
  leaseExpiresAt: '2026-07-25T10:10:00.000Z',
  scopes: [...EXECUTION_TOOL_ACTIONS],
};

class FakeGitHubWriteCredentialProvider implements GitHubWriteCredentialProvider {
  readonly issuedRepositories: string[] = [];
  readonly revokedTokens: string[] = [];
  failures = 0;
  revokeFailures = 0;
  beforeIssueReturn?: () => Promise<void>;

  async issueWriteCredential(repository: string): Promise<GitHubWriteCredential> {
    this.issuedRepositories.push(repository);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('simulated GitHub unavailable');
    }
    await this.beforeIssueReturn?.();
    return {
      token: RAW_TOKEN,
      expiresAt: '2026-07-25T11:00:00.000Z',
    };
  }

  async revokeWriteCredential(token: string): Promise<void> {
    if (this.revokeFailures > 0) {
      this.revokeFailures -= 1;
      throw new Error('simulated GitHub revoke unavailable');
    }
    this.revokedTokens.push(token);
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_signals'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_external_facts'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_command_refs'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_dependencies'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_acceptance_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_evidence_refs'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_assumptions'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM executor_patch_publications'),
    env.DB_CONTROL.prepare('DELETE FROM executor_patch_artifacts'),
    env.DB_CONTROL.prepare('DELETE FROM executor_cancellations'),
    env.DB_CONTROL.prepare('DELETE FROM executor_reconciliation_failures'),
    env.DB_CONTROL.prepare('DELETE FROM executor_observations'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_execution_instances'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM executor_routes'),
    env.DB_CONTROL.prepare(
      `DELETE FROM executor_profiles WHERE profile_id <> 'legacy-github-actions-v1'`,
    ),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seed(): Promise<void> {
  const now = NOW.toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-repo-write-credential', 'manual', 'repo-write-test', 'repo-write-test',
         'rev-1', ?, 'r2://tasks/repo-write-test', 'system', 'repo-write-test', ?,
         'main', 'test', 'bug', 'Repo write credential test', 'p1', 1, 1, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'f'.repeat(64)}`, REPOSITORY, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-repo-write-credential', 'rev-1', ?, ?, ?, 'executing', 4,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, `sha256:${'f'.repeat(64)}`, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, plan_id, plan_version, plan_item_id,
         claimed_progress_version, version, lease_generation, lease_token_digest,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', 'running', ?, ?, ?, '987654321', ?, 1, ?,
                 1, 2, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      `${REPOSITORY}/.github/workflows/delivery-agent.yml@refs/heads/main`,
      PLAN_ID,
      ITEM_ID,
      `sha256:${'1'.repeat(64)}`,
      AUTHORIZATION.leaseExpiresAt,
      now,
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', ?, 'Apply approved fix.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ATTEMPT_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-repo-write-credential', ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'2'.repeat(64)}`,
      await canonicalSha256(RAW_RUNNER_TOKEN),
      `sha256:${'4'.repeat(64)}`,
      JSON.stringify(AUTHORIZATION.scopes),
      AUTHORIZATION.leaseExpiresAt,
      now,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'change', 'Apply fix', 'Apply the approved repository change.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, now),
  ]);
}

async function approve(args: {
  decision?: 'approve' | 'reject';
  expiresAt?: string;
  baseSha?: string;
  id?: string;
  createdAt?: string;
} = {}): Promise<void> {
  const id = args.id ?? 'approval-repo-write';
  await env.DB_CONTROL.prepare(
    `INSERT INTO approvals (
       approval_id, run_id, task_revision, plan_id, plan_version,
       plan_digest, base_sha, effect, actor_id, decision, nonce_digest,
       expires_at, created_at
     ) VALUES (?, ?, 'rev-1', ?, 1, ?, ?, 'repo_write', 'user:approver', ?, ?, ?, ?)`,
  ).bind(
    id,
    RUN_ID,
    PLAN_ID,
    PLAN_DIGEST,
    args.baseSha ?? BASE_SHA,
    args.decision ?? 'approve',
    `sha256:${id.padEnd(64, '0').slice(0, 64)}`,
    args.expiresAt ?? '2026-07-25T10:05:00.000Z',
    args.createdAt ?? NOW.toISOString(),
  ).run();
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('repo_write approval and GitHub credential broker', () => {
  it('does not call GitHub or persist a credential without exact repo_write approval and Task policy', async () => {
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      name: RepoWriteCredentialError.name,
      code: 'approval_required',
    });
    await approve({ baseSha: '0'.repeat(40) });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      code: 'approval_required',
    });
    expect(provider.issuedRepositories).toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_write_credentials',
    ).first()).toEqual({ count: 0 });

    await env.DB_CONTROL.prepare(
      'UPDATE tasks SET allow_repository_write = 0 WHERE task_id = ?',
    ).bind('task-repo-write-credential').run();
    await approve({ id: 'approval-repo-write-exact' });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(provider.issuedRepositories).toEqual([]);
  });

  it('enforces the same approval gate through the authenticated Runner HTTP route', async () => {
    const provider = new FakeGitHubWriteCredentialProvider();
    const api = attemptApi({
      repoWriteCredentialRuntime: { provider, encryptionKey: ENCRYPTION_KEY },
      now: () => NOW,
    });
    const request = async (): Promise<Response> => await api.fetch(new Request(
      `https://delivery-loop.test/v1/attempts/${ATTEMPT_ID}/github/write-token`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RAW_RUNNER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expectedVersion: 2, leaseGeneration: 1 }),
      },
    ), env);

    const denied = await request();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'policy_denied' });
    expect(provider.issuedRepositories).toEqual([]);

    await approve();
    const issued = await request();
    expect(issued.status).toBe(201);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(await issued.json()).toMatchObject({
      repository: REPOSITORY,
      token: RAW_TOKEN,
      permissions: { contents: 'write', pullRequests: 'write' },
    });
    expect(provider.issuedRepositories).toEqual([REPOSITORY]);
  });

  it('never issues a Git write credential to an executor work-token grant', async () => {
    await approve();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare('DELETE FROM attempt_tokens WHERE attempt_id = ?').bind(ATTEMPT_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO executor_profiles (
           profile_id, schema_version, provider_kind, plugin_schema_version,
           release_digest, configuration_json, capabilities_json, status,
           created_at, activated_at
         ) VALUES ('executor-work-no-write', '1', 'cloudflare_sandbox', '1', ?,
                   '{}', '{}', 'active', ?, ?)`,
      ).bind(`sha256:${'8'.repeat(64)}`, NOW.toISOString(), NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET executor_profile_id = 'executor-work-no-write',
             executor_route_version = 1 WHERE attempt_id = ?`,
      ).bind(ATTEMPT_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) VALUES ('outbox-executor-work-no-write', ?, 'agent_execution_start',
                   'agent_executor', 'd1://attempt-executions/executor-work-no-write',
                   'agent-executor:executor-work-no-write', 'settled', ?, ?)`,
      ).bind(RUN_ID, NOW.toISOString(), NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_execution_instances (
           execution_id, attempt_id, attempt_version, lease_generation, execution_role,
           executor_profile_id, executor_route_version, spec_digest, spec_json,
           release_digest, provider_kind, plugin_schema_version, status, outbox_id,
           created_at, started_at, updated_at
         ) VALUES ('executor-work-no-write', ?, 2, 1, 'work',
                   'executor-work-no-write', 1, ?, '{}', ?,
                   'cloudflare_sandbox', '1', 'running',
                   'outbox-executor-work-no-write', ?, ?, ?)`,
      ).bind(
        ATTEMPT_ID,
        `sha256:${'9'.repeat(64)}`,
        `sha256:${'8'.repeat(64)}`,
        NOW.toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_tokens (
           token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
           lease_generation, scopes_json, expires_at, created_at, identity_kind, execution_id
         ) VALUES ('token-executor-work-no-write', ?, ?, ?, ?, 1, ?, ?, ?,
                   'executor', 'executor-work-no-write')`,
      ).bind(
        ATTEMPT_ID,
        `sha256:${'a'.repeat(64)}`,
        await canonicalSha256(RAW_RUNNER_TOKEN),
        `sha256:${'b'.repeat(64)}`,
        JSON.stringify(AUTHORIZATION.scopes),
        AUTHORIZATION.leaseExpiresAt,
        NOW.toISOString(),
      ),
    ]);
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect(provider.issuedRepositories).toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM github_write_credentials`,
    ).first()).toEqual({ count: 0 });
  });

  it('issues one target-repository credential, caps authorization TTL, and stores no plaintext', async () => {
    await approve();
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const credential = await store.issue(AUTHORIZATION, NOW);
    expect(credential).toMatchObject({
      repository: REPOSITORY,
      token: RAW_TOKEN,
      expiresAt: '2026-07-25T10:05:00.000Z',
      githubExpiresAt: '2026-07-25T11:00:00.000Z',
      approvalId: 'approval-repo-write',
      permissions: { contents: 'write', pullRequests: 'write' },
      created: true,
    });
    expect(provider.issuedRepositories).toEqual([REPOSITORY]);
    expect(await store.issue(AUTHORIZATION, NOW)).toMatchObject({
      token: RAW_TOKEN,
      created: false,
    });
    expect(provider.issuedRepositories).toEqual([REPOSITORY]);

    const row = await env.DB_CONTROL.prepare(
      `SELECT repository, approval_id, token_digest, token_ciphertext, token_iv,
              github_expires_at, authorization_expires_at, status
       FROM github_write_credentials WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      repository: REPOSITORY,
      approval_id: 'approval-repo-write',
      github_expires_at: '2026-07-25T11:00:00.000Z',
      authorization_expires_at: '2026-07-25T10:05:00.000Z',
      status: 'active',
    });
    expect(row?.token_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(row?.token_ciphertext).toBeTruthy();
    expect(row?.token_iv).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(RAW_TOKEN);
  });

  it('keeps one token while a heartbeat extends the live Attempt and refreshes its authorization window', async () => {
    await approve({ expiresAt: '2026-07-25T10:09:00.000Z' });
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const initialLeaseExpiresAt = '2026-07-25T10:05:00.000Z';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET lease_expires_at = ? WHERE attempt_id = ?`,
      ).bind(initialLeaseExpiresAt, ATTEMPT_ID),
      env.DB_CONTROL.prepare(
        `UPDATE attempt_tokens SET expires_at = ? WHERE attempt_id = ?`,
      ).bind(initialLeaseExpiresAt, ATTEMPT_ID),
    ]);
    const initial = await store.issue({
      ...AUTHORIZATION,
      leaseExpiresAt: initialLeaseExpiresAt,
    }, NOW);
    expect(initial.expiresAt).toBe('2026-07-25T10:05:00.000Z');

    const refreshedAt = new Date('2026-07-25T10:06:00.000Z');
    const refreshedLeaseExpiresAt = '2026-07-25T10:10:00.000Z';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET version = 3, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'running' AND version = 2
           AND lease_generation = 1`,
      ).bind(
        refreshedLeaseExpiresAt,
        refreshedAt.toISOString(),
        refreshedAt.toISOString(),
        ATTEMPT_ID,
      ),
      env.DB_CONTROL.prepare(
        `UPDATE attempt_tokens SET expires_at = ?
         WHERE attempt_id = ? AND lease_generation = 1 AND revoked_at IS NULL`,
      ).bind(refreshedLeaseExpiresAt, ATTEMPT_ID),
    ]);
    const revoker = new RepoWriteCredentialRevoker(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
      now: () => refreshedAt,
    });
    expect(await revoker.scan()).toEqual([]);
    expect(provider.revokedTokens).toEqual([]);

    const refreshed = await store.issue({
      ...AUTHORIZATION,
      version: 3,
      leaseExpiresAt: refreshedLeaseExpiresAt,
    }, refreshedAt);
    expect(refreshed).toMatchObject({
      token: RAW_TOKEN,
      expiresAt: '2026-07-25T10:09:00.000Z',
      created: false,
    });
    expect(provider.issuedRepositories).toEqual([REPOSITORY]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, authorization_expires_at
       FROM github_write_credentials WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'active',
      authorization_expires_at: '2026-07-25T10:09:00.000Z',
    });
  });

  it('converges concurrent issuance to one GitHub token request', async () => {
    await approve();
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.issue(AUTHORIZATION, NOW)),
    );
    expect(provider.issuedRepositories).toEqual([REPOSITORY]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(results.every((result) =>
      result.status === 'fulfilled' ||
      (result.reason instanceof RepoWriteCredentialError &&
        result.reason.code === 'credential_issuing'))).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_write_credentials WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).first()).toEqual({ count: 1 });
  });

  it('atomically activates one PAT reference even when issuing finalization is unavailable', async () => {
    await approve();
    const provider = new GitHubPatTokenProvider({
      pat: RAW_TOKEN,
      allowedRepositories: [REPOSITORY],
      now: () => NOW,
    });
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await env.DB_CONTROL.prepare(
      `CREATE TRIGGER reject_pat_issuing_finalization
       BEFORE UPDATE OF status ON github_write_credentials
       WHEN OLD.status = 'issuing' AND NEW.status = 'active'
       BEGIN
         SELECT RAISE(ABORT, 'simulated lost post-reservation finalization');
       END`,
    ).run();

    try {
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => store.issue(AUTHORIZATION, NOW)),
      );
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      expect(results.filter((result) => result.status === 'fulfilled' && result.value.created))
        .toHaveLength(1);
      expect(results.every((result) =>
        result.status === 'fulfilled' && result.value.token === RAW_TOKEN)).toBe(true);

      expect(await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM github_write_credentials
         WHERE attempt_id = ?`,
      ).bind(ATTEMPT_ID).first()).toEqual({ count: 1 });
      expect(await env.DB_CONTROL.prepare(
        `SELECT status, issue_lease_token, issue_lease_expires_at,
                token_digest, token_ciphertext, token_iv
         FROM github_write_credentials WHERE attempt_id = ?`,
      ).bind(ATTEMPT_ID).first()).toEqual({
        status: 'active',
        issue_lease_token: null,
        issue_lease_expires_at: null,
        token_digest: null,
        token_ciphertext: null,
        token_iv: null,
      });
    } finally {
      await env.DB_CONTROL.prepare('DROP TRIGGER reject_pat_issuing_finalization').run();
    }
  });

  it('expires a PAT reference locally when its exact control-plane authority ends', async () => {
    await approve();
    const provider = new GitHubPatTokenProvider({
      pat: RAW_TOKEN,
      allowedRepositories: [REPOSITORY],
      now: () => NOW,
    });
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await store.issue(AUTHORIZATION, NOW);

    const revoker = new RepoWriteCredentialRevoker(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
      now: () => new Date('2026-07-25T10:06:00.000Z'),
    });
    expect(await revoker.scan()).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'expired' },
    ]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, token_digest, token_ciphertext, token_iv, revoked_at
       FROM github_write_credentials WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'expired',
      token_digest: null,
      token_ciphertext: null,
      token_iv: null,
      revoked_at: null,
    });
  });

  it('reclaims a failed issuance without creating a second credential identity', async () => {
    await approve();
    const provider = new FakeGitHubWriteCredentialProvider();
    provider.failures = 1;
    let lease = 0;
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
      generateLeaseToken: () => `issue-lease-${++lease}`,
    });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    await expect(store.issue(AUTHORIZATION, NOW)).resolves.toMatchObject({
      token: RAW_TOKEN,
      created: true,
    });
    expect(provider.issuedRepositories).toEqual([REPOSITORY, REPOSITORY]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM github_write_credentials
       WHERE attempt_id = ? AND status = 'active'`,
    ).bind(ATTEMPT_ID).first()).toEqual({ count: 1 });
  });

  it('rejects expired or superseded approvals before requesting GitHub', async () => {
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await approve({ expiresAt: NOW.toISOString() });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      code: 'approval_required',
    });
    await env.DB_CONTROL.prepare('DELETE FROM approvals').run();
    await approve({ createdAt: '2026-07-25T09:59:00.000Z' });
    await approve({
      id: 'approval-repo-write-reject',
      decision: 'reject',
      createdAt: '2026-07-25T09:59:30.000Z',
    });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      code: 'approval_required',
    });
    expect(provider.issuedRepositories).toEqual([]);
  });

  it('revokes a token issued concurrently with a newer rejection instead of returning it', async () => {
    await approve({ createdAt: '2026-07-25T09:59:00.000Z' });
    const provider = new FakeGitHubWriteCredentialProvider();
    provider.beforeIssueReturn = async () => {
      await approve({
        id: 'approval-reject-during-issue',
        decision: 'reject',
        createdAt: '2026-07-25T10:00:30.000Z',
        expiresAt: '2026-07-25T10:09:00.000Z',
      });
    };
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await expect(store.issue(AUTHORIZATION, NOW)).rejects.toMatchObject({
      code: 'credential_conflict',
    });
    expect(provider.revokedTokens).toEqual([RAW_TOKEN]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, token_ciphertext, revoked_at
       FROM github_write_credentials WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'revoked',
      token_ciphertext: null,
      revoked_at: NOW.toISOString(),
    });
  });

  it('revokes the external token after approval TTL or Attempt cancellation and removes ciphertext', async () => {
    await approve();
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await store.issue(AUTHORIZATION, NOW);
    const revoker = new RepoWriteCredentialRevoker(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
      now: () => new Date('2026-07-25T10:06:00.000Z'),
    });
    expect(await revoker.scan()).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'revoked' },
    ]);
    expect(provider.revokedTokens).toEqual([RAW_TOKEN]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, token_ciphertext, token_iv, revoked_at
       FROM github_write_credentials WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'revoked',
      token_ciphertext: null,
      token_iv: null,
      revoked_at: '2026-07-25T10:06:00.000Z',
    });

    await reset();
    await seed();
    await approve({ expiresAt: '2026-07-25T10:09:00.000Z' });
    await store.issue(AUTHORIZATION, NOW);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'cancelled', version = version + 1,
                           lease_generation = lease_generation + 1
       WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).run();
    const cancellationRevoker = new RepoWriteCredentialRevoker(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
      now: () => new Date('2026-07-25T10:01:00.000Z'),
    });
    expect(await cancellationRevoker.scan()).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'revoked' },
    ]);
    expect(provider.revokedTokens).toEqual([RAW_TOKEN, RAW_TOKEN]);
  });

  it('revokes on a newer rejection and safely retries an unavailable GitHub revoke', async () => {
    await approve({ createdAt: '2026-07-25T09:59:00.000Z' });
    const provider = new FakeGitHubWriteCredentialProvider();
    const store = new RepoWriteCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
    });
    await store.issue(AUTHORIZATION, NOW);
    await approve({
      id: 'approval-repo-write-reject-after-issue',
      decision: 'reject',
      createdAt: '2026-07-25T10:00:30.000Z',
      expiresAt: '2026-07-25T10:09:00.000Z',
    });
    provider.revokeFailures = 1;
    const revoker = new RepoWriteCredentialRevoker(env.DB_CONTROL, provider, {
      encryptionKey: ENCRYPTION_KEY,
      now: () => new Date('2026-07-25T10:01:00.000Z'),
      generateLeaseToken: () => crypto.randomUUID(),
    });
    expect(await revoker.scan()).toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, last_error_code, token_ciphertext
       FROM github_write_credentials WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toMatchObject({
      status: 'revocation_pending',
      last_error_code: 'provider_unavailable',
      token_ciphertext: expect.any(String),
    });
    expect(await revoker.scan()).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'revoked' },
    ]);
    expect(provider.revokedTokens).toEqual([RAW_TOKEN]);
  });
});
