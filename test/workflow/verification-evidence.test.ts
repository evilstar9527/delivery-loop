/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { attemptApi } from '../../src/http/attempt-api.js';
import {
  VerificationEvidenceError,
  VerificationEvidenceStore,
} from '../../src/storage/verification-evidence-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import type { RunnerAuthorization } from '../../src/storage/runner-attempt-store.js';

const NOW = new Date('2026-07-25T13:00:00.000Z');
const RUN_ID = 'run-verification-evidence';
const ATTEMPT_ID = 'attempt-verification-evidence';
const PLAN_ID = 'plan-verification-evidence';
const ITEM_ID = 'verify';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const POLICY_DIGEST = `sha256:${'d'.repeat(64)}`;
const RAW_TOKEN = 'verification-evidence-runner-token';

const AUTHORIZATION: RunnerAuthorization = {
  attemptId: ATTEMPT_ID,
  runId: RUN_ID,
  mode: 'implement',
  status: 'running',
  version: 2,
  leaseGeneration: 1,
  leaseExpiresAt: '2026-07-25T13:10:00.000Z',
  scopes: ['repo:read', 'checkpoint:write'],
};

const MANIFEST = {
  schemaVersion: '1' as const,
  headSha: HEAD_SHA,
  policyDigest: POLICY_DIGEST,
  targetedCommandRefs: ['test:unit'],
  requiredVerifyCommandRefs: ['verify:all'],
};

