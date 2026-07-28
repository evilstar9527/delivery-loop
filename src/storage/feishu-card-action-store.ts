import { canonicalSha256 } from '../domain/digest.js';
import {
  FeishuCardActionCommandSchema,
  type DecodedFeishuCardAction,
  type FeishuCardActionCommand,
  type FeishuCardApprovalEffect,
} from '../domain/feishu-card-action.js';
import { FeishuDeliveryCardPresentationV2Schema } from '../domain/feishu-delivery-card.js';
import { VERIFY_ANALYSIS_REPLAY_STEP } from '../domain/workflow-replay.js';
import { TaskEnvelopeSchema, taskRevisionDigest, type TaskEnvelope } from '../domain/task.js';
import { ANONYMOUS_PRINCIPAL, IdentityMapper } from '../auth/identity-mapper.js';
import { AttemptLifecycleStore } from './attempt-lifecycle-store.js';
import { IdentityBoundApprovalStore } from './identity-bound-approval-store.js';
import { RecoveryAttemptStore } from './recovery-attempt-store.js';
import { SupplementalContextRevisionStore } from './supplemental-context-revision-store.js';
import { WorkflowReplayStore } from './workflow-replay-store.js';

const APPROVAL_TTL_MS = 60 * 60_000;

export type FeishuCardActionErrorCode =
  | 'invalid_request'
  | 'binding_conflict'
  | 'identity_unresolved'
  | 'actor_not_human'
  | 'actor_not_authorized'
  | 'self_approval_denied'
  | 'replay_rejected'
  | 'state_conflict'
  | 'context_required'
  | 'secret_detected'
  | 'effect_failed';

export class FeishuCardActionError extends Error {
  constructor(readonly code: FeishuCardActionErrorCode) {
    super(`Feishu card action failed: ${code}`);
    this.name = 'FeishuCardActionError';
  }
}

export interface ExecuteFeishuCardActionInput {
  deliveryId: string;
  tenantKey: string;
  appId: string;
  eventDigest: string;
  receivedAt: string;
  action: DecodedFeishuCardAction;
}

export interface FeishuCardActionResult {
  actionReceiptId: string;
  command: FeishuCardActionCommand['command'];
  effect: FeishuCardActionCommand['effect'];
  principal: string;
  resultKind: 'approval' | 'cancellation' | 'recovery_attempt' | 'workflow_replay' | 'task_revision';
  resultId: string;
}

export interface FeishuCardActionStoreOptions {
  now?: () => Date;
  secrets?: readonly string[];
}

interface CandidateRow {
  card_id: string;
  tenant_key: string;
  chat_id: string;
  active_message_id: string | null;
  latest_presentation_id: string | null;
  presentation_id: string;
  presentation_json: string | null;
  task_id: string;
  task_revision: string;
  task_digest: string;
  task_payload_ref: string;
  task_actor_type: string;
  task_actor_id: string;
  run_id: string;
  run_state: string;
  run_version: number;
  base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_base_sha: string;
  plan_status: string;
}

interface PreparedAction {
  command: FeishuCardActionCommand;
  candidate: CandidateRow;
  principal: string;
  roles: string[];
  rolesDigest: string;
  commandDigest: string;
  nonceDigest: string;
  actionReceiptId: string;
  retryPlanItemId: string | null;
  contextTask: TaskEnvelope | null;
}

/**
 * Consumes only card commands that were frozen in the latest immutable
 * presentation. Authorization and the current Run/Task/Plan/base snapshot are
 * re-read before the one-time nonce is claimed; existing stores remain the
 * business state-machine owners.
 */
