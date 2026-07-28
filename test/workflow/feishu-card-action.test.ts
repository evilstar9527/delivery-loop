/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFeishuSignature } from '../../src/feishu/webhook-crypto.js';
import { IdentityMapper } from '../../src/auth/identity-mapper.js';
import { computeAgentCheckpointDigest, type AgentCheckpointV1 } from '../../src/domain/checkpoint.js';
import type { FeishuCardActionCommand } from '../../src/domain/feishu-card-action.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import { FeishuDeliveryCardReconciler } from '../../src/reconciliation/feishu-delivery-card-reconciler.js';

const BASE_URL = 'https://delivery-loop.test';
const ENCRYPT_KEY = 'test-feishu-event-encrypt-key';
const VERIFICATION_TOKEN = 'test-feishu-event-verification-token';
const TENANT_KEY = 'test-feishu-tenant';
const APP_ID = 'cli_test_delivery_loop';
const OPERATIONS_TOKEN = 'test-operations-token';
const CHAT_ID = 'oc_feishu_delivery_status';
const MESSAGE_ID = 'om_feishu_card_action';
const BASE_SHA = 'a'.repeat(40);
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const TASK_ID = 'task-feishu-action';
const RUN_ID = 'run-feishu-action';
const PLAN_ID = 'plan-feishu-action';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptedRequest(payload: unknown, transportNonce = crypto.randomUUID()) {
  const encoder = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(ENCRYPT_KEY));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  ));
  const complete = new Uint8Array(iv.length + ciphertext.length);
  complete.set(iv);
  complete.set(ciphertext, iv.length);
  const body = JSON.stringify({ encrypt: bytesToBase64(complete) });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await computeFeishuSignature(timestamp, transportNonce, ENCRYPT_KEY, body);
  return {
    method: 'POST' as const,
    headers: {
      'content-type': 'application/json',
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': transportNonce,
      'x-lark-signature': signature,
    },
    body,
  };
}

function actionEvent(
  eventId: string,
  command: FeishuCardActionCommand,
  openId = 'ou_feishu_reviewer',
  binding: { tenantKey?: string; appId?: string; chatId?: string; messageId?: string } = {},
): unknown {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'card.action.trigger',
      create_time: String(Date.now()),
      token: VERIFICATION_TOKEN,
      app_id: binding.appId ?? APP_ID,
      tenant_key: binding.tenantKey ?? TENANT_KEY,
    },
    event: {
      operator: { open_id: openId },
      action: {
        value: { id: command.actionId, signal: command },
        form_value: { delivery_loop_context: 'CANARY_CONTEXT_NOT_FOR_APPROVAL' },
      },
      context: {
        open_chat_id: binding.chatId ?? CHAT_ID,
        open_message_id: binding.messageId ?? MESSAGE_ID,
      },
    },
  };
}