function result(position: number, exitCode = 0) {
  return {
    schemaVersion: '1' as const,
    position,
    phase: position === 0 ? 'targeted' as const : 'required_verify' as const,
    commandRef: position === 0 ? 'test:unit' : 'verify:all',
    exitCode,
    durationMs: position === 0 ? 125 : 450,
    headSha: HEAD_SHA,
  };
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
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
         'task-verification-evidence', 'manual', 'verification', 'verification', 'rev-1',
         ?, 'r2://tasks/verification', 'system', 'verification',
         'example/delivery-target', 'main', 'test', 'bug', 'Verification Evidence',
         'p1', 1, 1, 0, 0, 1, ?, ?
       )`,
    ).bind(taskDigest, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-verification-evidence', 'rev-1', ?, ?, ?, 'executing', 4,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id, claimed_progress_version,
         head_branch, head_sha, version, lease_generation, lease_token_digest,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, ?, 1, 'agent/task/attempt', ?, 2, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      PLAN_ID,
      ITEM_ID,
      HEAD_SHA,
      await canonicalSha256('verification-lease'),
      AUTHORIZATION.leaseExpiresAt,
      now,
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', ?, 'Verify the change.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ATTEMPT_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-verification-evidence', ?, ?, ?, 1, ?, ?, ?)`,
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
       VALUES (?, ?, 'verification', 'Verify', 'Run targeted and required checks.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'test:unit')`,
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
       VALUES (?, ?, 'repo_read')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, now),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('verification Evidence store', () => {
  it('persists targeted before required verify with exit, duration, and exact head SHA', async () => {
    const store = new VerificationEvidenceStore(env.DB_CONTROL);
    const suite = await store.start(AUTHORIZATION, MANIFEST, NOW);
    expect(suite).toMatchObject({
      created: true,
      status: 'running',
      commands: [
        { position: 0, phase: 'targeted', commandRef: 'test:unit' },
        { position: 1, phase: 'required_verify', commandRef: 'verify:all' },
      ],
    });
    const targeted = await store.record(AUTHORIZATION, suite.suiteId, result(0), NOW);
    expect(targeted).toMatchObject({ created: true, suiteStatus: 'running' });
    const required = await store.record(AUTHORIZATION, suite.suiteId, result(1), NOW);
    expect(required).toMatchObject({ created: true, suiteStatus: 'completed' });

    const rows = await env.DB_CONTROL.prepare(
      `SELECT evidence.kind, evidence.status, evidence.command_ref,
              evidence.exit_code, evidence.duration_ms, evidence.sha,
              evidence.summary, evidence.verification_status
       FROM evidence
       JOIN verification_suite_commands
         ON verification_suite_commands.evidence_id = evidence.evidence_id
       WHERE evidence.attempt_id = ?
       ORDER BY verification_suite_commands.position`,
    ).bind(ATTEMPT_ID).all<Record<string, unknown>>();
    expect(rows.results).toEqual([
      {
        kind: 'test',
        status: 'passed',
        command_ref: 'test:unit',
        exit_code: 0,
        duration_ms: 125,
        sha: HEAD_SHA,
        summary: 'targeted verification command passed',
        verification_status: 'unverified',
      },
      {
        kind: 'test',
        status: 'passed',
        command_ref: 'verify:all',
        exit_code: 0,
        duration_ms: 450,
        sha: HEAD_SHA,
        summary: 'required verification command passed',
        verification_status: 'unverified',
      },
    ]);
    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: required.evidenceId,
        commandRef: 'verify:all',
        exitCode: 0,
        durationMs: 450,
        sha: HEAD_SHA,
      }),
    ]));
    await expect(store.record(AUTHORIZATION, suite.suiteId, result(1), NOW)).resolves.toMatchObject({
      evidenceId: required.evidenceId,
      created: false,
      suiteStatus: 'completed',
    });
    await expect(store.record(
      { ...AUTHORIZATION, attemptId: 'attempt-other' },
      suite.suiteId,
      result(1),
      NOW,
    )).rejects.toMatchObject({ code: 'result_conflict' });
  });

  it('rejects required verify before targeted and stops a failed suite', async () => {
    const store = new VerificationEvidenceStore(env.DB_CONTROL);
    const suite = await store.start(AUTHORIZATION, MANIFEST, NOW);
    await expect(store.record(AUTHORIZATION, suite.suiteId, result(1), NOW)).rejects
      .toBeInstanceOf(VerificationEvidenceError);
    const failed = await store.record(AUTHORIZATION, suite.suiteId, result(0, 9), NOW);
    expect(failed).toMatchObject({ suiteStatus: 'failed' });
    await expect(store.record(AUTHORIZATION, suite.suiteId, result(1), NOW)).rejects
      .toMatchObject({ code: 'state_conflict' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM evidence WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).first()).toEqual({ count: 1 });
  });

  it('rejects a manifest not exactly bound to the Plan Item or current head', async () => {
    const store = new VerificationEvidenceStore(env.DB_CONTROL);
    for (const manifest of [
      { ...MANIFEST, headSha: '0'.repeat(40) },
      { ...MANIFEST, targetedCommandRefs: ['test:missing'] },
      { ...MANIFEST, requiredVerifyCommandRefs: [] },
    ]) {
      await expect(store.start(AUTHORIZATION, manifest, NOW)).rejects.toMatchObject({
        name: VerificationEvidenceError.name,
      });
    }
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM verification_suites',
    ).first()).toEqual({ count: 0 });
  });

  it('enforces authenticated strict HTTP reports and never accepts stderr/summary text', async () => {
    const api = attemptApi({ now: () => NOW });
    const headers = {
      authorization: `Bearer ${RAW_TOKEN}`,
      'content-type': 'application/json',
    };
    const start = await api.fetch(new Request(
      `https://delivery-loop.test/v1/attempts/${ATTEMPT_ID}/verifications`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedVersion: 2,
          leaseGeneration: 1,
          manifest: MANIFEST,
        }),
      },
    ), env);
    expect(start.status).toBe(201);
    const suite = await start.json() as { suiteId: string };
    const injected = await api.fetch(new Request(
      `https://delivery-loop.test/v1/attempts/${ATTEMPT_ID}/verifications/${suite.suiteId}/results`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedVersion: 2,
          leaseGeneration: 1,
          result: { ...result(0), stderr: 'secret output', summary: 'Agent says passed' },
        }),
      },
    ), env);
    expect(injected.status).toBe(400);
    const accepted = await api.fetch(new Request(
      `https://delivery-loop.test/v1/attempts/${ATTEMPT_ID}/verifications/${suite.suiteId}/results`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedVersion: 2,
          leaseGeneration: 1,
          result: result(0),
        }),
      },
    ), env);
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get('cache-control')).toBe('no-store');

    const unauthenticated = await api.fetch(new Request(
      `https://delivery-loop.test/v1/attempts/${ATTEMPT_ID}/verifications`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: 2,
          leaseGeneration: 1,
          manifest: MANIFEST,
        }),
      },
    ), env);
    expect(unauthenticated.status).toBe(401);
  });
});
