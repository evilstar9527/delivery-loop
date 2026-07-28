/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, introspectWorkflowInstance, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  analysisAttemptId,
  type AttemptResultSignalV1,
} from '../../src/domain/workflow-event.js';
import {
  CloudflareWorkflowEffectClient,
  WorkflowOutboxProcessor,
  type WorkflowEffectClient,
  type WorkflowRestartTarget,
} from '../../src/outbox/workflow-outbox.js';
import { WorkflowSignalStore } from '../../src/storage/workflow-signal-store.js';
import type { DeliveryRunWorkflowParams } from '../../src/workflows/delivery-run-workflow.js';

const BASE_URL = 'https://delivery-loop.test';
const NOW = '2026-07-25T12:00:00.000Z';
const BASE_SHA = '8'.repeat(40);
const PLAN_DIGEST = `sha256:${'7'.repeat(64)}`;

interface ReplayResponse {
  replayId: string;
  outboxId: string;
  runId: string;
  target: WorkflowRestartTarget;
  effectSnapshotDigest: string;
  created: boolean;
}

interface SeededRun {
  taskId: string;
  runId: string;
  attemptId: string;
  planId: string;
}

async function clearDatabase(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM workflow_step_executions'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replay_reconciliations'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replay_effects'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replays'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM github_api_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
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
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function replay(
  runId: string,
  body: unknown,
  token = 'test-task-intake-token',
): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/runs/${runId}/replay`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function seedTask(
  taskId: string,
  allowEffects: boolean,
): Promise<void> {
  await env.DB_CONTROL.prepare(
    `INSERT INTO tasks (
       task_id, source_system, tenant_key, source_task_key, task_revision,
       task_digest, payload_ref, actor_type, actor_id, target_repository,
       target_base_branch, target_environment, intent_kind, title, priority,
       acceptance_criteria_count, allow_repository_write, allow_test_deploy,
       allow_production_deploy, require_human_approval, created_at, updated_at
     ) VALUES (
       ?, 'manual', 'replay-test', ?, '1', ?, ?, 'system', 'replay-test',
       'example/repo', 'main', 'test', 'bug', 'Controlled replay test', 'p1',
       1, ?, ?, ?, 1, ?, ?
     )`,
  )
    .bind(
      taskId,
      taskId,
      `sha256:${'6'.repeat(64)}`,
      `r2://tasks/${taskId}`,
      allowEffects ? 1 : 0,
      allowEffects ? 1 : 0,
      0,
      NOW,
      NOW,
    )
    .run();
}

async function seedAnalysisWorkflow(): Promise<{
  seeded: SeededRun;
  params: DeliveryRunWorkflowParams;
  signal: AttemptResultSignalV1;
}> {
  const seeded: SeededRun = {
    taskId: 'task-replay-system-step',
    runId: 'run-replay-system-step',
    attemptId: analysisAttemptId('run-replay-system-step'),
    planId: 'plan-replay-system-step-v1',
  };
  await seedTask(seeded.taskId, false);
  await env.DB_CONTROL.prepare(
    `INSERT INTO runs (
       run_id, task_id, task_revision, task_digest, base_sha,
       workflow_instance_id, state, version, created_at, updated_at
     ) VALUES (?, ?, '1', ?, ?, ?, 'queued', 0, ?, ?)`,
  )
    .bind(
      seeded.runId,
      seeded.taskId,
      `sha256:${'6'.repeat(64)}`,
      BASE_SHA,
      seeded.runId,
      NOW,
      NOW,
    )
    .run();
  const params: DeliveryRunWorkflowParams = {
    schemaVersion: '1',
    runId: seeded.runId,
    taskId: seeded.taskId,
    taskRevision: '1',
    taskDigest: `sha256:${'6'.repeat(64)}`,
  };
  const signal: AttemptResultSignalV1 = {
    schemaVersion: '1',
    eventId: 'delivery-replay-system-result-1',
    runId: seeded.runId,
    type: 'attempt_completed',
    attemptId: seeded.attemptId,
    sequence: 1,
    payloadRef: `d1://execution-plans/${seeded.planId}`,
    digest: PLAN_DIGEST,
    occurredAt: NOW,
  };
  return { seeded, params, signal };
}

