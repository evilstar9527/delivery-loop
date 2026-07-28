/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  computeProtectedPathDiffDigest,
  type ProtectedPathChangeReportV1,
} from '../../src/domain/protected-path-change.js';
import { attemptApi } from '../../src/http/attempt-api.js';
import {
  WorkflowOutboxProcessor,
  type WorkflowEffectClient,
} from '../../src/outbox/workflow-outbox.js';
import {
  ProtectedPathApprovalError,
  ProtectedPathApprovalStore,
} from '../../src/storage/protected-path-approval-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import type { RunnerAuthorization } from '../../src/storage/runner-attempt-store.js';

const NOW = new Date('2026-07-25T12:00:00.000Z');
const RUN_ID = 'run-protected-path';
const ATTEMPT_ID = 'attempt-protected-path';
const PLAN_ID = 'plan-protected-path';
const ITEM_ID = 'change';
const BASE_SHA = 'a'.repeat(40);
const STAGED_TREE_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const POLICY_DIGEST = `sha256:${'d'.repeat(64)}`;
const DIFF_DIGEST = await computeProtectedPathDiffDigest(BASE_SHA, STAGED_TREE_SHA);
const RAW_RUNNER_TOKEN = 'protected-path-runner-token';
const SECRET_CANARY = 'must-never-enter-protected-path-projection';

const AUTHORIZATION: RunnerAuthorization = {
  attemptId: ATTEMPT_ID,
  runId: RUN_ID,
  mode: 'implement',
  status: 'running',
  version: 2,
  leaseGeneration: 1,
  leaseExpiresAt: '2026-07-25T12:10:00.000Z',
  scopes: ['repo:read', 'checkpoint:write'],
};