export class FeishuCardActionStore {
  private readonly now: () => Date;
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly taskObjects: R2Bucket,
    private readonly checkpointObjects: R2Bucket,
    options: FeishuCardActionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.secrets = options.secrets ?? [];
  }

  async execute(input: ExecuteFeishuCardActionInput): Promise<FeishuCardActionResult> {
    const now = this.now();
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(input.receivedAt))) {
      throw new FeishuCardActionError('invalid_request');
    }
    const prepared = await this.prepare(input);
    await this.claim(input, prepared, now.toISOString());
    try {
      const result = await this.apply(input, prepared, now);
      await this.recordOutcome(prepared.actionReceiptId, 'applied', result, null, now.toISOString());
      return {
        actionReceiptId: prepared.actionReceiptId,
        command: prepared.command.command,
        effect: prepared.command.effect,
        principal: prepared.principal,
        ...result,
      };
    } catch (error) {
      const reason = this.failureReason(error);
      await this.recordOutcome(prepared.actionReceiptId, 'rejected', null, reason, now.toISOString());
      throw new FeishuCardActionError(reason);
    }
  }

  private async prepare(input: ExecuteFeishuCardActionInput): Promise<PreparedAction> {
    const parsedCommand = FeishuCardActionCommandSchema.safeParse(input.action.command);
    if (!parsedCommand.success || parsedCommand.data.actionId !== input.action.command.actionId) {
      throw new FeishuCardActionError('invalid_request');
    }
    const command = parsedCommand.data;
    const candidate = await this.candidate(command.cardId, command.presentationId);
    if (candidate === null) throw new FeishuCardActionError('binding_conflict');
    if (
      candidate.tenant_key !== input.tenantKey || candidate.chat_id !== input.action.chatId ||
      candidate.active_message_id !== input.action.messageId ||
      candidate.latest_presentation_id !== command.presentationId ||
      candidate.card_id !== command.cardId || candidate.task_id !== command.taskId ||
      candidate.run_id !== command.runId || candidate.run_version !== command.runVersion ||
      candidate.active_plan_id !== command.planId ||
      candidate.active_plan_version !== command.planVersion ||
      candidate.active_plan_digest !== command.planDigest ||
      candidate.base_sha !== command.baseSha || candidate.plan_id !== command.planId ||
      candidate.plan_version !== command.planVersion || candidate.plan_digest !== command.planDigest ||
      candidate.plan_base_sha !== command.baseSha || candidate.plan_status !== 'active'
    ) throw new FeishuCardActionError('binding_conflict');

    const currentTaskRevisionDigest = await canonicalSha256({
      kind: 'task_revision',
      value: candidate.task_revision,
    });
    if (currentTaskRevisionDigest !== command.taskRevisionDigest) {
      throw new FeishuCardActionError('binding_conflict');
    }
    let presentation;
    try {
      presentation = FeishuDeliveryCardPresentationV2Schema.parse(
        JSON.parse(candidate.presentation_json ?? '') as unknown,
      );
    } catch {
      throw new FeishuCardActionError('binding_conflict');
    }
    const commandDigest = await canonicalSha256(command);
    const frozen = presentation.actions ?? [];
    const exact = await Promise.all(frozen.map(async (action) => await canonicalSha256(action)));
    if (!exact.includes(commandDigest)) throw new FeishuCardActionError('binding_conflict');
    if (
      (command.command === 'approve' || command.command === 'reject') &&
      !(await this.planHasEffect(command.planId, command.effect))
    ) throw new FeishuCardActionError('binding_conflict');

    const channel = `feishu:${input.tenantKey}`;
    const identity = await new IdentityMapper(this.db).resolve(channel, input.action.operatorOpenId);
    if (identity.principal === ANONYMOUS_PRINCIPAL) {
      throw new FeishuCardActionError('identity_unresolved');
    }
    if (
      !identity.roles.includes('human') || identity.principal.startsWith('service:') ||
      identity.principal.startsWith('agent:')
    ) throw new FeishuCardActionError('actor_not_human');
    const requiredRole = this.requiredRole(command);
    if (!identity.roles.includes(requiredRole)) {
      throw new FeishuCardActionError('actor_not_authorized');
    }
    if (
      command.command === 'approve' && candidate.task_actor_type === 'user' &&
      (candidate.task_actor_id === identity.principal ||
        candidate.task_actor_id === input.action.operatorOpenId)
    ) throw new FeishuCardActionError('self_approval_denied');

    let retryPlanItemId: string | null = null;
    if (command.command === 'retry') {
      retryPlanItemId = await this.retryTarget(command);
      if (retryPlanItemId === null) throw new FeishuCardActionError('state_conflict');
    }
    let contextTask: TaskEnvelope | null = null;
    if (command.command === 'add_context') {
      if (
        input.action.contextText === null || input.action.contextText.length > 65_536 ||
        !/\S/.test(input.action.contextText)
      ) throw new FeishuCardActionError('context_required');
      contextTask = await this.contextTask(candidate, input);
    }
    const rolesDigest = await canonicalSha256(identity.roles);
    const nonceDigest = await canonicalSha256(command.nonce);
    const receiptIdentity = await canonicalSha256({
      tenantKey: input.tenantKey,
      eventId: input.action.eventId,
      nonceDigest,
    });
    return {
      command,
      candidate,
      principal: identity.principal,
      roles: identity.roles,
      rolesDigest,
      commandDigest,
      nonceDigest,
      actionReceiptId: `feishu_action_${receiptIdentity.slice('sha256:'.length, 48)}`,
      retryPlanItemId,
      contextTask,
    };
  }

  private async claim(
    input: ExecuteFeishuCardActionInput,
    prepared: PreparedAction,
    nowIso: string,
  ): Promise<void> {
    const command = prepared.command;
    const result = await this.db.prepare(
      `INSERT INTO feishu_card_action_receipts (
         action_receipt_id, delivery_id, tenant_key, app_id, event_id,
         event_created_at, operator_open_id, principal, roles_digest, chat_id,
         message_id, card_id, presentation_id, task_id, run_id, run_version,
         task_revision_digest, plan_id, plan_version, plan_digest, base_sha,
         action_id, command, effect, context_mode, nonce_digest, command_digest,
         received_at, created_at
       )
       SELECT ?, deliveries.delivery_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM feishu_webhook_deliveries AS deliveries
       JOIN feishu_delivery_cards AS cards ON cards.card_id = ?
       JOIN feishu_delivery_card_presentations AS presentations
         ON presentations.presentation_id = ? AND presentations.card_id = cards.card_id
       JOIN runs ON runs.run_id = ? AND runs.task_id = ?
       JOIN execution_plans AS plans ON plans.plan_id = ? AND plans.run_id = runs.run_id
       WHERE deliveries.delivery_id = ? AND deliveries.tenant_key = ?
         AND deliveries.app_id = ? AND deliveries.event_id = ?
         AND deliveries.event_type = 'card.action.trigger'
         AND cards.tenant_key = ? AND cards.chat_id = ?
         AND cards.active_message_id = ? AND cards.latest_presentation_id = ?
         AND runs.version = ? AND runs.task_revision IS NOT NULL
         AND runs.base_sha = ? AND runs.active_plan_id = ?
         AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
         AND plans.plan_version = ? AND plans.digest = ? AND plans.base_sha = ?
         AND plans.status = 'active'
       ON CONFLICT DO NOTHING`,
    ).bind(
      prepared.actionReceiptId,
      input.tenantKey,
      input.appId,
      input.action.eventId,
      input.action.occurredAt,
      input.action.operatorOpenId,
      prepared.principal,
      prepared.rolesDigest,
      input.action.chatId,
      input.action.messageId,
      command.cardId,
      command.presentationId,
      command.taskId,
      command.runId,
      command.runVersion,
      command.taskRevisionDigest,
      command.planId,
      command.planVersion,
      command.planDigest,
      command.baseSha,
      command.actionId,
      command.command,
      command.effect,
      command.command === 'add_context' ? command.contextMode : null,
      prepared.nonceDigest,
      prepared.commandDigest,
      input.receivedAt,
      nowIso,
      command.cardId,
      command.presentationId,
      command.runId,
      command.taskId,
      command.planId,
      input.deliveryId,
      input.tenantKey,
      input.appId,
      input.action.eventId,
      input.tenantKey,
      input.action.chatId,
      input.action.messageId,
      command.presentationId,
      command.runVersion,
      command.baseSha,
      command.planId,
      command.planVersion,
      command.planDigest,
      command.planVersion,
      command.planDigest,
      command.baseSha,
    ).run();
    if (result.meta.changes === 1) return;
    const replay = await this.db.prepare(
      `SELECT action_receipt_id FROM feishu_card_action_receipts
       WHERE tenant_key = ? AND (event_id = ? OR nonce_digest = ?) LIMIT 1`,
    ).bind(input.tenantKey, input.action.eventId, prepared.nonceDigest)
      .first<{ action_receipt_id: string }>();
    throw new FeishuCardActionError(replay === null ? 'state_conflict' : 'replay_rejected');
  }

  private async apply(
    input: ExecuteFeishuCardActionInput,
    prepared: PreparedAction,
    now: Date,
  ): Promise<Pick<FeishuCardActionResult, 'resultKind' | 'resultId'>> {
    const command = prepared.command;
    if (command.command === 'approve' || command.command === 'reject') {
      const approvalId = command.effect === 'merge' || command.effect === 'production_deploy'
        ? await this.highRiskApproval(input, prepared, now)
        : await this.lowRiskApproval(input, prepared, now);
      return { resultKind: 'approval', resultId: approvalId };
    }
    if (command.command === 'cancel') {
      const result = await new AttemptLifecycleStore(this.db).cancelRun(
        command.runId,
        command.runVersion,
        now,
      );
      return { resultKind: 'cancellation', resultId: result.workflowCancelOutboxId };
    }
    if (command.command === 'retry') {
      if (prepared.retryPlanItemId === null) throw new Error('retry target missing');
      const result = await new RecoveryAttemptStore(this.db, this.checkpointObjects).schedule({
        runId: command.runId,
        expectedRunVersion: command.runVersion,
        planVersion: command.planVersion,
        planItemId: prepared.retryPlanItemId,
      }, now);
      return { resultKind: 'recovery_attempt', resultId: result.attemptId };
    }
    if (command.command === 'replay') {
      const result = await new WorkflowReplayStore(this.db).schedule({
        runId: command.runId,
        expectedRunVersion: command.runVersion,
        from: { stepName: VERIFY_ANALYSIS_REPLAY_STEP, stepCount: 1 },
        reason: 'feishu_card_action',
      }, now);
      return { resultKind: 'workflow_replay', resultId: result.replayId };
    }
    if (prepared.contextTask === null || input.action.contextText === null) {
      throw new FeishuCardActionError('context_required');
    }
    const contextInput = command.contextMode === 'apply_current'
      ? {
          schemaVersion: '1' as const,
          priorTaskId: command.taskId,
          task: prepared.contextTask,
          context: input.action.contextText,
          applyToCurrentRun: true as const,
          currentRun: {
            runId: command.runId,
            expectedRunVersion: command.runVersion,
            taskRevision: prepared.candidate.task_revision,
            planVersion: command.planVersion,
            planDigest: command.planDigest,
            baseSha: command.baseSha,
          },
        }
      : {
          schemaVersion: '1' as const,
          priorTaskId: command.taskId,
          task: prepared.contextTask,
          context: input.action.contextText,
          applyToCurrentRun: false as const,
        };
    const result = await new SupplementalContextRevisionStore(
      this.db,
      this.taskObjects,
      { secrets: this.secrets },
    ).accept(contextInput, now);
    return { resultKind: 'task_revision', resultId: result.taskId };
  }

  private async highRiskApproval(
    input: ExecuteFeishuCardActionInput,
    prepared: PreparedAction & { command: FeishuCardActionCommand },
    now: Date,
  ): Promise<string> {
    const command = prepared.command;
    if (command.command !== 'approve' && command.command !== 'reject') {
      throw new Error('approval command missing');
    }
    if (command.effect !== 'merge' && command.effect !== 'production_deploy') {
      throw new Error('high-risk effect missing');
    }
    const result = await new IdentityBoundApprovalStore(this.db, {
      now: () => now,
      cardActionReceiptId: prepared.actionReceiptId,
    }).decide({
      runId: command.runId,
      expectedRunVersion: command.runVersion,
      planVersion: command.planVersion,
      effect: command.effect,
      decision: command.command,
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      source: {
        schemaVersion: '1',
        provider: 'feishu',
        tenantKey: input.tenantKey,
        externalEventId: input.action.eventId,
        externalSubject: input.action.operatorOpenId,
        eventDigest: input.eventDigest,
        occurredAt: input.action.occurredAt,
      },
    });
    if (result.status !== 'accepted') {
      if (result.reason === 'identity_unresolved') {
        throw new FeishuCardActionError('identity_unresolved');
      }
      if (result.reason === 'actor_not_human') {
        throw new FeishuCardActionError('actor_not_human');
      }
      if (result.reason === 'self_approval_denied' || result.reason === 'task_actor_self_approval') {
        throw new FeishuCardActionError('self_approval_denied');
      }
      throw new FeishuCardActionError('actor_not_authorized');
    }
    return result.approvalId;
  }

  private async lowRiskApproval(
    input: ExecuteFeishuCardActionInput,
    prepared: PreparedAction,
    now: Date,
  ): Promise<string> {
    const command = prepared.command;
    if (
      (command.command !== 'approve' && command.command !== 'reject') ||
      (command.effect !== 'repo_write' && command.effect !== 'test_deploy')
    ) throw new Error('low-risk approval command missing');
    const approvalIdentity = await canonicalSha256({
      actionReceiptId: prepared.actionReceiptId,
      runId: command.runId,
      planId: command.planId,
      effect: command.effect,
      decision: command.command,
      principal: prepared.principal,
    });
    const approvalId = `approval_card_${approvalIdentity.slice('sha256:'.length, 46)}`;
    const lineageId = `approval_lineage_${approvalId}`;
    const approvalNonceDigest = await canonicalSha256({
      kind: 'card_approval',
      actionReceiptId: prepared.actionReceiptId,
    });
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO approvals (
           approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
           base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
         )
         SELECT ?, runs.run_id, runs.task_revision, plans.plan_id, plans.plan_version,
                plans.digest, runs.base_sha, ?, ?, ?, ?, ?, ?
         FROM runs JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         WHERE runs.run_id = ? AND runs.version = ? AND runs.task_id = ?
           AND runs.base_sha = ? AND runs.active_plan_id = ?
           AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
           AND plans.plan_version = ? AND plans.digest = ? AND plans.base_sha = ?
           AND plans.status = 'active'
           AND EXISTS (
             SELECT 1 FROM plan_item_effects
             WHERE plan_item_effects.plan_id = plans.plan_id
               AND plan_item_effects.effect = ?
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        approvalId,
        command.effect,
        prepared.principal,
        command.command,
        approvalNonceDigest,
        expiresAt,
        nowIso,
        command.runId,
        command.runVersion,
        command.taskId,
        command.baseSha,
        command.planId,
        command.planVersion,
        command.planDigest,
        command.planVersion,
        command.planDigest,
        command.baseSha,
        command.effect,
      ),
      this.db.prepare(
        `INSERT INTO feishu_card_action_approval_bindings (
           approval_id, action_receipt_id, approver_principal, approver_channel,
           approver_channel_user_id, roles_digest, created_at
         )
         SELECT approvals.approval_id, receipts.action_receipt_id, ?, ?, ?, ?, ?
         FROM approvals JOIN feishu_card_action_receipts AS receipts
           ON receipts.action_receipt_id = ?
         WHERE approvals.approval_id = ? AND approvals.run_id = ?
           AND approvals.plan_id = ? AND approvals.plan_version = ?
           AND approvals.plan_digest = ? AND approvals.base_sha = ?
           AND approvals.effect = ? AND approvals.actor_id = ?
           AND approvals.decision = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        prepared.principal,
        `feishu:${input.tenantKey}`,
        input.action.operatorOpenId,
        prepared.rolesDigest,
        nowIso,
        prepared.actionReceiptId,
        approvalId,
        command.runId,
        command.planId,
        command.planVersion,
        command.planDigest,
        command.baseSha,
        command.effect,
        prepared.principal,
        command.command,
      ),
      this.db.prepare(
        `INSERT INTO approval_lineages (
           lineage_id, approval_id, source_id, card_action_receipt_id,
           provider, tenant_key, external_event_id, external_event_digest,
           approver_principal, roles_digest, run_id, task_id, task_revision,
           plan_id, plan_version, plan_digest, base_sha, effect, decision,
           separation_verified, source_occurred_at, decision_recorded_at,
           expires_at, created_at
         )
         SELECT ?, approvals.approval_id, NULL, receipts.action_receipt_id,
                'feishu', receipts.tenant_key, receipts.event_id,
                deliveries.event_digest, bindings.approver_principal,
                bindings.roles_digest, approvals.run_id, runs.task_id,
                approvals.task_revision, approvals.plan_id,
                approvals.plan_version, approvals.plan_digest,
                approvals.base_sha, approvals.effect, approvals.decision,
                NULL, receipts.event_created_at, approvals.created_at,
                approvals.expires_at, ?
         FROM approvals
         JOIN feishu_card_action_approval_bindings AS bindings
           ON bindings.approval_id = approvals.approval_id
         JOIN feishu_card_action_receipts AS receipts
           ON receipts.action_receipt_id = bindings.action_receipt_id
         JOIN feishu_webhook_deliveries AS deliveries
           ON deliveries.delivery_id = receipts.delivery_id
         JOIN runs ON runs.run_id = approvals.run_id
         WHERE approvals.approval_id = ?
           AND receipts.action_receipt_id = ?
           AND receipts.tenant_key = ? AND receipts.event_id = ?
           AND receipts.principal = ? AND receipts.roles_digest = ?
           AND receipts.run_id = approvals.run_id
           AND receipts.task_id = runs.task_id
           AND receipts.plan_id = approvals.plan_id
           AND receipts.plan_version = approvals.plan_version
           AND receipts.plan_digest = approvals.plan_digest
           AND receipts.base_sha = approvals.base_sha
           AND receipts.effect = approvals.effect
           AND receipts.command = approvals.decision
         ON CONFLICT DO NOTHING`,
      ).bind(
        lineageId,
        nowIso,
        approvalId,
        prepared.actionReceiptId,
        input.tenantKey,
        input.action.eventId,
        prepared.principal,
        prepared.rolesDigest,
      ),
    ]);
    if (
      results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 ||
      results[2]?.meta.changes !== 1
    ) {
      throw new FeishuCardActionError('state_conflict');
    }
    return approvalId;
  }

  private async contextTask(
    candidate: CandidateRow,
    input: ExecuteFeishuCardActionInput,
  ): Promise<TaskEnvelope> {
    if (!candidate.task_payload_ref.startsWith('r2://')) {
      throw new FeishuCardActionError('state_conflict');
    }
    const key = candidate.task_payload_ref.slice('r2://'.length);
    if (key.length === 0 || key.includes('..')) throw new FeishuCardActionError('state_conflict');
    const object = await this.taskObjects.get(key);
    if (object === null) throw new FeishuCardActionError('effect_failed');
    let prior: TaskEnvelope;
    try {
      prior = TaskEnvelopeSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new FeishuCardActionError('state_conflict');
    }
    if (
      await taskRevisionDigest(prior) !== candidate.task_digest ||
      object.customMetadata?.taskDigest !== candidate.task_digest ||
      prior.source.revision !== candidate.task_revision
    ) throw new FeishuCardActionError('state_conflict');
    return TaskEnvelopeSchema.parse({
      ...prior,
      eventId: input.action.eventId,
      occurredAt: input.action.occurredAt,
      source: {
        ...prior.source,
        revision: `feishu-context-${input.action.eventId}`,
      },
      actor: {
        type: 'user',
        id: input.action.operatorOpenId,
      },
    });
  }

  private async retryTarget(command: FeishuCardActionCommand): Promise<string | null> {
    return await this.db.prepare(
      `SELECT items.item_id
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_items AS items ON items.plan_id = plans.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       JOIN attempts ON attempts.attempt_id = progress.active_attempt_id
       WHERE runs.run_id = ? AND runs.version = ? AND runs.state = 'blocked'
         AND plans.plan_id = ? AND plans.plan_version = ? AND plans.digest = ?
         AND plans.base_sha = ? AND plans.status = 'active'
         AND progress.status = 'in_progress' AND attempts.status = 'lost'
         AND EXISTS (
           SELECT 1 FROM outbox WHERE outbox.run_id = runs.run_id
             AND outbox.kind = 'workflow_cancel' AND outbox.delivery_state = 'settled'
         )
       ORDER BY items.position, items.item_id LIMIT 1`,
    ).bind(
      command.runId,
      command.runVersion,
      command.planId,
      command.planVersion,
      command.planDigest,
      command.baseSha,
    ).first<string>('item_id');
  }

  private async planHasEffect(planId: string, effect: FeishuCardApprovalEffect): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS present FROM plan_item_effects
       WHERE plan_id = ? AND effect = ? LIMIT 1`,
    ).bind(planId, effect).first<number>('present');
    return row === 1;
  }

  private async candidate(cardId: string, presentationId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT cards.card_id, cards.tenant_key, cards.chat_id, cards.active_message_id,
              cards.latest_presentation_id, presentations.presentation_id,
              presentations.presentation_json, tasks.task_id,
              tasks.task_revision, tasks.task_digest, tasks.payload_ref AS task_payload_ref,
              tasks.actor_type AS task_actor_type, tasks.actor_id AS task_actor_id,
              runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha, runs.active_plan_id, runs.active_plan_version,
              runs.active_plan_digest, plans.plan_id, plans.plan_version,
              plans.digest AS plan_digest, plans.base_sha AS plan_base_sha,
              plans.status AS plan_status
       FROM feishu_delivery_cards AS cards
       JOIN feishu_delivery_card_presentations AS presentations
         ON presentations.presentation_id = ? AND presentations.card_id = cards.card_id
       JOIN runs ON runs.run_id = cards.run_id
       JOIN tasks ON tasks.task_id = runs.task_id AND tasks.task_id = cards.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE cards.card_id = ?`,
    ).bind(presentationId, cardId).first<CandidateRow>();
  }

  private requiredRole(command: FeishuCardActionCommand): string {
    if (command.command === 'approve' || command.command === 'reject') {
      return `approve:${command.effect}`;
    }
    if (command.command === 'add_context') return 'context:add';
    return `operate:${command.command}`;
  }

  private failureReason(error: unknown): Extract<
    FeishuCardActionErrorCode,
    | 'state_conflict'
    | 'effect_failed'
    | 'context_required'
    | 'secret_detected'
    | 'identity_unresolved'
    | 'actor_not_human'
    | 'actor_not_authorized'
    | 'self_approval_denied'
  > {
    if (error instanceof FeishuCardActionError) {
      if (error.code === 'context_required') return 'context_required';
      if (error.code === 'secret_detected') return 'secret_detected';
      if (error.code === 'state_conflict') return 'state_conflict';
      if (error.code === 'identity_unresolved') return 'identity_unresolved';
      if (error.code === 'actor_not_human') return 'actor_not_human';
      if (error.code === 'actor_not_authorized') return 'actor_not_authorized';
      if (error.code === 'self_approval_denied') return 'self_approval_denied';
    }
    if (
      typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code?: unknown }).code === 'secret_detected'
    ) return 'secret_detected';
    return 'effect_failed';
  }

  private async recordOutcome(
    actionReceiptId: string,
    disposition: 'applied' | 'rejected',
    result: Pick<FeishuCardActionResult, 'resultKind' | 'resultId'> | null,
    reason:
      | 'state_conflict'
      | 'effect_failed'
      | 'context_required'
      | 'secret_detected'
      | 'identity_unresolved'
      | 'actor_not_human'
      | 'actor_not_authorized'
      | 'self_approval_denied'
      | null,
    nowIso: string,
  ): Promise<void> {
    const outcomeDigest = await canonicalSha256({ actionReceiptId, disposition, result, reason });
    const outcomeId = `feishu_action_outcome_${outcomeDigest.slice('sha256:'.length, 42)}`;
    const insert = await this.db.prepare(
      `INSERT INTO feishu_card_action_outcomes (
         outcome_id, action_receipt_id, disposition, result_kind, result_id,
         reason_code, completed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      outcomeId,
      actionReceiptId,
      disposition,
      result?.resultKind ?? null,
      result?.resultId ?? null,
      reason,
      nowIso,
      nowIso,
    ).run();
    if (insert.meta.changes !== 1) throw new FeishuCardActionError('state_conflict');
  }
}
