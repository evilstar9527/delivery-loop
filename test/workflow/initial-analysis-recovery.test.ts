/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  computeExecutionPlanDigest,
  type ExecutionPlanBodyV1,
  type ExecutionPlanV1,
} from '../../src/domain/plan.js';
import { InitialAnalysisReconciler } from
  '../../src/reconciliation/initial-analysis-reconciler.js';
import { AnalysisAttemptContextStore } from '../../src/storage/analysis-attempt-store.js';
import { ExecutionPlanStore } from '../../src/storage/execution-plan-store.js';
import { RunnerAttemptStore, type RunnerAuthorization } from
  '../../src/storage/runner-attempt-store.js';
import { type TaskEnvelope, taskRevisionDigest } from '../../src/domain/task.js';

const RUN_ID = 'run-initial-analysis-recovery';
const TASK_ID = 'task-initial-analysis-recovery';
const ROOT_ATTEMPT_ID = 'analysis-root-initial-recovery';
const BASE_SHA = '8'.repeat(40);
const NOW = '2026-08-13T01:00:00.000Z';
const FAILURE_ID = 'failure-initial-analysis-recovery';
const CAPACITY_FAILURE_ID = 'failure-initial-analysis-capacity-3';
const CAPACITY_BLOCKER_ID = 'blocker-initial-analysis-capacity';

