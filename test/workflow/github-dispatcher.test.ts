/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubActionsApiClient,
  GitHubDispatchOutboxProcessor,
  type GitHubDispatchRequest,
  type GitHubDispatchResult,
  type GitHubDispatchEffects,
  type GitHubInstallationTokenProvider,
} from '../../src/outbox/github-dispatcher.js';

const NOW = new Date('2026-07-25T10:00:00.000Z');
const BASE_SHA = 'a'.repeat(40);
const TASK_DIGEST = `sha256:${'b'.repeat(64)}`;
const RUN_ID = 'run-github-dispatch';
const ATTEMPT_ID = 'attempt-github-dispatch';
const OUTBOX_ID = 'dispatch-attempt-github-dispatch';
const REPOSITORY = 'example/delivery-target';
const CANARY = 'CANARY_TASK_BODY_OR_SECRET_MUST_NOT_DISPATCH';

class FakeGitHubDispatchEffects implements GitHubDispatchEffects {
  readonly requests: GitHubDispatchRequest[] = [];
  failures = 0;
  result: GitHubDispatchResult = {
    disposition: 'created',
    githubRunId: '123456789',
  };

  async ensureDispatch(request: GitHubDispatchRequest): Promise<GitHubDispatchResult> {
    this.requests.push(request);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('simulated GitHub unavailable');
    }
    return this.result;
  }
}

async function seedAnalysisDispatch(repository = REPOSITORY): Promise<void> {
  const workflowRef = `${repository}/.github/workflows/delivery-agent.yml@refs/heads/main`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-github-dispatch', 'manual', 'dispatch-test', 'dispatch-test', '1', ?,
         'r2://tasks/github-dispatch-canary', 'system', 'dispatch-test', ?, 'main',
         'test', 'bug', ?, 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(TASK_DIGEST, repository, CANARY, NOW.toISOString(), NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, 'task-github-dispatch', '1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, TASK_DIGEST, BASE_SHA, RUN_ID, NOW.toISOString(), NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'pending', ?, ?, ?, 0, 0, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      repository,
      workflowRef,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES (?, ?, 'analysis_dispatch', 'github_actions', ?, ?, 'pending', ?, ?)`,
    ).bind(
      OUTBOX_ID,
      RUN_ID,
      `d1://attempts/${ATTEMPT_ID}`,
      `analysis-dispatch:${RUN_ID}:1`,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
  ]);
}

function processor(
  effects: GitHubDispatchEffects,
  allowedRepositories: readonly string[] = [REPOSITORY],
): GitHubDispatchOutboxProcessor {
  return new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
    allowedRepositories,
    controlPlaneUrl: 'https://control.example.test',
    now: () => NOW,
    generateLeaseToken: () => crypto.randomUUID(),
    outboxLeaseMs: 30_000,
    attemptLeaseMs: 10 * 60_000,
  });
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
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
  await seedAnalysisDispatch();
});

