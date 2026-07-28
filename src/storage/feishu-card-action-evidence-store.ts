import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';

const QuerySchema = z.object({
  tenantKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
}).strict();

interface DeliveryRow {
  delivery_id: string;
  app_id: string;
  event_type: string;
  event_created_at: string;
  verification_mode: 'encrypted' | 'plaintext';
  request_digest: string;
  event_digest: string;
  received_at: string;
}

interface ReceiptRow {
  action_receipt_id: string;
  delivery_id: string;
  event_created_at: string;
  operator_open_id: string;
  principal: string;
  roles_digest: string;
  chat_id: string;
  message_id: string;
  card_id: string;
  presentation_id: string;
  task_id: string;
  run_id: string;
  run_version: number;
  task_revision_digest: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  base_sha: string;
  action_id: string;
  command: 'approve' | 'reject' | 'cancel' | 'retry' | 'replay' | 'add_context';
  effect:
    | 'repo_write' | 'test_deploy' | 'merge' | 'production_deploy'
    | 'cancel_run' | 'retry_run' | 'replay_run' | 'add_context';
  context_mode: 'new_run' | 'apply_current' | null;
  command_digest: string;
  received_at: string;
  created_at: string;
}

interface OutcomeRow {
  outcome_id: string;
  action_receipt_id: string;
  disposition: 'applied' | 'rejected';
  result_kind:
    | 'approval' | 'cancellation' | 'recovery_attempt' | 'workflow_replay' | 'task_revision'
    | null;
  result_id: string | null;
  reason_code:
    | 'state_conflict' | 'effect_failed' | 'context_required' | 'secret_detected'
    | 'identity_unresolved' | 'actor_not_human' | 'actor_not_authorized'
    | 'self_approval_denied' | null;
  completed_at: string;
}

interface ApprovalRow {
  approval_id: string;
  decision: 'approve' | 'reject';
  effect: 'repo_write' | 'test_deploy' | 'merge' | 'production_deploy';
  expires_at: string;
  lineage_id: string;
  source_occurred_at: string;
  decision_recorded_at: string;
  external_event_digest: string;
  current_trusted: number;
}

interface CancellationRow {
  outbox_id: string;
  run_id: string;
  kind: 'workflow_cancel';
  destination: 'cloudflare_workflows';
  delivery_state: 'pending' | 'delivering' | 'settled';
}

interface RecoveryRow {
  attempt_id: string;
  run_id: string;
  status: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  recovered_from_attempt_id: string;
  recovery_checkpoint_id: string;
  base_sha: string;
  head_sha: string;
}

interface ReplayRow {
  replay_id: string;
  run_id: string;
  plan_id: string;
  plan_version: number;
  target_kind: 'system_step' | 'plan_item';
  target_step_name: string;
  target_step_type: 'do' | 'sleep' | 'waitForEvent';
  target_step_count: number;
  outbox_id: string;
  delivery_state: 'pending' | 'delivering' | 'settled';
}

interface ContextRow {
  context_id: string;
  prior_task_id: string;
  prior_task_revision: string;
  new_task_id: string;
  new_task_revision: string;
  new_task_digest: string;
  new_run_id: string;
  context_digest: string;
  apply_to_current_run: number;
  applied_run_id: string | null;
}

interface CountRow {
  deliveries: number;
  ingress_outboxes: number;
  action_receipts: number;
  action_outcomes: number;
}

