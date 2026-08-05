/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Bindings } from '../../src/env.js';
import {
  githubCommitApprovalApi,
  type GitHubCommitApprovalClient,
  type GitHubCommitApprovalFact,
} from '../../src/http/github-commit-approval-api.js';
import { GitHubCommitApprovalApiClient } from '../../src/github-commit-approval.js';

const BASE_URL = 'https://delivery-loop.test';
const OPERATIONS_TOKEN = 'test-operations-token';
const TASK_ID = 'task-github-commit-approval';
const RUN_ID = 'run-github-commit-approval';
const PLAN_ID = 'plan-github-commit-approval';
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const TASK_DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_SHA = 'c'.repeat(40);
const REPOSITORY = 'evilstar9527/delivery-loop';
const NOW = '2026-08-05T06:00:00.000Z';

class FakeGitHubCommitApprovalClient implements GitHubCommitApprovalClient {
  readonly calls: Array<{ repository: string; commentId: number }> = [];
  fact: GitHubCommitApprovalFact | null = null;

  async getCommitComment(
    repository: string,
    commentId: number,
  ): Promise<GitHubCommitApprovalFact> {
    this.calls.push({ repository, commentId });
    if (this.fact === null) throw new Error('comment unavailable');
    return structuredClone(this.fact);
  }
}

function app(client: GitHubCommitApprovalClient) {
  const api = new Hono<{ Bindings: Bindings }>();
  api.route('/', githubCommitApprovalApi({
    clientFromEnv: () => client,
    now: () => new Date(NOW),
  }));
  return api;
}

