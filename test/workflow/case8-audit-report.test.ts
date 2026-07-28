/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { Case8AuditLogger } from '../../src/observability/case8-audit-log.js';
import {
  type Case8AuditReport,
  Case8AuditReportError,
  Case8AuditReportStore,
} from '../../src/storage/case8-audit-report-store.js';

const NOW = '2026-07-26T14:00:00.000Z';
const TASK_DIGEST = `sha256:${'1'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'2'.repeat(64)}`;
const POLICY_DIGEST = `sha256:${'3'.repeat(64)}`;
const EVIDENCE_SET_DIGEST = `sha256:${'4'.repeat(64)}`;
const REPLAY_REASON_DIGEST = `sha256:${'a'.repeat(64)}`;
const REPLAY_SNAPSHOT_DIGEST = `sha256:${'b'.repeat(64)}`;
const REPLAY_DISPATCH_DIGEST = 'sha256:04e529a46f073a429d3bed0a2fdea69a34ad16d90cd51233531ebac8e4801e7b';
const REPLAY_EVIDENCE_DIGEST = 'sha256:0560d0cb23ff3544a50d55312ad09112bb517857f3a1d4caab159a3c71c8ccf1';
const TOKEN_DIGEST = `sha256:${'5'.repeat(64)}`;
const OIDC_DIGEST = `sha256:${'6'.repeat(64)}`;
const TOOL_DIGEST = `sha256:${'7'.repeat(64)}`;
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const RUN_ID = 'run_case8_audit';
const TASK_ID = 'task_case8_audit';
const PLAN_ID = 'plan_case8_audit';
const ATTEMPT_ID = 'attempt_case8_implement';
const DEPLOY_ATTEMPT_ID = 'attempt_case8_deploy';
const ITEM_ID = 'item_case8_change';
const SECRET_CANARY = 'CASE8_SECRET_CANARY_SHOULD_NEVER_APPEAR';
const OPERATIONS_TOKEN = 'test-operations-token';

async function case8MergeGateFact(): Promise<{
  fact: Record<string, unknown>;
  factDigest: string;
  policyDigest: string;
  checksDigest: string;
  reviewsDigest: string;
}> {
  const requiredChecks = [{ context: 'ci', integrationId: 42, state: 'pending' as const }];
  const policyDigest = await canonicalSha256({
    requiredChecks: [{ context: 'ci', integrationId: 42 }], requiredApprovals: 1,
  });
  const checksDigest = await canonicalSha256(requiredChecks);
  const reviewsDigest = await canonicalSha256([]);
  const fact = {
    schemaVersion: '1', repository: 'example/audit-repo', number: 7,
    pullRequestAuthorLogin: 'delivery-author', headBranch: 'delivery/task-case8/attempt-case8',
    headSha: HEAD_SHA, baseBranch: 'main', baseSha: BASE_SHA,
    pullRequestBaseSha: BASE_SHA, state: 'open', draft: false,
    mergeability: 'mergeable', mergeState: 'clean', reviewDecision: 'review_required',
    requiredApprovals: 1, approvedReviewCount: 0, requiredChecks,
    policyDigest, checksDigest, reviewsDigest, externalUpdatedAt: NOW,
  };
  return { fact, factDigest: await canonicalSha256(fact), policyDigest, checksDigest, reviewsDigest };
}