export type FeishuCardActionEvidenceEffect =
  | {
    kind: 'approval';
    approvalId: string;
    decision: 'approve' | 'reject';
    effect: ApprovalRow['effect'];
    expiresAt: string;
    lineageId: string;
    sourceOccurredAt: string;
    decisionRecordedAt: string;
    externalEventDigest: string;
    currentTrusted: boolean;
  }
  | {
    kind: 'cancellation';
    outboxId: string;
    runId: string;
    deliveryState: CancellationRow['delivery_state'];
  }
  | {
    kind: 'recovery_attempt';
    attemptId: string;
    runId: string;
    status: string;
    planId: string;
    planVersion: number;
    planItemId: string;
    recoveredFromAttemptId: string;
    checkpointId: string;
    baseSha: string;
    headSha: string;
  }
  | {
    kind: 'workflow_replay';
    replayId: string;
    runId: string;
    planId: string;
    planVersion: number;
    targetKind: ReplayRow['target_kind'];
    targetStepName: string;
    targetStepType: ReplayRow['target_step_type'];
    targetStepCount: number;
    outboxId: string;
    deliveryState: ReplayRow['delivery_state'];
  }
  | {
    kind: 'task_revision';
    contextId: string;
    priorTaskId: string;
    priorTaskRevisionDigest: string;
    newTaskId: string;
    newTaskRevisionDigest: string;
    newTaskDigest: string;
    newRunId: string;
    contextDigest: string;
    contextMode: 'new_run' | 'apply_current';
    appliedRunId: string | null;
  };

export interface FeishuCardActionEvidenceProjection {
  schemaVersion: '1';
  tenantKey: string;
  eventId: string;
  counts: {
    deliveries: number;
    ingressOutboxes: number;
    actionReceipts: number;
    actionOutcomes: number;
    businessEffects: number;
  };
  delivery: {
    deliveryId: string;
    appId: string;
    eventType: 'card.action.trigger';
    eventCreatedAt: string;
    verificationMode: 'encrypted' | 'plaintext';
    requestDigest: string;
    eventDigest: string;
    receivedAt: string;
  } | null;
  action: {
    actionReceiptId: string;
    deliveryId: string;
    eventCreatedAt: string;
    operatorDigest: string;
    principalDigest: string;
    rolesDigest: string;
    chatDigest: string;
    messageId: string;
    cardId: string;
    presentationId: string;
    taskId: string;
    runId: string;
    runVersion: number;
    taskRevisionDigest: string;
    planId: string;
    planVersion: number;
    planDigest: string;
    baseSha: string;
    actionId: string;
    command: ReceiptRow['command'];
    effect: ReceiptRow['effect'];
    contextMode: ReceiptRow['context_mode'];
    commandDigest: string;
    receivedAt: string;
    createdAt: string;
    outcome: {
      outcomeId: string;
      disposition: OutcomeRow['disposition'];
      resultKind: OutcomeRow['result_kind'];
      resultId: string | null;
      reasonCode: OutcomeRow['reason_code'];
      completedAt: string;
    } | null;
    businessEffect: FeishuCardActionEvidenceEffect | null;
  } | null;
}

