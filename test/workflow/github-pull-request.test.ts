/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  GitHubPullRequestOutboxProcessor,
  type GitHubPullRequestEffects,
  type GitHubPullRequestFact,
  type GitHubPullRequestRequest,
} from '../../src/outbox/github-pull-request.js';
import { GitHubPullRequestReconciler } from '../../src/reconciliation/github-pull-request-reconciler.js';
import { CorrelationQueryStore } from '../../src/storage/correlation-query-store.js';

const BASE_URL = 'https://delivery-loop.test';
const SERVICE_TOKEN = 'test-task-intake-token';
const WEBHOOK_SECRET = 'test-github-webhook-secret';
const RUN_ID = 'run-pr-publication';
const TASK_ID = 'task-pr-publication';
const PLAN_ID = 'plan-pr-publication';
const ITEM_ID = 'verify-pr-publication';
const ANALYSIS_ATTEMPT_ID = 'attempt-pr-analysis';
const ATTEMPT_ID = 'attempt-pr-publication';
const DRAFT_ID = 'pr_draft_publication';
const HEAD_UPDATE_ID = 'head-pr-publication';
const HEAD_SHA = 'a'.repeat(40);
const PARENT_SHA = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);
const TASK_DIGEST = `sha256:${'d'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'e'.repeat(64)}`;
const BRANCH = `agent/${TASK_ID}/${ATTEMPT_ID}`;
const TITLE = `Delivery Loop: ${TASK_ID}`;
const BODY = '# Delivery Loop Draft PR\n\nVerified body.\n';
const NOW = '2026-07-25T17:00:00.000Z';

async function bodyDigest(): Promise<string> {
  return await canonicalSha256(BODY);
}

function pullRequestFact(digest: string, overrides: Partial<GitHubPullRequestFact> = {}): GitHubPullRequestFact {
  return {
    repository: 'example/delivery-target',
    number: 42,
    url: 'https://github.com/example/delivery-target/pull/42',
    state: 'open',
    draft: true,
    title: TITLE,
    bodyDigest: digest,
    headBranch: BRANCH,
    headSha: HEAD_SHA,
    baseBranch: 'main',
    externalUpdatedAt: '2026-07-25T17:01:00.000Z',
    ...overrides,
  };
}

class FakePullRequestEffects implements GitHubPullRequestEffects {
  readonly requests: GitHubPullRequestRequest[] = [];

  constructor(private readonly fact: GitHubPullRequestFact) {}

  async ensureDraftPullRequest(request: GitHubPullRequestRequest) {
    this.requests.push(request);
    return { disposition: 'created' as const, fact: this.fact };
  }
}

