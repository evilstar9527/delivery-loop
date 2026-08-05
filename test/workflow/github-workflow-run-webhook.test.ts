/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const BASE_URL = 'https://delivery-loop.test';
const WEBHOOK_SECRET = 'test-github-webhook-secret';
const RUN_ID = 'run-github-webhook';
const ATTEMPT_ID = 'attempt-github-webhook';
const GITHUB_RUN_ID = 987_654_321;
const REPOSITORY = 'example/delivery-target';
const BASE_SHA = 'b'.repeat(40);
const GITHUB_HEAD_SHA = 'a'.repeat(40);
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';
const PAYLOAD_CANARY = 'CANARY_GITHUB_PAYLOAD_MUST_NOT_PERSIST';

type WorkflowStatus = 'requested' | 'queued' | 'waiting' | 'in_progress' | 'completed';

function workflowRunPayload(options: {
  status?: WorkflowStatus;
  conclusion?: string | null;
  updatedAt?: string;
  repository?: string;
  githubRunId?: number;
  path?: string;
  headSha?: string;
  headBranch?: string;
  displayTitle?: string;
  runAttempt?: number;
} = {}): Record<string, unknown> {
  const status = options.status ?? 'completed';
  return {
    action:
      status === 'completed' ? 'completed' : status === 'requested' ? 'requested' : 'in_progress',
    workflow_run: {
      id: options.githubRunId ?? GITHUB_RUN_ID,
      event: 'workflow_dispatch',
      status,
      conclusion: options.conclusion === undefined ? (status === 'completed' ? 'success' : null) : options.conclusion,
      head_sha: options.headSha ?? GITHUB_HEAD_SHA,
      head_branch: options.headBranch ?? 'main',
      path: options.path ?? `${WORKFLOW_PATH}@refs/heads/main`,
      display_title: options.displayTitle ?? `delivery-loop/${ATTEMPT_ID}`,
      run_attempt: options.runAttempt ?? 1,
      updated_at: options.updatedAt ?? '2026-07-25T06:00:00Z',
    },
    repository: { full_name: options.repository ?? REPOSITORY },
    sender: { login: PAYLOAD_CANARY },
  };
}

async function signature(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

async function deliver(
  deliveryId: string,
  payload: Record<string, unknown>,
  options: { secret?: string; event?: string; rawBody?: string } = {},
): Promise<Response> {
  const body = options.rawBody ?? JSON.stringify(payload);
  return await SELF.fetch(`${BASE_URL}/v1/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': deliveryId,
      'x-github-event': options.event ?? 'workflow_run',
      'x-hub-signature-256': await signature(body, options.secret),
    },
    body,
  });
}

async function seedAttempt(): Promise<void> {
  const now = '2026-07-25T05:00:00.000Z';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-github-webhook', 'manual', 'github-webhook-test', 'github-webhook-test',
         'revision-1', ?, 'r2://tasks/github-webhook-test', 'system',
         'github-webhook-test', ?, 'main', 'none', 'bug', 'GitHub webhook test',
         'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'1'.repeat(64)}`, REPOSITORY, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, 'task-github-webhook', 'revision-1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, `sha256:${'1'.repeat(64)}`, BASE_SHA, RUN_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, github_head_sha, github_status, github_observed_at,
         version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, ?, ?, ?, ?, 'requested', ?, 7, 1, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
      String(GITHUB_RUN_ID),
      GITHUB_HEAD_SHA,
      now,
      now,
      now,
    ),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM github_webhook_deliveries'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedAttempt();
});