export class FeishuCardActionEvidenceStoreError extends Error {
  constructor(readonly code: 'invalid_query' | 'projection_conflict') {
    super(`Feishu card action evidence projection failed: ${code}`);
    this.name = 'FeishuCardActionEvidenceStoreError';
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Operations-only view. Raw callback, form text, open_id, principal and nonce never leave D1. */
export class FeishuCardActionEvidenceStore {
  constructor(private readonly db: D1Database) {}

  async get(rawQuery: { tenantKey: string; eventId: string }): Promise<FeishuCardActionEvidenceProjection> {
    const parsed = QuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new FeishuCardActionEvidenceStoreError('invalid_query');
    const { tenantKey, eventId } = parsed.data;
    const results = await this.db.batch([
      this.db.prepare(
        `SELECT delivery_id, app_id, event_type, event_created_at, verification_mode,
                request_digest, event_digest, received_at
         FROM feishu_webhook_deliveries WHERE tenant_key = ? AND event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT action_receipt_id, delivery_id, event_created_at, operator_open_id,
                principal, roles_digest, chat_id, message_id, card_id, presentation_id,
                task_id, run_id, run_version, task_revision_digest, plan_id, plan_version,
                plan_digest, base_sha, action_id, command, effect, context_mode,
                command_digest, received_at, created_at
         FROM feishu_card_action_receipts WHERE tenant_key = ? AND event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT outcomes.outcome_id, outcomes.action_receipt_id, outcomes.disposition,
                outcomes.result_kind, outcomes.result_id, outcomes.reason_code,
                outcomes.completed_at
         FROM feishu_card_action_outcomes AS outcomes
         JOIN feishu_card_action_receipts AS receipts
           ON receipts.action_receipt_id = outcomes.action_receipt_id
         WHERE receipts.tenant_key = ? AND receipts.event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT approvals.approval_id, approvals.decision, approvals.effect,
                approvals.expires_at, lineage.lineage_id, lineage.source_occurred_at,
                lineage.decision_recorded_at, lineage.external_event_digest,
                CASE WHEN approvals.decision = 'approve' AND EXISTS (
                  SELECT 1 FROM trusted_effect_approvals AS trusted
                  WHERE trusted.approval_id = approvals.approval_id
                ) THEN 1 ELSE 0 END AS current_trusted
         FROM feishu_card_action_receipts AS receipts
         JOIN feishu_card_action_outcomes AS outcomes
           ON outcomes.action_receipt_id = receipts.action_receipt_id
          AND outcomes.disposition = 'applied' AND outcomes.result_kind = 'approval'
         JOIN approvals ON approvals.approval_id = outcomes.result_id
         JOIN approval_lineages AS lineage
           ON lineage.approval_id = approvals.approval_id
          AND lineage.card_action_receipt_id = receipts.action_receipt_id
         WHERE receipts.tenant_key = ? AND receipts.event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT effect.outbox_id, effect.run_id, effect.kind, effect.destination,
                effect.delivery_state
         FROM feishu_card_action_receipts AS receipts
         JOIN feishu_card_action_outcomes AS outcomes
           ON outcomes.action_receipt_id = receipts.action_receipt_id
          AND outcomes.disposition = 'applied' AND outcomes.result_kind = 'cancellation'
         JOIN outbox AS effect ON effect.outbox_id = outcomes.result_id
          AND effect.run_id = receipts.run_id AND effect.kind = 'workflow_cancel'
          AND effect.destination = 'cloudflare_workflows'
         WHERE receipts.tenant_key = ? AND receipts.event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT recovery.attempt_id, recovery.run_id, recovery.status,
                recovery.plan_id, recovery.plan_version, recovery.plan_item_id,
                recovery.recovered_from_attempt_id, recovery.recovery_checkpoint_id,
                recovery.base_sha, recovery.head_sha
         FROM feishu_card_action_receipts AS receipts
         JOIN feishu_card_action_outcomes AS outcomes
           ON outcomes.action_receipt_id = receipts.action_receipt_id
          AND outcomes.disposition = 'applied' AND outcomes.result_kind = 'recovery_attempt'
         JOIN attempts AS recovery ON recovery.attempt_id = outcomes.result_id
          AND recovery.run_id = receipts.run_id
         JOIN checkpoints ON checkpoints.checkpoint_id = recovery.recovery_checkpoint_id
          AND checkpoints.attempt_id = recovery.recovered_from_attempt_id
          AND checkpoints.plan_id = recovery.plan_id
          AND checkpoints.plan_version = recovery.plan_version
          AND checkpoints.plan_item_id = recovery.plan_item_id
          AND checkpoints.head_sha = recovery.head_sha
         WHERE receipts.tenant_key = ? AND receipts.event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT replay.replay_id, replay.run_id, replay.plan_id, replay.plan_version,
                replay.target_kind, replay.target_step_name, replay.target_step_type,
                replay.target_step_count, effect.outbox_id, effect.delivery_state
         FROM feishu_card_action_receipts AS receipts
         JOIN feishu_card_action_outcomes AS outcomes
           ON outcomes.action_receipt_id = receipts.action_receipt_id
          AND outcomes.disposition = 'applied' AND outcomes.result_kind = 'workflow_replay'
         JOIN workflow_replays AS replay ON replay.replay_id = outcomes.result_id
          AND replay.run_id = receipts.run_id
         JOIN outbox AS effect
           ON effect.payload_ref = 'd1://workflow-replays/' || replay.replay_id
          AND effect.run_id = replay.run_id AND effect.kind = 'workflow_replay'
         WHERE receipts.tenant_key = ? AND receipts.event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT context.context_id, context.prior_task_id, context.prior_task_revision,
                context.new_task_id, context.new_task_revision, context.new_task_digest,
                context.new_run_id, context.context_digest, context.apply_to_current_run,
                context.applied_run_id
         FROM feishu_card_action_receipts AS receipts
         JOIN feishu_card_action_outcomes AS outcomes
           ON outcomes.action_receipt_id = receipts.action_receipt_id
          AND outcomes.disposition = 'applied' AND outcomes.result_kind = 'task_revision'
         JOIN supplemental_context_revisions AS context
           ON context.new_task_id = outcomes.result_id
          AND context.prior_task_id = receipts.task_id
         WHERE receipts.tenant_key = ? AND receipts.event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM feishu_webhook_deliveries
             WHERE tenant_key = ? AND event_id = ?) AS deliveries,
           (SELECT COUNT(*) FROM feishu_ingress_outbox
             WHERE tenant_key = ? AND event_id = ?) AS ingress_outboxes,
           (SELECT COUNT(*) FROM feishu_card_action_receipts
             WHERE tenant_key = ? AND event_id = ?) AS action_receipts,
           (SELECT COUNT(*) FROM feishu_card_action_outcomes AS outcomes
              JOIN feishu_card_action_receipts AS receipts
                ON receipts.action_receipt_id = outcomes.action_receipt_id
             WHERE receipts.tenant_key = ? AND receipts.event_id = ?) AS action_outcomes`,
      ).bind(
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
      ),
    ]);
    const deliveries = (results[0]?.results ?? []) as unknown as DeliveryRow[];
    const receipts = (results[1]?.results ?? []) as unknown as ReceiptRow[];
    const outcomes = (results[2]?.results ?? []) as unknown as OutcomeRow[];
    const approvalRows = (results[3]?.results ?? []) as unknown as ApprovalRow[];
    const cancellationRows = (results[4]?.results ?? []) as unknown as CancellationRow[];
    const recoveryRows = (results[5]?.results ?? []) as unknown as RecoveryRow[];
    const replayRows = (results[6]?.results ?? []) as unknown as ReplayRow[];
    const contextRows = (results[7]?.results ?? []) as unknown as ContextRow[];
    const counts = (results[8]?.results[0] ?? null) as unknown as CountRow | null;
    const effectCount = approvalRows.length + cancellationRows.length + recoveryRows.length +
      replayRows.length + contextRows.length;
    if (
      counts === null || deliveries.length > 1 || receipts.length > 1 || outcomes.length > 1 ||
      effectCount > 1 || counts.deliveries !== deliveries.length ||
      counts.action_receipts !== receipts.length || counts.action_outcomes !== outcomes.length ||
      !Object.values(counts).every(validCount) ||
      (receipts.length === 0 && (outcomes.length !== 0 || effectCount !== 0)) ||
      (outcomes[0]?.disposition === 'rejected' && effectCount !== 0) ||
      (outcomes[0]?.disposition === 'applied' && effectCount !== 1)
    ) throw new FeishuCardActionEvidenceStoreError('projection_conflict');

    const delivery = deliveries[0];
    if (delivery !== undefined && delivery.event_type !== 'card.action.trigger') {
      throw new FeishuCardActionEvidenceStoreError('projection_conflict');
    }
    const receipt = receipts[0];
    const outcome = outcomes[0];
    const effect = await this.effect(
      approvalRows[0],
      cancellationRows[0],
      recoveryRows[0],
      replayRows[0],
      contextRows[0],
    );
    return {
      schemaVersion: '1',
      tenantKey,
      eventId,
      counts: {
        deliveries: counts.deliveries,
        ingressOutboxes: counts.ingress_outboxes,
        actionReceipts: counts.action_receipts,
        actionOutcomes: counts.action_outcomes,
        businessEffects: effectCount,
      },
      delivery: delivery === undefined ? null : {
        deliveryId: delivery.delivery_id,
        appId: delivery.app_id,
        eventType: 'card.action.trigger',
        eventCreatedAt: delivery.event_created_at,
        verificationMode: delivery.verification_mode,
        requestDigest: delivery.request_digest,
        eventDigest: delivery.event_digest,
        receivedAt: delivery.received_at,
      },
      action: receipt === undefined ? null : {
        actionReceiptId: receipt.action_receipt_id,
        deliveryId: receipt.delivery_id,
        eventCreatedAt: receipt.event_created_at,
        operatorDigest: await canonicalSha256(receipt.operator_open_id),
        principalDigest: await canonicalSha256(receipt.principal),
        rolesDigest: receipt.roles_digest,
        chatDigest: await canonicalSha256(receipt.chat_id),
        messageId: receipt.message_id,
        cardId: receipt.card_id,
        presentationId: receipt.presentation_id,
        taskId: receipt.task_id,
        runId: receipt.run_id,
        runVersion: receipt.run_version,
        taskRevisionDigest: receipt.task_revision_digest,
        planId: receipt.plan_id,
        planVersion: receipt.plan_version,
        planDigest: receipt.plan_digest,
        baseSha: receipt.base_sha,
        actionId: receipt.action_id,
        command: receipt.command,
        effect: receipt.effect,
        contextMode: receipt.context_mode,
        commandDigest: receipt.command_digest,
        receivedAt: receipt.received_at,
        createdAt: receipt.created_at,
        outcome: outcome === undefined ? null : {
          outcomeId: outcome.outcome_id,
          disposition: outcome.disposition,
          resultKind: outcome.result_kind,
          resultId: outcome.result_id,
          reasonCode: outcome.reason_code,
          completedAt: outcome.completed_at,
        },
        businessEffect: effect,
      },
    };
  }

  private async effect(
    approval: ApprovalRow | undefined,
    cancellation: CancellationRow | undefined,
    recovery: RecoveryRow | undefined,
    replay: ReplayRow | undefined,
    context: ContextRow | undefined,
  ): Promise<FeishuCardActionEvidenceEffect | null> {
    if (approval !== undefined) return {
      kind: 'approval',
      approvalId: approval.approval_id,
      decision: approval.decision,
      effect: approval.effect,
      expiresAt: approval.expires_at,
      lineageId: approval.lineage_id,
      sourceOccurredAt: approval.source_occurred_at,
      decisionRecordedAt: approval.decision_recorded_at,
      externalEventDigest: approval.external_event_digest,
      currentTrusted: approval.current_trusted === 1,
    };
    if (cancellation !== undefined) return {
      kind: 'cancellation',
      outboxId: cancellation.outbox_id,
      runId: cancellation.run_id,
      deliveryState: cancellation.delivery_state,
    };
    if (recovery !== undefined) return {
      kind: 'recovery_attempt',
      attemptId: recovery.attempt_id,
      runId: recovery.run_id,
      status: recovery.status,
      planId: recovery.plan_id,
      planVersion: recovery.plan_version,
      planItemId: recovery.plan_item_id,
      recoveredFromAttemptId: recovery.recovered_from_attempt_id,
      checkpointId: recovery.recovery_checkpoint_id,
      baseSha: recovery.base_sha,
      headSha: recovery.head_sha,
    };
    if (replay !== undefined) return {
      kind: 'workflow_replay',
      replayId: replay.replay_id,
      runId: replay.run_id,
      planId: replay.plan_id,
      planVersion: replay.plan_version,
      targetKind: replay.target_kind,
      targetStepName: replay.target_step_name,
      targetStepType: replay.target_step_type,
      targetStepCount: replay.target_step_count,
      outboxId: replay.outbox_id,
      deliveryState: replay.delivery_state,
    };
    if (context !== undefined) return {
      kind: 'task_revision',
      contextId: context.context_id,
      priorTaskId: context.prior_task_id,
      priorTaskRevisionDigest: await canonicalSha256({
        kind: 'task_revision',
        value: context.prior_task_revision,
      }),
      newTaskId: context.new_task_id,
      newTaskRevisionDigest: await canonicalSha256({
        kind: 'task_revision',
        value: context.new_task_revision,
      }),
      newTaskDigest: context.new_task_digest,
      newRunId: context.new_run_id,
      contextDigest: context.context_digest,
      contextMode: context.apply_to_current_run === 1 ? 'apply_current' : 'new_run',
      appliedRunId: context.applied_run_id,
    };
    return null;
  }
}
