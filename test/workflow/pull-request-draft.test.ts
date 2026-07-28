/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';

const BASE_URL = 'https://delivery-loop.test';
const SERVICE_TOKEN = 'test-task-intake-token';
const RUN_ID = 'run-pull-request-draft';
const TASK_ID = 'task-pull-request-draft';
const PLAN_ID = 'plan-pull-request-draft';
const ITEM_ID = 'verify-release';
const OPTIONAL_ITEM_ID = 'optional-dashboard';
const ATTEMPT_ID = 'attempt-pull-request-draft';
const ANALYSIS_ATTEMPT_ID = 'attempt-pull-request-analysis';
const HEAD_SHA = 'a'.repeat(40);
const PARENT_SHA = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);
const PLAN_DIGEST = `sha256:${'d'.repeat(64)}`;
const BRANCH = `agent/${TASK_ID}/${ATTEMPT_ID}`;
const NOW = '2026-07-25T16:00:00.000Z';

function taskEnvelope(criterion = 'The checkout succeeds without a duplicate charge.'): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-pull-request-draft',
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'pull-request-draft',
      taskKey: TASK_ID,
      revision: 'revision-3',
      url: 'https://tasks.example.test/items/42?temporary_token=SHOULD_NOT_PUBLISH#private',
    },
    actor: { type: 'user', id: 'pull-request-author' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Fix checkout <script>alert(1)</script> @reviewers',
      description: 'Private feedback body must not be copied into the PR.',
      acceptanceCriteria: [criterion],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: true,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

async function requestDraft(body: unknown, token = SERVICE_TOKEN): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/pull-request-draft`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
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
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seed(): Promise<void> {
  const task = taskEnvelope();
  const taskDigest = await taskRevisionDigest(task);
  await env.TASK_OBJECTS.put('tasks/pr-draft', JSON.stringify(task), {
    customMetadata: { taskDigest },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         source_url, task_digest, payload_ref, actor_type, actor_id,
         target_repository, target_base_branch, target_environment, intent_kind,
         title, priority, acceptance_criteria_count, allow_repository_write,
         allow_test_deploy, allow_production_deploy, require_human_approval,
         created_at, updated_at
       ) VALUES (?, 'manual', 'pull-request-draft', ?, 'revision-3', ?, ?,
                 'r2://tasks/pr-draft', 'user', 'pull-request-author',
                 'example/delivery-target', 'main', 'test', 'bug',
                 ?, 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, task.source.url, taskDigest, task.intent.title, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-3', ?, ?, ?, 'verifying', 8, ?, 2, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 2, 'revision-3', ?, ?, 'active', ?,
                 'Fix checkout and verify the exact final head.', ?, ?)`,
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
       VALUES (?, ?, 'verification', 'Verify checkout',
               'Run targeted and required verification.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'change', 'Optional dashboard',
               'Add an optional observability dashboard.', 0, 1)`,
    ).bind(PLAN_ID, OPTIONAL_ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_acceptance_criteria (
         plan_id, item_id, acceptance_criterion_index
       ) VALUES (?, ?, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'Targeted and required verification pass.')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'test:checkout')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'verify:all')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, ?, 'test')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'passed', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, version, updated_at
       ) VALUES (?, ?, 'pending', 0, ?)`,
    ).bind(PLAN_ID, OPTIONAL_ITEM_ID, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, command_ref, exit_code, duration_ms, sha, summary,
         verification_status, observed_at, created_at
       ) VALUES ('evidence-pr-test', ?, ?, ?, 2, ?, 'test', 'passed',
                 'test:checkout', 0, 125, ?, 'Targeted command passed.',
                 'verified', ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, command_ref, exit_code, duration_ms, sha, summary,
         verification_status, observed_at, created_at
       ) VALUES ('evidence-pr-verify', ?, ?, ?, 2, ?, 'test', 'passed',
                 'verify:all', 0, 480, ?, 'Required command passed.',
                 'verified', ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-pr-commit', ?, ?, ?, 2, ?, 'commit', 'passed', ?,
                 'Trusted Runner recorded the bot commit head.', 'unverified', ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO verification_suites (
         suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         lease_generation, head_sha, delivery_policy_digest,
         targeted_command_count, required_command_count, status, created_at, updated_at
       ) VALUES ('suite-pr-draft', ?, ?, ?, 2, ?, 2, ?, ?, 1, 1, 'completed', ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, `sha256:${'e'.repeat(64)}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO verification_suite_commands (
         suite_id, position, phase, command_ref, result_status, evidence_id, updated_at
       ) VALUES ('suite-pr-draft', 0, 'targeted', 'test:checkout', 'passed',
                 'evidence-pr-test', ?)`,
    ).bind(NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO verification_suite_commands (
         suite_id, position, phase, command_ref, result_status, evidence_id, updated_at
       ) VALUES ('suite-pr-draft', 1, 'required_verify', 'verify:all', 'passed',
                 'evidence-pr-verify', ?)`,
    ).bind(NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_verifications (
         verification_id, run_id, plan_id, plan_version, plan_item_id,
         attempt_id, head_sha, progress_version, evidence_set_digest,
         status, created_at
       ) VALUES ('verification-pr-draft', ?, ?, 2, ?, ?, ?, 1, ?, 'passed', ?)`,
    ).bind(RUN_ID, PLAN_ID, ITEM_ID, ATTEMPT_ID, HEAD_SHA, `sha256:${'f'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when_evidence (
         verification_id, plan_id, item_id, done_when_position,
         evidence_position, evidence_id
       ) VALUES ('verification-pr-draft', ?, ?, 0, 0, 'evidence-pr-test')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when_evidence (
         verification_id, plan_id, item_id, done_when_position,
         evidence_position, evidence_id
       ) VALUES ('verification-pr-draft', ?, ?, 0, 1, 'evidence-pr-verify')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-pr-draft', 'evidence-pr-commit', ?, ?, ?, 2, ?, 2, ?, ?, ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, PARENT_SHA, HEAD_SHA, BRANCH, NOW),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('Draft PR snapshot API', () => {
  it('converges 20 requests to one immutable, Evidence-backed body with every required section', async () => {
    const request = {
      expectedRunVersion: 8,
      planVersion: 2,
      planDigest: PLAN_DIGEST,
      headSha: HEAD_SHA,
    };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => requestDraft(request)),
    );
    expect(responses.every((response) => response.status === 200 || response.status === 201))
      .toBe(true);
    const bodies = await Promise.all(responses.map(async (response) => await response.json())) as Array<{
      draftId: string;
      created: boolean;
      bodyDigest: string;
      body: string;
    }>;
    expect(bodies.filter((body) => body.created)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.draftId)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.bodyDigest)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.body)).size).toBe(1);
    const body = bodies[0]!.body;
    for (const heading of [
      '## Source task',
      '## Change summary',
      '## Acceptance criteria',
      '## Risks',
      '## Test evidence',
      '## Unfinished items',
      '## Rollback',
    ]) expect(body).toContain(heading);
    expect(body).toContain('Revision: `revision-3`');
    expect(body).toContain('`test:checkout` — exit `0`, `125 ms`');
    expect(body).toContain(OPTIONAL_ITEM_ID);
    expect(body).toContain(`Revert bot commit ${HEAD_SHA}`);
    expect(body).toContain('https://tasks.example.test/items/42');
    expect(body).not.toContain('temporary_token');
    expect(body).not.toContain('#private');
    expect(body).not.toContain('Private feedback body');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('@reviewers');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM pull_request_drafts',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM pull_request_draft_criteria',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM pull_request_draft_evidence',
    ).first()).toEqual({ count: 2 });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE pull_request_drafts SET body = 'forged' WHERE draft_id = ?`,
    ).bind(bodies[0]!.draftId).run()).rejects.toThrow('pull_request_draft_is_immutable');
  });

  it('rejects Agent auth, caller-authored body fields, stale head, and incomplete required Items', async () => {
    const valid = {
      expectedRunVersion: 8,
      planVersion: 2,
      planDigest: PLAN_DIGEST,
      headSha: HEAD_SHA,
    };
    expect((await requestDraft(valid, 'attempt-runner-token')).status).toBe(401);
    expect((await requestDraft({ ...valid, body: '# forged Agent body' })).status).toBe(400);
    expect((await requestDraft({ ...valid, headSha: '9'.repeat(40) })).status).toBe(409);
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-newer-pr-head', ?, 3, 'review_fix', 'pending', ?,
                 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 2, ?, 0, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, NOW, NOW).run();
    expect((await requestDraft(valid)).status).toBe(409);
    await env.DB_CONTROL.prepare('DELETE FROM attempts WHERE attempt_id = ?')
      .bind('attempt-newer-pr-head').run();
    await env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress SET status = 'blocked', version = version + 1
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).run();
    expect((await requestDraft(valid)).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM pull_request_drafts',
    ).first()).toEqual({ count: 0 });
  });

  it('runs the final publication Secret scan even if a corrupted Task snapshot bypassed intake', async () => {
    const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
    if (webhookSecret === undefined) throw new Error('test webhook Secret is unavailable');
    const corrupted = taskEnvelope(webhookSecret);
    const digest = await taskRevisionDigest(corrupted);
    await env.TASK_OBJECTS.put('tasks/pr-draft', JSON.stringify(corrupted), {
      customMetadata: { taskDigest: digest },
    });
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare('UPDATE tasks SET task_digest = ? WHERE task_id = ?')
        .bind(digest, TASK_ID),
      env.DB_CONTROL.prepare('UPDATE runs SET task_digest = ? WHERE run_id = ?')
        .bind(digest, RUN_ID),
    ]);
    const response = await requestDraft({
      expectedRunVersion: 8,
      planVersion: 2,
      planDigest: PLAN_DIGEST,
      headSha: HEAD_SHA,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(webhookSecret);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM pull_request_drafts',
    ).first()).toEqual({ count: 0 });
  });
});