async function seedCase8Run(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         source_url, task_digest, payload_ref, actor_type, actor_id,
         target_repository, target_base_branch, target_environment, intent_kind,
         title, priority, acceptance_criteria_count, allow_repository_write,
         allow_test_deploy, allow_production_deploy, require_human_approval,
         created_at, updated_at
       ) VALUES (?, 'feishu', 'tenant-case8', 'event-case8', 'revision-7', ?, ?,
                 'r2://tasks/case8.json', 'user', 'user:requester',
                 'example/audit-repo', 'main', 'test', 'bug', ?, 'p1', 1,
                 1, 1, 0, 1, ?, ?)`,
    ).bind(
      TASK_ID,
      `https://feishu.example.test/task/case8?secret=${SECRET_CANARY}#raw`,
      TASK_DIGEST,
      `title-${SECRET_CANARY}`,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-7', ?, ?, ?, 'succeeded', 9, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, github_status, github_conclusion,
         plan_id, plan_version, plan_item_id, claimed_progress_version,
         head_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', 'completed', ?, 'example/audit-repo',
                 'example/audit-repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '8001', 'completed', 'success', ?, 1, ?, 1, ?, 4, 1, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, github_status, github_conclusion,
         plan_id, plan_version, plan_item_id, head_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 2, 'deploy', 'completed', ?, 'example/audit-repo',
                 'example/audit-repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
                 '8002', 'completed', 'success', ?, 1, ?, ?, 2, 1, ?, ?)`,
    ).bind(DEPLOY_ATTEMPT_ID, RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_webhook_deliveries (
         delivery_id, event_type, payload_digest, repository, github_run_id,
         attempt_id, processing_state, external_updated_at, received_at, processed_at
       ) VALUES ('delivery_case8_agent', 'workflow_run', ?, 'example/audit-repo',
                 '8001', ?, 'applied', ?, ?, ?)`,
    ).bind(`sha256:${'c'.repeat(64)}`, ATTEMPT_ID, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_api_observations (
         observation_id, fact_digest, repository, github_run_id,
         attempt_id, processing_state, external_updated_at, observed_at, processed_at
       ) VALUES ('api_case8_agent', ?, 'example/audit-repo', '8001',
                 ?, 'applied', ?, ?, ?)`,
    ).bind(`sha256:${'d'.repeat(64)}`, ATTEMPT_ID, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-7', ?, ?, 'completed', ?, ?, ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ATTEMPT_ID, `objective-${SECRET_CANARY}`, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'case8 change', 'case8 objective', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, ?)`,
    ).bind(PLAN_ID, ITEM_ID, `condition-${SECRET_CANARY}`),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'passed', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval_case8_write', ?, 'revision-7', ?, 1, ?, ?,
                 'repo_write', 'user:reviewer', 'approve', ?,
                 '2026-07-27T14:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'8'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval_case8_deploy', ?, 'revision-7', ?, 1, ?, ?,
                 'test_deploy', 'user:deployer-approver', 'approve', ?,
                 '2026-07-27T14:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'9'.repeat(64)}`, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO approval_source_events (
         source_id, provider, tenant_key, external_event_id, event_digest,
         request_digest, channel, channel_user_id, occurred_at, received_at, created_at
       ) VALUES ('source_case8_deploy', 'feishu', 'tenant-case8',
                 'event-case8-deploy-approval', ?, ?, 'feishu:tenant-case8',
                 'ou_case8_deploy_reviewer', ?, ?, ?)`,
    ).bind(`sha256:${'c'.repeat(64)}`, `sha256:${'d'.repeat(64)}`, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO identity_bound_approvals (
         approval_id, source_id, approver_principal, approver_channel,
         approver_channel_user_id, pull_request_author_principal,
         pull_request_author_channel, pull_request_author_login,
         roles_digest, separation_verified, created_at
       ) VALUES ('approval_case8_deploy', 'source_case8_deploy',
                 'user:deployer-approver', 'feishu:tenant-case8',
                 'ou_case8_deploy_reviewer', 'user:delivery-author',
                 'github:example/audit-repo', 'delivery-author', ?, 1, ?)`,
    ).bind(`sha256:${'e'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approval_lineages (
         lineage_id, approval_id, source_id, card_action_receipt_id,
         provider, tenant_key, external_event_id, external_event_digest,
         approver_principal, roles_digest, run_id, task_id, task_revision,
         plan_id, plan_version, plan_digest, base_sha, effect, decision,
         separation_verified, source_occurred_at, decision_recorded_at,
         expires_at, created_at
       ) VALUES ('approval_lineage_case8_deploy', 'approval_case8_deploy',
                 'source_case8_deploy', NULL, 'feishu', 'tenant-case8',
                 'event-case8-deploy-approval', ?, 'user:deployer-approver', ?,
                 ?, ?, 'revision-7', ?, 1, ?, ?, 'test_deploy', 'approve', 1,
                 ?, ?, '2026-07-27T14:00:00.000Z', ?)`,
    ).bind(
      `sha256:${'c'.repeat(64)}`,
      `sha256:${'e'.repeat(64)}`,
      RUN_ID,
      TASK_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      NOW,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approval_source_events (
         source_id, provider, tenant_key, external_event_id, event_digest,
         request_digest, channel, channel_user_id, occurred_at, received_at, created_at
       ) VALUES ('source_case8_self_merge', 'github', 'example/audit-repo',
                 'review-case8-self', ?, ?, 'github:example/audit-repo',
                 'delivery-author', ?, ?, ?)`,
    ).bind(`sha256:${'f'.repeat(64)}`, `sha256:${'a'.repeat(64)}`, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approval_identity_rejections (
         rejection_id, source_id, run_id, plan_id, plan_version, effect,
         approver_principal, approver_channel, approver_channel_user_id,
         author_principal, author_channel, author_login, roles_digest,
         separation_verified, reason, decision, rejected_at, created_at
       ) VALUES ('rejection_case8_self_merge', 'source_case8_self_merge', ?, ?, 1,
                 'merge', 'agent:delivery-bot', 'github:example/audit-repo',
                 'delivery-author', 'agent:delivery-bot', 'github:example/audit-repo',
                 'delivery-author', ?, 0, 'self_approval_denied', 'approve', ?, ?)`,
    ).bind(RUN_ID, PLAN_ID, `sha256:${'b'.repeat(64)}`, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, revoked_at, created_at
       ) VALUES ('token_case8', ?, ?, ?, ?, 1,
                 '["repo:read","logs:read","trace:read","k8s:read","database:diagnostic","checkpoint:write"]',
                 '2026-07-26T14:05:00.000Z', ?, ?)`,
    ).bind(ATTEMPT_ID, OIDC_DIGEST, TOKEN_DIGEST, TOOL_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_write_credentials (
         credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         approval_id, repository, lease_generation, status, token_digest,
         github_expires_at, authorization_expires_at, revoked_at, created_at, updated_at
       ) VALUES ('credential_case8', ?, ?, ?, 1, ?, 'approval_case8_write',
                 'example/audit-repo', 1, 'revoked', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      ATTEMPT_ID,
      PLAN_ID,
      ITEM_ID,
      `sha256:${'a'.repeat(64)}`,
      '2026-07-26T14:05:00.000Z',
      '2026-07-26T14:05:00.000Z',
      NOW,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence_case8_commit', ?, ?, ?, 1, ?, 'commit', 'passed', ?, ?,
                 'verified', ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, `summary-${SECRET_CANARY}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, command_ref, exit_code, sha, external_url, summary,
         verification_status, observed_at, created_at
       ) VALUES ('evidence_case8_test', ?, ?, ?, 1, ?, 'test', 'passed',
                 'verify:required', 0, ?, ?, ?, 'verified', ?, ?)`,
    ).bind(
      RUN_ID,
      ATTEMPT_ID,
      PLAN_ID,
      ITEM_ID,
      HEAD_SHA,
      `https://github.example.test/actions/runs/8001?token=${SECRET_CANARY}#logs`,
      `test-${SECRET_CANARY}`,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, external_url, summary, verification_status,
         observed_at, created_at
       ) VALUES ('evidence_case8_deploy', ?, ?, ?, 1, ?, 'deployment', 'passed',
                 ?, ?, ?, 'verified', ?, ?)`,
    ).bind(
      RUN_ID,
      DEPLOY_ATTEMPT_ID,
      PLAN_ID,
      ITEM_ID,
      HEAD_SHA,
      `https://deploy.example.test/test/case8?credential=${SECRET_CANARY}`,
      `deploy-${SECRET_CANARY}`,
      NOW,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head_case8', 'evidence_case8_commit', ?, ?, ?, 1, ?, 1, ?, ?,
                 'delivery/task-case8/attempt-case8', ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, BASE_SHA, HEAD_SHA, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO verification_suites (
         suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         lease_generation, head_sha, delivery_policy_digest,
         targeted_command_count, required_command_count, status, created_at, updated_at
       ) VALUES ('suite_case8', ?, ?, ?, 1, ?, 1, ?, ?, 1, 1, 'completed', ?, ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, POLICY_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO verification_suite_commands (
         suite_id, position, phase, command_ref, result_status, evidence_id, updated_at
       ) VALUES ('suite_case8', 0, 'targeted', 'test:targeted', 'passed',
                 'evidence_case8_test', ?)`,
    ).bind(NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO verification_suite_commands (
         suite_id, position, phase, command_ref, result_status, evidence_id, updated_at
       ) VALUES ('suite_case8', 1, 'required_verify', 'verify:required', 'passed',
                 'evidence_case8_test', ?)`,
    ).bind(NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_verifications (
         verification_id, run_id, plan_id, plan_version, plan_item_id, attempt_id,
         head_sha, progress_version, evidence_set_digest, status, created_at
       ) VALUES ('verification_case8', ?, ?, 1, ?, ?, ?, 1, ?, 'passed', ?)`,
    ).bind(RUN_ID, PLAN_ID, ITEM_ID, ATTEMPT_ID, HEAD_SHA, EVIDENCE_SET_DIGEST, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when_evidence (
         verification_id, plan_id, item_id, done_when_position,
         evidence_position, evidence_id
       ) VALUES ('verification_case8', ?, ?, 0, 0, 'evidence_case8_test')`,
    ).bind(PLAN_ID, ITEM_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('trace_case8_logs', ?, ?, 'logs/search', 'logs:read', 'read',
                 120, 'success', ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES ('trace_case8_database', ?, ?, 'database/diagnose',
                 'database:diagnostic', 'read', 80, 'success', ?)`,
    ).bind(RUN_ID, ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO test_deployments (
         deployment_id, run_id, run_version, plan_id, plan_version, plan_digest,
         plan_item_id, attempt_id, approval_id, repository, base_branch, base_sha,
         ref_sha, workflow_path, environment, oidc_audience, role_ref, status,
         github_deployment_id, external_state, external_url, external_updated_at,
         observation_version, evidence_id, created_at, updated_at
       ) VALUES ('deployment_case8_test', ?, 8, ?, 1, ?, ?, ?,
                 'approval_case8_deploy', 'example/audit-repo', 'main', ?, ?,
                 '.github/workflows/delivery-test-deploy.yml', 'test',
                 'delivery-loop-test-deploy', 'test:case8-deployer', 'succeeded',
                 '9001', 'success', ?, ?, 1, 'evidence_case8_deploy', ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      ITEM_ID,
      DEPLOY_ATTEMPT_ID,
      BASE_SHA,
      HEAD_SHA,
      `https://deploy.example.test/test/case8?secret=${SECRET_CANARY}#raw`,
      NOW,
      NOW,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO test_deployment_oidc_attestations (
         attestation_id, deployment_id, oidc_token_digest, repository,
         workflow_ref, sha, github_run_id, subject, environment, audience, created_at
       ) VALUES ('attestation_case8_test', 'deployment_case8_test', ?,
                 'example/audit-repo',
                 'example/audit-repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
                 ?, '8002', 'repo:example/audit-repo:environment:test', 'test',
                 'delivery-loop-test-deploy', ?)`,
    ).bind(OIDC_DIGEST, HEAD_SHA, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_test_deployment_webhook_deliveries (
         delivery_id, event_type, payload_digest, repository, github_deployment_id,
         deployment_id, processing_state, external_updated_at, received_at, processed_at
       ) VALUES ('delivery_case8_test', 'deployment_status', ?, 'example/audit-repo',
                 '9001', 'deployment_case8_test', 'applied', ?, ?, ?)`,
    ).bind(`sha256:${'9'.repeat(64)}`, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_test_deployment_status_observations (
         observation_id, source_kind, fact_digest, repository, github_deployment_id,
         deployment_id, processing_state, external_updated_at, observed_at, processed_at
       ) VALUES ('api_observation_case8_test', 'api', ?, 'example/audit-repo',
                 '9001', 'deployment_case8_test', 'applied', ?, ?, ?)`,
    ).bind(`sha256:${'8'.repeat(64)}`, NOW, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, attempt_count, created_at, updated_at
       ) VALUES ('outbox_case8_dispatch', ?, 'execution_dispatch', 'github_actions',
                 'd1://execution-dispatches/case8', 'execution_dispatch:case8',
                 'settled', 1, ?, ?),
                ('outbox_case8_replay', ?, 'workflow_replay', 'cloudflare_workflows',
                 'd1://workflow-replays/replay_case8', 'workflow_replay:case8',
                 'settled', 1, ?, ?)`,
    ).bind(RUN_ID, NOW, NOW, RUN_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO workflow_replays (
         replay_id, run_id, expected_run_version, plan_id, plan_version,
         plan_item_id, target_kind, target_step_name, target_step_type,
         target_step_count, reason_digest, effect_snapshot_digest,
         restart_observed_at, created_at, updated_at
       ) VALUES ('replay_case8', ?, 8, ?, 1, ?, 'plan_item',
                 'plan-v1-item-item_case8_change-verify', 'do', 1, ?, ?, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      ITEM_ID,
      REPLAY_REASON_DIGEST,
      REPLAY_SNAPSHOT_DIGEST,
      NOW,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO workflow_replay_effects (replay_id, effect, approval_id)
       VALUES ('replay_case8', 'repo_write', 'approval_case8_write')`,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO workflow_replay_reconciliations (
         replay_id, source_kind, source_ref, source_digest
       ) VALUES ('replay_case8', 'outbox',
                 'd1://outbox/outbox_case8_dispatch', ?),
                ('replay_case8', 'evidence',
                 'd1://evidence/evidence_case8_deploy', ?)`,
    ).bind(REPLAY_DISPATCH_DIGEST, REPLAY_EVIDENCE_DIGEST),
  ]);
  const mergeGate = await case8MergeGateFact();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id, head_sha,
         branch, body, body_digest, status, created_at
       ) VALUES ('draft_case8_merge', ?, 9, ?, 'revision-7', ?, ?, 1, ?, ?,
                 'head_case8', ?, 'delivery/task-case8/attempt-case8',
                 'Case 8 merge draft', ?, 'prepared', ?)`,
    ).bind(
      RUN_ID, TASK_ID, TASK_DIGEST, PLAN_ID, PLAN_DIGEST, ATTEMPT_ID,
      HEAD_SHA, `sha256:${'e'.repeat(64)}`, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_publications (
         publication_id, run_id, run_version, draft_id, approval_id,
         repository, base_branch, head_branch, head_sha, title, body_digest,
         status, github_pr_number, github_pr_url, github_external_updated_at,
         github_observation_version, evidence_id, created_at, updated_at
       ) VALUES ('publication_case8_merge', ?, 9, 'draft_case8_merge',
                 'approval_case8_write', 'example/audit-repo', 'main',
                 'delivery/task-case8/attempt-case8', ?, 'Case 8 merge gate', ?,
                 'verified', 7, 'https://github.example.test/example/audit-repo/pull/7',
                 ?, 1, 'evidence_case8_test', ?, ?)`,
    ).bind(RUN_ID, HEAD_SHA, `sha256:${'f'.repeat(64)}`, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_merge_gate_observations (
         observation_id, run_id, run_version, publication_id, fact_digest,
         repository, github_pr_number, head_branch, head_sha, base_branch,
         pull_request_author_login, base_sha, pull_request_base_sha,
         pull_request_state, is_draft, mergeability, merge_state, review_decision,
         required_approval_count, approved_review_count, required_check_count,
         passed_check_count, pending_check_count, failed_check_count, missing_check_count,
         policy_digest, checks_digest, reviews_digest, external_updated_at,
         observed_at, created_at
       ) VALUES ('merge_observation_case8', ?, 9, 'publication_case8_merge', ?,
         'example/audit-repo', 7, 'delivery/task-case8/attempt-case8', ?, 'main',
         'delivery-author', ?, ?, 'open', 0, 'mergeable', 'clean', 'review_required',
         1, 0, 1, 0, 1, 0, 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      RUN_ID, mergeGate.factDigest, HEAD_SHA, BASE_SHA, BASE_SHA,
      mergeGate.policyDigest, mergeGate.checksDigest, mergeGate.reviewsDigest,
      NOW, NOW, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_merge_gate_required_checks (
         observation_id, position, context, integration_id, state
       ) VALUES ('merge_observation_case8', 0, 'ci', 42, 'pending')`,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO merge_gate_evaluations (
         evaluation_id, run_id, run_version, publication_id, observation_id,
         plan_id, plan_version, plan_digest, approval_id, status, rejection_reason, created_at
       ) VALUES ('merge_evaluation_case8', ?, 9, 'publication_case8_merge',
                 'merge_observation_case8', ?, 1, ?, NULL, 'rejected',
                 'required_checks_incomplete', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, NOW),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM case8_audit_report_accesses'),
    env.DB_CONTROL.prepare('DELETE FROM raw_agent_artifacts'),
    env.DB_CONTROL.prepare('DELETE FROM raw_agent_artifact_uploads'),
    env.DB_CONTROL.prepare('DELETE FROM merge_gate_decisions'),
    env.DB_CONTROL.prepare('DELETE FROM merge_gate_evaluations'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_gate_required_checks'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_gate_observations'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replay_reconciliations'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replay_effects'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_replays'),
    env.DB_CONTROL.prepare('DELETE FROM github_test_deployment_status_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_test_deployment_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM test_deployment_oidc_attestations'),
    env.DB_CONTROL.prepare('DELETE FROM test_deployments'),
    env.DB_CONTROL.prepare('DELETE FROM tool_call_traces'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM github_api_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedCase8Run();
});

describe('Case 8 one-query audit proof', () => {
  it('answers all eight questions with digests and safe links in under five minutes', async () => {
    const unauthorized = await SELF.fetch(
      `https://delivery-loop.test/v1/runs/${RUN_ID}/audit`,
    );
    expect(unauthorized.status).toBe(401);
    const unknownQuery = await SELF.fetch(
      `https://delivery-loop.test/v1/runs/${RUN_ID}/audit?include=raw`,
      { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
    );
    expect(unknownQuery.status).toBe(400);

    const responses = await Promise.all(Array.from({ length: 20 }, async () => {
      const response = await SELF.fetch(
        `https://delivery-loop.test/v1/runs/${RUN_ID}/audit`,
        { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return await response.json<{
        reportDigest: string;
        queryDurationMs: number;
        answers: Record<string, unknown>;
        links: Array<{ kind: string; url: string }>;
      }>();
    }));
    expect(new Set(responses.map((report) => report.reportDigest))).toHaveLength(1);
    const report = responses[0]!;
    expect(report.reportDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.queryDurationMs).toBeLessThan(300_000);
    expect(Object.keys(report.answers).sort()).toEqual([
      'approvals', 'changes', 'checks', 'contextReads', 'deployments',
      'permissions', 'sourceEvents', 'who',
    ]);
    expect(report.answers).toMatchObject({
      who: {
        taskActor: { type: 'user', id: 'user:requester' },
        attempts: expect.arrayContaining([
          expect.objectContaining({
            attemptId: ATTEMPT_ID, mode: 'implement', claimedProgressVersion: 1,
          }),
        ]),
      },
      sourceEvents: expect.arrayContaining([
        expect.objectContaining({
          kind: 'task_revision',
          provider: 'feishu',
          externalId: 'event-case8',
          revision: 'revision-7',
          digest: TASK_DIGEST,
        }),
        expect.objectContaining({
          kind: 'approval_decision',
          provider: 'feishu',
          externalId: 'event-case8-deploy-approval',
          approvalId: 'approval_case8_deploy',
        }),
      ]),
      permissions: expect.objectContaining({
        grants: expect.arrayContaining([
          expect.objectContaining({
            attemptId: ATTEMPT_ID,
            scopes: expect.arrayContaining(['logs:read', 'database:diagnostic']),
          }),
        ]),
        planEffects: expect.arrayContaining([
          expect.objectContaining({ itemId: ITEM_ID, effect: 'repo_write' }),
        ]),
        repositoryWriteCredentials: expect.arrayContaining([
          expect.objectContaining({
            credentialId: 'credential_case8', createdAt: NOW,
          }),
        ]),
      }),
      contextReads: expect.arrayContaining([
        expect.objectContaining({ category: 'logs', successfulCalls: 1 }),
        expect.objectContaining({ category: 'database', successfulCalls: 1 }),
      ]),
      changes: expect.arrayContaining([
        expect.objectContaining({
          kind: 'commit', parentSha: BASE_SHA, headSha: HEAD_SHA,
          evidenceId: 'evidence_case8_commit',
        }),
      ]),
      checks: expect.objectContaining({
        githubRunObservations: [
          expect.objectContaining({
            sourceKind: 'api', sourceId: 'api_case8_agent',
            githubRunId: '8001', attemptId: ATTEMPT_ID,
            processingState: 'applied', sourceDigest: `sha256:${'d'.repeat(64)}`,
          }),
          expect.objectContaining({
            sourceKind: 'webhook', sourceId: 'delivery_case8_agent',
            githubRunId: '8001', attemptId: ATTEMPT_ID,
            processingState: 'applied', sourceDigest: `sha256:${'c'.repeat(64)}`,
          }),
        ],
        pullRequestObservations: [],
        reviewObservations: [],
        planRevisions: [],
        baseRebases: [],
        baseConflicts: [],
        mergeGates: [expect.objectContaining({
          observationId: 'merge_observation_case8',
          runVersion: 9,
          publicationId: 'publication_case8_merge',
          evaluation: expect.objectContaining({
            evaluationId: 'merge_evaluation_case8',
            status: 'rejected',
            rejectionReason: 'required_checks_incomplete',
            approvalId: null,
          }),
          decisionId: null,
          fact: expect.objectContaining({
            repository: 'example/audit-repo', number: 7,
            requiredChecks: [{ context: 'ci', integrationId: 42, state: 'pending' }],
          }),
        })],
        mergeObservations: [],
        productionApprovals: [],
        productionDeploymentObservations: [],
        secretArtifacts: [],
        identityApprovals: expect.arrayContaining([
          expect.objectContaining({
            sourceId: 'source_case8_deploy', outcome: 'accepted',
            effect: 'test_deploy', separationVerified: true,
            approverPrincipal: 'user:deployer-approver',
          }),
          expect.objectContaining({
            sourceId: 'source_case8_self_merge', outcome: 'rejected',
            effect: 'merge', reason: 'self_approval_denied',
            separationVerified: false,
            approverPrincipal: 'agent:delivery-bot',
            authorPrincipal: 'agent:delivery-bot',
          }),
        ]),
        testDeploymentObservations: expect.arrayContaining([
          expect.objectContaining({
            observationId: 'delivery_case8_test', sourceKind: 'webhook',
            processingState: 'applied', deploymentId: 'deployment_case8_test',
          }),
          expect.objectContaining({
            observationId: 'api_observation_case8_test', sourceKind: 'api',
            processingState: 'applied', deploymentId: 'deployment_case8_test',
          }),
        ]),
        commands: expect.arrayContaining([
          expect.objectContaining({
            commandRef: 'verify:required', status: 'passed',
            deliveryPolicyDigest: POLICY_DIGEST,
          }),
        ]),
        itemVerifications: expect.arrayContaining([
          expect.objectContaining({ evidenceSetDigest: EVIDENCE_SET_DIGEST }),
        ]),
        replays: [{
          replayId: 'replay_case8',
          expectedRunVersion: 8,
          planId: PLAN_ID,
          planVersion: 1,
          itemId: ITEM_ID,
          target: {
            kind: 'plan_item',
            name: 'plan-v1-item-item_case8_change-verify',
            type: 'do',
            count: 1,
          },
          reasonDigest: REPLAY_REASON_DIGEST,
          effectSnapshotDigest: REPLAY_SNAPSHOT_DIGEST,
          restartObservedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
          outbox: {
            id: 'outbox_case8_replay',
            state: 'settled',
            attemptCount: 1,
          },
          effects: [{ effect: 'repo_write', approvalId: 'approval_case8_write' }],
          reconciliations: [
            {
              sourceKind: 'evidence',
              sourceRef: 'd1://evidence/evidence_case8_deploy',
              sourceDigest: REPLAY_EVIDENCE_DIGEST,
              evidenceId: 'evidence_case8_deploy',
              evidenceKind: 'deployment',
              status: 'passed',
              verificationStatus: 'verified',
              sha: HEAD_SHA,
            },
            {
              sourceKind: 'outbox',
              sourceRef: 'd1://outbox/outbox_case8_dispatch',
              sourceDigest: REPLAY_DISPATCH_DIGEST,
              outboxId: 'outbox_case8_dispatch',
              outboxKind: 'execution_dispatch',
              deliveryState: 'settled',
            },
          ],
        }],
        effectOutboxes: [{
          id: 'outbox_case8_dispatch',
          kind: 'execution_dispatch',
          state: 'settled',
          createdAt: NOW,
        }],
      }),
      approvals: expect.arrayContaining([
        expect.objectContaining({
          approvalId: 'approval_case8_write',
          approver: 'user:reviewer',
          effect: 'repo_write',
          decision: 'approve',
          planDigest: PLAN_DIGEST,
        }),
        expect.objectContaining({
          approvalId: 'approval_case8_deploy',
          taskId: TASK_ID,
          taskRevision: 'revision-7',
          approver: 'user:deployer-approver',
          effect: 'test_deploy',
          lineageId: 'approval_lineage_case8_deploy',
          sourceRecordId: 'source_case8_deploy',
          provider: 'feishu',
          externalEventId: 'event-case8-deploy-approval',
          sourceOccurredAt: NOW,
          decisionRecordedAt: NOW,
        }),
      ]),
        deployments: expect.arrayContaining([
        expect.objectContaining({
          deploymentId: 'deployment_case8_test',
          environment: 'test',
          roleRef: 'test:case8-deployer',
          status: 'succeeded',
          sha: HEAD_SHA,
          workflowPath: '.github/workflows/delivery-test-deploy.yml',
          oidcAudience: 'delivery-loop-test-deploy',
          oidcAttestationId: 'attestation_case8_test',
          oidcGithubRunId: '8002',
          oidcSubject: 'repo:example/audit-repo:environment:test',
        }),
      ]),
    });
    expect(report.links).toEqual(expect.arrayContaining([
      {
        kind: 'source',
        url: 'https://feishu.example.test/task/case8',
      },
      {
        kind: 'check',
        url: 'https://github.example.test/actions/runs/8001',
      },
      {
        kind: 'deployment',
        url: 'https://deploy.example.test/test/case8',
      },
    ]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SECRET_CANARY);
    expect(serialized).not.toContain(TOKEN_DIGEST);
    expect(serialized).not.toContain(OIDC_DIGEST);
    expect(serialized).not.toContain(TOOL_DIGEST);
    expect(serialized).not.toContain('nonce');
    expect(serialized).not.toContain('summary-');
    expect(serialized).not.toContain('title-');

    const logs: unknown[] = [];
    new Case8AuditLogger((record) => logs.push(record)).generated(
      report as Case8AuditReport,
    );
    expect(logs).toEqual([expect.objectContaining({
      event: 'case8_audit_report_generated',
      runId: RUN_ID,
      reportDigest: report.reportDigest,
      sourceEventCount: 2,
      contextCategoryCount: 3,
      changeCount: 2,
      approvalCount: 2,
      deploymentCount: 1,
    })]);
    expect(JSON.stringify(logs)).not.toContain(SECRET_CANARY);

    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM case8_audit_report_accesses
       WHERE run_id = ? AND principal = 'service:operations'
         AND report_digest = ? AND duration_ms < 300000`,
    ).bind(RUN_ID, report.reportDigest).first()).toEqual({ count: 20 });
  });

  it('projects only ciphertext registry metadata and sanitizes settled effect errors', async () => {
    const objectId = '22222222-2222-4222-8222-222222222222';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO raw_agent_artifacts (
           object_id, object_identity_digest, category, ciphertext_digest, size_bytes,
           r2_etag, policy_version, created_at, expires_at, deletion_state, updated_at
         ) VALUES (?, ?, 'raw_transcript', ?, 128, 'etag-case8', 'security-v1-raw-30d', ?, ?, 'active', ?)`,
      ).bind(
        objectId, `sha256:${'8'.repeat(64)}`, `sha256:${'9'.repeat(64)}`,
        NOW, '2026-08-25T14:00:00.000Z', NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO raw_agent_artifact_uploads (
           upload_id, object_identity_digest, attempt_id, category, lease_generation,
           upload_state, created_at, completed_at, updated_at
         ) VALUES (?, ?, ?, 'raw_transcript', 1, 'complete', ?, ?, ?)`,
      ).bind(
        objectId, `sha256:${'8'.repeat(64)}`, ATTEMPT_ID,
        NOW, NOW, NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, attempt_count, last_error_code, created_at, updated_at
         ) VALUES ('outbox_case8_secret_blocked', ?, 'pull_request', 'github_api',
                   'd1://pull-requests/case8', 'pull_request:case8:secret',
                   'settled', 1, 'pull_request_secret_detected', ?, ?)`,
      ).bind(RUN_ID, NOW, NOW),
    ]);
    const report = await new Case8AuditReportStore(env.DB_CONTROL).generate(RUN_ID);
    expect(report.answers.checks).toMatchObject({
      secretArtifacts: expect.arrayContaining([expect.objectContaining({
        objectId,
        attemptId: ATTEMPT_ID,
        category: 'raw_transcript',
        ciphertextDigest: `sha256:${'9'.repeat(64)}`,
        sizeBytes: 128,
        policyVersion: 'security-v1-raw-30d',
        deletionState: 'active',
      })]),
      effectOutboxes: expect.arrayContaining([expect.objectContaining({
        id: 'outbox_case8_secret_blocked',
        kind: 'pull_request',
        state: 'settled',
        lastErrorCode: 'pull_request_secret_detected',
      })]),
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('etag-case8');
    expect(serialized).not.toContain(SECRET_CANARY);
  });

  it('fails closed when a GitHub run observation safe projection is corrupted', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE github_webhook_deliveries SET payload_digest = ?
       WHERE delivery_id = 'delivery_case8_agent'`,
    ).bind(`sha256:${'G'.repeat(64)}`).run();
    await expect(new Case8AuditReportStore(env.DB_CONTROL).generate(RUN_ID))
      .rejects.toMatchObject({ code: 'projection_conflict' });
  });

  it('rejects missing runs and reports that exceed the five-minute server budget', async () => {
    const missing = await SELF.fetch(
      'https://delivery-loop.test/v1/runs/run_case8_missing/audit',
      { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
    );
    expect(missing.status).toBe(404);

    await env.DB_CONTROL.prepare(
      `UPDATE attempt_tokens SET scopes_json = '["repo:read","repo:write"]'
       WHERE token_id = 'token_case8'`,
    ).run();
    await expect(new Case8AuditReportStore(env.DB_CONTROL).generate(RUN_ID))
      .rejects.toMatchObject({ code: 'projection_conflict' });
    await env.DB_CONTROL.prepare(
      `UPDATE attempt_tokens
       SET scopes_json = '["repo:read","logs:read","trace:read","k8s:read","database:diagnostic","checkpoint:write"]'
       WHERE token_id = 'token_case8'`,
    ).run();

    let elapsed = 0;
    const store = new Case8AuditReportStore(env.DB_CONTROL, {
      now: () => new Date(NOW),
      monotonicNow: () => {
        elapsed += 300_001;
        return elapsed;
      },
      generateAccessId: () => 'access_case8_over_budget',
    });
    await expect(store.generate(RUN_ID)).rejects.toSatisfy((error: unknown) =>
      error instanceof Case8AuditReportError && error.code === 'time_budget_exceeded');
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM case8_audit_report_accesses
       WHERE access_id = 'access_case8_over_budget'`,
    ).first()).toEqual({ count: 0 });
  });
});