describe('GitHub App workflow dispatcher contract', () => {
  it('lets one of 20 consumers dispatch a fixed workflow with a reference-only payload', async () => {
    const effects = new FakeGitHubDispatchEffects();
    const dispatcher = processor(effects);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => dispatcher.deliver(OUTBOX_ID)),
    );

    expect(effects.requests).toHaveLength(1);
    expect(results.filter((result) => result === 'settled').length).toBeGreaterThanOrEqual(1);
    expect(effects.requests[0]).toEqual({
      repository: REPOSITORY,
      workflowFile: '.github/workflows/delivery-agent.yml',
      ref: 'refs/heads/main',
      inputs: {
        schema_version: '1',
        run_id: RUN_ID,
        attempt_id: ATTEMPT_ID,
        task_digest: TASK_DIGEST,
        base_sha: BASE_SHA,
        checkout_sha: BASE_SHA,
        control_plane_url: 'https://control.example.test',
        mode: 'analysis',
      },
    });
    const serialized = JSON.stringify(effects.requests[0]);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toMatch(/token|secret|description|acceptance/i);

    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_expires_at,
              github_run_id, github_status, github_observed_at
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(attempt).toMatchObject({
      status: 'starting',
      version: 1,
      lease_generation: 1,
      lease_expires_at: '2026-07-25T10:10:00.000Z',
      github_run_id: '123456789',
      github_status: 'requested',
      github_observed_at: NOW.toISOString(),
    });
    const outbox = await env.DB_CONTROL.prepare(
      'SELECT delivery_state, attempt_count, lease_token FROM outbox WHERE outbox_id = ?',
    )
      .bind(OUTBOX_ID)
      .first<Record<string, unknown>>();
    expect(outbox).toMatchObject({ delivery_state: 'settled', attempt_count: 1, lease_token: null });
  });

  it('fails closed for a repository outside the App installation allowlist', async () => {
    const effects = new FakeGitHubDispatchEffects();
    const result = await processor(effects, ['approved/other-repo']).deliver(OUTBOX_ID);

    expect(result).toBe('retry');
    expect(effects.requests).toHaveLength(0);
    const outbox = await env.DB_CONTROL.prepare(
      'SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?',
    )
      .bind(OUTBOX_ID)
      .first<Record<string, unknown>>();
    expect(outbox).toEqual({
      delivery_state: 'pending',
      last_error_code: 'repository_not_allowed',
    });
  });

  it('rejects a mutable/non-fixed workflow ref before calling GitHub', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET workflow_ref = ?
       WHERE attempt_id = ?`,
    )
      .bind(`${REPOSITORY}/.github/workflows/untrusted.yml@refs/heads/feature`, ATTEMPT_ID)
      .run();
    const effects = new FakeGitHubDispatchEffects();
    const result = await processor(effects).deliver(OUTBOX_ID);

    expect(result).toBe('retry');
    expect(effects.requests).toHaveLength(0);
    const outbox = await env.DB_CONTROL.prepare(
      'SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?',
    )
      .bind(OUTBOX_ID)
      .first<Record<string, unknown>>();
    expect(outbox).toEqual({
      delivery_state: 'pending',
      last_error_code: 'workflow_ref_mismatch',
    });
  });

  it('rolls back a failed delivery and converges after external reconciliation', async () => {
    const effects = new FakeGitHubDispatchEffects();
    effects.failures = 1;
    const dispatcher = processor(effects);

    expect(await dispatcher.deliver(OUTBOX_ID)).toBe('retry');
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?',
      )
        .bind(OUTBOX_ID)
        .first(),
    ).toEqual({ delivery_state: 'pending', last_error_code: 'github_unavailable' });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT released_at, release_reason
         FROM quota_concurrency_reservations WHERE attempt_id = ?`,
      ).bind(ATTEMPT_ID).first(),
    ).toEqual({ released_at: null, release_reason: null });

    effects.result = { disposition: 'existing', githubRunId: '123456789' };
    expect(await dispatcher.deliver(OUTBOX_ID)).toBe('settled');
    expect(effects.requests).toHaveLength(2);
    const attempt = await env.DB_CONTROL.prepare(
      'SELECT status, version, github_run_id FROM attempts WHERE attempt_id = ?',
    )
      .bind(ATTEMPT_ID)
      .first();
    expect(attempt).toEqual({ status: 'starting', version: 1, github_run_id: '123456789' });
  });

  it('uses a GitHub App installation token and reconciles a newly dispatched run', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
      new Response(null, { status: 204 }),
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 123456789,
              event: 'workflow_dispatch',
              display_title: `delivery-loop/${ATTEMPT_ID}`,
              path: '.github/workflows/delivery-agent.yml',
              head_branch: 'main',
            },
          ],
        }),
        { status: 200 },
      ),
    ];
    const tokenProvider: GitHubInstallationTokenProvider = {
      async getInstallationToken(repository) {
        expect(repository).toBe(REPOSITORY);
        return 'test-installation-token-never-in-payload';
      },
    };
    const client = new GitHubActionsApiClient(tokenProvider, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        const response = responses.shift();
        if (response === undefined) throw new Error('unexpected fetch');
        return response;
      },
      reconciliationAttempts: 1,
    });
    const request: GitHubDispatchRequest = {
      repository: REPOSITORY,
      workflowFile: '.github/workflows/delivery-agent.yml',
      ref: 'refs/heads/main',
      inputs: {
        schema_version: '1',
        run_id: RUN_ID,
        attempt_id: ATTEMPT_ID,
        task_digest: TASK_DIGEST,
        base_sha: BASE_SHA,
        checkout_sha: BASE_SHA,
        control_plane_url: 'https://control.example.test',
        mode: 'analysis',
      },
    };

    await expect(client.ensureDispatch(request)).resolves.toEqual({
      disposition: 'created',
      githubRunId: '123456789',
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toBe(
      'https://api.github.test/repos/example/delivery-target/actions/workflows/.github%2Fworkflows%2Fdelivery-agent.yml/dispatches',
    );
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      ref: 'refs/heads/main',
      inputs: request.inputs,
    });
    expect(String(calls[1]?.init?.body)).not.toContain('installation-token');
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe(
      'Bearer test-installation-token-never-in-payload',
    );
    expect(new Headers(calls[1]?.init?.headers).get('user-agent')).toBe(
      'delivery-loop-control-plane',
    );
  });

  it('returns an existing external run without issuing a duplicate dispatch', async () => {
    const methods: string[] = [];
    const tokenProvider: GitHubInstallationTokenProvider = {
      async getInstallationToken() {
        return 'test-installation-token';
      },
    };
    const client = new GitHubActionsApiClient(tokenProvider, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 777,
                event: 'workflow_dispatch',
                display_title: `delivery-loop/${ATTEMPT_ID}`,
                path: '.github/workflows/delivery-agent.yml',
                head_branch: 'main',
              },
            ],
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      client.ensureDispatch({
        repository: REPOSITORY,
        workflowFile: '.github/workflows/delivery-agent.yml',
        ref: 'refs/heads/main',
        inputs: { attempt_id: ATTEMPT_ID },
      }),
    ).resolves.toEqual({ disposition: 'existing', githubRunId: '777' });
    expect(methods).toEqual(['GET']);
  });
});