async function postAction(
  eventId: string,
  command: FeishuCardActionCommand,
  openId = 'ou_feishu_reviewer',
  binding: { tenantKey?: string; appId?: string; chatId?: string; messageId?: string } = {},
): Promise<Response> {
  return await SELF.fetch(
    `${BASE_URL}/v1/webhooks/feishu`,
    await encryptedRequest(actionEvent(eventId, command, openId, binding)),
  );
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM feishu_card_action_outcomes'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_card_action_approval_bindings'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_card_action_receipts'),
    env.DB_CONTROL.prepare('DELETE FROM supplemental_context_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replay_reconciliations'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replay_effects'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replays'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_ingress_queue_observations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_ingress_outbox'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_webhook_nonces'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_observations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_presentations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_cards'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedActionCard(): Promise<FeishuCardActionCommand[]> {
  const now = new Date().toISOString();
  const task: TaskEnvelope = {
    schemaVersion: '1',
    eventId: 'seed-feishu-action',
    occurredAt: now,
    source: {
      system: 'feishu',
      tenantKey: TENANT_KEY,
      taskKey: 'feishu-action-task',
      revision: 'revision-1',
    },
    actor: { type: 'user', id: 'ou_requester' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'requirement',
      title: 'Exercise card action authorization',
      description: 'Only the frozen card command may affect the Run.',
      acceptanceCriteria: ['One exact identity-bound approval is recorded.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: true,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
  const taskDigest = await taskRevisionDigest(task);
  const taskKey = `tasks/${TASK_ID}/${taskDigest.slice('sha256:'.length)}.json`;
  await env.TASK_OBJECTS.put(taskKey, JSON.stringify(task), {
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
       ) VALUES (?, 'feishu', ?, 'feishu-action-task', 'revision-1', ?, ?,
                 'user', 'ou_requester', 'example/delivery-target', 'main', 'test',
                 'requirement', 'Exercise card action authorization', 'p1', 1,
                 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TENANT_KEY, taskDigest, `r2://${taskKey}`, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'awaiting_approval', 4,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES ('attempt-feishu-action-analysis', ?, 1, 'analysis', 'completed', ?,
                 1, 1, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active',
                 'attempt-feishu-action-analysis', 'Authorize one bounded effect', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'item-feishu-action', 'change', 'Apply approved change',
                 'Use only an identity-bound repo write.', 1, 0)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, version, updated_at
       ) VALUES (?, 'item-feishu-action', 'ready', 0, ?)`,
    ).bind(PLAN_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'item-feishu-action', 'repo_write')`,
    ).bind(PLAN_ID),
  ]);
  const mapper = new IdentityMapper(env.DB_CONTROL);
  await mapper.bind('user:feishu-reviewer', [
    'human',
    'approve:repo_write',
    'operate:cancel',
    'operate:retry',
    'operate:replay',
    'context:add',
  ], now);
  await mapper.bindChannelIdentity(
    `feishu:${TENANT_KEY}`,
    'ou_feishu_reviewer',
    'user:feishu-reviewer',
    now,
  );
  const projected = await new FeishuDeliveryCardReconciler(
    env.DB_CONTROL,
    { tenantKey: TENANT_KEY, chatId: CHAT_ID },
  ).reconcileRun(RUN_ID);
  if (projected === 'not_found') throw new Error('card missing');
  await env.DB_CONTROL.prepare(
    `UPDATE feishu_delivery_cards
     SET active_message_id = ?, active_message_created_at = ?, updated_at = ?
     WHERE run_id = ?`,
  ).bind(MESSAGE_ID, now, now, RUN_ID).run();
  const raw = await env.DB_CONTROL.prepare(
    `SELECT presentation_json FROM feishu_delivery_card_presentations
     WHERE presentation_id = ?`,
  ).bind(projected.presentationId).first<string>('presentation_json');
  return (JSON.parse(raw!) as { actions: FeishuCardActionCommand[] }).actions;
}

async function seedRetryActionCard(): Promise<FeishuCardActionCommand[]> {
  await seedActionCard();
  const now = new Date().toISOString();
  const headSha = 'd'.repeat(40);
  const checkpoint: AgentCheckpointV1 = {
    schemaVersion: '1',
    sequence: 1,
    provider: 'codex',
    providerSessionRef: 'session-feishu-retry',
    planVersion: 1,
    planItemId: 'item-feishu-action',
    headBranch: 'codex/feishu-retry',
    headSha,
    completedAcceptanceCriteria: [],
    evidenceRefs: [],
    summary: 'Safe checkpoint for a server-derived retry target.',
    nextStep: 'Resume the same Plan Item.',
  };
  const checkpointDigest = await computeAgentCheckpointDigest(checkpoint);
  const checkpointRef = `r2://checkpoints/attempt-feishu-action-lost/1-${checkpointDigest.slice('sha256:'.length)}.json`;
  await env.CHECKPOINT_OBJECTS.put(
    checkpointRef.slice('r2://'.length),
    JSON.stringify(checkpoint),
    {
      customMetadata: {
        checkpointDigest,
        attemptId: 'attempt-feishu-action-lost',
        sequence: '1',
      },
    },
  );
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id, head_branch,
         head_sha, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-feishu-action-lost', ?, 2, 'implement', 'lost', ?,
                 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, 'item-feishu-action', 'codex/feishu-retry', ?, 3, 2, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, PLAN_ID, headSha, now, now),
    env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress
       SET status = 'in_progress', active_attempt_id = 'attempt-feishu-action-lost',
           version = version + 1, updated_at = ?
       WHERE plan_id = ? AND item_id = 'item-feishu-action'`,
    ).bind(now, PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO checkpoints (
         checkpoint_id, attempt_id, sequence, plan_id, plan_version,
         plan_item_id, head_sha, payload_ref, payload_digest, summary,
         next_step, created_at
       ) VALUES ('checkpoint-feishu-action-retry', 'attempt-feishu-action-lost', 1,
                 ?, 1, 'item-feishu-action', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      PLAN_ID,
      headSha,
      checkpointRef,
      checkpointDigest,
      checkpoint.summary,
      checkpoint.nextStep,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('workflow-cancel-retry-action', ?, 'workflow_cancel',
                 'cloudflare_workflows', ?, 'workflow-cancel:retry-action',
                 'settled', ?, ?)`,
    ).bind(RUN_ID, `d1://runs/${RUN_ID}`, now, now),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 5, updated_at = ?
       WHERE run_id = ? AND version = 4`,
    ).bind(now, RUN_ID),
  ]);
  const projected = await new FeishuDeliveryCardReconciler(
    env.DB_CONTROL,
    { tenantKey: TENANT_KEY, chatId: CHAT_ID },
  ).reconcileRun(RUN_ID);
  if (projected === 'not_found') throw new Error('retry card missing');
  const raw = await env.DB_CONTROL.prepare(
    `SELECT presentation_json FROM feishu_delivery_card_presentations
     WHERE presentation_id = ?`,
  ).bind(projected.presentationId).first<string>('presentation_json');
  return (JSON.parse(raw!) as { actions: FeishuCardActionCommand[] }).actions;
}

beforeEach(async () => {
  await reset();
});

describe('server-authorized Feishu card actions', () => {
  it('converges 20 approve callbacks, rejects nonce replay and never enters Task ingress', async () => {
    const actions = await seedActionCard();
    const approve = actions.find(
      (action) => action.command === 'approve' && action.effect === 'repo_write',
    );
    if (approve === undefined) throw new Error('approve action missing');
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      postAction(`event-card-approve-${index}`, approve)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(19);
    const acceptedIndex = responses.findIndex((response) => response.status === 200);
    const acceptedBody = await responses[acceptedIndex]!.text();
    expect(acceptedBody).not.toContain('ou_feishu_reviewer');
    expect(acceptedBody).not.toContain('user:feishu-reviewer');
    expect(acceptedBody).not.toContain(approve.nonce);
    const evidenceResponse = await SELF.fetch(
      `${BASE_URL}/v1/operations/feishu-card-action/evidence` +
        `?tenantKey=${TENANT_KEY}&eventId=event-card-approve-${acceptedIndex}`,
      { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
    );
    expect(evidenceResponse.status).toBe(200);
    const evidence = await evidenceResponse.json<Record<string, unknown>>();
    expect(evidence).toMatchObject({
      schemaVersion: '1',
      tenantKey: TENANT_KEY,
      eventId: `event-card-approve-${acceptedIndex}`,
      counts: {
        deliveries: 1,
        ingressOutboxes: 0,
        actionReceipts: 1,
        actionOutcomes: 1,
        businessEffects: 1,
      },
      delivery: {
        appId: APP_ID,
        eventType: 'card.action.trigger',
        verificationMode: 'encrypted',
      },
      action: {
        messageId: MESSAGE_ID,
        runId: RUN_ID,
        planId: PLAN_ID,
        command: 'approve',
        effect: 'repo_write',
        outcome: { disposition: 'applied', resultKind: 'approval' },
        businessEffect: {
          kind: 'approval',
          decision: 'approve',
          effect: 'repo_write',
          currentTrusted: true,
        },
      },
    });
    expect(JSON.stringify(evidence)).not.toContain('ou_feishu_reviewer');
    expect(JSON.stringify(evidence)).not.toContain('user:feishu-reviewer');
    expect(JSON.stringify(evidence)).not.toContain(approve.nonce);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approvals
       WHERE run_id = ? AND effect = 'repo_write' AND decision = 'approve'`,
    ).bind(RUN_ID).first<number>('count')).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_card_action_receipts',
    ).first<number>('count')).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      "SELECT COUNT(*) AS count FROM feishu_card_action_outcomes WHERE disposition = 'applied'",
    ).first<number>('count')).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_ingress_outbox',
    ).first<number>('count')).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT provider, tenant_key, external_event_id, approver_principal,
              task_id, task_revision, plan_id, plan_version, plan_digest,
              base_sha, effect, decision, card_action_receipt_id
       FROM approval_lineages WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toMatchObject({
      provider: 'feishu',
      tenant_key: TENANT_KEY,
      approver_principal: 'user:feishu-reviewer',
      task_id: TASK_ID,
      task_revision: 'revision-1',
      plan_id: PLAN_ID,
      plan_version: 1,
      plan_digest: PLAN_DIGEST,
      base_sha: BASE_SHA,
      effect: 'repo_write',
      decision: 'approve',
      card_action_receipt_id: expect.stringMatching(/^feishu_action_/),
    });
    const rows = JSON.stringify(await env.DB_CONTROL.prepare(
      `SELECT operator_open_id, principal, command, effect, nonce_digest,
              command_digest FROM feishu_card_action_receipts`,
    ).all());
    expect(rows).not.toContain('CANARY_CONTEXT_NOT_FOR_APPROVAL');
    expect(rows).not.toContain(approve.nonce);
    expect(rows).not.toContain(VERIFICATION_TOKEN);
  });

  it('rejects forged identity/binding/snapshot fields before any action effect', async () => {
    const actions = await seedActionCard();
    const approve = actions.find((action) => action.command === 'approve');
    if (approve === undefined || approve.command !== 'approve') throw new Error('approve missing');
    const forged = { ...approve, effect: 'test_deploy' as const };
    expect((await postAction('event-card-forged-effect', forged)).status).toBe(403);
    const staleCommands: FeishuCardActionCommand[] = [
      { ...approve, runVersion: approve.runVersion - 1 },
      {
        ...approve,
        taskRevision: 'revision-0',
        taskRevisionDigest: `sha256:${'c'.repeat(64)}`,
      },
      { ...approve, planVersion: approve.planVersion + 1 },
      { ...approve, planDigest: `sha256:${'d'.repeat(64)}` },
      { ...approve, baseSha: 'e'.repeat(40) },
      { ...approve, nonce: `fa_${'f'.repeat(64)}` },
    ];
    for (const [index, stale] of staleCommands.entries()) {
      expect((await postAction(`event-card-stale-${index}`, stale)).status).toBe(403);
    }
    expect((await postAction('event-card-unresolved', approve, 'ou_unknown')).status).toBe(403);
    expect((await postAction(
      'event-card-wrong-tenant',
      approve,
      'ou_feishu_reviewer',
      { tenantKey: 'wrong-tenant' },
    )).status).toBe(403);
    expect((await postAction(
      'event-card-wrong-app',
      approve,
      'ou_feishu_reviewer',
      { appId: 'cli_wrong_app' },
    )).status).toBe(403);
    expect((await postAction(
      'event-card-wrong-chat',
      approve,
      'ou_feishu_reviewer',
      { chatId: 'oc_wrong_chat' },
    )).status).toBe(403);
    expect((await postAction(
      'event-card-wrong-message',
      approve,
      'ou_feishu_reviewer',
      { messageId: 'om_wrong_message' },
    )).status).toBe(403);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM approvals',
    ).first<number>('count')).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_card_action_receipts',
    ).first<number>('count')).toBe(0);
    const rejectedEvidence = await SELF.fetch(
      `${BASE_URL}/v1/operations/feishu-card-action/evidence` +
        `?tenantKey=${TENANT_KEY}&eventId=event-card-forged-effect`,
      { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
    );
    expect(rejectedEvidence.status).toBe(200);
    const rejected = await rejectedEvidence.json<Record<string, unknown>>();
    expect(rejected).toMatchObject({
      counts: {
        deliveries: 1,
        ingressOutboxes: 0,
        actionReceipts: 0,
        actionOutcomes: 0,
        businessEffects: 0,
      },
      action: null,
    });
    expect(JSON.stringify(rejected)).not.toContain('ou_feishu_reviewer');
    expect(JSON.stringify(rejected)).not.toContain(forged.nonce);
    expect((await SELF.fetch(
      `${BASE_URL}/v1/operations/feishu-card-action/evidence` +
        `?tenantKey=${TENANT_KEY}&eventId=event-card-forged-effect&extra=1`,
      { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
    )).status).toBe(400);
    expect((await SELF.fetch(
      `${BASE_URL}/v1/operations/feishu-card-action/evidence` +
        `?tenantKey=${TENANT_KEY}&eventId=event-card-forged-effect`,
    )).status).toBe(401);
  });

  it('dispatches cancel through the existing lifecycle store with the frozen Run version', async () => {
    const actions = await seedActionCard();
    const cancel = actions.find((action) => action.command === 'cancel');
    if (cancel === undefined) throw new Error('cancel action missing');
    const response = await postAction('event-card-cancel', cancel);
    expect(response.status).toBe(200);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'cancelled', version: 5 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT result_kind FROM feishu_card_action_outcomes
       WHERE disposition = 'applied'`,
    ).first<string>('result_kind')).toBe('cancellation');
  });

  it('rejects service/agent/missing-role identities resolved at action time', async () => {
    const actions = await seedActionCard();
    const approve = actions.find((action) => action.command === 'approve');
    if (approve === undefined) throw new Error('approve missing');
    const mapper = new IdentityMapper(env.DB_CONTROL);
    const now = new Date().toISOString();
    const cases = [
      ['ou_service', 'service:release', ['human', 'approve:repo_write']],
      ['ou_agent', 'agent:release', ['human', 'approve:repo_write']],
      ['ou_no_role', 'user:no-role', ['human']],
      ['ou_not_human', 'user:not-human', ['approve:repo_write']],
    ] as const;
    for (const [openId, principal, roles] of cases) {
      await mapper.bind(principal, [...roles], now);
      await mapper.bindChannelIdentity(`feishu:${TENANT_KEY}`, openId, principal, now);
      expect((await postAction(`event-card-${openId}`, approve, openId)).status).toBe(403);
    }
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM approvals',
    ).first<number>('count')).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_card_action_receipts',
    ).first<number>('count')).toBe(0);
  });

  it('records a terminal rejection without partial business state when the inner store denies', async () => {
    const actions = await seedActionCard();
    const replay = actions.find((action) => action.command === 'replay');
    if (replay === undefined) throw new Error('replay missing');
    expect((await postAction('event-card-replay-without-approval', replay)).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 4 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM workflow_replays',
    ).first<number>('count')).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT disposition, reason_code FROM feishu_card_action_outcomes`,
    ).first()).toEqual({ disposition: 'rejected', reason_code: 'effect_failed' });
    const refreshed = await new FeishuDeliveryCardReconciler(
      env.DB_CONTROL,
      { tenantKey: TENANT_KEY, chatId: CHAT_ID },
    ).reconcileRun(RUN_ID);
    if (refreshed === 'not_found') throw new Error('refreshed card missing');
    expect(refreshed.presentationId).not.toBe(replay.presentationId);
    const raw = await env.DB_CONTROL.prepare(
      `SELECT presentation_json FROM feishu_delivery_card_presentations
       WHERE presentation_id = ?`,
    ).bind(refreshed.presentationId).first<string>('presentation_json');
    const nextReplay = (JSON.parse(raw!) as { actions: FeishuCardActionCommand[] }).actions
      .find((action) => action.command === 'replay');
    expect(nextReplay?.nonce).not.toBe(replay.nonce);
  });

  it('records reject as the exact effect decision from the frozen card command', async () => {
    const actions = await seedActionCard();
    const reject = actions.find(
      (action) => action.command === 'reject' && action.effect === 'repo_write',
    );
    if (reject === undefined) throw new Error('reject action missing');
    expect((await postAction('event-card-reject', reject)).status).toBe(200);
    expect(await env.DB_CONTROL.prepare(
      `SELECT effect, decision, actor_id FROM approvals WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      effect: 'repo_write',
      decision: 'reject',
      actor_id: 'user:feishu-reviewer',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT provider, external_event_id, approver_principal, effect, decision
       FROM approval_lineages WHERE approval_id IN (
         SELECT approval_id FROM approvals WHERE run_id = ?
       )`,
    ).bind(RUN_ID).first()).toEqual({
      provider: 'feishu',
      external_event_id: 'event-card-reject',
      approver_principal: 'user:feishu-reviewer',
      effect: 'repo_write',
      decision: 'reject',
    });
  });

  it('derives the replay target on the server and uses the existing replay scheduler', async () => {
    const actions = await seedActionCard();
    const approve = actions.find(
      (action) => action.command === 'approve' && action.effect === 'repo_write',
    );
    const replay = actions.find((action) => action.command === 'replay');
    if (approve === undefined || replay === undefined) throw new Error('actions missing');
    expect((await postAction('event-card-replay-approval', approve)).status).toBe(200);
    expect((await postAction('event-card-replay', replay)).status).toBe(200);
    expect(await env.DB_CONTROL.prepare(
      `SELECT target_step_name, target_step_type, target_step_count
       FROM workflow_replays WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      target_step_name: 'verify-analysis-result',
      target_step_type: 'do',
      target_step_count: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT result_kind FROM feishu_card_action_outcomes
       WHERE result_kind = 'workflow_replay'`,
    ).first<string>('result_kind')).toBe('workflow_replay');
  });

  it('builds a supplemental Task revision from the prior R2 object and signed actor', async () => {
    const actions = await seedActionCard();
    const addContext = actions.find(
      (action) => action.command === 'add_context' && action.contextMode === 'new_run',
    );
    if (addContext === undefined) throw new Error('context action missing');
    expect((await postAction('event-card-add-context', addContext)).status).toBe(200);
    const revision = await env.DB_CONTROL.prepare(
      `SELECT revisions.context_id, revisions.new_task_id, revisions.new_run_id,
              revisions.context_ref,
              tasks.actor_type, tasks.actor_id, tasks.task_revision
       FROM supplemental_context_revisions AS revisions
       JOIN tasks ON tasks.task_id = revisions.new_task_id
       WHERE revisions.prior_task_id = ?`,
    ).bind(TASK_ID).first<Record<string, unknown>>();
    expect(revision).toMatchObject({
      actor_type: 'user',
      actor_id: 'ou_feishu_reviewer',
      task_revision: 'feishu-context-event-card-add-context',
    });
    expect(revision?.new_task_id).not.toBe(TASK_ID);
    expect(revision?.new_run_id).not.toBe(RUN_ID);
    expect(JSON.stringify(revision)).not.toContain('CANARY_CONTEXT_NOT_FOR_APPROVAL');
    const evidence = await SELF.fetch(
      `https://delivery-loop.test/v1/operations/supplemental-context/evidence` +
        `?contextId=${String(revision?.context_id)}`,
      { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
    );
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({
      contextId: revision?.context_id,
      objects: { contextVerified: true, newTaskVerified: true },
      lineage: { mode: 'new_run', newTaskId: revision?.new_task_id },
      feishuActions: [{
        eventId: 'event-card-add-context',
        contextMode: 'new_run',
        resultId: revision?.new_task_id,
        sourceRunId: RUN_ID,
      }],
      meegleMappings: [],
      counts: { feishuActions: 1, meegleMappings: 0 },
    });
  });

  it('derives the lost Plan Item on the server and uses the existing recovery scheduler', async () => {
    const actions = await seedRetryActionCard();
    const retry = actions.find((action) => action.command === 'retry');
    if (retry === undefined) throw new Error('retry action missing');
    expect((await postAction('event-card-retry', retry)).status).toBe(200);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovered_from_attempt_id, recovery_checkpoint_id, status,
              plan_item_id FROM attempts
       WHERE recovered_from_attempt_id = 'attempt-feishu-action-lost'`,
    ).first()).toEqual({
      recovered_from_attempt_id: 'attempt-feishu-action-lost',
      recovery_checkpoint_id: 'checkpoint-feishu-action-retry',
      status: 'pending',
      plan_item_id: 'item-feishu-action',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 6 });
  });
});
