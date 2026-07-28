import { describe, expect, it } from 'vitest';
import {
  FeishuDeliveryCardPresentationV2Schema,
  renderFeishuDeliveryCard,
  type FeishuDeliveryCardPresentationV2,
} from '../src/domain/feishu-delivery-card.js';
import {
  feishuDeliveryCardPresentationFromRow,
} from '../src/storage/feishu-delivery-card-presentation.js';

const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;

const PRESENTATION: FeishuDeliveryCardPresentationV2 = {
  schemaVersion: '2',
  cardId: 'feishu_card_run_status',
  presentationId: 'feishu_presentation_run_status_1',
  runId: 'run-status-card',
  runVersion: 12,
  runState: 'blocked',
  taskRevision: 'revision-42',
  targetRepository: 'example/delivery-loop',
  baseSha: 'a'.repeat(40),
  planVersion: 7,
  planDigest: PLAN_DIGEST,
  progress: {
    passed: 2,
    total: 4,
    requiredPassed: 2,
    requiredTotal: 3,
    inProgress: 0,
    failed: 0,
    blocked: 1,
  },
  currentGoal: 'Repair [unsafe](https://evil.example) *without* repeating dispatch',
  actionUrl: 'https://github.com/example/delivery-loop/actions/runs/12345',
  checkUrl: 'https://github.com/example/delivery-loop/actions/runs/12345/job/67890',
  checkpointSummary: 'Checkpoint 3 persisted; raw transcript is not embedded.',
  evidenceSummary: 'Full verification passed; large logs remain external.',
  evidenceUrl: 'https://github.com/example/delivery-loop/actions/runs/12345',
  blocker: {
    reason: 'repeated_fingerprint',
    attemptCount: 2,
    attemptedPaths: ['repository_inspection', 'targeted_test'],
    neededHumanInput: 'provide_reproduction',
  },
  approvedEffects: [{
    effect: 'repo_write',
    expiresAt: '2026-07-26T09:00:00.000Z',
  }],
  pr: {
    status: 'open',
    url: 'https://github.com/example/delivery-loop/pull/42',
  },
  merge: { status: 'waiting', url: null },
  testDeploy: { status: 'not_started', url: null },
  productionDeploy: { status: 'not_started', url: null },
};

describe('Feishu full run-status card v2', () => {
  it('renders every DoD status field while treating summaries as escaped data', () => {
    const card = renderFeishuDeliveryCard(PRESENTATION);
    const encoded = JSON.stringify(card);
    expect(card.config).toEqual({ wide_screen_mode: true, update_multi: true });
    expect(card.elements.length).toBeGreaterThan(8);
    expect(encoded).toContain('blocked');
    expect(encoded).toContain('revision-42');
    expect(encoded).toContain('example/delivery-loop');
    expect(encoded).toContain('v7');
    expect(encoded).toContain(PLAN_DIGEST);
    expect(encoded).toContain('2/4');
    expect(encoded).toContain('actions/runs/12345');
    expect(encoded).toContain('pull/42');
    expect(encoded).toContain('repo_write');
    expect(encoded).toContain('Full verification passed');
    expect(encoded).toContain('Provide a minimal reproduction');
    expect(encoded).not.toContain('[unsafe](https://evil.example)');
    expect(encoded).not.toContain('rawLog');
  });

  it('is strict and rejects raw logs, unsafe links, invalid progress, and unknown effects', () => {
    expect(FeishuDeliveryCardPresentationV2Schema.safeParse({
      ...PRESENTATION,
      rawLog: 'CANARY_RAW_LOG_BODY',
    }).success).toBe(false);
    expect(FeishuDeliveryCardPresentationV2Schema.safeParse({
      ...PRESENTATION,
      actionUrl: 'https://user@example.com/action',
    }).success).toBe(false);
    expect(FeishuDeliveryCardPresentationV2Schema.safeParse({
      ...PRESENTATION,
      progress: { ...PRESENTATION.progress, passed: 5 },
    }).success).toBe(false);
    expect(FeishuDeliveryCardPresentationV2Schema.safeParse({
      ...PRESENTATION,
      approvedEffects: [{ effect: 'production_override', expiresAt: '2026-07-26T09:00:00.000Z' }],
    }).success).toBe(false);
  });

  it('rehydrates an in-flight schema v1 row without rewriting it as v2', () => {
    const presentation = feishuDeliveryCardPresentationFromRow({
      presentation_id: 'presentation-v1',
      card_id: 'card-v1',
      run_id: 'run-v1',
      run_version: 4,
      schema_version: '1',
      presentation_json: null,
      pr_status: 'open',
      pr_url: 'https://github.com/example/repo/pull/1',
      merge_status: 'waiting',
      merge_url: null,
      test_deploy_status: 'not_started',
      test_deploy_url: null,
      production_deploy_status: 'not_started',
      production_deploy_url: null,
    });
    expect(presentation.schemaVersion).toBe('1');
    expect(renderFeishuDeliveryCard(presentation).elements).toHaveLength(4);
    expect(() => feishuDeliveryCardPresentationFromRow({
      presentation_id: 'presentation-v1',
      card_id: 'card-v1',
      run_id: 'run-v1',
      run_version: 4,
      schema_version: '1',
      presentation_json: JSON.stringify(PRESENTATION),
      pr_status: 'open',
      pr_url: 'https://github.com/example/repo/pull/1',
      merge_status: 'waiting',
      merge_url: null,
      test_deploy_status: 'not_started',
      test_deploy_url: null,
      production_deploy_status: 'not_started',
      production_deploy_url: null,
    })).toThrow('Feishu card presentation is invalid');
  });
});