describe('GitHub workflow_run webhook external facts', () => {
  it('applies one signed external fact and deduplicates 20 delivery replays', async () => {
    const payload = workflowRunPayload();
    const deliveryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const first = await deliver(deliveryId, payload);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, disposition: 'applied' });

    const replays = await Promise.all(
      Array.from({ length: 20 }, () => deliver(deliveryId, payload)),
    );
    expect(replays.every((response) => response.status === 202)).toBe(true);
    const replayBodies = await Promise.all(replays.map((response) => response.json()));
    expect(replayBodies.every((body) => (body as { disposition?: string }).disposition === 'duplicate')).toBe(true);

    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, github_status, github_conclusion, github_observed_at,
              github_external_updated_at, github_observation_version
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(attempt).toMatchObject({
      status: 'running',
      version: 7,
      github_status: 'completed',
      github_conclusion: 'success',
      github_external_updated_at: '2026-07-25T06:00:00.000Z',
      github_observation_version: 1,
    });
    expect(attempt?.github_observed_at).toBeTruthy();
    const deliveries = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count, MAX(processing_state) AS processing_state,
              MAX(payload_digest) AS payload_digest
       FROM github_webhook_deliveries`,
    ).first<{ count: number; processing_state: string; payload_digest: string }>();
    expect(deliveries).toMatchObject({ count: 1, processing_state: 'applied' });
    expect(deliveries?.payload_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(deliveries)).not.toContain(PAYLOAD_CANARY);
  });

  it('rejects invalid signatures and delivery conflicts without echoing payload or secret', async () => {
    const deliveryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const invalid = await deliver(deliveryId, workflowRunPayload(), {
      secret: 'wrong-webhook-secret',
    });
    expect(invalid.status).toBe(401);
    const invalidText = await invalid.text();
    expect(invalidText).not.toContain(PAYLOAD_CANARY);
    expect(invalidText).not.toContain(WEBHOOK_SECRET);
    expect(
      (
        await env.DB_CONTROL.prepare(
          'SELECT COUNT(*) AS count FROM github_webhook_deliveries',
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);

    const unsupported = await deliver(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0',
      workflowRunPayload(),
      { event: 'ping' },
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: 'invalid_argument' });

    const accepted = await deliver(deliveryId, workflowRunPayload());
    expect(accepted.status).toBe(202);
    const conflict = await deliver(
      deliveryId,
      workflowRunPayload({ updatedAt: '2026-07-25T06:01:00Z', conclusion: 'failure' }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'conflict' });
    const attempt = await env.DB_CONTROL.prepare(
      'SELECT github_conclusion, github_observation_version FROM attempts WHERE attempt_id = ?',
    )
      .bind(ATTEMPT_ID)
      .first<{ github_conclusion: string; github_observation_version: number }>();
    expect(attempt).toEqual({ github_conclusion: 'success', github_observation_version: 1 });
  });

  it('ignores signed facts whose repository, workflow, SHA, title, or run ID is not bound', async () => {
    const mismatches = [
      workflowRunPayload({ repository: 'attacker/other-repo' }),
      workflowRunPayload({ path: '.github/workflows/other.yml@refs/heads/main' }),
      workflowRunPayload({ headSha: BASE_SHA }),
      workflowRunPayload({ displayTitle: 'delivery-loop/other-attempt' }),
      workflowRunPayload({ githubRunId: GITHUB_RUN_ID + 1 }),
      workflowRunPayload({ runAttempt: 2 }),
    ];
    for (const [index, payload] of mismatches.entries()) {
      const response = await deliver(`cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, '0')}`, payload);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: true, disposition: 'ignored' });
    }
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT github_status, github_conclusion, github_external_updated_at,
              github_observation_version, version
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(attempt).toMatchObject({
      github_status: 'requested',
      github_conclusion: null,
      github_external_updated_at: null,
      github_observation_version: 0,
      version: 7,
    });
  });

  it('does not let an older signed event regress a newer completed fact', async () => {
    const inProgress = await deliver(
      'dddddddd-dddd-4ddd-8ddd-000000000001',
      workflowRunPayload({
        status: 'in_progress',
        conclusion: null,
        updatedAt: '2026-07-25T05:30:00Z',
      }),
    );
    expect(await inProgress.json()).toMatchObject({ disposition: 'applied' });
    const completed = await deliver(
      'dddddddd-dddd-4ddd-8ddd-000000000002',
      workflowRunPayload({ updatedAt: '2026-07-25T06:00:00Z' }),
    );
    expect(await completed.json()).toMatchObject({ disposition: 'applied' });
    const stale = await deliver(
      'dddddddd-dddd-4ddd-8ddd-000000000003',
      workflowRunPayload({
        status: 'queued',
        conclusion: null,
        updatedAt: '2026-07-25T05:00:00Z',
      }),
    );
    expect(await stale.json()).toMatchObject({ disposition: 'ignored' });

    const attempt = await env.DB_CONTROL.prepare(
      `SELECT github_status, github_conclusion, github_external_updated_at,
              github_observation_version, version
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(attempt).toMatchObject({
      github_status: 'completed',
      github_conclusion: 'success',
      github_external_updated_at: '2026-07-25T06:00:00.000Z',
      github_observation_version: 2,
      version: 7,
    });
  });
});
