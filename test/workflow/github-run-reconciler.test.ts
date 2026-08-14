/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubActionsApiClient } from '../../src/outbox/github-dispatcher.js';
import {
  GitHubRunReconciler,
  type GitHubRunExternalFactClient,
} from '../../src/reconciliation/github-run-reconciler.js';
import type { GitHubWorkflowRunFact } from '../../src/storage/github-run-observation-store.js';

const RUN_ID = 'run-github-reconciler';
const ATTEMPT_ID = 'attempt-github-reconciler';
const GITHUB_RUN_ID = '123456789';
const REPOSITORY = 'example/delivery-target';
const EXECUTOR_REPOSITORY = 'example/delivery-loop';
const BASE_SHA = 'd'.repeat(40);
const GITHUB_HEAD_SHA = 'c'.repeat(40);
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';

function runFact(overrides: Partial<GitHubWorkflowRunFact> = {}): GitHubWorkflowRunFact {
  return {
    repository: EXECUTOR_REPOSITORY,
    githubRunId: GITHUB_RUN_ID,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    headSha: GITHUB_HEAD_SHA,
    headBranch: 'main',
    workflowPath: `${WORKFLOW_PATH}@refs/heads/main`,
    displayTitle: `delivery-loop/${ATTEMPT_ID}`,
    runAttempt: 1,
    externalUpdatedAt: '2026-07-25T07:00:00.000Z',
    ...overrides,
  };
}

class FakeRunClient implements GitHubRunExternalFactClient {
  readonly calls: Array<{ repository: string; githubRunId: string }> = [];

  constructor(public fact: GitHubWorkflowRunFact) {}

  async getWorkflowRun(repository: string, githubRunId: string): Promise<GitHubWorkflowRunFact> {
    this.calls.push({ repository, githubRunId });
    return this.fact;
  }
}

async function seedAttempt(): Promise<void> {
  const now = '2026-07-25T06:00:00.000Z';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-github-reconciler', 'manual', 'github-reconciler-test',
         'github-reconciler-test', 'revision-1', ?, 'r2://tasks/github-reconciler-test',
         'system', 'github-reconciler-test', ?, 'main', 'none', 'bug',
         'GitHub reconciler test', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'4'.repeat(64)}`, REPOSITORY, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, 'task-github-reconciler', 'revision-1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, `sha256:${'4'.repeat(64)}`, BASE_SHA, RUN_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, github_head_sha, github_status, github_observed_at,
         version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, ?, ?, ?, ?, 'in_progress', ?, 9, 2, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      `${EXECUTOR_REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
      GITHUB_RUN_ID,
      GITHUB_HEAD_SHA,
      now,
      now,
      now,
    ),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM github_api_observations'),
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