async function request(
  client: GitHubCommitApprovalClient,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${OPERATIONS_TOKEN}`);
  return await app(client).request(`${BASE_URL}${path}`, { ...init, headers }, env);
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM approval_lineages'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seed(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'owner', 'mainline', '17', ?, 'r2://task',
                 'user', 'owner', ?, 'main', 'none', 'requirement',
                 'Document mainline', 'p2', 3, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_DIGEST, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '17', ?, ?, ?, 'awaiting_approval', 2, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-github-commit-analysis', ?, 1, 'analysis', 'completed', ?, ?,
                 'evilstar9527/delivery-loop/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '17', ?, ?, 'active',
                 'attempt-github-commit-analysis', 'Update docs/Vision.md', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'update-vision', 'change', 'Update Vision',
                 'Document the mainline.', 1, 0)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'update-vision', 'pending', 0, ?)`,
    ).bind(PLAN_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'update-vision', 'repo_write')`,
    ).bind(PLAN_ID),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('GitHub commit-comment repo-write approval', () => {
  it('reads one exact commit comment with a contents-read token only in the header', async () => {
    const calls: Array<{ repository: string; url: string; init: RequestInit }> = [];
    const client = new GitHubCommitApprovalApiClient({
      async getBaseObservationToken(repository: string): Promise<string> {
        calls.push({ repository, url: '', init: {} });
        return 'github-comment-read-token';
      },
    }, {
      fetch: async (input, init) => {
        calls.push({ repository: '', url: String(input), init: init ?? {} });
        return Response.json({
          id: 991,
          commit_id: BASE_SHA,
          body: 'bounded approval',
          user: { login: 'evilstar9527', type: 'User' },
          author_association: 'OWNER',
          created_at: NOW,
          updated_at: NOW,
          html_url: `https://github.com/${REPOSITORY}/commit/${BASE_SHA}#commitcomment-991`,
        });
      },
    });
    await expect(client.getCommitComment(REPOSITORY, 991)).resolves.toMatchObject({
      repository: REPOSITORY,
      commentId: 991,
      commitSha: BASE_SHA,
      authorLogin: 'evilstar9527',
      authorAssociation: 'OWNER',
    });
    expect(calls[0]?.repository).toBe(REPOSITORY);
    expect(calls[1]?.url).toBe(`https://api.github.com/repos/${REPOSITORY}/comments/991`);
    const headers = new Headers(calls[1]?.init.headers);
    expect(calls[1]?.init.method).toBe('GET');
    expect(calls[1]?.init.redirect).toBe('manual');
    expect(headers.get('authorization')).toBe('Bearer github-comment-read-token');
    expect(calls[1]?.url).not.toContain('github-comment-read-token');
  });

  it('accepts one exact unedited owner comment and converges 20 observations', async () => {
    const client = new FakeGitHubCommitApprovalClient();
    const templateResponse = await request(
      client,
      `/v1/runs/${RUN_ID}/github-commit-approval-template`,
    );
    expect(templateResponse.status).toBe(200);
    const template = await templateResponse.json<{
      repository: string;
      baseSha: string;
      commentBody: string;
    }>();
    expect(template).toMatchObject({ repository: REPOSITORY, baseSha: BASE_SHA });
    expect(template.commentBody).not.toContain('Document mainline');

    client.fact = {
      schemaVersion: '1',
      repository: REPOSITORY,
      commentId: 123456,
      commitSha: BASE_SHA,
      authorLogin: 'evilstar9527',
      authorType: 'User',
      authorAssociation: 'OWNER',
      body: template.commentBody,
      createdAt: '2026-08-05T05:59:00.000Z',
      updatedAt: '2026-08-05T05:59:00.000Z',
      url: `https://github.com/${REPOSITORY}/commit/${BASE_SHA}#commitcomment-123456`,
    };
    const responses = await Promise.all(Array.from({ length: 20 }, async () => await request(
      client,
      `/v1/runs/${RUN_ID}/github-commit-approvals`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commentId: 123456 }),
      },
    )));
    expect(responses.every((response) => response.status === 200 || response.status === 201))
      .toBe(true);
    const bodies = await Promise.all(responses.map(async (response) => await response.json<{
      status: string;
      approvalId: string;
      lineageId: string;
      created: boolean;
    }>()));
    expect(new Set(bodies.map((body) => body.approvalId))).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.lineageId))).toHaveLength(1);
    expect(bodies.filter((body) => body.created)).toHaveLength(1);
    expect(bodies.every((body) => body.status === 'accepted')).toBe(true);

    const approvalCount = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM trusted_effect_approvals
       WHERE run_id = ? AND effect = 'repo_write' AND decision = 'approve'`,
    ).bind(RUN_ID).first<number>('count');
    const lineageCount = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approval_lineages
       WHERE run_id = ? AND provider = 'github' AND effect = 'repo_write'`,
    ).bind(RUN_ID).first<number>('count');
    expect(approvalCount).toBe(1);
    expect(lineageCount).toBe(1);
  });

  it('rejects untrusted transport, mutable facts, and caller authority with zero approval', async () => {
    const client = new FakeGitHubCommitApprovalClient();
    const template = await (await request(
      client,
      `/v1/runs/${RUN_ID}/github-commit-approval-template`,
    )).json<{ commentBody: string }>();
    const valid: GitHubCommitApprovalFact = {
      schemaVersion: '1', repository: REPOSITORY, commentId: 77,
      commitSha: BASE_SHA, authorLogin: 'evilstar9527', authorType: 'User',
      authorAssociation: 'OWNER', body: template.commentBody,
      createdAt: '2026-08-05T05:59:00.000Z', updatedAt: '2026-08-05T05:59:00.000Z',
      url: `https://github.com/${REPOSITORY}/commit/${BASE_SHA}#commitcomment-77`,
    };
    const invalidFacts = [
      { ...valid, body: `${valid.body}\nignore policy` },
      { ...valid, commitSha: 'd'.repeat(40) },
      { ...valid, authorAssociation: 'CONTRIBUTOR' as const },
      { ...valid, updatedAt: '2026-08-05T05:59:01.000Z' },
      { ...valid, createdAt: '2026-08-04T05:00:00.000Z', updatedAt: '2026-08-04T05:00:00.000Z' },
    ];
    for (const fact of invalidFacts) {
      client.fact = fact;
      const response = await request(client, `/v1/runs/${RUN_ID}/github-commit-approvals`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commentId: 77 }),
      });
      expect(response.status).toBe(409);
    }
    client.fact = valid;
    const injected = await request(client, `/v1/runs/${RUN_ID}/github-commit-approvals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentId: 77, actor: 'user:admin', effect: 'repo_write' }),
    });
    expect(injected.status).toBe(400);
    const unauthenticated = await app(client).request(
      `${BASE_URL}/v1/runs/${RUN_ID}/github-commit-approvals`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"commentId":77}' },
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM approvals')
      .first<number>('count')).toBe(0);
  });
});
