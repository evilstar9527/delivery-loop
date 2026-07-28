import { describe, expect, it } from 'vitest';
import {
  decodeFeishuCardAction,
  type FeishuCardActionCommand,
} from '../src/domain/feishu-card-action.js';
import {
  renderFeishuDeliveryCard,
  type FeishuDeliveryCardPresentationV2,
} from '../src/domain/feishu-delivery-card.js';

const command: FeishuCardActionCommand = {
  schemaVersion: '1',
  actionId: 'delivery-loop:cancel:cancel_run:0',
  command: 'cancel',
  effect: 'cancel_run',
  cardId: 'feishu_card_action_1',
  presentationId: 'feishu_presentation_action_1',
  taskId: 'task_action_1',
  runId: 'run_action_1',
  runVersion: 7,
  taskRevision: 'revision-7',
  taskRevisionDigest: `sha256:${'a'.repeat(64)}`,
  planId: 'plan_action_1',
  planVersion: 3,
  planDigest: `sha256:${'b'.repeat(64)}`,
  baseSha: 'c'.repeat(40),
  nonce: `fa_${'d'.repeat(64)}`,
};

function event(signal: unknown = command, id = command.actionId): unknown {
  return {
    header: {
      event_id: 'event-card-action-1',
      event_type: 'card.action.trigger',
      create_time: '1785024000000',
    },
    event: {
      operator: { open_id: 'ou_operator' },
      action: {
        value: { id, signal },
        form_value: { delivery_loop_context: 'bounded context' },
      },
      context: {
        open_chat_id: 'oc_delivery_loop',
        open_message_id: 'om_delivery_loop',
      },
    },
  };
}

describe('Watt-derived Feishu card action codec', () => {
  it('extracts operator/action/chat/event fields and keeps raw input out of the result', () => {
    const decoded = decodeFeishuCardAction(event());
    expect(decoded).toEqual({
      ok: true,
      action: {
        eventId: 'event-card-action-1',
        occurredAt: '2026-07-26T00:00:00.000Z',
        operatorOpenId: 'ou_operator',
        chatId: 'oc_delivery_loop',
        messageId: 'om_delivery_loop',
        command,
        contextText: 'bounded context',
      },
    });
    expect(JSON.stringify(decoded)).not.toContain('form_value');
    expect(JSON.stringify(decoded)).not.toContain('raw');
  });

  it('rejects a mismatched Watt action id and caller-selected authority fields', () => {
    expect(decodeFeishuCardAction(event(command, 'other-action'))).toEqual({
      ok: false,
      reason: 'invalid_card_action',
    });
    expect(decodeFeishuCardAction(event({ ...command, principal: 'user:admin' }))).toEqual({
      ok: false,
      reason: 'invalid_card_action',
    });
    expect(decodeFeishuCardAction(event({
      ...command,
      policy: { allow: true },
      target: { planItemId: 'caller-selected' },
    }))).toEqual({
      ok: false,
      reason: 'invalid_card_action',
    });
    expect(decodeFeishuCardAction({ header: { event_type: 'im.message.receive_v1' } })).toEqual({
      ok: false,
      reason: 'not_card_action',
    });
  });

  it('renders Watt-compatible id/signal buttons without embedding a policy conclusion', () => {
    const presentation: FeishuDeliveryCardPresentationV2 = {
      schemaVersion: '2',
      cardId: command.cardId,
      presentationId: command.presentationId,
      runId: command.runId,
      runVersion: command.runVersion,
      runState: 'blocked',
      taskRevision: command.taskRevision,
      targetRepository: 'example/repo',
      baseSha: command.baseSha,
      planVersion: command.planVersion,
      planDigest: command.planDigest,
      progress: {
        passed: 0,
        total: 1,
        requiredPassed: 0,
        requiredTotal: 1,
        inProgress: 0,
        failed: 0,
        blocked: 1,
      },
      currentGoal: 'Recover safely',
      actionUrl: null,
      checkUrl: null,
      checkpointSummary: null,
      evidenceSummary: null,
      evidenceUrl: null,
      blocker: null,
      approvedEffects: [],
      actions: [command],
      pr: { status: 'not_started', url: null },
      merge: { status: 'waiting', url: null },
      testDeploy: { status: 'not_started', url: null },
      productionDeploy: { status: 'not_started', url: null },
    };
    const encoded = JSON.stringify(renderFeishuDeliveryCard(presentation));
    expect(encoded).toContain(command.actionId);
    expect(encoded).toContain(command.nonce);
    expect(encoded).toContain('"signal"');
    expect(encoded).not.toContain('principal');
    expect(encoded).not.toContain('authorized');
    expect(encoded).not.toContain('policy');
  });
});