const task: TaskEnvelope = {
  schemaVersion: '1',
  eventId: 'event-initial-analysis-recovery',
  occurredAt: NOW,
  source: {
    system: 'manual',
    tenantKey: 'initial-analysis-recovery',
    taskKey: TASK_ID,
    revision: 'revision-1',
    url: 'https://tasks.example.test/initial-analysis-recovery',
  },
  actor: { type: 'user', id: 'user-initial-analysis-recovery' },
  target: {
    owner: 'example',
    repo: 'delivery-target',
    baseBranch: 'main',
    environment: 'none',
  },
  intent: {
    kind: 'requirement',
    title: 'Recover the initial analysis',
    description: 'Create a replacement without creating another Task or Run.',
    acceptanceCriteria: ['The replacement Plan becomes the active Plan.'],
    priority: 'p1',
  },
  policy: {
    allowRepositoryWrite: false,
    allowTestDeploy: false,
    allowProductionDeploy: false,
    requireHumanApproval: true,
  },
};

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM workflow_signals'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_plaintext_source_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_source_snapshot_capacity_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_tool_bridge_secret_value_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_tool_bridge_scope_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_tool_bridge_transport_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_tool_bridge_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_inventory_adapter_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_capacity_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM initial_analysis_retries'),
    env.DB_CONTROL.prepare('DELETE FROM quota_model_reservations'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_heartbeat_receipts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures'),
    env.DB_CONTROL.prepare('DELETE FROM run_blockers'),
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
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM tool_call_traces'),
    env.DB_CONTROL.prepare('DELETE FROM model_usage'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seedFailedRoot(overrides: {
  scopeAttemptCount?: number;
  consecutiveFingerprintCount?: number;
  blocker?: boolean;
  plan?: boolean;
} = {}): Promise<void> {
  const digest = await taskRevisionDigest(task);
  const key = `tasks/${TASK_ID}/${digest.slice('sha256:'.length)}.json`;
  await env.TASK_OBJECTS.put(key, JSON.stringify(task), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { taskDigest: digest },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'initial-analysis-recovery', ?, 'revision-1', ?, ?,
                 'user', 'user-initial-analysis-recovery', 'example/delivery-target',
                 'main', 'none', 'requirement', 'Recover initial analysis', 'p1',
                 1, 0, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, digest, `r2://${key}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, digest, BASE_SHA, RUN_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'failed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 3, 1, ?, ?)`,
    ).bind(ROOT_ATTEMPT_ID, RUN_ID, BASE_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempt_failures (
       failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
       retry_scope_digest, fingerprint_digest, failure_class, failure_code,
       failure_site, needed_human_input, scope_attempt_count,
       consecutive_fingerprint_count, revoked_lease_generation,
       occurred_at, created_at
     ) VALUES (?, ?, ?, 1, 'event-initial-analysis-failed', 1, ?, ?,
               'policy_denied', 'tool_policy_denied', 'external_reconciliation',
               'approve_policy_change', ?, ?, 1, ?, ?)`,
  ).bind(
    FAILURE_ID,
    RUN_ID,
    ROOT_ATTEMPT_ID,
    `sha256:${'a'.repeat(64)}`,
    `sha256:${'b'.repeat(64)}`,
    overrides.scopeAttemptCount ?? 1,
    overrides.consecutiveFingerprintCount ?? 1,
    NOW,
    NOW,
  ).run();
  if (overrides.blocker === true) {
    await env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input,
         created_at
       ) VALUES ('blocker-initial-analysis', ?, 'attempt_limit', ?, ?, 3, 1,
                 'manual_investigation', ?)`,
    ).bind(RUN_ID, `sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, NOW).run();
  }
  if (overrides.plan === true) {
    await env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES ('plan-untrusted-existing', ?, 1, 'revision-1', ?, ?, 'validated',
                 ?, 'Existing proposal blocks recovery.', ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, `sha256:${'c'.repeat(64)}`, ROOT_ATTEMPT_ID, NOW, NOW).run();
  }
}

async function seedCapacityBlocked(overrides: {
  failureCode?: 'unknown_failure' | 'tool_unavailable';
  failureSite?: 'repo_snapshot' | 'tool_repo_read';
  blocker?: boolean;
  plan?: boolean;
} = {}): Promise<void> {
  await seedFailedRoot();
  const scopeDigest = `sha256:${'e'.repeat(64)}`;
  const firstFingerprint = `sha256:${'f'.repeat(64)}`;
  const repeatedFingerprint = `sha256:${'1'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 4, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `UPDATE attempt_failures
       SET retry_scope_digest = ?, fingerprint_digest = ?,
           failure_class = 'unknown', failure_code = 'unknown_failure',
           failure_site = 'repo_snapshot', needed_human_input = 'manual_investigation',
           scope_attempt_count = 1, consecutive_fingerprint_count = 1
       WHERE failure_id = ?`,
    ).bind(scopeDigest, firstFingerprint, FAILURE_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES ('analysis-capacity-retry-1', ?, 2, 'analysis', 'failed', ?,
                 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 3, 1, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES ('analysis-capacity-retry-2', ?, 3, 'analysis', 'failed', ?,
                 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 3, 1, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-initial-analysis-capacity-2', ?, 'analysis-capacity-retry-1', 2,
                 'event-initial-analysis-capacity-2', 1, ?, ?, 'unknown',
                 'unknown_failure', 'repo_snapshot', 'manual_investigation', 2, 1, 1, ?, ?)`,
    ).bind(RUN_ID, scopeDigest, firstFingerprint, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES (?, ?, 'analysis-capacity-retry-2', 3,
                 'event-initial-analysis-capacity-3', 1, ?, ?, ?, ?, ?,
                 'manual_investigation', 3, 2, 1, ?, ?)`,
    ).bind(
      CAPACITY_FAILURE_ID,
      RUN_ID,
      scopeDigest,
      repeatedFingerprint,
      overrides.failureCode === 'tool_unavailable' ? 'tool_error' : 'unknown',
      overrides.failureCode ?? 'unknown_failure',
      overrides.failureSite ?? 'repo_snapshot',
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO initial_analysis_retries (
         retry_id, run_id, failure_id, failed_attempt_id,
         retry_attempt_id, retry_sequence, created_at
       ) VALUES ('initial-analysis-capacity-retry-1', ?, ?, ?,
                 'analysis-capacity-retry-1', 1, ?)`,
    ).bind(RUN_ID, FAILURE_ID, ROOT_ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO initial_analysis_retries (
         retry_id, run_id, failure_id, failed_attempt_id,
         retry_attempt_id, retry_sequence, created_at
       ) VALUES ('initial-analysis-capacity-retry-2', ?,
                 'failure-initial-analysis-capacity-2', 'analysis-capacity-retry-1',
                 'analysis-capacity-retry-2', 2, ?)`,
    ).bind(RUN_ID, NOW),
  ]);
  if (overrides.blocker !== false) {
    await env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES (?, ?, 'repeated_fingerprint', ?, ?, 3, 2,
                 'manual_investigation', ?)`,
    ).bind(CAPACITY_BLOCKER_ID, RUN_ID, scopeDigest, repeatedFingerprint, NOW).run();
  }
  if (overrides.plan === true) {
    await env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES ('plan-capacity-existing', ?, 1, 'revision-1', ?, ?, 'validated',
                 'analysis-capacity-retry-2', 'Existing proposal blocks recovery.', ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, `sha256:${'2'.repeat(64)}`, NOW, NOW).run();
  }
}

async function seedInventoryAdapterBlocked(options: {
  modelReservation?: boolean;
} = {}): Promise<string> {
  await seedCapacityBlocked();
  const reconciler = new InitialAnalysisReconciler(env.DB_CONTROL, {
    now: () => new Date(NOW),
  });
  expect(await reconciler.reconcileCapacityFailures(1)).toBe(1);
  const recovery = await env.DB_CONTROL.prepare(
    `SELECT replacement_attempt_id FROM initial_analysis_capacity_recoveries WHERE run_id = ?`,
  ).bind(RUN_ID).first<{ replacement_attempt_id: string }>();
  if (recovery === null) throw new Error('missing capacity replacement');
  const scopeDigest = `sha256:${'e'.repeat(64)}`;
  const fingerprintDigest = `sha256:${'3'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', version = 3, lease_generation = 1,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, recovery.replacement_attempt_id),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 5, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-inventory-adapter-capacity', ?, ?, 4,
                 'event-inventory-adapter-capacity', 1, ?, ?, 'invalid_output',
                 'invalid_agent_output', 'agent_output', 'manual_investigation',
                 4, 1, 1, ?, ?)`,
    ).bind(RUN_ID, recovery.replacement_attempt_id, scopeDigest, fingerprintDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-inventory-adapter-capacity', ?, 'attempt_limit', ?, ?,
                 4, 1, 'manual_investigation', ?)`,
    ).bind(RUN_ID, scopeDigest, fingerprintDigest, NOW),
  ]);
  if (options.modelReservation === true) {
    await env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, status, expires_at, created_at, updated_at
       ) VALUES ('reservation-adapter-capacity', ?, ?,
                 'codex-gpt-5p6-terra-medium-tool-loop-20260811', 1, 1,
                 'released', '2026-08-13T02:00:00.000Z', ?, ?)`,
    ).bind(recovery.replacement_attempt_id, RUN_ID, NOW, NOW).run();
  }
  return recovery.replacement_attempt_id;
}

async function seedToolBridgeBlocked(overrides: {
  traceResult?: 'upstream_error' | 'success';
  evidence?: boolean;
  blockerReason?: 'external_dependency' | 'attempt_limit';
} = {}): Promise<string> {
  const failedAttemptId = await seedInventoryAdapterBlocked();
  const reconciler = new InitialAnalysisReconciler(env.DB_CONTROL, {
    now: () => new Date(NOW),
  });
  expect(await reconciler.reconcileInventoryAdapterFailures(1)).toBe(1);
  const adapter = await env.DB_CONTROL.prepare(
    `SELECT recovery_id, replacement_attempt_id
     FROM initial_analysis_inventory_adapter_recoveries WHERE run_id = ?`,
  ).bind(RUN_ID).first<{ recovery_id: string; replacement_attempt_id: string }>();
  if (adapter === null) throw new Error('missing adapter replacement');
  const scopeDigest = `sha256:${'4'.repeat(64)}`;
  const fingerprintDigest = `sha256:${'5'.repeat(64)}`;
  const profile = 'codex-gpt-5p6-terra-medium-tool-loop-20260811';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', version = 3, lease_generation = 1,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, adapter.replacement_attempt_id),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 6, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-tool-bridge-external', ?, ?, 5,
                 'event-tool-bridge-external', 1, ?, ?, 'tool_error',
                 'tool_unavailable', 'tool_logs_search', 'resolve_external_dependency',
                 5, 1, 1, ?, ?)`,
    ).bind(RUN_ID, adapter.replacement_attempt_id, scopeDigest, fingerprintDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-tool-bridge-external', ?, ?, ?, ?,
                 5, 1, 'resolve_external_dependency', ?)`,
    ).bind(
      RUN_ID,
      overrides.blockerReason ?? 'external_dependency',
      scopeDigest,
      fingerprintDigest,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace-tool-bridge-external', ?, ?, 'logs/search',
                 'logs:read', 'read', 913, ?, ?)`,
    ).bind(
      RUN_ID,
      adapter.replacement_attempt_id,
      overrides.traceResult ?? 'upstream_error',
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, status, expires_at, created_at, updated_at
       ) VALUES ('reservation-tool-bridge-external', ?, ?, ?, 1, 1,
                 'settled', '2026-08-13T02:00:00.000Z', ?, ?)`,
    ).bind(adapter.replacement_attempt_id, RUN_ID, profile, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO model_usage (
         usage_id, at, provider, model, run_id, attempt_id, tenant_key,
         repository, principal, input_tokens, cached_input_tokens, output_tokens,
         reasoning_output_tokens, cost_microusd, source_digest, created_at
       ) VALUES ('usage-tool-bridge-external', ?, 'delivery_loop_relay', 'gpt-5.6-terra',
                 ?, ?, 'initial-analysis-recovery', 'example/delivery-target',
                 'service:delivery-loop', 1, 0, 1, 1, 1, ?, ?)`,
    ).bind(
      NOW,
      RUN_ID,
      adapter.replacement_attempt_id,
      `sha256:${'6'.repeat(64)}`,
      NOW,
    ),
  ]);
  if (overrides.evidence === true) {
    await env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, kind, status, summary,
         verification_status, observed_at, created_at
       ) VALUES ('evidence-tool-bridge-external', ?, ?, 'diagnostic', 'passed',
                 'Existing evidence blocks recovery.', 'verified', ?, ?)`,
    ).bind(RUN_ID, adapter.replacement_attempt_id, NOW, NOW).run();
  }
  expect(failedAttemptId).toBeTruthy();
  return adapter.replacement_attempt_id;
}

async function seedToolBridgeTransportBlocked(): Promise<string> {
  await seedToolBridgeBlocked({ blockerReason: 'attempt_limit' });
  const reconciler = new InitialAnalysisReconciler(env.DB_CONTROL, {
    now: () => new Date(NOW),
  });
  expect(await reconciler.reconcileToolBridgeFailures(1)).toBe(1);
  const provider = await env.DB_CONTROL.prepare(
    `SELECT recovery_id, replacement_attempt_id
     FROM initial_analysis_tool_bridge_recoveries WHERE run_id = ?`,
  ).bind(RUN_ID).first<{ recovery_id: string; replacement_attempt_id: string }>();
  if (provider === null) throw new Error('missing Tool Bridge provider replacement');
  const scopeDigest = `sha256:${'7'.repeat(64)}`;
  const fingerprintDigest = `sha256:${'8'.repeat(64)}`;
  const profile = 'codex-gpt-5p6-terra-medium-tool-loop-20260811';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', version = 3, lease_generation = 1,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, provider.replacement_attempt_id),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 8, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-tool-bridge-transport', ?, ?, 6,
                 'event-tool-bridge-transport', 1, ?, ?, 'tool_error',
                 'tool_unavailable', 'tool_logs_search', 'resolve_external_dependency',
                 6, 2, 1, ?, ?)`,
    ).bind(RUN_ID, provider.replacement_attempt_id, scopeDigest, fingerprintDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-tool-bridge-transport', ?, 'repeated_fingerprint', ?, ?,
                 6, 2, 'resolve_external_dependency', ?)`,
    ).bind(RUN_ID, scopeDigest, fingerprintDigest, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace-tool-bridge-transport', ?, ?, 'logs/search',
                 'logs:read', 'read', 629, 'upstream_error', ?)`,
    ).bind(RUN_ID, provider.replacement_attempt_id, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, status, expires_at, created_at, updated_at
       ) VALUES ('reservation-tool-bridge-transport', ?, ?, ?, 1, 1,
                 'settled', '2026-08-13T02:00:00.000Z', ?, ?)`,
    ).bind(provider.replacement_attempt_id, RUN_ID, profile, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO model_usage (
         usage_id, at, provider, model, run_id, attempt_id, tenant_key,
         repository, principal, input_tokens, cached_input_tokens, output_tokens,
         reasoning_output_tokens, cost_microusd, source_digest, created_at
       ) VALUES ('usage-tool-bridge-transport', ?, 'delivery_loop_relay', 'gpt-5.6-terra',
                 ?, ?, 'initial-analysis-recovery', 'example/delivery-target',
                 'service:delivery-loop', 1, 0, 1, 1, 1, ?, ?)`,
    ).bind(
      NOW,
      RUN_ID,
      provider.replacement_attempt_id,
      `sha256:${'9'.repeat(64)}`,
      NOW,
    ),
  ]);
  return provider.replacement_attempt_id;
}

