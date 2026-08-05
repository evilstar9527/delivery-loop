/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeExecutionPlanDigest,
  type ExecutionPlanBodyV1,
  type ExecutionPlanV1,
} from '../../src/domain/plan.js';
import { ExecutionPlanStore } from '../../src/storage/execution-plan-store.js';
import { PlanRevisionStore } from '../../src/storage/plan-revision-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';

const RUN_ID = 'run-plan-revision';
const TASK_ID = 'task-plan-revision';
const OLD_PLAN_ID = 'plan-revision-v1';
const NEW_PLAN_ID = 'plan-revision-v2';
const OLD_ANALYSIS_ID = 'attempt-plan-revision-analysis-v1';
const ACTIVE_ATTEMPT_ID = 'attempt-plan-revision-active-v1';
const OLD_BASE_SHA = 'a'.repeat(40);
const NEW_BASE_SHA = 'b'.repeat(40);
const OLD_PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const SOURCE_DIGEST = `sha256:${'d'.repeat(64)}`;
const NOW = '2026-07-25T20:00:00.000Z';

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
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
       ) VALUES (?, 'manual', 'plan-revision', ?, 'revision-1', ?,
                 'r2://tasks/plan-revision.json', 'user', 'user-plan-revision',
                 'example/delivery-target', 'main', 'test', 'requirement',
                 'Revise an active execution plan', 'p1', 1, 1, 1, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, `sha256:${'1'.repeat(64)}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 10, ?, 1, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      TASK_ID,
      `sha256:${'1'.repeat(64)}`,
      OLD_BASE_SHA,
      RUN_ID,
      OLD_PLAN_ID,
      OLD_PLAN_DIGEST,
      NOW,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(OLD_ANALYSIS_ID, RUN_ID, OLD_BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Implement the original approved scope.', ?, ?)`,
    ).bind(OLD_PLAN_ID, RUN_ID, OLD_BASE_SHA, OLD_PLAN_DIGEST, OLD_ANALYSIS_ID, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'change-code', 'change', 'Change code',
                 'Implement the original scope.', 1, 0)`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'verify-code', 'verification', 'Verify code',
                 'Run the trusted verification.', 1, 1)`,
    ).bind(OLD_PLAN_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_sha, version, lease_generation,
         lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, 'change-code', 1, ?, 3, 2,
                 '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(ACTIVE_ATTEMPT_ID, RUN_ID, OLD_BASE_SHA, OLD_PLAN_ID, OLD_BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, 'change-code', 'in_progress', ?, 1, ?)`,
    ).bind(OLD_PLAN_ID, ACTIVE_ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'verify-code', 'pending', 0, ?)`,
    ).bind(OLD_PLAN_ID, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plan_assumptions (plan_id, position, assumption)
       VALUES (?, 0, 'The original base is current.')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_acceptance_criteria (
         plan_id, item_id, acceptance_criterion_index
       ) VALUES (?, 'change-code', 0)`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_acceptance_criteria (
         plan_id, item_id, acceptance_criterion_index
       ) VALUES (?, 'verify-code', 0)`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, 'change-code', 0, 'The original change is implemented.')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, 'verify-code', 0, 'Trusted verification passes.')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_dependencies (plan_id, item_id, depends_on_item_id)
       VALUES (?, 'verify-code', 'change-code')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'change-code', 'repo_write')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'verify-code', 'repo_read')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, 'verify-code', 'test:unit')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'change-code', 'commit')`,
    ).bind(OLD_PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'verify-code', 'test')`,
    ).bind(OLD_PLAN_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-plan-revision-v1', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, OLD_PLAN_ID, OLD_PLAN_DIGEST, OLD_BASE_SHA, `sha256:${'2'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest,
         tool_token_digest, lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-plan-revision-v1', ?, ?, ?, ?, 2,
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
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('dispatch-plan-revision-old', ?, 'execution_dispatch',
                 'github_actions', ?, 'execution:old-plan', 'pending', ?, ?)`,
    ).bind(RUN_ID, `d1://attempts/${ACTIVE_ATTEMPT_ID}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_revision_source_facts (
         source_ref, run_id, expected_run_version, prior_plan_id, prior_plan_version,
         prior_plan_digest, source_kind, source_digest,
         requested_base_sha, observed_at, created_at
       ) VALUES ('r2://supplemental-context/context-revision-1.json', ?, 10, ?, 1, ?,
                 'supplemental_context', ?, ?, ?, ?)`,
    ).bind(RUN_ID, OLD_PLAN_ID, OLD_PLAN_DIGEST, SOURCE_DIGEST, NEW_BASE_SHA, NOW, NOW),
  ]);
}

function revisedPlanBody(analysisAttemptId: string): ExecutionPlanBodyV1 {
  return {
    schemaVersion: '1',
    id: NEW_PLAN_ID,
    runId: RUN_ID,
    version: 2,
    taskRevision: 'revision-1',
    baseSha: NEW_BASE_SHA,
    createdByAttemptId: analysisAttemptId,
    objective: 'Implement the revised scope on the observed new base.',
    assumptions: ['The new base observation is trusted.'],
    evidenceRefs: ['d1://evidence/context-revision-1'],
    items: [
      {
        id: 'change-code',
        kind: 'change',
        title: 'Change code',
        objective: 'Implement the revised scope.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The revised change is implemented.'],
        verification: { evidenceKinds: ['commit'] },
        effects: ['repo_write', 'test_deploy'],
        dependsOn: [],
        required: true,
      },
      {
        id: 'verify-code',
        kind: 'verification',
        title: 'Verify code',
        objective: 'Run all trusted checks on the revised head.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['Targeted and required verification pass.'],
        verification: {
          commandRefs: ['test:unit', 'verify:all'],
          evidenceKinds: ['test'],
        },
        effects: ['repo_read'],
        dependsOn: ['change-code'],
        required: true,
      },
    ],
  };
}

function semanticallyUnchangedPlanBody(analysisAttemptId: string): ExecutionPlanBodyV1 {
  return {
    schemaVersion: '1',
    id: NEW_PLAN_ID,
    runId: RUN_ID,
    version: 2,
    taskRevision: 'revision-1',
    baseSha: OLD_BASE_SHA,
    createdByAttemptId: analysisAttemptId,
    objective: 'Implement the original approved scope.',
    assumptions: ['The original base is current.'],
    evidenceRefs: [],
    items: [
      {
        id: 'change-code',
        kind: 'change',
        title: 'Change code',
        objective: 'Implement the original scope.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The original change is implemented.'],
        verification: { evidenceKinds: ['commit'] },
        effects: ['repo_write'],
        dependsOn: [],
        required: true,
      },
      {
        id: 'verify-code',
        kind: 'verification',
        title: 'Verify code',
        objective: 'Run the trusted verification.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['Trusted verification passes.'],
        verification: { commandRefs: ['test:unit'], evidenceKinds: ['test'] },
        effects: ['repo_read'],
        dependsOn: ['change-code'],
        required: true,
      },
    ],
  };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('immutable ExecutionPlan revision', () => {
  it('converges re-analysis, invalidates old approval, and atomically activates changed v2', async () => {
    const store = new PlanRevisionStore(env.DB_CONTROL);
    const input = {
      runId: RUN_ID,
      expectedRunVersion: 10,
      activePlanVersion: 1,
      activePlanDigest: OLD_PLAN_DIGEST,
      sourceKind: 'supplemental_context' as const,
      sourceRef: 'r2://supplemental-context/context-revision-1.json',
      sourceDigest: SOURCE_DIGEST,
      requestedBaseSha: NEW_BASE_SHA,
    };
    const starts = await Promise.all(Array.from({ length: 20 }, async () =>
      await store.begin(input, new Date(NOW))));
    expect(starts.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(starts.map((result) => result.revisionId))).toHaveLength(1);
    const started = starts[0]!;
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha, active_plan_id FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({
      state: 'planning',
      version: 11,
      base_sha: NEW_BASE_SHA,
      active_plan_id: OLD_PLAN_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status, lease_generation FROM attempts WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({ status: 'cancelled', lease_generation: 3 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first<{ revoked_at: string | null }>()).toMatchObject({
      revoked_at: NOW,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT approval_id, reason FROM approval_invalidations WHERE revision_id = ?`,
    ).bind(started.revisionId).first()).toEqual({
      approval_id: 'approval-plan-revision-v1',
      reason: 'plan_revision_started',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT kind, delivery_state, payload_ref FROM outbox ORDER BY kind`,
    ).all()).toMatchObject({
      results: [
        {
          kind: 'analysis_dispatch',
          delivery_state: 'pending',
          payload_ref: `d1://attempts/${started.analysisAttemptId}`,
        },
        {
          kind: 'execution_dispatch',
          delivery_state: 'settled',
          payload_ref: `d1://attempts/${ACTIVE_ATTEMPT_ID}`,
        },
      ],
    });

    const body = revisedPlanBody(started.analysisAttemptId);
    const proposal: ExecutionPlanV1 = {
      ...body,
      digest: await computeExecutionPlanDigest(body),
      status: 'proposed',
    };
    const plan = await new ExecutionPlanStore(env.DB_CONTROL).saveValidatedProposal(
      proposal,
      {
        runId: RUN_ID,
        taskRevision: 'revision-1',
        baseSha: NEW_BASE_SHA,
        expectedVersion: 2,
        acceptanceCriteriaCount: 1,
        allowedCommandRefs: ['test:unit', 'verify:all'],
        verificationCommandRefs: ['test:unit', 'verify:all'],
        allowedEffects: ['repo_read', 'repo_write', 'test_deploy'],
        requiresRepositoryChange: false,
      },
      NOW,
    );
    const activated = await store.activate({
      revisionId: started.revisionId,
      expectedRunVersion: 11,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: plan.digest,
    }, new Date(NOW));
    expect(activated).toMatchObject({
      created: true,
      planId: NEW_PLAN_ID,
      planVersion: 2,
      runVersion: 12,
      changes: { body: true, base: true, effects: true },
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT plan_id, status, objective FROM execution_plans ORDER BY plan_version`,
    ).all()).toMatchObject({
      results: [
        {
          plan_id: OLD_PLAN_ID,
          status: 'superseded',
          objective: 'Implement the original approved scope.',
        },
        {
          plan_id: NEW_PLAN_ID,
          status: 'active',
          objective: 'Implement the revised scope on the observed new base.',
        },
      ],
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version, base_sha, active_plan_id, active_plan_version,
              active_plan_digest FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      state: 'awaiting_approval',
      version: 12,
      base_sha: NEW_BASE_SHA,
      active_plan_id: NEW_PLAN_ID,
      active_plan_version: 2,
      active_plan_digest: plan.digest,
    });
    expect(await store.activate({
      revisionId: started.revisionId,
      expectedRunVersion: 11,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: plan.digest,
    }, new Date(NOW))).toMatchObject({ created: false, runVersion: 12 });
    expect(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)).toMatchObject({
      run: {
        planRevision: {
          id: started.revisionId,
          status: 'activated',
          sourceKind: 'supplemental_context',
          sourceDigest: SOURCE_DIGEST,
          priorPlan: { id: OLD_PLAN_ID, version: 1, baseSha: OLD_BASE_SHA },
          newPlan: { id: NEW_PLAN_ID, version: 2, digest: plan.digest },
          changes: { body: true, base: true, effects: true },
        },
      },
    });
  });

  it('blocks in-place mutation of active Plan identity, body, Item, and effects', async () => {
    await expect(env.DB_CONTROL.prepare(
      `UPDATE execution_plans SET objective = 'mutated in place' WHERE plan_id = ?`,
    ).bind(OLD_PLAN_ID).run()).rejects.toThrow('execution_plan_body_is_immutable');
    await expect(env.DB_CONTROL.prepare(
      `UPDATE plan_items SET objective = 'mutated Item' WHERE plan_id = ? AND item_id = 'change-code'`,
    ).bind(OLD_PLAN_ID).run()).rejects.toThrow('plan_item_is_immutable');
    await expect(env.DB_CONTROL.prepare(
      `UPDATE plan_item_effects SET effect = 'production_deploy'
       WHERE plan_id = ? AND item_id = 'change-code' AND effect = 'repo_write'`,
    ).bind(OLD_PLAN_ID).run()).rejects.toThrow('plan_item_effect_is_immutable');
    expect(await env.DB_CONTROL.prepare(
      `SELECT objective FROM execution_plans WHERE plan_id = ?`,
    ).bind(OLD_PLAN_ID).first()).toEqual({ objective: 'Implement the original approved scope.' });
  });

  it('rejects caller-authored revision references that have no immutable source fact', async () => {
    await env.DB_CONTROL.prepare(
      `DELETE FROM plan_revision_source_facts WHERE source_ref = ?`,
    ).bind('r2://supplemental-context/context-revision-1.json').run();
    await expect(new PlanRevisionStore(env.DB_CONTROL).begin({
      runId: RUN_ID,
      expectedRunVersion: 10,
      activePlanVersion: 1,
      activePlanDigest: OLD_PLAN_DIGEST,
      sourceKind: 'supplemental_context',
      sourceRef: 'r2://supplemental-context/forged.json',
      sourceDigest: SOURCE_DIGEST,
      requestedBaseSha: NEW_BASE_SHA,
    }, new Date(NOW))).rejects.toMatchObject({ code: 'state_conflict' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({
      state: 'executing',
      version: 10,
      base_sha: OLD_BASE_SHA,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 2 });
  });

  it('rejects no-op version churn and restores a recoverable approval gate on the old Plan', async () => {
    await env.DB_CONTROL.prepare(
      `DELETE FROM plan_revision_source_facts`,
    ).run();
    const sourceRef = 'r2://supplemental-context/no-op-context.json';
    await env.DB_CONTROL.prepare(
      `INSERT INTO plan_revision_source_facts (
         source_ref, run_id, expected_run_version, prior_plan_id, prior_plan_version,
         prior_plan_digest, source_kind, source_digest,
         requested_base_sha, observed_at, created_at
       ) VALUES (?, ?, 10, ?, 1, ?, 'supplemental_context', ?, ?, ?, ?)`,
    ).bind(
      sourceRef,
      RUN_ID,
      OLD_PLAN_ID,
      OLD_PLAN_DIGEST,
      SOURCE_DIGEST,
      OLD_BASE_SHA,
      NOW,
      NOW,
    ).run();
    const store = new PlanRevisionStore(env.DB_CONTROL);
    const started = await store.begin({
      runId: RUN_ID,
      expectedRunVersion: 10,
      activePlanVersion: 1,
      activePlanDigest: OLD_PLAN_DIGEST,
      sourceKind: 'supplemental_context',
      sourceRef,
      sourceDigest: SOURCE_DIGEST,
      requestedBaseSha: OLD_BASE_SHA,
    }, new Date(NOW));
    const body = semanticallyUnchangedPlanBody(started.analysisAttemptId);
    const proposal: ExecutionPlanV1 = {
      ...body,
      digest: await computeExecutionPlanDigest(body),
      status: 'proposed',
    };
    const plan = await new ExecutionPlanStore(env.DB_CONTROL).saveValidatedProposal(
      proposal,
      {
        runId: RUN_ID,
        taskRevision: 'revision-1',
        baseSha: OLD_BASE_SHA,
        expectedVersion: 2,
        acceptanceCriteriaCount: 1,
        allowedCommandRefs: ['test:unit'],
        verificationCommandRefs: ['test:unit'],
        allowedEffects: ['repo_read', 'repo_write'],
        requiresRepositoryChange: false,
      },
      NOW,
    );
    await expect(store.activate({
      revisionId: started.revisionId,
      expectedRunVersion: 11,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: plan.digest,
    }, new Date(NOW))).rejects.toMatchObject({ code: 'no_change' });
    await expect(store.activate({
      revisionId: started.revisionId,
      expectedRunVersion: 11,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: plan.digest,
    }, new Date(NOW))).rejects.toMatchObject({ code: 'no_change' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version, base_sha, active_plan_id FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      state: 'awaiting_approval',
      version: 12,
      base_sha: OLD_BASE_SHA,
      active_plan_id: OLD_PLAN_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT plan_id, status FROM execution_plans ORDER BY plan_version`,
    ).all()).toMatchObject({
      results: [
        { plan_id: OLD_PLAN_ID, status: 'active' },
        { plan_id: NEW_PLAN_ID, status: 'superseded' },
      ],
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, body_changed, base_changed, effects_changed
       FROM plan_revisions WHERE revision_id = ?`,
    ).bind(started.revisionId).first()).toEqual({
      status: 'rejected',
      body_changed: 0,
      base_changed: 0,
      effects_changed: 0,
    });
  });
});