async function seedReadOnlyPlan(seeded: SeededRun, signal: AttemptResultSignalV1): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest,
         status, created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'validated', ?, 'Replay-safe analysis plan', ?, ?)`,
    ).bind(
      seeded.planId,
      seeded.runId,
      BASE_SHA,
      signal.digest,
      seeded.attemptId,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'verify-analysis', 'verification', 'Verify analysis',
                 'Recheck the immutable analysis result.', 1, 0)`,
    ).bind(seeded.planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'verify-analysis', 'repo_read')`,
    ).bind(seeded.planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'verify-analysis', 'pending', 0, ?)`,
    ).bind(seeded.planId, NOW),
    env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 1, lease_generation = 1,
           lease_expires_at = ?, heartbeat_at = ?, result_event_id = ?,
           result_sequence = ?, result_payload_ref = ?, result_digest = ?,
           result_reported_at = ?, updated_at = ?
       WHERE attempt_id = ? AND run_id = ? AND status = 'pending'`,
    ).bind(
      '2026-07-25T12:02:00.000Z',
      NOW,
      signal.eventId,
      signal.sequence,
      signal.payloadRef,
      signal.digest,
      NOW,
      NOW,
      seeded.attemptId,
      seeded.runId,
    ),
  ]);
}

async function seedCompletedDeliveryRun(label: string): Promise<SeededRun> {
  const seeded: SeededRun = {
    taskId: `task-replay-${label}`,
    runId: `run-replay-${label}`,
    attemptId: `attempt-replay-${label}`,
    planId: `plan-replay-${label}-v1`,
  };
  await seedTask(seeded.taskId, true);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'succeeded', 8, ?, 1, ?, ?, ?)`,
    ).bind(
      seeded.runId,
      seeded.taskId,
      `sha256:${'6'.repeat(64)}`,
      BASE_SHA,
      seeded.runId,
      seeded.planId,
      PLAN_DIGEST,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 2, 1, ?, ?)`,
    ).bind(seeded.attemptId, seeded.runId, BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest,
         status, created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'completed', ?, 'Completed delivery plan', ?, ?)`,
    ).bind(
      seeded.planId,
      seeded.runId,
      BASE_SHA,
      PLAN_DIGEST,
      seeded.attemptId,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'verify-release', 'verification', 'Verify release',
                 'Rerun verification without repeating delivery effects.', 1, 0)`,
    ).bind(seeded.planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'deliver-release', 'delivery', 'Deliver release',
                 'Represent already reconciled PR and deployment effects.', 1, 1)`,
    ).bind(seeded.planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'verify-release', 'passed', 3, ?)`,
    ).bind(seeded.planId, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'deliver-release', 'passed', 3, ?)`,
    ).bind(seeded.planId, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_verifications (
         verification_id, run_id, plan_id, plan_version, plan_item_id,
         attempt_id, head_sha, progress_version, evidence_set_digest,
         status, created_at
       ) VALUES (?, ?, ?, 1, 'verify-release', ?, ?, 2, ?, 'passed', ?)`,
    ).bind(
      `verification-replay-${label}`,
      seeded.runId,
      seeded.planId,
      seeded.attemptId,
      BASE_SHA,
      `sha256:${'4'.repeat(64)}`,
      NOW,
    ),
    ...['repo_read'].map((effect) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_effects (plan_id, item_id, effect) VALUES (?, 'verify-release', ?)`,
      ).bind(seeded.planId, effect),
    ),
    ...['repo_write', 'test_deploy', 'merge'].map((effect) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_effects (plan_id, item_id, effect) VALUES (?, 'deliver-release', ?)`,
      ).bind(seeded.planId, effect),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_external_facts (plan_id, item_id, external_fact)
       VALUES (?, 'deliver-release', 'github_pr')`,
    ).bind(seeded.planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_external_facts (plan_id, item_id, external_fact)
       VALUES (?, 'deliver-release', 'deployment')`,
    ).bind(seeded.planId),
    ...[
      ['analysis-dispatch', 'analysis_dispatch'],
      ['pull-request', 'pull_request'],
    ].map(([suffix, kind]) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) VALUES (?, ?, ?, 'github_actions', ?, ?, 'settled', ?, ?)`,
      ).bind(
        `outbox-${label}-${suffix}`,
        seeded.runId,
        kind,
        `d1://runs/${seeded.runId}/${suffix}`,
        `${kind}:${seeded.runId}`,
        NOW,
        NOW,
      ),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, external_url, summary, verification_status,
         observed_at, created_at
       ) VALUES (?, ?, ?, ?, 1, 'deliver-release', 'pull_request', 'passed', ?,
                 'https://github.example/repo/pull/1', 'Verified PR fact', 'unverified', ?, ?)`,
    ).bind(
      `evidence-${label}-pr`,
      seeded.runId,
      seeded.attemptId,
      seeded.planId,
      BASE_SHA,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, external_url, summary, verification_status,
         observed_at, created_at
       ) VALUES (?, ?, ?, ?, 1, 'deliver-release', 'deployment', 'passed', ?,
                 'https://deploy.example/release/1', 'Verified deployment fact', 'verified', ?, ?)`,
    ).bind(
      `evidence-${label}-deploy`,
      seeded.runId,
      seeded.attemptId,
      seeded.planId,
      BASE_SHA,
      NOW,
      NOW,
    ),
  ]);
  return seeded;
}