const REPORT: ProtectedPathChangeReportV1 = {
  schemaVersion: '1',
  baseSha: BASE_SHA,
  stagedTreeSha: STAGED_TREE_SHA,
  policyDigest: POLICY_DIGEST,
  diffDigest: DIFF_DIGEST,
  totalChangedFiles: 2,
  protectedChanges: [
    {
      path: '.env.production',
      changeType: 'added',
      additions: 1,
      deletions: 0,
    },
    {
      path: '.github/workflows/deploy.yml',
      changeType: 'modified',
      additions: 3,
      deletions: 1,
    },
  ],
};

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM protected_path_change_entries'),
    env.DB_CONTROL.prepare('DELETE FROM protected_path_change_gates'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
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
         'task-protected-path', 'manual', 'protected-path', 'protected-path', 'rev-1',
         ?, 'r2://tasks/protected-path', 'system', 'protected-path',
         'example/delivery-target', 'main', 'test', 'bug', 'Protected path gate',
         'p1', 1, 1, 0, 0, 1, ?, ?
       )`,
    ).bind(taskDigest, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-protected-path', 'rev-1', ?, ?, ?, 'executing', 4,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, version, lease_generation, lease_token_digest,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, ?, 1, 2, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      PLAN_ID,
      ITEM_ID,
      await canonicalSha256('lease-token'),
      AUTHORIZATION.leaseExpiresAt,
      now,
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', ?, 'Change code.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ATTEMPT_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-protected-path', ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'1'.repeat(64)}`,
      await canonicalSha256(RAW_RUNNER_TOKEN),
      JSON.stringify(AUTHORIZATION.scopes),
      AUTHORIZATION.leaseExpiresAt,
      now,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'change', 'Apply change', 'Apply the repository change.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-repo-write', ?, 'rev-1', ?, 1, ?, ?, 'repo_write',
                 'user:approver', 'approve', ?, '2026-07-25T12:05:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'2'.repeat(64)}`, now),
  ]);
  await env.DB_CONTROL.prepare(
    `INSERT INTO github_write_credentials (
       credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
       approval_id, repository, lease_generation, status, token_digest,
       token_ciphertext, token_iv, github_expires_at, authorization_expires_at,
       created_at, updated_at
     ) VALUES ('credential-protected-path', ?, ?, ?, 1, ?, 'approval-repo-write',
               'example/delivery-target', 1, 'active', ?, 'ciphertext', 'iv',
               '2026-07-25T13:00:00.000Z', '2026-07-25T12:05:00.000Z', ?, ?)`,
  ).bind(
    RUN_ID,
    ATTEMPT_ID,
    PLAN_ID,
    ITEM_ID,
    `sha256:${'3'.repeat(64)}`,
    now,
    now,
  ).run();
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('protected path approval control-plane gate', () => {
  it('atomically pauses execution, revokes leases, and exposes only the safe diff summary', async () => {
    const store = new ProtectedPathApprovalStore(env.DB_CONTROL);
    const result = await store.request(AUTHORIZATION, REPORT, NOW);
    expect(result).toMatchObject({
      created: true,
      state: 'awaiting_approval',
      runVersion: 5,
      report: REPORT,
    });

    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 5 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest, lease_expires_at
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'cancelled',
      version: 3,
      lease_generation: 2,
      lease_token_digest: null,
      lease_expires_at: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).first()).toEqual({ revoked_at: NOW.toISOString() });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, active_attempt_id, protected_path_gate_id
       FROM plan_item_progress WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'in_progress',
      version: 3,
      active_attempt_id: ATTEMPT_ID,
      protected_path_gate_id: result.gateId,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM github_write_credentials WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).first()).toEqual({ status: 'revocation_pending' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT kind, destination, payload_ref, delivery_state
       FROM outbox WHERE run_id = ? AND kind = 'workflow_pause'`,
    ).bind(RUN_ID).first()).toEqual({
      kind: 'workflow_pause',
      destination: 'cloudflare_workflows',
      payload_ref: `d1://protected-path-gates/${result.gateId}`,
      delivery_state: 'pending',
    });

    const terminatedRuns: string[] = [];
    const effects: WorkflowEffectClient = {
      ensureRun: async () => 'created',
      terminateRun: async (runId) => {
        terminatedRuns.push(runId);
      },
      sendEvent: async () => undefined,
    };
    await expect(
      new WorkflowOutboxProcessor(env.DB_CONTROL, effects).deliver(
        `workflow-pause-${result.gateId}`,
      ),
    ).resolves.toBe('settled');
    expect(terminatedRuns).toEqual([RUN_ID]);

    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.run).toMatchObject({
      state: 'awaiting_approval',
      approvalRequest: {
        id: result.gateId,
        kind: 'protected_path_change',
        status: 'awaiting_approval',
        diffDigest: REPORT.diffDigest,
        changes: REPORT.protectedChanges,
      },
    });
    const persisted = await env.DB_CONTROL.prepare(
      `SELECT group_concat(path || ':' || change_type, ',') AS summary
       FROM protected_path_change_entries WHERE gate_id = ? ORDER BY position`,
    ).bind(result.gateId).first<{ summary: string }>();
    expect(persisted?.summary).toContain('.env.production:added');
    expect(JSON.stringify({ result, projection, persisted })).not.toContain(SECRET_CANARY);

    await expect(store.request(AUTHORIZATION, REPORT, NOW)).resolves.toMatchObject({
      gateId: result.gateId,
      created: false,
      state: 'awaiting_approval',
    });
  });

  it('enforces the authenticated HTTP boundary and rejects stale base bindings', async () => {
    const api = attemptApi({ now: () => NOW });
    const request = async (report: ProtectedPathChangeReportV1): Promise<Response> =>
      await api.fetch(new Request(
        `https://delivery-loop.test/v1/attempts/${ATTEMPT_ID}/protected-path-changes`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${RAW_RUNNER_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedVersion: 2,
            leaseGeneration: 1,
            report,
          }),
        },
      ), env);

    const stale = await request({ ...REPORT, baseSha: '0'.repeat(40) });
    expect(stale.status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 4 });

    const accepted = await request(REPORT);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(await accepted.json()).toMatchObject({
      created: true,
      state: 'awaiting_approval',
      report: REPORT,
    });
  });

  it('rejects a forged non-repo-write context without leaving a gate', async () => {
    await env.DB_CONTROL.prepare(
      `DELETE FROM plan_item_effects WHERE plan_id = ? AND item_id = ? AND effect = 'repo_write'`,
    ).bind(PLAN_ID, ITEM_ID).run();
    await expect(
      new ProtectedPathApprovalStore(env.DB_CONTROL).request(AUTHORIZATION, REPORT, NOW),
    ).rejects.toMatchObject({
      name: ProtectedPathApprovalError.name,
      code: 'state_conflict',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM protected_path_change_gates',
    ).first()).toEqual({ count: 0 });
  });
});
