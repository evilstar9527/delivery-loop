/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  PlanItemEvidenceVerificationError,
  PlanItemEvidenceVerifier,
} from '../../src/storage/plan-item-evidence-verifier.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import { VerificationEvidenceStore } from '../../src/storage/verification-evidence-store.js';
import type { RunnerAuthorization } from '../../src/storage/runner-attempt-store.js';

const NOW = new Date('2026-07-25T14:00:00.000Z');
const VERIFIED_AT = new Date('2026-07-25T14:01:00.000Z');
const RUN_ID = 'run-plan-item-verifier';
const ATTEMPT_ID = 'attempt-plan-item-verifier';
const PLAN_ID = 'plan-plan-item-verifier';
const ITEM_ID = 'verify';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const POLICY_DIGEST = `sha256:${'d'.repeat(64)}`;
const RAW_TOKEN = 'plan-item-verifier-runner-token';
const SERVICE_TOKEN = 'test-task-intake-token';

const AUTHORIZATION: RunnerAuthorization = {
  attemptId: ATTEMPT_ID,
  runId: RUN_ID,
  mode: 'implement',
  status: 'running',
  version: 2,
  leaseGeneration: 1,
  leaseExpiresAt: '2099-07-25T14:10:00.000Z',
  scopes: ['repo:read', 'checkpoint:write'],
};

