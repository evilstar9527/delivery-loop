/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const GITHUB_HEAD_SHA = 'c'.repeat(40);
const TASK_DIGEST = `sha256:${'b'.repeat(64)}`;
const RUN_ID = 'run-github-dispatch';
const ATTEMPT_ID = 'attempt-github-dispatch';
const OUTBOX_ID = 'dispatch-attempt-github-dispatch';
const REPOSITORY = 'example/delivery-target';
const EXECUTOR_REPOSITORY = 'example/delivery-loop';
const EXECUTOR_REF = 'refs/heads/main';
const CANARY = 'CANARY_TASK_BODY_OR_SECRET_MUST_NOT_DISPATCH';

class FakeGitHubDispatchEffects implements GitHubDispatchEffects {
  readonly requests: GitHubDispatchRequest[] = [];
  failures = 0;
  result: GitHubDispatchResult = {
    disposition: 'created',
    githubRunId: '123456789',
    githubHeadSha: GITHUB_HEAD_SHA,
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

async function seedInitialExecutionDispatch(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES ('plan-initial-execution', ?, 1, '1', ?, ?, 'active', ?,
                 'Implement and verify the approved change.', ?, ?)`,
    ).bind(
      RUN_ID,
      BASE_SHA,
      `sha256:${'c'.repeat(64)}`,
      ATTEMPT_ID,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES ('plan-initial-execution', 'change', 'change', 'Change', 'Implement.', 1, 0)`,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id, claimed_progress_version,
         version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-initial-execution', ?, 2, 'implement', 'pending', ?, ?,
                 ?, 'plan-initial-execution', 1, 'change', 1, 0, 0, ?, ?)`,
    ).bind(
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      `${REPOSITORY}/.github/workflows/delivery-agent.yml@refs/heads/main`,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
  ]);
  await env.DB_CONTROL.prepare(
    `UPDATE runs SET state = 'executing', version = 2,
       active_plan_id = 'plan-initial-execution', active_plan_version = 1,
       active_plan_digest = ? WHERE run_id = ?`,
  ).bind(`sha256:${'c'.repeat(64)}`, RUN_ID).run();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, active_attempt_id, version, updated_at)
       VALUES ('plan-initial-execution', 'change', 'in_progress',
               'attempt-initial-execution', 2, ?)`,
    ).bind(NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('outbox-initial-execution', ?, 'execution_dispatch', 'github_actions',
                 'd1://attempts/attempt-initial-execution',
                 'execution-dispatch:attempt-initial-execution', 'pending', ?, ?)`,
    ).bind(RUN_ID, NOW.toISOString(), NOW.toISOString()),
  ]);
}

function processor(
  effects: GitHubDispatchEffects,
  allowedRepositories: readonly string[] = [REPOSITORY],
): GitHubDispatchOutboxProcessor {
  return new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
    allowedRepositories,
    executorRepository: EXECUTOR_REPOSITORY,
    executorRef: EXECUTOR_REF,
    controlPlaneUrl: 'https://control.example.test',
    now: () => NOW,
    generateLeaseToken: () => crypto.randomUUID(),
    outboxLeaseMs: 30_000,
    attemptLeaseMs: 10 * 60_000,
  });
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM automated_review_replacement_redispatches'),
    env.DB_CONTROL.prepare('DELETE FROM automated_review_fix_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_reviews'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM run_blockers'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failure_paths'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM review_approval_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM review_approval_recovery_approvals'),
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
  it('invokes the default runtime fetch through globalThis instead of the client receiver', async () => {
    const usedGlobalReceiver: boolean[] = [];
    const fetchImplementation = vi.fn(function (this: unknown) {
      usedGlobalReceiver.push(this === globalThis);
      return Promise.resolve(new Response(JSON.stringify({
        workflow_runs: [{
          id: 777,
          event: 'workflow_dispatch',
          display_title: `delivery-loop/${ATTEMPT_ID}`,
          path: '.github/workflows/delivery-agent.yml',
          head_branch: 'main',
          head_sha: GITHUB_HEAD_SHA,
        }],
      }), { status: 200 }));
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      const client = new GitHubActionsApiClient({
        async getInstallationToken() {
          return 'test-installation-token';
        },
      }, { apiBaseUrl: 'https://api.github.test' });

      await expect(client.ensureDispatch({
        repository: REPOSITORY,
        workflowFile: '.github/workflows/delivery-agent.yml',
        ref: 'refs/heads/main',
        inputs: { attempt_id: ATTEMPT_ID },
      })).resolves.toEqual({
        disposition: 'existing',
        githubRunId: '777',
        githubHeadSha: GITHUB_HEAD_SHA,
      });
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(usedGlobalReceiver).toEqual([true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets one of 20 consumers dispatch a fixed workflow with a reference-only payload', async () => {
    const effects = new FakeGitHubDispatchEffects();
    const dispatcher = processor(effects);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => dispatcher.deliver(OUTBOX_ID)),
    );

    expect(effects.requests).toHaveLength(1);
    expect(results.filter((result) => result === 'settled').length).toBeGreaterThanOrEqual(1);
    expect(effects.requests[0]).toEqual({
      repository: EXECUTOR_REPOSITORY,
      workflowFile: '.github/workflows/delivery-agent.yml',
      ref: 'refs/heads/main',
      inputs: {
        schema_version: '1',
        run_id: RUN_ID,
        attempt_id: ATTEMPT_ID,
        task_digest: TASK_DIGEST,
        base_sha: BASE_SHA,
        checkout_sha: BASE_SHA,
        target_repository: REPOSITORY,
        control_plane_url: 'https://control.example.test',
        mode: 'analysis',
      },
    });
    const serialized = JSON.stringify(effects.requests[0]);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toMatch(/token|secret|description|acceptance/i);

    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_expires_at,
              github_run_id, github_head_sha, github_status, github_observed_at
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
      github_head_sha: GITHUB_HEAD_SHA,
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

  it('dispatches an initial implement Attempt with no repair source', async () => {
    await seedInitialExecutionDispatch();
    const effects = new FakeGitHubDispatchEffects();

    await expect(processor(effects).deliver('outbox-initial-execution')).resolves.toBe('settled');
    expect(effects.requests).toHaveLength(1);
    expect(effects.requests[0]).toMatchObject({
      repository: EXECUTOR_REPOSITORY,
      inputs: {
        attempt_id: 'attempt-initial-execution',
        mode: 'implement',
        plan_version: '1',
        plan_item_id: 'change',
        checkout_sha: BASE_SHA,
        target_repository: REPOSITORY,
      },
    });
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, github_run_id, github_head_sha,
              github_status, github_observed_at
       FROM attempts WHERE attempt_id = 'attempt-initial-execution'`,
    ).first<Record<string, unknown>>();
    expect(attempt).toMatchObject({
      status: 'starting',
      version: 1,
      lease_generation: 1,
      github_run_id: '123456789',
      github_head_sha: GITHUB_HEAD_SHA,
      github_status: 'requested',
      github_observed_at: NOW.toISOString(),
    });
  });

  it('dispatches a review_fix Attempt whose source is approval recovery lineage', async () => {
    await seedInitialExecutionDispatch();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET mode = 'review_fix'
         WHERE attempt_id = 'attempt-initial-execution'`,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id, version,
           lease_generation, head_sha, created_at, updated_at
         ) VALUES ('attempt-failed-review-source', ?, 3, 'review_fix', 'failed', ?, ?,
                   ?, 'plan-initial-execution', 1, 'change', 1, 1, ?, ?, ?)`,
      ).bind(
        RUN_ID,
        BASE_SHA,
        REPOSITORY,
        `${REPOSITORY}/.github/workflows/delivery-agent.yml@refs/heads/main`,
        GITHUB_HEAD_SHA,
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO approvals (
           approval_id, run_id, task_revision, plan_id, plan_version,
           plan_digest, base_sha, effect, actor_id, decision, nonce_digest,
           expires_at, created_at
         ) VALUES ('approval-recovery-dispatch', ?, '1', 'plan-initial-execution', 1,
                   ?, ?, 'repo_write', 'human:dispatch-test', 'approve', ?, ?, ?)`,
      ).bind(
        RUN_ID,
        `sha256:${'c'.repeat(64)}`,
        BASE_SHA,
        `sha256:${'d'.repeat(64)}`,
        '2026-07-25T11:00:00.000Z',
        NOW.toISOString(),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO review_approval_recovery_approvals (
           recovery_approval_id, run_id, plan_id, plan_version, plan_item_id,
           failed_attempt_id, root_review_attempt_id, approval_id, created_at
         ) VALUES ('recovery-approval-dispatch', ?, 'plan-initial-execution', 1,
                   'change', 'attempt-failed-review-source', ?,
                   'approval-recovery-dispatch', ?)`,
      ).bind(RUN_ID, ATTEMPT_ID, NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `INSERT INTO review_approval_recoveries (
           recovery_id, recovery_approval_id, run_id, plan_id, plan_version,
           plan_item_id, failed_attempt_id, root_review_attempt_id, approval_id,
           replacement_attempt_id, created_at
         ) VALUES ('recovery-dispatch', 'recovery-approval-dispatch', ?,
                   'plan-initial-execution', 1, 'change',
                   'attempt-failed-review-source', ?, 'approval-recovery-dispatch',
                   'attempt-initial-execution', ?)`
      ).bind(RUN_ID, ATTEMPT_ID, NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `UPDATE outbox SET attempt_count = 2 WHERE outbox_id = 'outbox-initial-execution'`,
      ),
    ]);
    const effects = new FakeGitHubDispatchEffects();

    await expect(processor(effects).deliver('outbox-initial-execution')).resolves.toBe('settled');
    expect(effects.requests).toHaveLength(1);
    expect(effects.requests[0]).toMatchObject({
      repository: EXECUTOR_REPOSITORY,
      inputs: {
        attempt_id: 'attempt-initial-execution',
        mode: 'review_fix',
        plan_version: '1',
        plan_item_id: 'change',
        checkout_sha: BASE_SHA,
        target_repository: REPOSITORY,
        dispatch_generation: '1',
      },
    });
  });

  it('still rejects a review_fix Attempt unless exactly one trusted repair source exists', async () => {
    await seedInitialExecutionDispatch();
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET mode = 'review_fix'
       WHERE attempt_id = 'attempt-initial-execution'`,
    ).run();
    const effects = new FakeGitHubDispatchEffects();

    await expect(processor(effects).deliver('outbox-initial-execution')).resolves.toBe('settled');
    expect(effects.requests).toHaveLength(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox
       WHERE outbox_id = 'outbox-initial-execution'`,
    ).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: 'repair_dispatch_stale',
    });
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

    effects.result = {
      disposition: 'existing',
      githubRunId: '123456789',
      githubHeadSha: GITHUB_HEAD_SHA,
    };
    expect(await dispatcher.deliver(OUTBOX_ID)).toBe('settled');
    expect(effects.requests).toHaveLength(2);
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, github_run_id, github_head_sha
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first();
    expect(attempt).toEqual({
      status: 'starting',
      version: 1,
      github_run_id: '123456789',
      github_head_sha: GITHUB_HEAD_SHA,
    });
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
              head_sha: GITHUB_HEAD_SHA,
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
      githubHeadSha: GITHUB_HEAD_SHA,
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
                head_sha: GITHUB_HEAD_SHA,
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
    ).resolves.toEqual({
      disposition: 'existing',
      githubRunId: '777',
      githubHeadSha: GITHUB_HEAD_SHA,
    });
    expect(methods).toEqual(['GET']);
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-github-head'],
  ])('rejects a matching external run with %s head_sha without dispatching again', async (
    _label,
    headSha,
  ) => {
    const methods: string[] = [];
    const client = new GitHubActionsApiClient({
      async getInstallationToken() {
        return 'test-installation-token';
      },
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return new Response(JSON.stringify({
          workflow_runs: [{
            id: 777,
            event: 'workflow_dispatch',
            display_title: `delivery-loop/${ATTEMPT_ID}`,
            path: '.github/workflows/delivery-agent.yml',
            head_branch: 'main',
            ...(headSha === undefined ? {} : { head_sha: headSha }),
          }],
        }), { status: 200 });
      },
    });

    await expect(client.ensureDispatch({
      repository: REPOSITORY,
      workflowFile: '.github/workflows/delivery-agent.yml',
      ref: 'refs/heads/main',
      inputs: { attempt_id: ATTEMPT_ID },
    })).rejects.toThrow('GitHub workflow run response is invalid');
    expect(methods).toEqual(['GET']);
  });
});