describe('GitHub App workflow run reconciliation', () => {
  it('repairs a missed webhook through API facts and deduplicates the same observation', async () => {
    const client = new FakeRunClient(runFact());
    const reconciler = new GitHubRunReconciler(env.DB_CONTROL, client, {
      now: () => new Date('2026-07-25T07:01:00.000Z'),
    });
    expect(await reconciler.reconcileAttempt(ATTEMPT_ID)).toBe('applied');
    expect(await reconciler.reconcileAttempt(ATTEMPT_ID)).toBe('duplicate');
    expect(client.calls).toEqual([
      { repository: EXECUTOR_REPOSITORY, githubRunId: GITHUB_RUN_ID },
      { repository: EXECUTOR_REPOSITORY, githubRunId: GITHUB_RUN_ID },
    ]);

    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, github_status, github_conclusion,
              github_external_updated_at, github_observation_version
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(attempt).toMatchObject({
      status: 'running',
      version: 9,
      github_status: 'completed',
      github_conclusion: 'success',
      github_external_updated_at: '2026-07-25T07:00:00.000Z',
      github_observation_version: 1,
    });
    const observations = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count, MAX(processing_state) AS processing_state,
              MAX(fact_digest) AS fact_digest
       FROM github_api_observations`,
    ).first<{ count: number; processing_state: string; fact_digest: string }>();
    expect(observations).toMatchObject({ count: 1, processing_state: 'applied' });
    expect(observations?.fact_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('ignores API facts that fail the same trusted binding or are older than webhook facts', async () => {
    const wrong = new FakeRunClient(runFact({ headSha: BASE_SHA }));
    expect(await new GitHubRunReconciler(env.DB_CONTROL, wrong).reconcileAttempt(ATTEMPT_ID)).toBe(
      'ignored',
    );
    const afterWrong = await env.DB_CONTROL.prepare(
      'SELECT github_observation_version FROM attempts WHERE attempt_id = ?',
    )
      .bind(ATTEMPT_ID)
      .first<{ github_observation_version: number }>();
    expect(afterWrong?.github_observation_version).toBe(0);

    const newer = new FakeRunClient(
      runFact({ status: 'in_progress', conclusion: null, externalUpdatedAt: '2026-07-25T08:00:00.000Z' }),
    );
    expect(await new GitHubRunReconciler(env.DB_CONTROL, newer).reconcileAttempt(ATTEMPT_ID)).toBe(
      'applied',
    );
    const stale = new FakeRunClient(runFact({ externalUpdatedAt: '2026-07-25T07:00:00.000Z' }));
    expect(await new GitHubRunReconciler(env.DB_CONTROL, stale).reconcileAttempt(ATTEMPT_ID)).toBe(
      'ignored',
    );
    const final = await env.DB_CONTROL.prepare(
      `SELECT github_status, github_conclusion, github_external_updated_at,
              github_observation_version, version
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(final).toMatchObject({
      github_status: 'in_progress',
      github_conclusion: null,
      github_external_updated_at: '2026-07-25T08:00:00.000Z',
      github_observation_version: 1,
      version: 9,
    });
  });

  it('drains only attempts still missing a completed external fact', async () => {
    const client = new FakeRunClient(runFact());
    const reconciler = new GitHubRunReconciler(env.DB_CONTROL, client);
    expect(await reconciler.reconcileBatch(10)).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'applied' },
    ]);
    expect(await reconciler.reconcileBatch(10)).toEqual([]);
  });

  it('prioritizes an active result-reported attempt over historical terminal backlog', async () => {
    const historicalCreatedAt = '2026-07-20T06:00:00.000Z';
    const historicalAttemptId = 'attempt-historical-missing-observation';
    const historicalRunId = 'run-historical-missing-observation';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO tasks (
           task_id, source_system, tenant_key, source_task_key, task_revision,
           task_digest, payload_ref, actor_type, actor_id, target_repository,
           target_base_branch, target_environment, intent_kind, title, priority,
           acceptance_criteria_count, allow_repository_write, allow_test_deploy,
           allow_production_deploy, require_human_approval, created_at, updated_at
         ) VALUES (
           'task-historical-missing-observation', 'manual', 'github-reconciler-test',
           'historical-missing-observation', 'revision-1', ?,
           'r2://tasks/historical-missing-observation', 'system',
           'github-reconciler-test', ?, 'main', 'none', 'bug',
           'Historical terminal attempt', 'p1', 1, 0, 0, 0, 1, ?, ?
         )`,
      ).bind(`sha256:${'5'.repeat(64)}`, REPOSITORY, historicalCreatedAt, historicalCreatedAt),
      env.DB_CONTROL.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha,
           workflow_instance_id, state, version, created_at, updated_at
         ) VALUES (?, 'task-historical-missing-observation', 'revision-1', ?, ?, ?,
                   'blocked', 2, ?, ?)`,
      ).bind(
        historicalRunId,
        `sha256:${'5'.repeat(64)}`,
        BASE_SHA,
        historicalRunId,
        historicalCreatedAt,
        historicalCreatedAt,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, github_run_id, github_head_sha, github_status, version,
           lease_generation, created_at, updated_at
         ) VALUES (?, ?, 1, 'analysis', 'lost', ?, ?, ?, '987654321', ?, 'requested',
                   2, 1, ?, ?)`,
      ).bind(
        historicalAttemptId,
        historicalRunId,
        BASE_SHA,
        REPOSITORY,
        `${EXECUTOR_REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
        GITHUB_HEAD_SHA,
        historicalCreatedAt,
        historicalCreatedAt,
      ),
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET result_event_id = 'event-fresh-result',
             result_sequence = 1,
             result_digest = ?,
             result_reported_at = ?
         WHERE attempt_id = ?`,
      ).bind(`sha256:${'6'.repeat(64)}`, '2026-07-25T06:59:00.000Z', ATTEMPT_ID),
    ]);

    const client = new FakeRunClient(runFact());
    expect(await new GitHubRunReconciler(env.DB_CONTROL, client).reconcileBatch(1)).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'applied' },
    ]);
    expect(client.calls).toEqual([
      { repository: EXECUTOR_REPOSITORY, githubRunId: GITHUB_RUN_ID },
    ]);

    client.fact = runFact({
      githubRunId: '987654321',
      displayTitle: `delivery-loop/${historicalAttemptId}`,
      externalUpdatedAt: '2026-07-20T07:00:00.000Z',
    });
    expect(await new GitHubRunReconciler(env.DB_CONTROL, client).reconcileBatch(1)).toEqual([
      { attemptId: historicalAttemptId, disposition: 'applied' },
    ]);
  });

  it('prioritizes a blocked lost recovery over historical missing observations', async () => {
    const rootAttemptId = 'attempt-review-recovery-root';
    const historicalAttemptId = 'attempt-older-terminal-backlog';
    const historicalRunId = 'run-older-terminal-backlog';
    const historicalCreatedAt = '2026-07-20T06:00:00.000Z';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'blocked', version = 3 WHERE run_id = ?`,
      ).bind(RUN_ID),
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET ordinal = 2, mode = 'review_fix', status = 'lost',
             result_event_id = NULL
         WHERE attempt_id = ?`,
      ).bind(ATTEMPT_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO tasks (
           task_id, source_system, tenant_key, source_task_key, task_revision,
           task_digest, payload_ref, actor_type, actor_id, target_repository,
           target_base_branch, target_environment, intent_kind, title, priority,
           acceptance_criteria_count, allow_repository_write, allow_test_deploy,
           allow_production_deploy, require_human_approval, created_at, updated_at
         ) VALUES (
           'task-older-terminal-backlog', 'manual', 'github-reconciler-test',
           'older-terminal-backlog', 'revision-1', ?,
           'r2://tasks/older-terminal-backlog', 'system',
           'github-reconciler-test', ?, 'main', 'none', 'bug',
           'Older terminal backlog', 'p1', 1, 0, 0, 0, 1, ?, ?
         )`,
      ).bind(`sha256:${'7'.repeat(64)}`, REPOSITORY, historicalCreatedAt, historicalCreatedAt),
      env.DB_CONTROL.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha,
           workflow_instance_id, state, version, created_at, updated_at
         ) VALUES (?, 'task-older-terminal-backlog', 'revision-1', ?, ?, ?,
                   'blocked', 2, ?, ?)`,
      ).bind(
        historicalRunId,
        `sha256:${'7'.repeat(64)}`,
        BASE_SHA,
        historicalRunId,
        historicalCreatedAt,
        historicalCreatedAt,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, github_run_id, github_head_sha, github_status, version,
           lease_generation, created_at, updated_at
         ) VALUES (?, ?, 1, 'analysis', 'lost', ?, ?, ?, '987654321', ?, 'requested',
                   2, 1, ?, ?)`,
      ).bind(
        historicalAttemptId,
        historicalRunId,
        BASE_SHA,
        REPOSITORY,
        `${EXECUTOR_REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
        GITHUB_HEAD_SHA,
        historicalCreatedAt,
        historicalCreatedAt,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         ) VALUES (?, ?, 1, 'implement', 'failed', ?, ?, ?, 2, 1, ?, ?)`,
      ).bind(
        rootAttemptId,
        RUN_ID,
        BASE_SHA,
        REPOSITORY,
        `${EXECUTOR_REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
        '2026-07-25T05:00:00.000Z',
        '2026-07-25T05:00:00.000Z',
      ),
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET recovered_from_attempt_id = ? WHERE attempt_id = ?`,
      ).bind(rootAttemptId, ATTEMPT_ID),
    ]);

    const client = new FakeRunClient(runFact({ conclusion: 'failure' }));
    expect(await new GitHubRunReconciler(env.DB_CONTROL, client).reconcileBatch(1)).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'applied' },
    ]);
    expect(client.calls).toEqual([
      { repository: EXECUTOR_REPOSITORY, githubRunId: GITHUB_RUN_ID },
    ]);
  });

  it('does not spend a GitHub request until an active attempt is eligible for stuck fencing', async () => {
    const now = new Date('2026-07-25T07:01:00.000Z');
    const client = new FakeRunClient(runFact());
    const reconciler = new GitHubRunReconciler(env.DB_CONTROL, client, {
      now: () => now,
    });

    expect(await reconciler.reconcileAtRiskBatch(5, 90)).toEqual([]);
    expect(client.calls).toEqual([]);

    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(
      '2026-07-25T07:00:59.000Z',
      '2026-07-25T06:59:29.000Z',
      '2026-07-25T06:59:29.000Z',
      ATTEMPT_ID,
    ).run();

    expect(await reconciler.reconcileAtRiskBatch(5, 90)).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'applied' },
    ]);
    expect(client.calls).toEqual([
      { repository: EXECUTOR_REPOSITORY, githubRunId: GITHUB_RUN_ID },
    ]);
  });

  it('projects current execution before an older active-run backlog entry', async () => {
    const now = new Date('2026-07-25T07:01:00.000Z');
    const oldRunId = 'run-old-active-backlog';
    const oldAttemptId = 'attempt-old-active-backlog';
    const oldGitHubRunId = '987654321';
    const oldUpdatedAt = '2026-07-20T06:00:00.000Z';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'executing' WHERE run_id = ?`,
      ).bind(RUN_ID),
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET mode = 'implement', lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ?`,
      ).bind(
        '2026-07-25T07:00:59.000Z',
        '2026-07-25T06:59:00.000Z',
        '2026-07-25T06:59:00.000Z',
        ATTEMPT_ID,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO tasks (
           task_id, source_system, tenant_key, source_task_key, task_revision,
           task_digest, payload_ref, actor_type, actor_id, target_repository,
           target_base_branch, target_environment, intent_kind, title, priority,
           acceptance_criteria_count, allow_repository_write, allow_test_deploy,
           allow_production_deploy, require_human_approval, created_at, updated_at
         ) VALUES (
           'task-old-active-backlog', 'manual', 'github-reconciler-test',
           'old-active-backlog', 'revision-1', ?, 'r2://tasks/old-active-backlog',
           'system', 'github-reconciler-test', ?, 'main', 'none', 'bug',
           'Old active backlog', 'p1', 1, 0, 0, 0, 1, ?, ?
         )`,
      ).bind(`sha256:${'7'.repeat(64)}`, REPOSITORY, oldUpdatedAt, oldUpdatedAt),
      env.DB_CONTROL.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha,
           workflow_instance_id, state, version, created_at, updated_at
         ) VALUES (?, 'task-old-active-backlog', 'revision-1', ?, ?, ?,
                   'planning', 2, ?, ?)`,
      ).bind(
        oldRunId,
        `sha256:${'7'.repeat(64)}`,
        BASE_SHA,
        oldRunId,
        oldUpdatedAt,
        oldUpdatedAt,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, github_run_id, github_head_sha, github_status,
           version, lease_generation, lease_expires_at, heartbeat_at,
           created_at, updated_at
         ) VALUES (?, ?, 1, 'analysis', 'running', ?, ?, ?, ?, ?, 'requested',
                   2, 1, ?, ?, ?, ?)`,
      ).bind(
        oldAttemptId,
        oldRunId,
        BASE_SHA,
        REPOSITORY,
        `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
        oldGitHubRunId,
        GITHUB_HEAD_SHA,
        oldUpdatedAt,
        oldUpdatedAt,
        oldUpdatedAt,
        oldUpdatedAt,
      ),
    ]);

    const client = new FakeRunClient(runFact());
    const reconciler = new GitHubRunReconciler(env.DB_CONTROL, client, {
      now: () => now,
    });
    expect(await reconciler.reconcileAtRiskBatch(1, 90)).toEqual([
      { attemptId: ATTEMPT_ID, disposition: 'applied' },
    ]);
    expect(client.calls).toEqual([
      { repository: EXECUTOR_REPOSITORY, githubRunId: GITHUB_RUN_ID },
    ]);
  });

  it('uses only a short installation token to read and strictly parse a workflow run', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new GitHubActionsApiClient(
      { getInstallationToken: async () => 'CANARY_SHORT_INSTALLATION_TOKEN' },
      {
        apiBaseUrl: 'https://api.github.test',
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get('authorization'),
          });
          return Response.json({
            id: Number(GITHUB_RUN_ID),
            event: 'workflow_dispatch',
            status: 'completed',
            conclusion: 'success',
            head_sha: GITHUB_HEAD_SHA,
            head_branch: 'main',
            path: `${WORKFLOW_PATH}@refs/heads/main`,
            display_title: `delivery-loop/${ATTEMPT_ID}`,
            run_attempt: 1,
            updated_at: '2026-07-25T07:00:00Z',
            repository: { full_name: EXECUTOR_REPOSITORY },
          });
        },
      },
    );
    expect(await client.getWorkflowRun(EXECUTOR_REPOSITORY, GITHUB_RUN_ID)).toEqual(runFact());
    expect(requests).toEqual([
      {
        url: `https://api.github.test/repos/${EXECUTOR_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
        authorization: 'Bearer CANARY_SHORT_INSTALLATION_TOKEN',
      },
    ]);
  });

  it('rejects mismatched API facts without exposing the token or response body', async () => {
    const tokenCanary = 'CANARY_RECONCILIATION_INSTALLATION_TOKEN';
    const bodyCanary = 'CANARY_UNTRUSTED_GITHUB_API_BODY';
    const client = new GitHubActionsApiClient(
      { getInstallationToken: async () => tokenCanary },
      {
        fetch: async () =>
          Response.json({
            id: Number(GITHUB_RUN_ID),
            event: 'workflow_dispatch',
            status: 'completed',
            conclusion: 'success',
            head_sha: GITHUB_HEAD_SHA,
            head_branch: 'main',
            path: `${WORKFLOW_PATH}@refs/heads/main`,
            display_title: `delivery-loop/${ATTEMPT_ID}`,
            run_attempt: 1,
            updated_at: '2026-07-25T07:00:00Z',
            repository: { full_name: 'attacker/other-repo' },
            untrusted: bodyCanary,
          }),
      },
    );
    const promise = client.getWorkflowRun(REPOSITORY, GITHUB_RUN_ID);
    await expect(promise).rejects.toThrow('GitHub workflow run response is invalid');
    await expect(promise).rejects.not.toThrow(tokenCanary);
    await expect(promise).rejects.not.toThrow(bodyCanary);
  });
});