async function seedToolBridgeScopeBlocked(): Promise<string> {
  const failedAttemptId = await seedToolBridgeTransportBlocked();
  const reconciler = new InitialAnalysisReconciler(env.DB_CONTROL, {
    now: () => new Date(NOW),
  });
  expect(await reconciler.reconcileToolBridgeTransportFailures(1)).toBe(1);
  const transport = await env.DB_CONTROL.prepare(
    `SELECT recovery_id, replacement_attempt_id
     FROM initial_analysis_tool_bridge_transport_recoveries WHERE run_id = ?`,
  ).bind(RUN_ID).first<{ recovery_id: string; replacement_attempt_id: string }>();
  if (transport === null) throw new Error('missing transport replacement');
  const scopeDigest = `sha256:${'a'.repeat(64)}`;
  const fingerprintDigest = `sha256:${'b'.repeat(64)}`;
  const profile = 'codex-gpt-5p6-terra-medium-tool-loop-20260811';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', version = 3, lease_generation = 1,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, transport.replacement_attempt_id),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 10, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-tool-bridge-scope', ?, ?, 7,
                 'event-tool-bridge-scope', 1, ?, ?, 'tool_error',
                 'tool_unavailable', 'tool_logs_search', 'resolve_external_dependency',
                 7, 3, 1, ?, ?)`,
    ).bind(RUN_ID, transport.replacement_attempt_id, scopeDigest, fingerprintDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-tool-bridge-scope', ?, 'repeated_fingerprint', ?, ?,
                 7, 3, 'resolve_external_dependency', ?)`,
    ).bind(RUN_ID, scopeDigest, fingerprintDigest, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace-tool-bridge-scope', ?, ?, 'logs/search',
                 'logs:read', 'read', 2489, 'upstream_error', ?)`,
    ).bind(RUN_ID, transport.replacement_attempt_id, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, status, expires_at, created_at, updated_at
       ) VALUES ('reservation-tool-bridge-scope', ?, ?, ?, 1, 1,
                 'settled', '2026-08-13T02:00:00.000Z', ?, ?)`,
    ).bind(transport.replacement_attempt_id, RUN_ID, profile, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO model_usage (
         usage_id, at, provider, model, run_id, attempt_id, tenant_key,
         repository, principal, input_tokens, cached_input_tokens, output_tokens,
         reasoning_output_tokens, cost_microusd, source_digest, created_at
       ) VALUES ('usage-tool-bridge-scope', ?, 'delivery_loop_relay', 'gpt-5.6-terra',
                 ?, ?, 'initial-analysis-recovery', 'example/delivery-target',
                 'service:delivery-loop', 1, 0, 1, 1, 1, ?, ?)`,
    ).bind(NOW, RUN_ID, transport.replacement_attempt_id, `sha256:${'c'.repeat(64)}`, NOW),
  ]);
  expect(failedAttemptId).toBeTruthy();
  return transport.replacement_attempt_id;
}

async function seedToolBridgeSecretValueBlocked(): Promise<string> {
  const failedAttemptId = await seedToolBridgeScopeBlocked();
  const reconciler = new InitialAnalysisReconciler(env.DB_CONTROL, {
    now: () => new Date(NOW),
  });
  expect(await reconciler.reconcileToolBridgeScopeFailures(1)).toBe(1);
  const scope = await env.DB_CONTROL.prepare(
    `SELECT recovery_id, replacement_attempt_id
     FROM initial_analysis_tool_bridge_scope_recoveries WHERE run_id = ?`,
  ).bind(RUN_ID).first<{ recovery_id: string; replacement_attempt_id: string }>();
  if (scope === null) throw new Error('missing scope replacement');
  const scopeDigest = `sha256:${'d'.repeat(64)}`;
  const fingerprintDigest = `sha256:${'e'.repeat(64)}`;
  const profile = 'codex-gpt-5p6-terra-medium-tool-loop-20260811';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', version = 3, lease_generation = 1,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, scope.replacement_attempt_id),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 12, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-tool-bridge-secret-value', ?, ?, 8,
                 'event-tool-bridge-secret-value', 1, ?, ?, 'tool_error',
                 'tool_unavailable', 'tool_logs_search', 'resolve_external_dependency',
                 8, 4, 1, ?, ?)`,
    ).bind(RUN_ID, scope.replacement_attempt_id, scopeDigest, fingerprintDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-tool-bridge-secret-value', ?, 'repeated_fingerprint', ?, ?,
                 8, 4, 'resolve_external_dependency', ?)`,
    ).bind(RUN_ID, scopeDigest, fingerprintDigest, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace-tool-bridge-secret-value', ?, ?, 'logs/search',
                 'logs:read', 'read', 807, 'upstream_error', ?)`,
    ).bind(RUN_ID, scope.replacement_attempt_id, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, status, expires_at, created_at, updated_at
       ) VALUES ('reservation-tool-bridge-secret-value', ?, ?, ?, 1, 1,
                 'settled', '2026-08-13T03:00:00.000Z', ?, ?)`,
    ).bind(scope.replacement_attempt_id, RUN_ID, profile, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO model_usage (
         usage_id, at, provider, model, run_id, attempt_id, tenant_key,
         repository, principal, input_tokens, cached_input_tokens, output_tokens,
         reasoning_output_tokens, cost_microusd, source_digest, created_at
       ) VALUES ('usage-tool-bridge-secret-value', ?, 'delivery_loop_relay', 'gpt-5.6-terra',
                 ?, ?, 'initial-analysis-recovery', 'example/delivery-target',
                 'service:delivery-loop', 1, 0, 1, 1, 1, ?, ?)`,
    ).bind(NOW, RUN_ID, scope.replacement_attempt_id, `sha256:${'f'.repeat(64)}`, NOW),
  ]);
  expect(failedAttemptId).toBeTruthy();
  return scope.replacement_attempt_id;
}