const MANIFEST = {
  schemaVersion: '1' as const,
  headSha: HEAD_SHA,
  policyDigest: POLICY_DIGEST,
  targetedCommandRefs: ['test:unit'],
  requiredVerifyCommandRefs: ['verify:all'],
};

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
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
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seed(): Promise<void> {
  const now = NOW.toISOString();
  const taskDigest = `sha256:${'f'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-plan-item-verifier', 'manual', 'verifier', 'verifier', 'rev-1',
         ?, 'r2://tasks/verifier', 'system', 'verifier', 'example/delivery-target',
         'main', 'test', 'bug', 'Plan Item verifier', 'p1', 1, 1, 0, 0, 1, ?, ?
       )`,
    ).bind(taskDigest, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-plan-item-verifier', 'rev-1', ?, ?, ?, 'executing', 4,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-plan-item-analysis', ?, 1, 'analysis', 'completed', ?,
                 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', 'attempt-plan-item-analysis',
                 'Verify every doneWhen with exact Evidence.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id, claimed_progress_version,
         head_branch, head_sha, version, lease_generation, lease_token_digest,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, ?, 1, 'agent/task/attempt', ?, 2, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      PLAN_ID,
      ITEM_ID,
      HEAD_SHA,
      await canonicalSha256('verifier-lease'),
      AUTHORIZATION.leaseExpiresAt,
      now,
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-plan-item-verifier', ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'1'.repeat(64)}`,
      await canonicalSha256(RAW_TOKEN),
      JSON.stringify(AUTHORIZATION.scopes),
      AUTHORIZATION.leaseExpiresAt,
      now,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'verification', 'Verify', 'Verify both exit and repository state.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'The targeted behavior passes.')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 1, 'The required repository verification passes.')`,
    ).bind(PLAN_ID, ITEM_ID),
    ...['test:unit', 'verify:all'].map((commandRef) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
         VALUES (?, ?, ?)`,
      ).bind(PLAN_ID, ITEM_ID, commandRef),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, ?, 'test')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_read')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, now),
  ]);
}

async function createEvidence(): Promise<[string, string]> {
  const evidenceStore = new VerificationEvidenceStore(env.DB_CONTROL);
  const suite = await evidenceStore.start(AUTHORIZATION, MANIFEST, NOW);
  const targeted = await evidenceStore.record(AUTHORIZATION, suite.suiteId, {
    schemaVersion: '1',
    position: 0,
    phase: 'targeted',
    commandRef: 'test:unit',
    exitCode: 0,
    durationMs: 100,
    headSha: HEAD_SHA,
  }, NOW);
  const required = await evidenceStore.record(AUTHORIZATION, suite.suiteId, {
    schemaVersion: '1',
    position: 1,
    phase: 'required_verify',
    commandRef: 'verify:all',
    exitCode: 0,
    durationMs: 200,
    headSha: HEAD_SHA,
  }, NOW);
  return [targeted.evidenceId, required.evidenceId];
}

function verificationInput(evidenceIds: readonly string[]) {
  return {
    runId: RUN_ID,
    expectedRunVersion: 4,
    planVersion: 1,
    planItemId: ITEM_ID,
    expectedProgressVersion: 2,
    attemptId: ATTEMPT_ID,
    expectedAttemptVersion: 2,
    leaseGeneration: 1,
    headSha: HEAD_SHA,
    doneWhenEvidence: [
      { position: 0, evidenceIds },
      { position: 1, evidenceIds },
    ],
  };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('required Plan Item Evidence verifier', () => {
  it('maps every doneWhen to verified same-head Evidence and is idempotent', async () => {
    const evidenceIds = await createEvidence();
    const input = verificationInput(evidenceIds);
    const verifier = new PlanItemEvidenceVerifier(env.DB_CONTROL);
    const verified = await verifier.verify(input, VERIFIED_AT);
    expect(verified).toMatchObject({
      created: true,
      runId: RUN_ID,
      planId: PLAN_ID,
      planVersion: 1,
      planItemId: ITEM_ID,
      attemptId: ATTEMPT_ID,
      headSha: HEAD_SHA,
      status: 'passed',
      progressVersion: 3,
      evidenceIds,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'passed',
      active_attempt_id: null,
      version: 3,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest, lease_expires_at
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'completed',
      version: 3,
      lease_generation: 2,
      lease_token_digest: null,
      lease_expires_at: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM plan_item_done_when_evidence
       WHERE verification_id = ?`,
    ).bind(verified.verificationId).first()).toEqual({ count: 4 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE evidence_id IN (?, ?) AND verification_status = 'verified'`,
    ).bind(...evidenceIds).first()).toEqual({ count: 2 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT revoked_at FROM attempt_tokens WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({ revoked_at: VERIFIED_AT.toISOString() });

    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.items[0]).toMatchObject({
      id: ITEM_ID,
      status: 'passed',
      verificationDecision: {
        id: verified.verificationId,
        headSha: HEAD_SHA,
        evidenceIds,
        doneWhenEvidence: [
          { position: 0, evidenceIds },
          { position: 1, evidenceIds },
        ],
      },
    });
    await expect(verifier.verify(input, VERIFIED_AT)).resolves.toMatchObject({
      verificationId: verified.verificationId,
      created: false,
      status: 'passed',
    });
  });

  it('rejects missing doneWhen coverage, failed Evidence, and old SHA without partial verification', async () => {
    const cases: Array<(ids: [string, string]) => Promise<unknown> | unknown> = [
      (ids) => ({ ...verificationInput(ids), doneWhenEvidence: [
        { position: 0, evidenceIds: ids },
      ] }),
      async (ids) => {
        await env.DB_CONTROL.prepare(
          `UPDATE evidence SET status = 'failed' WHERE evidence_id = ?`,
        ).bind(ids[0]).run();
        return verificationInput(ids);
      },
      async (ids) => {
        await env.DB_CONTROL.prepare(
          `UPDATE evidence SET sha = ? WHERE evidence_id = ?`,
        ).bind(BASE_SHA, ids[1]).run();
        return verificationInput(ids);
      },
      async (ids) => {
        await env.DB_CONTROL.prepare(
          `UPDATE evidence SET attempt_id = 'attempt-plan-item-analysis'
           WHERE evidence_id = ?`,
        ).bind(ids[0]).run();
        return verificationInput(ids);
      },
    ];
    for (const mutate of cases) {
      await reset();
      await seed();
      const ids = await createEvidence();
      const input = await mutate(ids);
      await expect(
        new PlanItemEvidenceVerifier(env.DB_CONTROL).verify(input, VERIFIED_AT),
      ).rejects.toBeInstanceOf(PlanItemEvidenceVerificationError);
      expect(await env.DB_CONTROL.prepare(
        `SELECT status, version FROM plan_item_progress WHERE plan_id = ? AND item_id = ?`,
      ).bind(PLAN_ID, ITEM_ID).first()).toEqual({ status: 'in_progress', version: 2 });
      expect(await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM plan_item_verifications`,
      ).first()).toEqual({ count: 0 });
    }
  });

  it('requires every declared command and rejects direct passed/skipped mutations', async () => {
    const ids = await createEvidence();
    const input = verificationInput(ids);
    input.doneWhenEvidence[1] = { position: 1, evidenceIds: [ids[0]] };
    await expect(
      new PlanItemEvidenceVerifier(env.DB_CONTROL).verify(input, VERIFIED_AT),
    ).rejects.toMatchObject({ code: 'evidence_incomplete' });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress SET status = 'passed'
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).run()).rejects.toThrow(
      'required_plan_item_requires_verified_evidence',
    );
    await expect(env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress SET status = 'skipped'
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).run()).rejects.toThrow(
      'protected_plan_item_cannot_be_skipped',
    );
  });

  it('exposes only a service-authenticated strict control-plane verification route', async () => {
    const evidenceIds = await createEvidence();
    const body = {
      expectedRunVersion: 4,
      planVersion: 1,
      expectedProgressVersion: 2,
      attemptId: ATTEMPT_ID,
      expectedAttemptVersion: 2,
      leaseGeneration: 1,
      headSha: HEAD_SHA,
      doneWhenEvidence: verificationInput(evidenceIds).doneWhenEvidence,
    };
    const url = `https://delivery-loop.test/v1/runs/${RUN_ID}/items/${ITEM_ID}/verify`;
    const agent = await SELF.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(agent.status).toBe(401);
    const forged = await SELF.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, status: 'passed', verified: true }),
    });
    expect(forged.status).toBe(400);
    const accepted = await SELF.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      created: true,
      status: 'passed',
      planItemId: ITEM_ID,
      headSha: HEAD_SHA,
    });
  });
});
