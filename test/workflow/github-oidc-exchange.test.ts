/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';

const BASE_URL = 'https://delivery-loop.test';
const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'delivery-loop-control-plane';
const REPOSITORY = 'example/delivery-target';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/delivery-agent.yml@refs/heads/main`;
const BASE_SHA = 'e'.repeat(40);
const GITHUB_RUN_ID = '987654321';
const ATTEMPT_ID = 'attempt-github-oidc';
const RUN_ID = 'run-github-oidc';

let trustedPrivateKey: Awaited<ReturnType<typeof importJWK>>;
let forgedPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

interface ClaimOverrides {
  repository?: string;
  workflow_ref?: string;
  job_workflow_ref?: string;
  sha?: string;
  run_id?: string;
}

interface SignOptions {
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
  key?: CryptoKey;
}

async function signOidcToken(
  overrides: ClaimOverrides = {},
  options: SignOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    repository: REPOSITORY,
    workflow_ref: WORKFLOW_REF,
    sha: BASE_SHA,
    run_id: GITHUB_RUN_ID,
    event_name: 'workflow_dispatch',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'delivery-loop-test-github-oidc' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject(`repo:${REPOSITORY}:ref:refs/heads/main`)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .sign(options.key ?? trustedPrivateKey);
}

async function exchange(token: string, attemptId = ATTEMPT_ID): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/attempts/${attemptId}/exchange`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function seedBoundAttempt(args: { expiredLease?: boolean } = {}): Promise<void> {
  const now = Date.now();
  const leaseExpiresAt = new Date(now + (args.expiredLease === true ? -30_000 : 300_000)).toISOString();
  const timestamp = new Date(now).toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-github-oidc', 'manual', 'oidc-test', 'oidc-test', '1', ?,
         'r2://tasks/github-oidc', 'system', 'oidc-test', ?, 'main', 'test',
         'bug', 'GitHub OIDC exchange', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'a'.repeat(64)}`, REPOSITORY, timestamp, timestamp),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, 'task-github-oidc', '1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, `sha256:${'a'.repeat(64)}`, BASE_SHA, RUN_ID, timestamp, timestamp),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, version, lease_generation,
         lease_token_digest, lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      WORKFLOW_REF,
      GITHUB_RUN_ID,
      `sha256:${'b'.repeat(64)}`,
      leaseExpiresAt,
      timestamp,
      timestamp,
      timestamp,
    ),
  ]);
}

beforeAll(async () => {
  trustedPrivateKey = await importJWK(
    JSON.parse(env.TEST_GITHUB_OIDC_PRIVATE_JWK) as JWK,
    'RS256',
  );
  forgedPrivateKey = (await generateKeyPair('RS256')).privateKey;
});

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedBoundAttempt();
});

describe('POST /v1/attempts/:id/exchange', () => {
  it('cryptographically binds GitHub OIDC claims and stores only token digests', async () => {
    const oidcToken = await signOidcToken();
    const response = await exchange(oidcToken);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      attemptToken: string;
      expiresAt: string;
      attemptVersion: number;
      leaseGeneration: number;
      grant: { toolBridgeToken: string; expiresAt: string; scopes: string[] };
    };
    expect(body.attemptToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(body.grant.toolBridgeToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(body.grant.toolBridgeToken).not.toBe(body.attemptToken);
    expect(body.grant.expiresAt).toBe(body.expiresAt);
    expect(body.attemptVersion).toBe(1);
    expect(body.leaseGeneration).toBe(1);
    expect(body.grant.scopes).toEqual([
      'repo:read',
      'logs:read',
      'trace:read',
      'k8s:read',
      'database:diagnostic',
    ]);
    expect(body.grant.scopes).not.toEqual(
      expect.arrayContaining(['repo:write', 'k8s:write', 'database:write', 'shell:exec']),
    );

    const row = await env.DB_CONTROL.prepare(
      `SELECT oidc_token_digest, token_digest, tool_token_digest,
              lease_generation, expires_at, revoked_at
       FROM attempt_tokens WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<{
        oidc_token_digest: string;
        token_digest: string;
        tool_token_digest: string;
        lease_generation: number;
        expires_at: string;
        revoked_at: string | null;
      }>();
    expect(row).toEqual({
      oidc_token_digest: await canonicalSha256(oidcToken),
      token_digest: await canonicalSha256(body.attemptToken),
      tool_token_digest: await canonicalSha256(body.grant.toolBridgeToken),
      lease_generation: 1,
      expires_at: body.expiresAt,
      revoked_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(body.attemptToken);
    expect(JSON.stringify(row)).not.toContain(body.grant.toolBridgeToken);
    const crossUse = await SELF.fetch(
      `${BASE_URL}/v1/attempts/${ATTEMPT_ID}/context`,
      { headers: { authorization: `Bearer ${body.grant.toolBridgeToken}` } },
    );
    expect(crossUse.status).toBe(401);
    await expect(
      env.DB_CONTROL.prepare(
        'UPDATE attempt_tokens SET tool_token_digest = token_digest WHERE attempt_id = ?',
      ).bind(ATTEMPT_ID).run(),
    ).rejects.toThrow();

    const replay = await exchange(oidcToken);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'conflict', retryable: false });
  });

  it('issues one credential pair under concurrency and caps both TTLs at the Attempt lease', async () => {
    const leaseExpiresAt = new Date(Date.now() + 45_000).toISOString();
    await env.DB_CONTROL.prepare(
      'UPDATE attempts SET lease_expires_at = ? WHERE attempt_id = ?',
    ).bind(leaseExpiresAt, ATTEMPT_ID).run();
    const oidcToken = await signOidcToken();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => exchange(oidcToken)),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.every((response) => [200, 409].includes(response.status))).toBe(true);
    const winner = responses.find((response) => response.status === 200);
    if (winner === undefined) throw new Error('missing exchange winner');
    const body = (await winner.json()) as {
      attemptToken: string;
      expiresAt: string;
      grant: { toolBridgeToken: string; expiresAt: string };
    };
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.parse(leaseExpiresAt));
    expect(body.grant.expiresAt).toBe(body.expiresAt);
    expect(body.grant.toolBridgeToken).not.toBe(body.attemptToken);
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM attempt_tokens WHERE attempt_id = ?',
      ).bind(ATTEMPT_ID).first(),
    ).toEqual({ count: 1 });
  });

  it('atomically moves a dispatched Attempt from starting to running', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'starting' WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .run();
    const response = await exchange(await signOidcToken());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attemptVersion: 2,
      leaseGeneration: 1,
    });
    const attempt = await env.DB_CONTROL.prepare(
      'SELECT status, version, heartbeat_at FROM attempts WHERE attempt_id = ?',
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(attempt).toMatchObject({ status: 'running', version: 2 });
    expect(attempt?.heartbeat_at).toBeTruthy();
  });

  it('exchanges an implementation Attempt without embedding repo_write in the run/tool grant', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET mode = 'implement' WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).run();
    const response = await exchange(await signOidcToken());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      grant: { scopes: string[] };
    };
    expect(body.grant.scopes).toEqual([
      'repo:read',
      'logs:read',
      'trace:read',
      'k8s:read',
      'database:diagnostic',
      'checkpoint:write',
      'artifact:write',
    ]);
    expect(body.grant.scopes).not.toContain('repo:write');
  });

  it('rejects every signed claim that differs from the bound Attempt', async () => {
    const cases: Array<{ token: Promise<string>; expectedStatus: number }> = [
      { token: signOidcToken({}, { issuer: 'https://issuer.example.test' }), expectedStatus: 401 },
      { token: signOidcToken({}, { audience: 'another-audience' }), expectedStatus: 401 },
      { token: signOidcToken({ repository: 'other/repository' }), expectedStatus: 403 },
      { token: signOidcToken({ workflow_ref: `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main` }), expectedStatus: 403 },
      { token: signOidcToken({ sha: 'f'.repeat(40) }), expectedStatus: 403 },
      { token: signOidcToken({ run_id: '123' }), expectedStatus: 403 },
    ];

    for (const testCase of cases) {
      const response = await exchange(await testCase.token);
      expect(response.status).toBe(testCase.expectedStatus);
    }
    const count = await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM attempt_tokens',
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('rejects forged, expired, malformed, and lease-expired exchanges', async () => {
    const forged = await exchange(await signOidcToken({}, { key: forgedPrivateKey }));
    expect(forged.status).toBe(401);
    const expired = await exchange(await signOidcToken({}, { expiresInSeconds: -30 }));
    expect(expired.status).toBe(401);
    const malformed = await exchange('not-a-jwt');
    expect(malformed.status).toBe(401);

    await env.DB_CONTROL.prepare(
      'UPDATE attempts SET lease_expires_at = ? WHERE attempt_id = ?',
    )
      .bind(new Date(Date.now() - 30_000).toISOString(), ATTEMPT_ID)
      .run();
    const leaseExpired = await exchange(await signOidcToken());
    expect(leaseExpired.status).toBe(403);
    expect(await leaseExpired.json()).toMatchObject({ code: 'policy_denied' });
  });
});