async function seedSourceSnapshotCapacityBlocked(): Promise<string> {
  await seedToolBridgeSecretValueBlocked();
  const reconciler = new InitialAnalysisReconciler(env.DB_CONTROL, {
    now: () => new Date(NOW),
  });
  expect(await reconciler.reconcileToolBridgeSecretValueFailures(1)).toBe(1);
  const recovery = await env.DB_CONTROL.prepare(
    `SELECT recovery_id, replacement_attempt_id
     FROM initial_analysis_tool_bridge_secret_value_recoveries WHERE run_id = ?`,
  ).bind(RUN_ID).first<{ recovery_id: string; replacement_attempt_id: string }>();
  if (recovery === null) throw new Error('missing verified credential replacement');
  const scopeDigest = `sha256:${'1'.repeat(64)}`;
  const fingerprintDigest = `sha256:${'2'.repeat(64)}`;
  const profile = 'codex-gpt-5p6-terra-medium-tool-loop-20260811';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', version = 3, lease_generation = 2,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, recovery.replacement_attempt_id),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 14, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-source-snapshot-capacity', ?, ?, 9,
                 'event-source-snapshot-capacity', 1, ?, ?, 'invalid_output',
                 'invalid_agent_output', 'agent_output', 'manual_investigation',
                 9, 1, 2, ?, ?)`,
    ).bind(RUN_ID, recovery.replacement_attempt_id, scopeDigest, fingerprintDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-source-snapshot-capacity', ?, 'attempt_limit', ?, ?,
                 9, 1, 'manual_investigation', ?)`,
    ).bind(RUN_ID, scopeDigest, fingerprintDigest, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace-source-snapshot-logs', ?, ?, 'logs/search',
                 'logs:read', 'read', 4185, 'success', ?)`,
    ).bind(RUN_ID, recovery.replacement_attempt_id, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('tooltrace-source-snapshot-request', ?, ?, 'traces/get',
                 'trace:read', 'read', 3450, 'success', ?)`,
    ).bind(RUN_ID, recovery.replacement_attempt_id, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, status, expires_at, created_at, updated_at
       ) VALUES ('reservation-source-snapshot-capacity', ?, ?, ?, 1, 1,
                 'settled', '2026-08-13T03:00:00.000Z', ?, ?)`,
    ).bind(recovery.replacement_attempt_id, RUN_ID, profile, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO model_usage (
         usage_id, at, provider, model, run_id, attempt_id, tenant_key,
         repository, principal, input_tokens, cached_input_tokens, output_tokens,
         reasoning_output_tokens, cost_microusd, source_digest, created_at
       ) VALUES ('usage-source-snapshot-capacity', ?, 'delivery_loop_relay', 'gpt-5.6-terra',
                 ?, ?, 'initial-analysis-recovery', 'example/delivery-target',
                 'service:delivery-loop', 1, 0, 1, 1, 1, ?, ?)`,
    ).bind(NOW, RUN_ID, recovery.replacement_attempt_id, `sha256:${'3'.repeat(64)}`, NOW),
  ]);
  return recovery.replacement_attempt_id;
}