async function requestPublication(body: unknown, token = SERVICE_TOKEN): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/pull-request`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function webhookSignature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  ));
  return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function sendPullRequestWebhook(
  fact: GitHubPullRequestFact,
  deliveryId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
): Promise<Response> {
  const payload = JSON.stringify({
    action: 'opened',
    number: fact.number,
    pull_request: {
      html_url: fact.url,
      state: fact.state,
      draft: fact.draft,
      title: fact.title,
      body: fact.bodyDigest === await bodyDigest() ? BODY : 'different body',
      head: {
        ref: fact.headBranch,
        sha: fact.headSha,
        repo: { full_name: fact.repository },
      },
      base: {
        ref: fact.baseBranch,
        repo: { full_name: fact.repository },
      },
      updated_at: fact.externalUpdatedAt,
    },
    repository: { full_name: fact.repository },
  });
  return await SELF.fetch(`${BASE_URL}/v1/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': await webhookSignature(payload),
    },
    body: payload,
  });
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM github_pull_request_api_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_pull_request_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_unfinished_items'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seed(): Promise<void> {
  const digest = await bodyDigest();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'pr-publication', ?, 'revision-4', ?,
                 'r2://tasks/pr-publication', 'system', 'control-plane',
                 'example/delivery-target', 'main', 'test', 'bug',
                 'Publish verified PR', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, TASK_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-4', ?, ?, ?, 'verifying', 8, ?, 2, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 2, 'revision-4', ?, ?, 'active', ?,
                 'Publish an externally verified Draft PR.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_branch, head_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 2, ?, 1, ?, ?, 4, 2, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, BRANCH, HEAD_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'delivery', 'Publish Draft PR', 'Publish verified head.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, active_attempt_id, version, updated_at)
       VALUES (?, ?, 'passed', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-pr-publication', ?, 'revision-4', ?, 2, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?,
                 '2099-07-25T18:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'f'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-pr-publication-commit', ?, ?, ?, 2, ?, 'commit',
                 'passed', ?, 'Trusted Runner recorded the bot commit head.',
                 'unverified', ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES (?, 'evidence-pr-publication-commit', ?, ?, ?, 2, ?, 2, ?, ?, ?, ?)`,
    ).bind(HEAD_UPDATE_ID, RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, PARENT_SHA, HEAD_SHA, BRANCH, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id,
         head_sha, branch, body, body_digest, status, created_at
       ) VALUES (?, ?, 8, ?, 'revision-4', ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
    ).bind(
      DRAFT_ID,
      RUN_ID,
      TASK_ID,
      TASK_DIGEST,
      PLAN_ID,
      PLAN_DIGEST,
      ATTEMPT_ID,
      HEAD_UPDATE_ID,
      HEAD_SHA,
      BRANCH,
      BODY,
      digest,
      NOW,
    ),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('GitHub Draft PR publication and external facts', () => {
  it('converges scheduling and creation, but advances Run only after a signed exact webhook', async () => {
    const request = { expectedRunVersion: 8, draftId: DRAFT_ID };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => requestPublication(request)),
    );
    expect(responses.every((response) => response.status === 200 || response.status === 201))
      .toBe(true);
    const bodies = await Promise.all(responses.map(async (response) => await response.json())) as Array<{
      publicationId: string;
      outboxId: string;
      created: boolean;
    }>;
    expect(bodies.filter((body) => body.created)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.publicationId)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.outboxId)).size).toBe(1);

    const digest = await bodyDigest();
    const effects = new FakePullRequestEffects(pullRequestFact(digest));
    const processor = new GitHubPullRequestOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(NOW),
    });
    const deliveries = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(bodies[0]!.outboxId)),
    );
    expect(deliveries.every((entry) => entry === 'settled' || entry === 'busy')).toBe(true);
    expect(effects.requests).toHaveLength(1);
    expect(effects.requests[0]).toEqual({
      repository: 'example/delivery-target',
      title: TITLE,
      body: BODY,
      bodyDigest: digest,
      headBranch: BRANCH,
      headSha: HEAD_SHA,
      baseBranch: 'main',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status, github_pr_number FROM pull_request_publications',
    ).first()).toEqual({ status: 'created_unverified', github_pr_number: 42 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'verifying', version: 8 });

    const webhook = await sendPullRequestWebhook(pullRequestFact(digest));
    expect(webhook.status).toBe(202);
    expect(await webhook.json()).toEqual({ accepted: true, disposition: 'applied' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 9 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, github_pr_number, github_pr_url, evidence_id
       FROM pull_request_publications`,
    ).first()).toMatchObject({
      status: 'verified',
      github_pr_number: 42,
      github_pr_url: 'https://github.com/example/delivery-target/pull/42',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT kind, status, sha, external_url, verification_status, summary
       FROM evidence WHERE kind = 'pull_request'`,
    ).first()).toEqual({
      kind: 'pull_request',
      status: 'passed',
      sha: HEAD_SHA,
      external_url: 'https://github.com/example/delivery-target/pull/42',
      verification_status: 'verified',
      summary: 'GitHub externally verified the Draft PR.',
    });
    await expect(new CorrelationQueryStore(env.DB_CONTROL).resolve({
      kind: 'github_pr',
      id: '42',
      repository: 'example/delivery-target',
    })).resolves.toMatchObject({
      correlationId: RUN_ID,
      pullRequests: [{ number: 42, status: 'verified' }],
    });
    const duplicate = await sendPullRequestWebhook(pullRequestFact(digest));
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ accepted: true, disposition: 'duplicate' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence WHERE kind = 'pull_request'`,
    ).first()).toEqual({ count: 1 });
  });

  it('rejects Agent self-report and approval bypass, ignores mismatched webhook facts, and repairs a missed webhook by API', async () => {
    const valid = { expectedRunVersion: 8, draftId: DRAFT_ID };
    expect((await requestPublication({ ...valid, url: 'https://attacker.test/pr/1' })).status).toBe(400);
    expect((await requestPublication(valid, 'attempt-runner-token')).status).toBe(401);

    await env.DB_CONTROL.prepare(
      `UPDATE approvals SET expires_at = '2020-07-25T16:59:00.000Z'
       WHERE approval_id = 'approval-pr-publication'`,
    ).run();
    expect((await requestPublication(valid)).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM pull_request_publications',
    ).first()).toEqual({ count: 0 });
    await env.DB_CONTROL.prepare(
      `UPDATE approvals SET expires_at = '2099-07-25T18:00:00.000Z'
       WHERE approval_id = 'approval-pr-publication'`,
    ).run();

    const scheduled = await requestPublication(valid);
    expect(scheduled.status).toBe(201);
    const publication = await scheduled.json() as { publicationId: string; outboxId: string };
    const digest = await bodyDigest();
    const exactFact = pullRequestFact(digest);
    const effects = new FakePullRequestEffects(exactFact);
    expect(await new GitHubPullRequestOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(NOW),
    }).deliver(publication.outboxId)).toBe('settled');

    const mismatched = await sendPullRequestWebhook(
      pullRequestFact(digest, { headSha: '9'.repeat(40) }),
      '11111111-2222-3333-4444-555555555555',
    );
    expect(mismatched.status).toBe(202);
    expect(await mismatched.json()).toEqual({ accepted: true, disposition: 'ignored' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'verifying' });

    const reconciler = new GitHubPullRequestReconciler(env.DB_CONTROL, {
      async getPullRequest(request, number) {
        expect(request.body).toBe(BODY);
        expect(number).toBe(42);
        return exactFact;
      },
    }, { now: () => new Date('2026-07-25T17:02:00.000Z') });
    expect(await reconciler.reconcilePublication(publication.publicationId)).toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 9 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_pull_request_api_observations',
    ).first()).toEqual({ count: 1 });
  });

  it('skips stale Run snapshots before GitHub API reconciliation without starving the current publication', async () => {
    const scheduled = await requestPublication({ expectedRunVersion: 8, draftId: DRAFT_ID });
    expect(scheduled.status).toBe(201);
    const publication = await scheduled.json() as { publicationId: string; outboxId: string };
    const digest = await bodyDigest();
    const exactFact = pullRequestFact(digest);
    expect(await new GitHubPullRequestOutboxProcessor(
      env.DB_CONTROL,
      new FakePullRequestEffects(exactFact),
      { now: () => new Date(NOW) },
    ).deliver(publication.outboxId)).toBe('settled');

    const staleBody = '# Delivery Loop Draft PR\n\nStale body.\n';
    const staleBodyDigest = await canonicalSha256(staleBody);
    const staleHeadSha = '9'.repeat(40);
    const staleBranch = `agent/${TASK_ID}/stale-attempt`;
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, sha, summary, verification_status, observed_at, created_at
         ) VALUES ('evidence-pr-publication-stale', ?, ?, ?, 2, ?, 'commit',
                   'passed', ?, 'Stale bot commit head.', 'unverified', ?, ?)`,
      ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, staleHeadSha, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_head_updates (
           update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
           plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
         ) VALUES ('head-pr-publication-stale', 'evidence-pr-publication-stale',
                   ?, ?, ?, 2, ?, 3, ?, ?, ?, ?)`,
      ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, staleHeadSha, staleBranch, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO pull_request_drafts (
           draft_id, run_id, run_version, task_id, task_revision, task_digest,
           plan_id, plan_version, plan_digest, attempt_id, head_update_id,
           head_sha, branch, body, body_digest, status, created_at
         ) VALUES ('pr_draft_publication_stale', ?, 7, ?, 'revision-4', ?, ?, 2, ?, ?,
                   'head-pr-publication-stale', ?, ?, ?, ?, 'prepared', ?)`,
      ).bind(
        RUN_ID,
        TASK_ID,
        TASK_DIGEST,
        PLAN_ID,
        PLAN_DIGEST,
        ATTEMPT_ID,
        staleHeadSha,
        staleBranch,
        staleBody,
        staleBodyDigest,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO pull_request_publications (
           publication_id, run_id, run_version, draft_id, approval_id, repository,
           base_branch, head_branch, head_sha, title, body_digest, status,
           github_pr_number, created_at, updated_at
         ) VALUES ('pr_pub_stale_snapshot', ?, 7, 'pr_draft_publication_stale',
                   'approval-pr-publication', 'example/delivery-target', 'main', ?, ?,
                   'Stale publication', ?, 'created_unverified', 41,
                   '2026-07-25T16:00:00.000Z', '2026-07-25T16:00:00.000Z')`,
      ).bind(RUN_ID, staleBranch, staleHeadSha, staleBodyDigest),
    ]);

    const requests: Array<{ number: number }> = [];
    const reconciler = new GitHubPullRequestReconciler(env.DB_CONTROL, {
      async getPullRequest(_request, number) {
        requests.push({ number });
        return exactFact;
      },
    }, { now: () => new Date('2026-07-25T17:02:00.000Z') });

    await expect(reconciler.reconcilePublication('pr_pub_stale_snapshot'))
      .resolves.toBe('not_found');
    await expect(reconciler.reconcileBatch(1)).resolves.toEqual([
      { publicationId: publication.publicationId, disposition: 'applied' },
    ]);
    expect(requests).toEqual([{ number: 42 }]);
  });

  it('rechecks the exact approval immediately before the GitHub effect', async () => {
    const scheduled = await requestPublication({
      expectedRunVersion: 8,
      draftId: DRAFT_ID,
    });
    expect(scheduled.status).toBe(201);
    const publication = await scheduled.json() as { outboxId: string };
    await env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-pr-rejected-later', ?, 'revision-4', ?, 2, ?, ?,
                 'repo_write', 'user:approver', 'reject', ?,
                 '2099-07-25T18:00:00.000Z', '2026-07-25T17:00:01.000Z')`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      `sha256:${'1'.repeat(64)}`,
    ).run();
    const effects = new FakePullRequestEffects(pullRequestFact(await bodyDigest()));
    expect(await new GitHubPullRequestOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(NOW),
    }).deliver(publication.outboxId)).toBe('settled');
    expect(effects.requests).toHaveLength(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?`,
    ).bind(publication.outboxId).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: 'approval_invalid',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM pull_request_publications',
    ).first()).toEqual({ status: 'pending' });
  });

  it('rescans the frozen PR body with current Secrets immediately before the GitHub effect', async () => {
    const scheduled = await requestPublication({ expectedRunVersion: 8, draftId: DRAFT_ID });
    expect(scheduled.status).toBe(201);
    const publication = await scheduled.json() as { outboxId: string };
    const effects = new FakePullRequestEffects(pullRequestFact(await bodyDigest()));
    const processor = new GitHubPullRequestOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(NOW),
      secrets: ['Verified body.'],
    });

    expect(await processor.deliver(publication.outboxId)).toBe('settled');
    expect(effects.requests).toHaveLength(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?`,
    ).bind(publication.outboxId).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: 'pull_request_secret_detected',
    });
  });
});
