/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import {
  GitHubBaseObservationReconciler,
  type GitHubBaseExternalFactClient,
  type GitHubBaseObservationResult,
} from '../../src/reconciliation/github-base-observation-reconciler.js';
import { AnalysisAttemptContextStore } from '../../src/storage/analysis-attempt-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';

const RUN_ID = 'run-github-base-observation';
const TASK_ID = 'task-github-base-observation';
const PLAN_ID = 'plan-github-base-observation-v1';
const ANALYSIS_ATTEMPT_ID = 'attempt-github-base-analysis-v1';
const ACTIVE_ATTEMPT_ID = 'attempt-github-base-active-v1';
const REPOSITORY = 'example/delivery-target';
const BEFORE_SHA = 'a'.repeat(40);
const AFTER_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const REFERENCE_DIGEST = `sha256:${'d'.repeat(64)}`;
const COMPARISON_DIGEST = `sha256:${'e'.repeat(64)}`;
const NOW = '2026-07-25T23:00:00.000Z';

function taskEnvelope(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-github-base-observation',
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'github-base-observation',
      taskKey: TASK_ID,
      revision: 'revision-1',
    },
    actor: { type: 'system', id: 'github-base-observation' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'requirement',
      title: 'Replan when the trusted base advances',
      description: 'Observe a pure fast-forward before replacing the active Plan.',
      acceptanceCriteria: ['The replacement Plan binds the observed base head.'],
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

function fastForwardResult(): GitHubBaseObservationResult {
  return {
    disposition: 'fast_forward',
    fact: {
      schemaVersion: '1',
      repository: REPOSITORY,
      baseBranch: 'main',
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      relationship: 'ahead',
      aheadBy: 2,
      referenceDigest: REFERENCE_DIGEST,
      comparisonDigest: COMPARISON_DIGEST,
    },
  };
}

function nonFastForwardResult(): GitHubBaseObservationResult {
  return {
    disposition: 'non_fast_forward',
    fact: {
      schemaVersion: '1',
      repository: REPOSITORY,
      baseBranch: 'main',
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      relationship: 'diverged',
      aheadBy: 2,
      behindBy: 1,
      mergeBaseSha: 'f'.repeat(40),
      referenceDigest: REFERENCE_DIGEST,
      comparisonDigest: COMPARISON_DIGEST,
    },
  };
}

class FakeBaseClient implements GitHubBaseExternalFactClient {
  readonly calls: Array<{ repository: string; baseBranch: string; beforeSha: string }> = [];

  constructor(
    private readonly result: GitHubBaseObservationResult,
    private readonly beforeReturn?: () => Promise<void>,
  ) {}

  async observeBase(
    repository: string,
    baseBranch: string,
    beforeSha: string,
  ): Promise<GitHubBaseObservationResult> {
    this.calls.push({ repository, baseBranch, beforeSha });
    await this.beforeReturn?.();
    return structuredClone(this.result);
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM base_conflict_approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM github_base_conflicts'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM github_base_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
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
  const payloadKey = 'tasks/github-base-observation.json';
  await env.TASK_OBJECTS.put(payloadKey, JSON.stringify(task), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { taskDigest },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'github-base-observation', ?, 'revision-1', ?,
                 ?, 'system',
                 'github-base-observation', ?, 'main', 'test', 'requirement',
                 'Replan when the trusted base advances', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, taskDigest, `r2://${payloadKey}`, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 10, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BEFORE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BEFORE_SHA, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Execute the approved work on the original base.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BEFORE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, version, lease_generation,
         lease_token_digest, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, 3, 2, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(
      ACTIVE_ATTEMPT_ID,
      RUN_ID,
      BEFORE_SHA,
      REPOSITORY,
      PLAN_ID,
      `sha256:${'2'.repeat(64)}`,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest,
         tool_token_digest, lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-github-base-active', ?, ?, ?, ?, 2,
                 '["repo:read","checkpoint:write"]',
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      ACTIVE_ATTEMPT_ID,
      `sha256:${'3'.repeat(64)}`,
      `sha256:${'4'.repeat(64)}`,
      `sha256:${'5'.repeat(64)}`,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-github-base-v1', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BEFORE_SHA, `sha256:${'6'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('dispatch-github-base-old', ?, 'execution_dispatch',
                 'github_actions', ?, 'execution:github-base-old', 'pending', ?, ?)`,
    ).bind(RUN_ID, `d1://attempts/${ACTIVE_ATTEMPT_ID}`, NOW, NOW),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('GitHub base observation reconciliation', () => {
  it('converges 20 fast-forward observations to one immutable source fact and re-analysis', async () => {
    const client = new FakeBaseClient(fastForwardResult());
    const reconciler = new GitHubBaseObservationReconciler(env.DB_CONTROL, client, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun(RUN_ID)),
    );
    expect(results.filter((result) => result === 'replanning')).toHaveLength(1);
    expect(results.every((result) => ['replanning', 'duplicate', 'stale'].includes(result))).toBe(true);
    expect(client.calls).toHaveLength(20);

    const fact = fastForwardResult();
    if (fact.disposition !== 'fast_forward') throw new Error('invalid test fact');
    const sourceDigest = await canonicalSha256(fact.fact);
    const observation = await env.DB_CONTROL.prepare(
      `SELECT observation_id, run_id, expected_run_version, prior_plan_id,
              prior_plan_version, prior_plan_digest, repository, base_branch,
              before_sha, after_sha, relationship, ahead_by,
              reference_digest, comparison_digest, source_digest
       FROM github_base_observations`,
    ).first<Record<string, unknown>>();
    expect(observation).toMatchObject({
      run_id: RUN_ID,
      expected_run_version: 10,
      prior_plan_id: PLAN_ID,
      prior_plan_version: 1,
      prior_plan_digest: PLAN_DIGEST,
      repository: REPOSITORY,
      base_branch: 'main',
      before_sha: BEFORE_SHA,
      after_sha: AFTER_SHA,
      relationship: 'ahead',
      ahead_by: 2,
      reference_digest: REFERENCE_DIGEST,
      comparison_digest: COMPARISON_DIGEST,
      source_digest: sourceDigest,
    });
    const observationId = String(observation?.observation_id);
    expect(await env.DB_CONTROL.prepare(
      `SELECT source_ref, run_id, expected_run_version, prior_plan_id,
              source_kind, source_digest, requested_base_sha
       FROM plan_revision_source_facts`,
    ).first()).toEqual({
      source_ref: `d1://github-base-observations/${observationId}`,
      run_id: RUN_ID,
      expected_run_version: 10,
      prior_plan_id: PLAN_ID,
      source_kind: 'base_update',
      source_digest: sourceDigest,
      requested_base_sha: AFTER_SHA,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revisions',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE mode = 'analysis' AND status = 'pending'`,
    ).first()).toEqual({ count: 1 });
    const revision = await env.DB_CONTROL.prepare(
      'SELECT analysis_attempt_id FROM plan_revisions',
    ).first<{ analysis_attempt_id: string }>();
    if (revision === null) throw new Error('missing base re-analysis Attempt');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
                           lease_token_digest = ?, lease_expires_at = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(
      `sha256:${'9'.repeat(64)}`,
      '2099-01-01T00:00:00.000Z',
      NOW,
      revision.analysis_attempt_id,
    ).run();
    const revisionContext = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId: revision.analysis_attempt_id,
      runId: RUN_ID,
      mode: 'analysis',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['repo:read'],
    });
    expect(revisionContext.revisionSource).toEqual({
      schemaVersion: '1',
      kind: 'base_update',
      digest: sourceDigest,
      data: fact.fact,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'planning', version: 11, base_sha: AFTER_SHA });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({
      status: 'cancelled',
      version: 4,
      lease_generation: 3,
      lease_token_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM approval_invalidations',
    ).first()).toEqual({ count: 1 });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE github_base_observations SET after_sha = ? WHERE observation_id = ?`,
    ).bind('f'.repeat(40), observationId).run()).rejects.toThrow(
      'github_base_observation_is_immutable',
    );
  });

  it('blocks a non-fast-forward history with one immutable human-action projection', async () => {
    const client = new FakeBaseClient(nonFastForwardResult());
    const reconciler = new GitHubBaseObservationReconciler(env.DB_CONTROL, client, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun(RUN_ID)),
    );
    expect(results.every((result) => result === 'blocked')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT run_id, expected_run_version, prior_plan_id, repository, base_branch,
              before_sha, after_sha, relationship, blocker_reason,
              needed_human_input
       FROM github_base_conflicts`,
    ).first()).toEqual({
      run_id: RUN_ID,
      expected_run_version: 10,
      prior_plan_id: PLAN_ID,
      repository: REPOSITORY,
      base_branch: 'main',
      before_sha: BEFORE_SHA,
      after_sha: AFTER_SHA,
      relationship: 'diverged',
      blocker_reason: 'base_history_diverged',
      needed_human_input: 'manual_rebase',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'blocked', version: 11, base_sha: BEFORE_SHA });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM execution_plans WHERE plan_id = ?',
    ).bind(PLAN_ID).first()).toEqual({ status: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({
      status: 'cancelled',
      version: 4,
      lease_generation: 3,
      lease_token_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM base_conflict_approval_invalidations',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM invalidated_approvals',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox
       WHERE outbox_id = 'dispatch-github-base-old'`,
    ).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: 'base_history_diverged',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state FROM outbox WHERE kind = 'workflow_cancel'`,
    ).first()).toEqual({ delivery_state: 'pending' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });
    expect(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)).toMatchObject({
      run: {
        state: 'blocked',
        blocker: {
          kind: 'base_history_conflict',
          reason: 'base_history_diverged',
          repository: REPOSITORY,
          baseBranch: 'main',
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          relationship: 'diverged',
          neededHumanInput: {
            code: 'manual_rebase',
          },
        },
      },
    });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE github_base_conflicts SET after_sha = ?`,
    ).bind('1'.repeat(40)).run()).rejects.toThrow('github_base_conflict_is_immutable');
  });

  it('leaves zero source facts for unchanged, stale, and ineligible Runs', async () => {
    const unchanged = new GitHubBaseObservationReconciler(env.DB_CONTROL, new FakeBaseClient({
      disposition: 'unchanged',
      headSha: BEFORE_SHA,
    }));
    expect(await unchanged.reconcileBatch(10)).toEqual([
      { runId: RUN_ID, disposition: 'unchanged' },
    ]);

    const stale = new GitHubBaseObservationReconciler(
      env.DB_CONTROL,
      new FakeBaseClient(fastForwardResult(), async () => {
        await env.DB_CONTROL.prepare(
          'UPDATE runs SET version = version + 1 WHERE run_id = ?',
        ).bind(RUN_ID).run();
      }),
    );
    expect(await stale.reconcileRun(RUN_ID)).toBe('stale');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_base_observations',
    ).first()).toEqual({ count: 0 });

    await env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'merging' WHERE run_id = ?`,
    ).bind(RUN_ID).run();
    const ineligibleClient = new FakeBaseClient(fastForwardResult());
    expect(await new GitHubBaseObservationReconciler(
      env.DB_CONTROL,
      ineligibleClient,
    ).reconcileRun(RUN_ID)).toBe('not_found');
    expect(ineligibleClient.calls).toEqual([]);
  });
});