async function seedPlaintextSourceBlocked(): Promise<string> {
  await seedSourceSnapshotCapacityBlocked();
  const reconciler = new InitialAnalysisReconciler(env.DB_CONTROL, {
    now: () => new Date(NOW),
  });
  expect(await reconciler.reconcileSourceSnapshotCapacityFailures(1)).toBe(1);
  const recovery = await env.DB_CONTROL.prepare(
    `SELECT recovery_id, replacement_attempt_id
     FROM initial_analysis_source_snapshot_capacity_recoveries WHERE run_id = ?`,
  ).bind(RUN_ID).first<{ recovery_id: string; replacement_attempt_id: string }>();
  if (recovery === null) throw new Error('missing source snapshot capacity replacement');
  const scopeDigest = `sha256:${'4'.repeat(64)}`;
  const fingerprintDigest = `sha256:${'5'.repeat(64)}`;
  const profile = 'codex-gpt-5p6-terra-medium-tool-loop-20260811';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', version = 3, lease_generation = 2,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, recovery.replacement_attempt_id),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 16, updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation,
         occurred_at, created_at
       ) VALUES ('failure-plaintext-source', ?, ?, 10, 'event-plaintext-source', 1,
                 ?, ?, 'invalid_output', 'invalid_agent_output', 'agent_output',
                 'manual_investigation', 10, 2, 2, ?, ?)`,
    ).bind(RUN_ID, recovery.replacement_attempt_id, scopeDigest, fingerprintDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-plaintext-source', ?, 'attempt_limit', ?, ?,
                 10, 2, 'manual_investigation', ?)`,
    ).bind(RUN_ID, scopeDigest, fingerprintDigest, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces VALUES
       ('tooltrace-plaintext-logs', ?, ?, 'logs/search', 'logs:read', 'read', 3002, 'success', ?),
       ('tooltrace-plaintext-request', ?, ?, 'traces/get', 'trace:read', 'read', 2783, 'success', ?)`,
    ).bind(
      RUN_ID, recovery.replacement_attempt_id, NOW,
      RUN_ID, recovery.replacement_attempt_id, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, status, expires_at, created_at, updated_at
       ) VALUES ('reservation-plaintext-source', ?, ?, ?, 1, 1, 'settled',
                 '2026-08-13T03:00:00.000Z', ?, ?)`,
    ).bind(recovery.replacement_attempt_id, RUN_ID, profile, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO model_usage (
         usage_id, at, provider, model, run_id, attempt_id, tenant_key,
         repository, principal, input_tokens, cached_input_tokens, output_tokens,
         reasoning_output_tokens, cost_microusd, source_digest, created_at
       ) VALUES ('usage-plaintext-source', ?, 'delivery_loop_relay', 'gpt-5.6-terra',
                 ?, ?, 'initial-analysis-recovery', 'example/delivery-target',
                 'service:delivery-loop', 1, 0, 1, 1, 1, ?, ?)`,
    ).bind(NOW, RUN_ID, recovery.replacement_attempt_id, `sha256:${'6'.repeat(64)}`, NOW),
  ]);
  return recovery.replacement_attempt_id;
}

function validPlan(attemptId: string): ExecutionPlanBodyV1 {
  return {
    schemaVersion: '1',
    id: 'plan-initial-analysis-recovery',
    runId: RUN_ID,
    version: 1,
    taskRevision: 'revision-1',
    baseSha: BASE_SHA,
    createdByAttemptId: attemptId,
    objective: 'Continue the same Task and Run after bounded analysis recovery.',
    assumptions: ['The replacement uses the immutable original Task snapshot.'],
    evidenceRefs: ['d1://evidence/initial-analysis-recovery'],
    items: [{
      id: 'verify-plan',
      kind: 'verification',
      title: 'Verify recovered analysis',
      objective: 'Verify the source-backed recovered plan.',
      acceptanceCriteriaIndexes: [0],
      doneWhen: ['The recovered Plan is activated without another Task or Run.'],
      verification: { commandRefs: ['policy:inspect'], evidenceKinds: ['diagnostic'] },
      effects: ['repo_read'],
      dependsOn: [],
      required: true,
    }],
  };
}

beforeEach(reset);

describe('initial analysis recovery', () => {
  it('converges the exact plaintext source failure to one replacement', async () => {
    const failedAttemptId = await seedPlaintextSourceBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(Array.from(
      { length: 20 },
      async () => await reconciler().reconcilePlaintextSourceFailures(5),
    ));
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovery.failed_attempt_id, recovery.logs_trace_id,
              recovery.request_trace_id, recovery.source_policy_version,
              attempts.ordinal, attempts.status, retries.retry_sequence,
              blockers.resolution_code, runs.state, outbox.delivery_state
       FROM initial_analysis_plaintext_source_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first()).toMatchObject({
      failed_attempt_id: failedAttemptId,
      logs_trace_id: 'tooltrace-plaintext-logs',
      request_trace_id: 'tooltrace-plaintext-request',
      source_policy_version: 3,
      ordinal: 11,
      status: 'pending',
      retry_sequence: 10,
      resolution_code: 'analysis_plaintext_source_v3',
      state: 'planning',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await reconciler().reconcilePlaintextSourceFailures(5)).toBe(0);
  });

  it('converges the exact stale source snapshot capacity failure to one replacement', async () => {
    const failedAttemptId = await seedSourceSnapshotCapacityBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        await reconciler().reconcileSourceSnapshotCapacityFailures(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovery.failed_attempt_id, recovery.logs_trace_id,
              recovery.request_trace_id, recovery.inventory_policy_version,
              recovery.max_tracked_paths, attempts.ordinal, attempts.status,
              retries.retry_sequence, blockers.resolution_code, runs.state,
              outbox.delivery_state
       FROM initial_analysis_source_snapshot_capacity_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first()).toMatchObject({
      failed_attempt_id: failedAttemptId,
      logs_trace_id: 'tooltrace-source-snapshot-logs',
      request_trace_id: 'tooltrace-source-snapshot-request',
      inventory_policy_version: 2,
      max_tracked_paths: 5_000,
      ordinal: 10,
      status: 'pending',
      retry_sequence: 9,
      resolution_code: 'analysis_source_snapshot_capacity_v2',
      state: 'planning',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await reconciler().reconcileSourceSnapshotCapacityFailures(5)).toBe(0);
  });

  it('converges the exact unverified Tool Bridge secret value failure to one replacement', async () => {
    const failedAttemptId = await seedToolBridgeSecretValueBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        await reconciler().reconcileToolBridgeSecretValueFailures(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovery.failed_attempt_id, recovery.logs_trace_id,
              recovery.credential_policy_version, attempts.ordinal, attempts.status,
              retries.retry_sequence, blockers.resolution_code, runs.state,
              outbox.delivery_state
       FROM initial_analysis_tool_bridge_secret_value_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first()).toMatchObject({
      failed_attempt_id: failedAttemptId,
      logs_trace_id: 'tooltrace-tool-bridge-secret-value',
      credential_policy_version: 4,
      ordinal: 9,
      status: 'pending',
      retry_sequence: 8,
      resolution_code: 'analysis_tool_bridge_verified_credential_value_v4',
      state: 'planning',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await reconciler().reconcileToolBridgeSecretValueFailures(5)).toBe(0);
  });

  it('converges the exact stale Tool Bridge scope failure to one replacement', async () => {
    const failedAttemptId = await seedToolBridgeScopeBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => await reconciler().reconcileToolBridgeScopeFailures(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovery.failed_attempt_id, recovery.logs_trace_id,
              recovery.credential_policy_version, attempts.ordinal, attempts.status,
              retries.retry_sequence, blockers.resolution_code, runs.state,
              outbox.delivery_state
       FROM initial_analysis_tool_bridge_scope_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first()).toMatchObject({
      failed_attempt_id: failedAttemptId,
      logs_trace_id: 'tooltrace-tool-bridge-scope',
      credential_policy_version: 3,
      ordinal: 8,
      status: 'pending',
      retry_sequence: 7,
      resolution_code: 'analysis_tool_bridge_tipsy_namespace_scope_v3',
      state: 'planning',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await reconciler().reconcileToolBridgeScopeFailures(5)).toBe(0);
  });

  it('converges the exact workerd redirect transport failure to one replacement', async () => {
    const failedAttemptId = await seedToolBridgeTransportBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        await reconciler().reconcileToolBridgeTransportFailures(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovery.failed_attempt_id, recovery.logs_trace_id,
              recovery.transport_policy_version, attempts.ordinal, attempts.status,
              retries.retry_sequence, blockers.resolution_code, runs.state,
              outbox.delivery_state
       FROM initial_analysis_tool_bridge_transport_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries
         ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first()).toMatchObject({
      failed_attempt_id: failedAttemptId,
      logs_trace_id: 'tooltrace-tool-bridge-transport',
      transport_policy_version: 2,
      ordinal: 7,
      status: 'pending',
      retry_sequence: 6,
      resolution_code: 'analysis_tool_bridge_workerd_redirect_manual_v2',
      state: 'planning',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await reconciler().reconcileToolBridgeTransportFailures(5)).toBe(0);
  });

  it('converges the exact external Tool Bridge failure to one replacement', async () => {
    const failedAttemptId = await seedToolBridgeBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => await reconciler().reconcileToolBridgeFailures(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovery.failed_attempt_id, recovery.logs_trace_id,
              recovery.provider_policy_version, attempts.ordinal, attempts.status,
              retries.retry_sequence, blockers.resolution_code, runs.state,
              outbox.delivery_state
       FROM initial_analysis_tool_bridge_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries
         ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first()).toMatchObject({
      failed_attempt_id: failedAttemptId,
      logs_trace_id: 'tooltrace-tool-bridge-external',
      provider_policy_version: 1,
      ordinal: 6,
      status: 'pending',
      retry_sequence: 5,
      resolution_code: 'analysis_tipsy_sls_tool_bridge_v1',
      state: 'planning',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await reconciler().reconcileToolBridgeFailures(5)).toBe(0);
  });

  it('recovers the same external Tool Bridge failure after the attempt limit blocks it', async () => {
    await seedToolBridgeBlocked({ blockerReason: 'attempt_limit' });
    expect(await new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).reconcileToolBridgeFailures(1)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT attempts.ordinal, runs.state, blockers.resolution_code
       FROM initial_analysis_tool_bridge_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id`,
    ).first()).toEqual({
      ordinal: 6,
      state: 'planning',
      resolution_code: 'analysis_tipsy_sls_tool_bridge_v1',
    });
  });

  it.each([
    [{ traceResult: 'success' as const }, 'successful old tool call'],
    [{ evidence: true }, 'existing Evidence'],
  ])('does not recover a non-exact Tool Bridge failure: %s (%s)', async (...[overrides]) => {
    await seedToolBridgeBlocked(overrides);
    expect(await new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).reconcileToolBridgeFailures(5)).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM initial_analysis_tool_bridge_recoveries',
    ).first()).toEqual({ count: 0 });
  });

  it('converges the zero-model v2 adapter capacity blocker to one compatibility replacement', async () => {
    const failedAttemptId = await seedInventoryAdapterBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        await reconciler().reconcileInventoryAdapterFailures(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT recovery.failed_attempt_id, recovery.inventory_policy_version,
              recovery.max_prompt_path_bytes, attempts.ordinal, attempts.status,
              retries.retry_sequence, blockers.resolution_code, runs.state,
              outbox.delivery_state
       FROM initial_analysis_inventory_adapter_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries
         ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first()).toMatchObject({
      failed_attempt_id: failedAttemptId,
      inventory_policy_version: 2,
      max_prompt_path_bytes: 512 * 1_024,
      ordinal: 5,
      status: 'pending',
      retry_sequence: 4,
      resolution_code: 'analysis_inventory_adapter_capacity_v2',
      state: 'planning',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await reconciler().reconcileInventoryAdapterFailures(5)).toBe(0);
  });

  it('does not compatibility-recover after a model reservation exists', async () => {
    await seedInventoryAdapterBlocked({ modelReservation: true });
    expect(await new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).reconcileInventoryAdapterFailures(5)).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM initial_analysis_inventory_adapter_recoveries',
    ).first()).toEqual({ count: 0 });
  });

  it('converges a production-shaped capacity blocker to one replacement lineage', async () => {
    await seedCapacityBlocked();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => await reconciler().reconcileCapacityFailures(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    const recovery = await env.DB_CONTROL.prepare(
      `SELECT recovery.run_id, recovery.failed_attempt_id,
              recovery.replacement_attempt_id, recovery.inventory_policy_version,
              recovery.max_tracked_paths, recovery.max_tracked_path_bytes,
              attempts.ordinal, attempts.mode, attempts.status,
              retries.retry_sequence, blockers.resolution_code, runs.state,
              outbox.delivery_state
       FROM initial_analysis_capacity_recoveries AS recovery
       JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
       JOIN initial_analysis_retries AS retries
         ON retries.retry_attempt_id = recovery.replacement_attempt_id
       JOIN run_blockers AS blockers ON blockers.blocker_id = recovery.blocker_id
       JOIN runs ON runs.run_id = recovery.run_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || recovery.replacement_attempt_id`,
    ).first<Record<string, unknown>>();
    expect(recovery).toMatchObject({
      run_id: RUN_ID,
      failed_attempt_id: 'analysis-capacity-retry-2',
      inventory_policy_version: 2,
      max_tracked_paths: 5_000,
      max_tracked_path_bytes: 256 * 1_024,
      ordinal: 4,
      mode: 'analysis',
      status: 'pending',
      retry_sequence: 3,
      resolution_code: 'analysis_repository_capacity_v2',
      state: 'planning',
      delivery_state: 'pending',
    });
    if (
      recovery === null ||
      typeof recovery.replacement_attempt_id !== 'string'
    ) throw new Error('missing capacity replacement');
    expect(await reconciler().reconcileCapacityFailures(5)).toBe(0);
    const expiresAt = new Date(Date.parse(NOW) + 300_000).toISOString();
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 2, lease_generation = 1,
                           lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(expiresAt, NOW, NOW, recovery.replacement_attempt_id).run();
    const context = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId: recovery.replacement_attempt_id,
      runId: RUN_ID,
      mode: 'analysis',
      status: 'running',
      version: 2,
      leaseGeneration: 1,
      leaseExpiresAt: expiresAt,
      scopes: ['repo:read'],
    });
    expect(context.attempt.id).toBe(recovery.replacement_attempt_id);
    expect(context.revisionSource).toBeUndefined();
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first())
      .toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM initial_analysis_capacity_recoveries',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'analysis_dispatch'`,
    ).first()).toEqual({ count: 1 });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE initial_analysis_capacity_recoveries SET created_at = ? WHERE run_id = ?`,
    ).bind('2026-08-13T02:00:00.000Z', RUN_ID).run()).rejects.toThrow();
  });

  it('keeps the blocker and Run intact when attempt quota rejects the replacement', async () => {
    await seedCapacityBlocked();
    await env.DB_CONTROL.prepare(
      `INSERT INTO quota_policies (
         policy_id, scope_type, scope_key, resource_type, limit_value,
         window_kind, enabled, created_at, updated_at
       ) VALUES ('quota-capacity-run', 'run', ?, 'attempt', 3,
                 'run_lifetime', 1, ?, ?)`,
    ).bind(RUN_ID, NOW, NOW).run();
    await expect(new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).reconcileCapacityFailures(5)).rejects.toThrow();
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM initial_analysis_capacity_recoveries',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM attempts').first())
      .toEqual({ count: 3 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT resolved_at FROM run_blockers WHERE blocker_id = ?',
    ).bind(CAPACITY_BLOCKER_ID).first()).toEqual({ resolved_at: null });
  });

  it.each([
    [{ failureCode: 'tool_unavailable' as const }, 'wrong failure code'],
    [{ failureSite: 'tool_repo_read' as const }, 'wrong failure site'],
    [{ blocker: false }, 'missing active blocker'],
    [{ plan: true }, 'existing Plan'],
  ])('does not capacity-recover with %s (%s)', async (...[overrides]) => {
    await seedCapacityBlocked(overrides);
    expect(await new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).reconcileCapacityFailures(5)).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM initial_analysis_capacity_recoveries',
    ).first()).toEqual({ count: 0 });
  });

  it('converges 20 reconcilers to one replacement and activates its Plan', async () => {
    await seedFailedRoot();
    const reconciler = () => new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => await reconciler().reconcileFailedAttempts(5)),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    const retry = await env.DB_CONTROL.prepare(
      `SELECT retries.retry_attempt_id, retries.retry_sequence,
              attempts.status, outbox.delivery_state
       FROM initial_analysis_retries AS retries
       JOIN attempts ON attempts.attempt_id = retries.retry_attempt_id
       JOIN outbox ON outbox.payload_ref = 'd1://attempts/' || attempts.attempt_id`,
    ).first<{
      retry_attempt_id: string;
      retry_sequence: number;
      status: string;
      delivery_state: string;
    }>();
    expect(retry).toMatchObject({
      retry_sequence: 1,
      status: 'pending',
      delivery_state: 'pending',
    });
    if (retry === null) throw new Error('missing initial analysis retry');
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first()).toEqual({
      count: 1,
    });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs').first()).toEqual({
      count: 1,
    });

    const expiresAt = new Date(Date.parse(NOW) + 300_000).toISOString();
    const replacementAuth: RunnerAuthorization = {
      attemptId: retry.retry_attempt_id,
      runId: RUN_ID,
      mode: 'analysis',
      status: 'running',
      version: 2,
      leaseGeneration: 1,
      leaseExpiresAt: expiresAt,
      scopes: ['repo:read'],
    };
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 2, lease_generation = 1,
                           lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(expiresAt, NOW, NOW, retry.retry_attempt_id).run();
    const context = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get(replacementAuth);
    expect(context.attempt.id).toBe(retry.retry_attempt_id);
    expect(context.revisionSource).toBeUndefined();
    await expect(new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({ ...replacementAuth, attemptId: ROOT_ATTEMPT_ID, version: 3 }))
      .rejects.toMatchObject({ code: 'attempt_context_mismatch' });

    const body = validPlan(retry.retry_attempt_id);
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
        baseSha: BASE_SHA,
        expectedVersion: 1,
        acceptanceCriteriaCount: 1,
        allowedCommandRefs: ['policy:inspect'],
        allowedEffects: ['repo_read'],
        requiresRepositoryChange: false,
      },
      NOW,
    );
    const rawToken = 'initial-analysis-replacement-token';
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-initial-analysis-replacement', ?, ?, ?, 1,
                 '["repo:read"]', ?, ?)`,
    ).bind(
      retry.retry_attempt_id,
      `sha256:${'d'.repeat(64)}`,
      await canonicalSha256(rawToken),
      expiresAt,
      NOW,
    ).run();
    await new RunnerAttemptStore(env.DB_CONTROL).complete(
      retry.retry_attempt_id,
      rawToken,
      {
        schemaVersion: '1',
        eventId: 'event-initial-analysis-replacement-completed',
        sequence: 1,
        payloadRef: `d1://execution-plans/${plan.id}`,
        digest: plan.digest,
        occurredAt: NOW,
        expectedVersion: 2,
        leaseGeneration: 1,
      },
      new Date(NOW),
    );
    expect(await reconciler().reconcilePreparedPlans(5)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, active_plan_id, active_plan_version, active_plan_digest
       FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      state: 'awaiting_approval',
      active_plan_id: plan.id,
      active_plan_version: 1,
      active_plan_digest: plan.digest,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM attempts WHERE attempt_id = ?',
    ).bind(retry.retry_attempt_id).first()).toEqual({ status: 'completed' });
    expect(await reconciler().reconcilePreparedPlans(5)).toBe(0);
  });

  it.each([
    [{ blocker: true }, 'active blocker'],
    [{ plan: true }, 'existing proposal'],
    [{ scopeAttemptCount: 3 }, 'attempt limit'],
    [{ consecutiveFingerprintCount: 2 }, 'repeated fingerprint'],
  ] as const)('does not retry with %s (%s)', async (...[overrides]) => {
    await seedFailedRoot(overrides);
    const created = await new InitialAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).reconcileFailedAttempts(5);
    expect(created).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM initial_analysis_retries',
    ).first()).toEqual({ count: 0 });
  });
});