async function insertApprovals(
  seeded: SeededRun,
  expiresAt: string,
  wrongRepoWriteBase = false,
  bindHighRisk = true,
): Promise<void> {
  const effects = ['repo_write', 'test_deploy', 'merge'] as const;
  const highRiskEffects = ['merge'] as const;
  await env.DB_CONTROL.batch([
    ...effects.map((effect) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO approvals (
           approval_id, run_id, task_revision, plan_id, plan_version,
           plan_digest, base_sha, effect, actor_id, decision, nonce_digest,
           expires_at, created_at
         ) VALUES (?, ?, '1', ?, 1, ?, ?, ?, 'user:replay-approver',
                   'approve', ?, ?, ?)`,
      ).bind(
        `approval-${seeded.runId}-${effect}`,
        seeded.runId,
        seeded.planId,
        PLAN_DIGEST,
        effect === 'repo_write' && wrongRepoWriteBase ? '0'.repeat(40) : BASE_SHA,
        effect,
        `sha256:${effect.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`,
        expiresAt,
        NOW,
      ),
    ),
    ...(bindHighRisk ? [env.DB_CONTROL.prepare(
      `INSERT INTO identity_mappings (principal, roles, created_at, updated_at)
       VALUES ('user:replay-approver',
               '["approve:merge","human"]', ?, ?),
              ('user:delivery-author', '["human"]', ?, ?)
       ON CONFLICT(principal) DO UPDATE SET
         roles = excluded.roles, updated_at = excluded.updated_at`,
    ).bind(NOW, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO channel_identities (
         channel, channel_user_id, principal, created_at, updated_at
       ) VALUES ('feishu:replay-test', 'ou_replay_approver',
                 'user:replay-approver', ?, ?),
                ('github:example/repo', 'delivery-author',
                 'user:delivery-author', ?, ?)
       ON CONFLICT(channel, channel_user_id) DO UPDATE SET
         principal = excluded.principal, updated_at = excluded.updated_at`,
    ).bind(NOW, NOW, NOW, NOW),
    ...highRiskEffects.flatMap((effect) => {
      const approvalId = `approval-${seeded.runId}-${effect}`;
      const sourceId = `approval-source-${seeded.runId}-${effect}`;
      return [
        env.DB_CONTROL.prepare(
          `INSERT INTO approval_source_events (
             source_id, provider, tenant_key, external_event_id, event_digest,
             request_digest, channel, channel_user_id, occurred_at, received_at, created_at
           ) VALUES (?, 'feishu', 'replay-test', ?, ?, ?, 'feishu:replay-test',
                     'ou_replay_approver', ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).bind(
          sourceId,
          `event-${seeded.runId}-${effect}`,
          `sha256:${'d'.repeat(64)}`,
          `sha256:${'c'.repeat(64)}`,
          NOW,
          NOW,
          NOW,
        ),
        env.DB_CONTROL.prepare(
          `INSERT INTO identity_bound_approvals (
             approval_id, source_id, approver_principal, approver_channel,
             approver_channel_user_id, pull_request_author_principal,
             pull_request_author_channel, pull_request_author_login,
             roles_digest, separation_verified, created_at
           ) VALUES (?, ?, 'user:replay-approver', 'feishu:replay-test',
                     'ou_replay_approver', 'user:delivery-author',
                     'github:example/repo', 'delivery-author', ?, 1, ?)`,
        ).bind(approvalId, sourceId, `sha256:${'e'.repeat(64)}`, NOW),
      ];
    })] : []),
  ]);
}

class FakeReplayEffects implements WorkflowEffectClient {
  readonly restarts: Array<{ runId: string; target: WorkflowRestartTarget }> = [];

  async ensureRun(): Promise<'existing'> {
    return 'existing';
  }

  async terminateRun(): Promise<void> {}

  async sendEvent(): Promise<void> {}

  async restartRun(
    runId: string,
    target: WorkflowRestartTarget,
  ): Promise<'restarted'> {
    this.restarts.push({ runId, target });
    return 'restarted';
  }
}

async function outbox(outboxId: string): Promise<{
  delivery_state: string;
  attempt_count: number;
  last_error_code: string | null;
}> {
  const row = await env.DB_CONTROL.prepare(
    `SELECT delivery_state, attempt_count, last_error_code
     FROM outbox WHERE outbox_id = ?`,
  )
    .bind(outboxId)
    .first<{
      delivery_state: string;
      attempt_count: number;
      last_error_code: string | null;
    }>();
  if (row === null) throw new Error('replay outbox missing');
  return row;
}

beforeEach(async () => {
  await clearDatabase();
});

describe('Controlled Workflow replay', () => {
  it('restarts the real Workflow from a stable verification step without redispatching analysis', async () => {
    const { seeded, params, signal } = await seedAnalysisWorkflow();
    await using instance = await introspectWorkflowInstance(env.DELIVERY_RUN, seeded.runId);
    await env.DELIVERY_RUN.create({ id: seeded.runId, params });
    await instance.waitForStepResult({ name: 'dispatch-analysis-attempt' });
    await seedReadOnlyPlan(seeded, signal);
    const signalRef = await new WorkflowSignalStore(env.DB_CONTROL).enqueueAttemptResult(signal, NOW);
    expect(
      await new WorkflowOutboxProcessor(
        env.DB_CONTROL,
        new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
      ).deliver(signalRef.outboxId),
    ).toBe('settled');
    await instance.waitForStepResult({ name: 'activate-analysis-plan' });
    await (await env.DELIVERY_RUN.get(seeded.runId)).terminate();
    await instance.waitForStatus('terminated');
    await env.DB_CONTROL.prepare(
      `UPDATE outbox SET delivery_state = 'settled', last_error_code = NULL
       WHERE run_id = ? AND kind = 'analysis_dispatch'`,
    )
      .bind(seeded.runId)
      .run();

    expect(
      await replay(seeded.runId, {
        expectedRunVersion: 2,
        from: { stepName: 'dispatch-analysis-attempt' },
        reason: 'Attempt to repeat an effectful system step.',
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await replay(
        seeded.runId,
        {
          expectedRunVersion: 2,
          from: { stepName: 'verify-analysis-result' },
          reason: 'Recheck the already accepted analysis result.',
        },
        'wrong-token',
      ),
    ).toMatchObject({ status: 401 });
    expect(
      await replay(seeded.runId, {
        expectedRunVersion: 1,
        from: { stepName: 'verify-analysis-result' },
        reason: 'Reject a stale Run version.',
      }),
    ).toMatchObject({ status: 409 });

    const responses = await Promise.all(
      Array.from({ length: 20 }, async () =>
        await replay(seeded.runId, {
          expectedRunVersion: 2,
          from: { stepName: 'verify-analysis-result', stepCount: 1 },
          reason: 'Recheck the already accepted analysis result.',
        }),
      ),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = (await Promise.all(
      responses.map(async (response) => await response.json()),
    )) as ReplayResponse[];
    expect(bodies.filter((body) => body.created)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.replayId)).size).toBe(1);
    expect(bodies[0]).toMatchObject({
      runId: seeded.runId,
      target: { name: 'verify-analysis-result', type: 'do', count: 1 },
    });
    const accepted = bodies[0]!;
    expect(
      await replay(seeded.runId, {
        expectedRunVersion: 2,
        from: { stepName: 'verify-analysis-result' },
        reason: 'Change immutable replay content.',
      }),
    ).toMatchObject({ status: 409 });

    expect(
      await new WorkflowOutboxProcessor(
        env.DB_CONTROL,
        new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
      ).deliver(accepted.outboxId),
    ).toBe('settled');
    let replayExecution: { run_version: number } | null = null;
    for (let attempt = 0; attempt < 100 && replayExecution === null; attempt += 1) {
      replayExecution = await env.DB_CONTROL.prepare(
        `SELECT run_version FROM workflow_step_executions
         WHERE run_id = ? AND step_name = 'verify-analysis-result' AND run_version = 3`,
      )
        .bind(seeded.runId)
        .first<{ run_version: number }>();
      if (replayExecution === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(replayExecution).toEqual({ run_version: 3 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM outbox
         WHERE run_id = ? AND kind = 'analysis_dispatch'`,
      )
        .bind(seeded.runId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?',
      )
        .bind(seeded.runId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB_CONTROL.prepare('SELECT state, version FROM runs WHERE run_id = ?')
        .bind(seeded.runId)
        .first(),
    ).toEqual({ state: 'awaiting_approval', version: 3 });
    await (await env.DELIVERY_RUN.get(seeded.runId)).terminate();
    await instance.waitForStatus('terminated');
  });

  it('requires exact approvals and reconciled PR/deploy facts for a Plan Item replay', async () => {
    const seeded = await seedCompletedDeliveryRun('effects');
    const params: DeliveryRunWorkflowParams = {
      schemaVersion: '1',
      runId: seeded.runId,
      taskId: seeded.taskId,
      taskRevision: '1',
      taskDigest: `sha256:${'6'.repeat(64)}`,
    };
    await using instance = await introspectWorkflowInstance(env.DELIVERY_RUN, seeded.runId);
    await env.DELIVERY_RUN.create({ id: seeded.runId, params });
    expect(await instance.waitForStepResult({
      name: 'plan-v1-item-verify-release-verify',
    })).toEqual({ runVersion: 8 });
    await instance.waitForStepResult({ name: 'confirm-run-terminal' });
    const request = {
      expectedRunVersion: 8,
      from: { planVersion: 1, planItemId: 'verify-release' },
      reason: 'Rerun verification after the external effects were observed.',
    };
    expect((await replay(seeded.runId, {
      expectedRunVersion: 8,
      from: { stepName: 'verify-analysis-result' },
      reason: 'Completed Plans cannot replay an analysis system step.',
    })).status).toBe(409);
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'failed' WHERE run_id = ?`,
    ).bind(seeded.runId).run();
    expect((await replay(seeded.runId, request)).status).toBe(409);
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'succeeded' WHERE run_id = ?`,
    ).bind(seeded.runId).run();
    expect(
      (
        await replay(seeded.runId, {
          ...request,
          from: { planVersion: 1, planItemId: 'deliver-release' },
        })
      ).status,
    ).toBe(409);
    expect((await replay(seeded.runId, request)).status).toBe(403);

    await insertApprovals(seeded, '2099-01-01T00:00:00.000Z', true);
    expect((await replay(seeded.runId, request)).status).toBe(403);
    await env.DB_CONTROL.prepare('DELETE FROM approvals WHERE run_id = ?')
      .bind(seeded.runId)
      .run();
    await insertApprovals(seeded, '2099-01-01T00:00:00.000Z', false, false);
    expect((await replay(seeded.runId, request)).status).toBe(403);
    await env.DB_CONTROL.prepare('DELETE FROM approvals WHERE run_id = ?')
      .bind(seeded.runId)
      .run();
    await insertApprovals(seeded, '2099-01-01T00:00:00.000Z');
    expect((await replay(seeded.runId, request)).status).toBe(409);
    await env.DB_CONTROL.prepare(
      `UPDATE evidence SET verification_status = 'verified'
       WHERE evidence_id = ?`,
    )
      .bind('evidence-effects-pr')
      .run();

    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await replay(seeded.runId, request)),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = (await Promise.all(
      responses.map(async (response) => await response.json()),
    )) as ReplayResponse[];
    expect(bodies.filter((body) => body.created)).toHaveLength(1);
    const accepted = bodies[0]!;
    expect(accepted.target).toEqual({
      name: 'plan-v1-item-verify-release-verify',
      type: 'do',
      count: 1,
    });
    expect(accepted.effectSnapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    expect(
      await new WorkflowOutboxProcessor(
        env.DB_CONTROL,
        new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
      ).deliver(accepted.outboxId),
    ).toBe('settled');
    let replayExecution: { run_version: number } | null = null;
    for (let attempt = 0; attempt < 100 && replayExecution === null; attempt += 1) {
      replayExecution = await env.DB_CONTROL.prepare(
        `SELECT run_version FROM workflow_step_executions
         WHERE run_id = ? AND step_name = ? AND run_version = 9`,
      ).bind(seeded.runId, accepted.target.name).first<{ run_version: number }>();
      if (replayExecution === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(replayExecution).toEqual({ run_version: 9 });
    expect(await outbox(accepted.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 1,
      last_error_code: null,
    });
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM workflow_replay_effects WHERE replay_id = ?',
      )
        .bind(accepted.replayId)
        .first(),
    ).toEqual({ count: 4 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM workflow_replay_reconciliations
         WHERE replay_id = ?`,
      )
        .bind(accepted.replayId)
        .first(),
    ).toEqual({ count: 4 });
    for (const kind of ['analysis_dispatch', 'pull_request']) {
      expect(
        await env.DB_CONTROL.prepare(
          'SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = ?',
        )
          .bind(seeded.runId, kind)
          .first(),
      ).toEqual({ count: 1 });
    }
    expect(
      await env.DB_CONTROL.prepare('SELECT state, version FROM runs WHERE run_id = ?')
        .bind(seeded.runId)
        .first(),
    ).toEqual({ state: 'succeeded', version: 9 });
    const replayRow = await env.DB_CONTROL.prepare(
      `SELECT reason_digest, restart_observed_at FROM workflow_replays WHERE replay_id = ?`,
    )
      .bind(accepted.replayId)
      .first<{ reason_digest: string; restart_observed_at: string | null }>();
    expect(replayRow?.reason_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(replayRow?.reason_digest).not.toContain(request.reason);
    expect(replayRow?.restart_observed_at).toBeTruthy();
  });

  it('rechecks approval expiry before the restart effect and terminally settles without it', async () => {
    const seeded = await seedCompletedDeliveryRun('expiry');
    await insertApprovals(seeded, '2030-01-01T00:00:00.000Z');
    await env.DB_CONTROL.prepare(
      `UPDATE evidence SET verification_status = 'verified' WHERE run_id = ?`,
    )
      .bind(seeded.runId)
      .run();
    const response = await replay(seeded.runId, {
      expectedRunVersion: 8,
      from: { planVersion: 1, planItemId: 'verify-release' },
      reason: 'Approval must still be active at effect time.',
    });
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as ReplayResponse;
    const effects = new FakeReplayEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date('2040-01-01T00:00:00.000Z'),
      generateLeaseToken: () => 'expired-replay-lease',
    });
    expect(await processor.deliver(accepted.outboxId)).toBe('settled');
    expect(effects.restarts).toHaveLength(0);
    expect(await outbox(accepted.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 1,
      last_error_code: 'approval_expired',
    });
  });
});
