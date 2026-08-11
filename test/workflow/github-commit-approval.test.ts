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
import { AutomatedReviewScheduler } from '../../src/storage/automated-review-store.js';

const BASE_URL = 'https://delivery-loop.test';
const OPERATIONS_TOKEN = 'test-operations-token';
const TASK_ID = 'task-github-commit-approval';
const RUN_ID = 'run-github-commit-approval';
const PLAN_ID = 'plan-github-commit-approval';
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const TASK_DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_SHA = 'c'.repeat(40);
const REVIEW_HEAD_SHA = 'd'.repeat(40);
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
    env.DB_CONTROL.prepare('DELETE FROM automated_review_fix_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_reviews'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM approval_lineages'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedFailedAutomatedReview(): Promise<void> {
  const bodyDigest = `sha256:${'e'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'pull_request_open', version = 9, updated_at = ?
       WHERE run_id = ? AND state = 'awaiting_approval'`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-github-review-publication', ?, '17', ?, 1, ?, ?,
                 'repo_write', 'user:owner', 'approve', ?,
                 '2026-08-05T05:30:00.000Z', '2026-08-05T04:30:00.000Z')`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'f'.repeat(64)}`),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_branch, head_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES ('attempt-github-review-prior', ?, 2, 'implement', 'completed', ?, ?,
                 'evilstar9527/delivery-loop/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, 'update-vision', 1, 'agent/review', ?, 4, 2, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, REPOSITORY, PLAN_ID, REVIEW_HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress
       SET status = 'in_progress', active_attempt_id = 'attempt-github-review-prior',
           version = 1, updated_at = ?
       WHERE plan_id = ? AND item_id = 'update-vision' AND status = 'pending'`,
    ).bind(NOW, PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, lease_expires_at,
         github_run_id, github_head_sha, github_status, github_conclusion,
         created_at, updated_at
       ) VALUES ('attempt-github-automated-review-root', ?, 3, 'analysis', 'running', ?, ?,
                 'evilstar9527/delivery-loop/.github/workflows/delivery-agent.yml@refs/heads/main',
                 2, 1, '2026-08-05T05:59:00.000Z', '88001', ?,
                 'completed', 'failure', ?, ?)`,
    ).bind(RUN_ID, REVIEW_HEAD_SHA, REPOSITORY, BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-github-review-head', ?, 'attempt-github-review-prior', ?, 1,
                 'update-vision', 'commit', 'passed', ?, 'Trusted bot commit.',
                 'verified', ?, ?)`,
    ).bind(RUN_ID, PLAN_ID, REVIEW_HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'update-vision', 'commit')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_verifications (
         verification_id, run_id, plan_id, plan_version, plan_item_id,
         attempt_id, head_sha, progress_version, evidence_set_digest, status, created_at
       ) VALUES ('verification-github-review', ?, ?, 1, 'update-vision',
                 'attempt-github-review-prior', ?, 1, ?, 'passed', ?)`,
    ).bind(RUN_ID, PLAN_ID, REVIEW_HEAD_SHA, `sha256:${'1'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress
       SET status = 'passed', active_attempt_id = NULL, version = 2, updated_at = ?
       WHERE plan_id = ? AND item_id = 'update-vision'
         AND status = 'in_progress' AND active_attempt_id = 'attempt-github-review-prior'`,
    ).bind(NOW, PLAN_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-github-review', 'evidence-github-review-head', ?,
                 'attempt-github-review-prior', ?, 1, 'update-vision', 2,
                 ?, ?, 'agent/review', ?)`,
    ).bind(RUN_ID, PLAN_ID, BASE_SHA, REVIEW_HEAD_SHA, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id,
         head_sha, branch, body, body_digest, status, created_at
       ) VALUES ('draft-github-review', ?, 8, ?, '17', ?, ?, 1, ?,
                 'attempt-github-review-prior', 'head-github-review', ?,
                 'agent/review', '# Review candidate', ?, 'prepared', ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, PLAN_ID, PLAN_DIGEST, REVIEW_HEAD_SHA, bodyDigest, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_publications (
         publication_id, run_id, run_version, draft_id, approval_id,
         repository, base_branch, head_branch, head_sha, title, body_digest,
         status, github_pr_number, github_pr_url, github_external_updated_at,
         github_observation_version, evidence_id, created_at, updated_at
       ) VALUES ('publication-github-review', ?, 8, 'draft-github-review',
                 'approval-github-review-publication', ?, 'main', 'agent/review', ?,
                 'Automated review candidate', ?, 'verified', 42,
                 'https://github.com/evilstar9527/delivery-loop/pull/42', ?, 1, NULL, ?, ?)`,
    ).bind(RUN_ID, REPOSITORY, REVIEW_HEAD_SHA, bodyDigest, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO automated_reviews (
         review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
         prior_attempt_id, review_attempt_id, repository, github_pr_number,
         base_branch, branch, source_head_sha, iteration, status, created_at, updated_at
       ) VALUES ('automated-review-failed', ?, 'publication-github-review', ?, 1,
                 'update-vision', 'attempt-github-review-prior',
                 'attempt-github-automated-review-root', ?, 42, 'main',
                 'agent/review', ?, 1, 'pending', ?, ?)`,
    ).bind(RUN_ID, PLAN_ID, REPOSITORY, REVIEW_HEAD_SHA, NOW, NOW),
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
  it('issues one fresh exact approval for a failed pending automated review', async () => {
    await seedFailedAutomatedReview();
    const client = new FakeGitHubCommitApprovalClient();
    const templateResponse = await request(
      client,
      `/v1/runs/${RUN_ID}/github-commit-approval-template`,
    );
    expect(templateResponse.status).toBe(200);
    const template = await templateResponse.json<{ commentBody: string }>();
    client.fact = {
      schemaVersion: '1', repository: REPOSITORY, commentId: 808,
      commitSha: BASE_SHA, authorLogin: 'evilstar9527', authorType: 'User',
      authorAssociation: 'OWNER', body: template.commentBody,
      createdAt: '2026-08-05T05:59:30.000Z', updatedAt: '2026-08-05T05:59:30.000Z',
      url: `https://github.com/${REPOSITORY}/commit/${BASE_SHA}#commitcomment-808`,
    };
    const response = await request(client, `/v1/runs/${RUN_ID}/github-commit-approvals`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentId: 808 }),
    });
    expect(response.status).toBe(201);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 9 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM trusted_effect_approvals
       WHERE run_id = ? AND plan_id = ? AND effect = 'repo_write'
         AND decision = 'approve' AND expires_at > ?`,
    ).bind(RUN_ID, PLAN_ID, NOW).first()).toEqual({ count: 1 });
    expect(await new AutomatedReviewScheduler(env.DB_CONTROL)
      .recoverRun(RUN_ID, new Date(NOW))).toMatchObject({ created: true });
    expect((await request(
      client,
      `/v1/runs/${RUN_ID}/github-commit-approval-template`,
    )).status).toBe(409);
  });

  it('does not open repo-write approval for an ordinary pull_request_open Run', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'pull_request_open', version = 9, updated_at = ?
       WHERE run_id = ? AND state = 'awaiting_approval'`,
    ).bind(NOW, RUN_ID).run();
    const client = new FakeGitHubCommitApprovalClient();
    expect((await request(
      client,
      `/v1/runs/${RUN_ID}/github-commit-approval-template`,
    )).status).toBe(409);
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM approvals')
      .first()).toEqual({ count: 0 });
  });

  it('does not issue approval when the failed review cannot be redispatched', async () => {
    await seedFailedAutomatedReview();
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET workflow_ref = NULL
       WHERE attempt_id = 'attempt-github-automated-review-root'`,
    ).run();
    const client = new FakeGitHubCommitApprovalClient();
    expect((await request(
      client,
      `/v1/runs/${RUN_ID}/github-commit-approval-template`,
    )).status).toBe(409);
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM approvals')
      .first()).toEqual({ count: 1 });
  });

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
