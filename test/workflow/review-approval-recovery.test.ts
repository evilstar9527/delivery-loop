/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubCommitApprovalService,
  githubCommitApprovalBody,
  type GitHubCommitApprovalClient,
  type GitHubCommitApprovalFact,
} from '../../src/github-commit-approval.js';
import {
  GitHubReviewApprovalRecoveryReconciler,
} from '../../src/reconciliation/github-review-feedback-reconciler.js';
import { ExecutionProgressReconciler } from '../../src/reconciliation/execution-progress-reconciler.js';

const NOW = '2026-08-08T08:00:00.000Z';
const RUN_ID = 'run-review-approval-recovery';
const TASK_ID = 'task-review-approval-recovery';
const PLAN_ID = 'plan-review-approval-recovery';
const ITEM_ID = 'apply-review-fix';
const ROOT_ATTEMPT_ID = 'attempt-review-root';
const FAILED_ATTEMPT_ID = 'attempt-review-credential-failed';
const ANALYSIS_ATTEMPT_ID = 'attempt-review-recovery-analysis';
const PRIOR_ATTEMPT_ID = 'attempt-review-recovery-prior';
const REPOSITORY = 'evilstar9527/delivery-loop';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const TASK_DIGEST = `sha256:${'d'.repeat(64)}`;
const FEEDBACK_DIGEST = `sha256:${'e'.repeat(64)}`;
const FAILURE_SCOPE_DIGEST = `scope:v1:${'f'.repeat(62)}`;
const FAILURE_FINGERPRINT = `sha256:${'1'.repeat(64)}`;
const BRANCH = `agent/${TASK_ID}/${PRIOR_ATTEMPT_ID}`;
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/delivery-agent.yml@refs/heads/main`;

class FakeCommentClient implements GitHubCommitApprovalClient {
  fact: GitHubCommitApprovalFact | null = null;

  async getCommitComment(): Promise<GitHubCommitApprovalFact> {
    if (this.fact === null) throw new Error('comment is unavailable');
    return structuredClone(this.fact);
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM automated_review_replacement_redispatches'),
    env.DB_CONTROL.prepare('DELETE FROM automated_review_fix_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_reviews'),
    env.DB_CONTROL.prepare('DELETE FROM review_approval_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM review_approval_recovery_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_lineages'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM run_blockers'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failure_paths'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures'),
    env.DB_CONTROL.prepare('DELETE FROM review_feedback_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_feedbacks'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_unfinished_items'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_command_refs'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedBlockedReviewCredentialFailure(
  shape: 'human_blocked' | 'automated_executing' = 'human_blocked',
): Promise<void> {
  const runState = shape === 'human_blocked' ? 'blocked' : 'executing';
  const planStatus = shape === 'human_blocked' ? 'blocked' : 'active';
  const progressStatus = shape === 'human_blocked' ? 'blocked' : 'in_progress';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'owner', 'review-recovery', '1', ?, 'r2://task',
                 'user', 'owner', ?, 'main', 'none', 'bug', 'Recover review fix',
                 'p1', 1, 1, 0, 0, 1, ?, ?)` ,
    ).bind(TASK_ID, TASK_DIGEST, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, ?, 10, ?, 1, ?, ?, ?)` ,
    ).bind(
      RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, runState, PLAN_ID,
      PLAN_DIGEST, NOW, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, ?, ?, 1, 1, ?, ?)` ,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, WORKFLOW_REF, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, ?, ?, 'Apply exact review feedback.', ?, ?)` ,
    ).bind(
      PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, planStatus, ANALYSIS_ATTEMPT_ID, NOW, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id, head_branch, head_sha,
         version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'completed', ?, ?, ?, ?, 1, ?, ?, ?, 5, 2, ?, ?)` ,
    ).bind(
      PRIOR_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, WORKFLOW_REF, PLAN_ID, ITEM_ID,
      BRANCH, HEAD_SHA, NOW, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'change', 'Apply review fix', 'Address the exact-head review.', 1, 0)` ,
    ).bind(PLAN_ID, ITEM_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'The review issue is fixed and verification passes.')` ,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'test:unit')` ,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'verify:all')` ,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, ?, 'commit')` ,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, ?, 'test')` ,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')` ,
    ).bind(PLAN_ID, ITEM_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_sha, version, lease_generation,
         github_status, github_conclusion, recovered_from_attempt_id,
         created_at, updated_at
       ) VALUES (?, ?, 3, 'review_fix', 'lost', ?, ?, ?, ?, 1, ?, 4, ?, 4, 2,
                 'completed', 'failure', NULL, ?, ?)` ,
    ).bind(ROOT_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, WORKFLOW_REF, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_sha, version, lease_generation,
         github_status, github_conclusion, recovered_from_attempt_id,
         created_at, updated_at
       ) VALUES (?, ?, 4, 'review_fix', 'failed', ?, ?, ?, ?, 1, ?, 5, ?, 4, 2,
                 'completed', 'failure', ?, ?, ?)` ,
    ).bind(
      FAILED_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, WORKFLOW_REF, PLAN_ID,
      ITEM_ID, HEAD_SHA, ROOT_ATTEMPT_ID, NOW, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, ?, ?, 6, ?)` ,
    ).bind(PLAN_ID, ITEM_ID, progressStatus, FAILED_ATTEMPT_ID, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, kind, status,
         sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-review-recovery-pr', ?, ?, ?, 1, 'pull_request', 'passed',
                 ?, 'Verified Draft PR.', 'verified', ?, ?)` ,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-review-recovery-head', ?, ?, ?, 1, ?, 'commit', 'passed',
                 ?, 'Verified prior head.', 'verified', ?, ?)` ,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-review-recovery-prior', 'evidence-review-recovery-head', ?, ?, ?, 1,
                 ?, 2, ?, ?, ?, ?)` ,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, ITEM_ID, BASE_SHA, HEAD_SHA, BRANCH, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id,
         head_sha, branch, body, body_digest, status, created_at
       ) VALUES ('draft-review-recovery', ?, 8, ?, '1', ?, ?, 1, ?, ?,
                 'head-review-recovery-prior', ?, ?, 'bounded', ?, 'prepared', ?)` ,
    ).bind(
      RUN_ID, TASK_ID, TASK_DIGEST, PLAN_ID, PLAN_DIGEST, PRIOR_ATTEMPT_ID,
      HEAD_SHA, BRANCH, FEEDBACK_DIGEST, NOW,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-review-recovery-old', ?, '1', ?, 1, ?, ?, 'repo_write',
                 'user:owner', 'approve', ?, '2026-08-08T07:00:00.000Z', ?)` ,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'2'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_publications (
         publication_id, run_id, run_version, draft_id, approval_id, repository,
         base_branch, head_branch, head_sha, title, body_digest, status,
         github_pr_number, github_pr_url, github_external_updated_at,
         github_observation_version, evidence_id, created_at, updated_at
       ) VALUES ('publication-review-recovery', ?, 8, 'draft-review-recovery',
                 'approval-review-recovery-old', ?, 'main', ?, ?, 'Review recovery', ?,
                 'verified', 209, 'https://github.com/evilstar9527/delivery-loop/pull/209',
                 ?, 1, 'evidence-review-recovery-pr', ?, ?)` ,
    ).bind(RUN_ID, REPOSITORY, BRANCH, HEAD_SHA, FEEDBACK_DIGEST, NOW, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO github_review_webhook_deliveries (
         delivery_id, event_type, payload_digest, repository, github_pr_number,
         github_review_id, publication_id, reviewed_head_sha, processing_state,
         received_at, processed_at
       ) VALUES ('delivery-review-recovery', 'pull_request_review', ?, ?, 209, '4884313395',
                 'publication-review-recovery', ?, 'applied', ?, ?)` ,
    ).bind(FEEDBACK_DIGEST, REPOSITORY, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_review_feedbacks (
         feedback_id, source_delivery_id, github_review_id, publication_id, run_id,
         expected_run_version, plan_id, plan_version, plan_item_id, prior_attempt_id,
         repository, github_pr_number, source_head_sha, branch, review_url,
         submitted_at, body_ref, body_digest, payload_digest, created_at
       ) VALUES ('feedback-review-recovery', 'delivery-review-recovery', '4884313395',
                 'publication-review-recovery', ?, 9, ?, 1, ?, ?, ?, 209, ?, ?,
                 'https://github.com/evilstar9527/delivery-loop/pull/209#pullrequestreview-4884313395',
                 ?, 'r2://review-feedback', ?, ?, ?)` ,
    ).bind(
      RUN_ID, PLAN_ID, ITEM_ID, PRIOR_ATTEMPT_ID, REPOSITORY, HEAD_SHA, BRANCH,
      NOW, FEEDBACK_DIGEST, FEEDBACK_DIGEST, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO review_feedback_attempts (
         feedback_id, review_attempt_id, prior_attempt_id, branch, source_head_sha, created_at
       ) VALUES ('feedback-review-recovery', ?, ?, ?, ?, ?)` ,
    ).bind(ROOT_ATTEMPT_ID, PRIOR_ATTEMPT_ID, BRANCH, HEAD_SHA, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation, occurred_at, created_at
       ) VALUES ('failure-review-recovery', ?, ?, 4, 'event-review-recovery-failure', 1,
                 ?, ?, 'tool_error', 'tool_unavailable', 'external_reconciliation',
                 'resolve_external_dependency', 1, 1, 2, ?, ?)` ,
    ).bind(RUN_ID, FAILED_ATTEMPT_ID, FAILURE_SCOPE_DIGEST, FAILURE_FINGERPRINT, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-review-recovery', ?, 'external_dependency', ?, ?, 1, 1,
                 'resolve_external_dependency', ?)` ,
    ).bind(RUN_ID, FAILURE_SCOPE_DIGEST, FAILURE_FINGERPRINT, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('workflow-cancel-review-recovery', ?, 'workflow_cancel',
                 'cloudflare_workflows', ?, ?, 'settled', ?, ?)` ,
    ).bind(RUN_ID, `d1://runs/${RUN_ID}`, `workflow-cancel:${RUN_ID}`, NOW, NOW),
  ]);
}

async function convertToLostPreEffectReplacement(
  credentialStatus: 'active' | 'revoked' = 'revoked',
): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO review_approval_recovery_approvals (
         recovery_approval_id, run_id, plan_id, plan_version, plan_item_id,
         failed_attempt_id, root_review_attempt_id, approval_id, created_at
       ) VALUES ('prior-review-recovery-approval', ?, ?, 1, ?, ?, ?,
                 'approval-review-recovery-old', ?)`,
    ).bind(RUN_ID, PLAN_ID, ITEM_ID, ROOT_ATTEMPT_ID, ROOT_ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare('DELETE FROM run_blockers WHERE run_id = ?').bind(RUN_ID),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures WHERE attempt_id = ?')
      .bind(FAILED_ATTEMPT_ID),
    env.DB_CONTROL.prepare(
      `UPDATE execution_plans SET status = 'active', updated_at = ? WHERE plan_id = ?`,
    ).bind(NOW, PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO review_approval_recoveries (
         recovery_id, recovery_approval_id, run_id, plan_id, plan_version,
         plan_item_id, failed_attempt_id, root_review_attempt_id, approval_id,
         replacement_attempt_id, created_at
       ) VALUES ('prior-review-recovery', 'prior-review-recovery-approval', ?, ?, 1,
                 ?, ?, ?, 'approval-review-recovery-old', ?, ?)`,
    ).bind(
      RUN_ID, PLAN_ID, ITEM_ID, ROOT_ATTEMPT_ID, ROOT_ATTEMPT_ID, FAILED_ATTEMPT_ID, NOW,
    ),
    env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress
       SET status = 'in_progress', version = version + 1, updated_at = ?
       WHERE plan_id = ? AND item_id = ? AND active_attempt_id = ?`,
    ).bind(NOW, PLAN_ID, ITEM_ID, FAILED_ATTEMPT_ID),
    env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'lost', github_status = 'completed', github_conclusion = 'failure',
           version = version + 1, lease_generation = lease_generation + 1, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(NOW, FAILED_ATTEMPT_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_write_credentials (
         credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         approval_id, repository, lease_generation, status, revoked_at,
         authorization_expires_at, created_at, updated_at
       ) VALUES ('credential-review-recovery-terminal', ?, ?, ?, 1, ?,
                 'approval-review-recovery-old', ?, 3, ?, ?, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      FAILED_ATTEMPT_ID,
      PLAN_ID,
      ITEM_ID,
      REPOSITORY,
      credentialStatus,
      credentialStatus === 'revoked' ? NOW : null,
      credentialStatus === 'active' ? '2099-01-01T00:00:00.000Z' : NOW,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_stuck_incidents (
         incident_id, run_id, state_kind, observed_run_state, run_version,
         attempt_id, threshold_seconds, action, status, detected_at,
         recovery_requested_at, resolved_at, resolution_code
       ) VALUES ('incident-review-recovery-lost', ?, 'running', 'executing', 9,
                 ?, 90, 'fence_lost_attempt', 'resolved', ?, ?, ?, 'attempt_fenced')`,
    ).bind(RUN_ID, FAILED_ATTEMPT_ID, NOW, NOW, NOW),
  ]);
}

async function convertToAutomatedReviewFixFailure(
  credentialStatus: 'active' | 'revoked' | 'expired' = 'revoked',
): Promise<void> {
  await reset();
  await seedBlockedReviewCredentialFailure('automated_executing');
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM review_feedback_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_feedbacks'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM run_blockers'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failure_paths'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures'),
    env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress
       SET status = 'in_progress', active_attempt_id = ?, version = 6, updated_at = ?
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(FAILED_ATTEMPT_ID, NOW, PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'failed', recovered_from_attempt_id = NULL,
           github_status = 'in_progress', github_conclusion = NULL,
           head_sha = ?, version = 4, lease_generation = 2, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(HEAD_SHA, NOW, FAILED_ATTEMPT_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO automated_reviews (
         review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
         prior_attempt_id, review_attempt_id, repository, github_pr_number,
         base_branch, branch, source_head_sha, iteration, status, result_ref,
         result_digest, feedback_body_digest, blocking_finding_count,
         minor_finding_count, completed_at, created_at, updated_at
       ) VALUES ('automated-review-fix-recovery', ?, 'publication-review-recovery', ?, 1, ?,
                 ?, ?, ?, 209, 'main', ?, ?, 1, 'changes_requested',
                 'r2://automated-reviews/recovery.json', ?, ?, 1, 0, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      ITEM_ID,
      PRIOR_ATTEMPT_ID,
      ANALYSIS_ATTEMPT_ID,
      REPOSITORY,
      BRANCH,
      HEAD_SHA,
      FEEDBACK_DIGEST,
      `sha256:${'6'.repeat(64)}`,
      NOW,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO automated_review_fix_attempts (
         review_id, fix_attempt_id, prior_attempt_id, branch, source_head_sha, created_at
       ) VALUES ('automated-review-fix-recovery', ?, ?, ?, ?, ?)`,
    ).bind(FAILED_ATTEMPT_ID, PRIOR_ATTEMPT_ID, BRANCH, HEAD_SHA, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation, occurred_at, created_at
       ) VALUES ('failure-automated-review-fix-recovery', ?, ?, 4,
                 'event-automated-review-fix-recovery', 1, ?, ?, 'unknown',
                 'unknown_failure', 'external_reconciliation', 'manual_investigation',
                 1, 1, 2, ?, ?)`,
    ).bind(RUN_ID, FAILED_ATTEMPT_ID, FAILURE_SCOPE_DIGEST, FAILURE_FINGERPRINT, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_write_credentials (
         credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         approval_id, repository, lease_generation, status, revoked_at,
         authorization_expires_at, created_at, updated_at
       ) VALUES ('credential-automated-review-fix-recovery', ?, ?, ?, 1, ?,
                 'approval-review-recovery-old', ?, 2, ?, ?, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      FAILED_ATTEMPT_ID,
      PLAN_ID,
      ITEM_ID,
      REPOSITORY,
      credentialStatus,
      credentialStatus === 'revoked' ? NOW : null,
      credentialStatus === 'active' ? '2099-01-01T00:00:00.000Z' : NOW,
      NOW,
      NOW,
    ),
  ]);
}

async function convertToImplementationRepairCredentialFailure(): Promise<void> {
  await reset();
  await seedBlockedReviewCredentialFailure('automated_executing');
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM review_feedback_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_feedbacks'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_webhook_deliveries'),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', updated_at = ? WHERE run_id = ?`,
    ).bind(NOW, RUN_ID),
    env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress SET status = 'blocked', updated_at = ?
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(NOW, PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'failed', recovered_from_attempt_id = NULL, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(NOW, FAILED_ATTEMPT_ID),
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed', updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, PRIOR_ATTEMPT_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation, occurred_at, created_at
       ) VALUES ('failure-implementation-verification', ?, ?, 2,
                 'event-implementation-verification', 1, ?, ?, 'verification_error',
                 'verification_nonzero_exit', 'targeted_verification',
                 'manual_investigation', 2, 1, 2, ?, ?)`,
    ).bind(
      RUN_ID, PRIOR_ATTEMPT_ID, `scope:v1:${'7'.repeat(62)}`,
      `sha256:${'8'.repeat(64)}`, NOW, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('dispatch-implementation-credential-repair', ?, 'execution_dispatch',
                 'github_actions', ?, 'execution-repair:failure-implementation-verification',
                 'settled', ?, ?)`,
    ).bind(RUN_ID, `d1://attempts/${FAILED_ATTEMPT_ID}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_write_credentials (
         credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         approval_id, repository, lease_generation, status, last_error_code,
         created_at, updated_at
       ) VALUES ('credential-implementation-repair-failed', ?, ?, ?, 1, ?,
                 'approval-review-recovery-old', ?, 2, 'issuance_failed',
                 'provider_unavailable', ?, ?)`,
    ).bind(RUN_ID, FAILED_ATTEMPT_ID, PLAN_ID, ITEM_ID, REPOSITORY, NOW, NOW),
  ]);
}

function commentFact(body: string, commentId = 219): GitHubCommitApprovalFact {
  return {
    schemaVersion: '1',
    repository: REPOSITORY,
    commentId,
    commitSha: BASE_SHA,
    authorLogin: 'evilstar9527',
    authorType: 'User',
    authorAssociation: 'OWNER',
    body,
    createdAt: '2026-08-08T07:59:00.000Z',
    updatedAt: '2026-08-08T07:59:00.000Z',
    url: `https://github.com/${REPOSITORY}/commit/${BASE_SHA}#commitcomment-${commentId}`,
  };
}

beforeEach(async () => {
  await reset();
  await seedBlockedReviewCredentialFailure();
});

describe('review repo-write approval recovery', () => {
  it('continues the prior implementation head after a credential-only repair failure', async () => {
    await convertToImplementationRepairCredentialFailure();
    const client = new FakeCommentClient();
    const service = new GitHubCommitApprovalService(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );
    const template = await service.template(RUN_ID);
    client.fact = commentFact(template.commentBody, 222);
    const decision = await service.approve(RUN_ID, 222);
    expect(decision.created).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT resolved_at IS NOT NULL AS resolved FROM run_blockers WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ resolved: 1 });

    const reconciler = new GitHubReviewApprovalRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    const results = await reconciler.reconcileBatch();
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const replacement = await env.DB_CONTROL.prepare(
      `SELECT mode, status, head_sha, recovered_from_attempt_id
       FROM attempts WHERE attempt_id = ?`,
    ).bind(results[0]?.replacementAttemptId).first();
    expect(replacement).toEqual({
      mode: 'review_fix',
      status: 'pending',
      head_sha: HEAD_SHA,
      recovered_from_attempt_id: PRIOR_ATTEMPT_ID,
    });

    const outboxId = `dispatch_review_approval_recovery_${results[0]?.replacementAttemptId
      .replace('attempt_review_approval_recovery_', '')}`;
    await env.DB_CONTROL.prepare(
      `UPDATE outbox SET delivery_state = 'settled', attempt_count = 2,
              last_error_code = 'repair_fenced_after_dispatch'
       WHERE outbox_id = ?`,
    ).bind(outboxId).run();
    await expect(reconciler.reconcileBatch()).resolves.toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, attempt_count, last_error_code
       FROM outbox WHERE outbox_id = ?`,
    ).bind(outboxId).first()).toEqual({
      delivery_state: 'pending', attempt_count: 2, last_error_code: null,
    });
  });

  it('creates one fresh-approval replacement for an automated review fix that failed pre-effect', async () => {
    await convertToAutomatedReviewFixFailure();
    const client = new FakeCommentClient();
    const service = new GitHubCommitApprovalService(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );
    const template = await service.template(RUN_ID);
    expect(template.commentBody).toBe(githubCommitApprovalBody({
      runId: RUN_ID,
      runVersion: 10,
      planId: PLAN_ID,
      planVersion: 1,
      planDigest: PLAN_DIGEST,
      baseSha: BASE_SHA,
    }));
    client.fact = commentFact(template.commentBody, 221);

    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () => await service.approve(RUN_ID, 221)),
    );
    expect(decisions.filter((decision) => decision.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 11 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'ready', active_attempt_id: null, version: 7,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT source_kind, failed_attempt_id, root_review_attempt_id
       FROM review_approval_recovery_approvals WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      source_kind: 'automated_fix_failed_pre_effect',
      failed_attempt_id: FAILED_ATTEMPT_ID,
      root_review_attempt_id: FAILED_ATTEMPT_ID,
    });
    await expect(service.template(RUN_ID)).rejects.toMatchObject({ code: 'state_conflict' });

    const reconciler = new GitHubReviewApprovalRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    const recovered = await Promise.all(
      Array.from({ length: 20 }, async () => await reconciler.reconcileBatch()),
    );
    expect(recovered.flat().filter((result) => result.created)).toHaveLength(1);
    const lineage = await env.DB_CONTROL.prepare(
      `SELECT source_kind, failed_attempt_id, root_review_attempt_id, replacement_attempt_id
       FROM review_approval_recoveries WHERE failed_attempt_id = ?`,
    ).bind(FAILED_ATTEMPT_ID).first<{
      source_kind: string;
      failed_attempt_id: string;
      root_review_attempt_id: string;
      replacement_attempt_id: string;
    }>();
    expect(lineage).toMatchObject({
      source_kind: 'automated_fix_failed_pre_effect',
      failed_attempt_id: FAILED_ATTEMPT_ID,
      root_review_attempt_id: FAILED_ATTEMPT_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, recovered_from_attempt_id FROM attempts WHERE attempt_id = ?`,
    ).bind(lineage?.replacement_attempt_id).first()).toEqual({
      status: 'pending', recovered_from_attempt_id: FAILED_ATTEMPT_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE recovered_from_attempt_id = ?`,
    ).bind(FAILED_ATTEMPT_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'execution_dispatch'
       AND payload_ref = ?`,
    ).bind(`d1://attempts/${lineage?.replacement_attempt_id}`).first()).toEqual({ count: 1 });
  });

  it.each([
    'active_credential',
    'head_update',
    'verification',
    'existing_replacement',
  ] as const)('rejects unsafe automated review fix recovery evidence: %s', async (kind) => {
    await convertToAutomatedReviewFixFailure(
      kind === 'active_credential' ? 'active' : 'revoked',
    );
    if (kind === 'head_update') {
      await env.DB_CONTROL.batch([
        env.DB_CONTROL.prepare(
          `INSERT INTO evidence (
             evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
             kind, status, sha, summary, verification_status, observed_at, created_at
           ) VALUES ('evidence-automated-recovery-unsafe', ?, ?, ?, 1, ?, 'commit',
                     'passed', ?, 'Unexpected automated fix effect.', 'unverified', ?, ?)`,
        ).bind(RUN_ID, FAILED_ATTEMPT_ID, PLAN_ID, ITEM_ID, '7'.repeat(40), NOW, NOW),
        env.DB_CONTROL.prepare(
          `INSERT INTO attempt_head_updates (
             update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
             plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
           ) VALUES ('head-automated-recovery-unsafe',
                     'evidence-automated-recovery-unsafe', ?, ?, ?, 1,
                     ?, 2, ?, ?, ?, ?)`,
        ).bind(
          RUN_ID,
          FAILED_ATTEMPT_ID,
          PLAN_ID,
          ITEM_ID,
          HEAD_SHA,
          '7'.repeat(40),
          BRANCH,
          NOW,
        ),
      ]);
    }
    if (kind === 'verification') {
      await env.DB_CONTROL.prepare(
        `INSERT INTO verification_suites (
           suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           lease_generation, head_sha, delivery_policy_digest,
           targeted_command_count, required_command_count, status, created_at, updated_at
         ) VALUES ('suite-automated-recovery-unsafe', ?, ?, ?, 1, ?, 2, ?, ?, 1, 1,
                   'failed', ?, ?)`,
      ).bind(
        RUN_ID,
        FAILED_ATTEMPT_ID,
        PLAN_ID,
        ITEM_ID,
        HEAD_SHA,
        `sha256:${'7'.repeat(64)}`,
        NOW,
        NOW,
      ).run();
    }
    if (kind === 'existing_replacement') {
      await env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id, head_sha,
           recovered_from_attempt_id, version, lease_generation, created_at, updated_at
         ) VALUES ('attempt-existing-automated-fix-replacement', ?, 5, 'review_fix', 'pending',
                   ?, ?, ?, ?, 1, ?, ?, ?, 0, 0, ?, ?)`,
      ).bind(
        RUN_ID,
        BASE_SHA,
        REPOSITORY,
        WORKFLOW_REF,
        PLAN_ID,
        ITEM_ID,
        HEAD_SHA,
        FAILED_ATTEMPT_ID,
        NOW,
        NOW,
      ).run();
    }
    const service = new GitHubCommitApprovalService(
      env.DB_CONTROL,
      new FakeCommentClient(),
      () => new Date(NOW),
    );
    await expect(service.template(RUN_ID)).rejects.toMatchObject({ code: 'state_conflict' });
  });

  it('reopens one exact blocked review failure and creates one approval-bound replacement', async () => {
    const client = new FakeCommentClient();
    const service = new GitHubCommitApprovalService(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );
    const template = await service.template(RUN_ID);
    expect(template.commentBody).toBe(githubCommitApprovalBody({
      runId: RUN_ID,
      runVersion: 10,
      planId: PLAN_ID,
      planVersion: 1,
      planDigest: PLAN_DIGEST,
      baseSha: BASE_SHA,
    }));
    client.fact = commentFact(template.commentBody);

    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () => await service.approve(RUN_ID, 219)),
    );
    expect(decisions.filter((decision) => decision.created)).toHaveLength(1);
    expect(new Set(decisions.map((decision) =>
      decision.status === 'accepted' ? decision.approvalId : 'rejected'))).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 11 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM execution_plans WHERE plan_id = ?`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'active' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'ready', active_attempt_id: null, version: 7,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT resolved_at, resolution_code FROM run_blockers WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      resolved_at: NOW,
      resolution_code: 'repo_write_reapproved',
    });
    await expect(service.template(RUN_ID)).rejects.toMatchObject({ code: 'state_conflict' });

    const generic = new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => new Date(NOW),
    });
    expect(await generic.reconcileScheduling()).toEqual({ activatedRuns: 0, scheduledAttempts: 0 });

    const recovery = new GitHubReviewApprovalRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => await recovery.reconcileBatch()),
    );
    expect(results.flat()).toHaveLength(20);
    expect(results.flat().filter((result) => result.created)).toHaveLength(1);
    const lineage = await env.DB_CONTROL.prepare(
      `SELECT failed_attempt_id, root_review_attempt_id, approval_id, replacement_attempt_id
       FROM review_approval_recoveries WHERE run_id = ?`,
    ).bind(RUN_ID).first<{
      failed_attempt_id: string;
      root_review_attempt_id: string;
      approval_id: string;
      replacement_attempt_id: string;
    }>();
    expect(lineage).toMatchObject({
      failed_attempt_id: FAILED_ATTEMPT_ID,
      root_review_attempt_id: ROOT_ATTEMPT_ID,
    });
    expect(lineage?.approval_id).toMatch(/^approval_identity_/);
    expect(lineage?.replacement_attempt_id).toMatch(/^attempt_review_approval_recovery_/);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, recovered_from_attempt_id FROM attempts WHERE attempt_id = ?`,
    ).bind(lineage?.replacement_attempt_id).first()).toEqual({
      status: 'pending',
      recovered_from_attempt_id: ROOT_ATTEMPT_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 12 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'execution_dispatch'
       AND payload_ref = ?`,
    ).bind(`d1://attempts/${lineage?.replacement_attempt_id}`).first()).toEqual({ count: 1 });
  });

  it('reapproves one fenced lost replacement after its credential is revoked pre-effect', async () => {
    await convertToLostPreEffectReplacement();

    const client = new FakeCommentClient();
    const service = new GitHubCommitApprovalService(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );
    const template = await service.template(RUN_ID);
    expect(template.commentBody).toBe(githubCommitApprovalBody({
      runId: RUN_ID,
      runVersion: 10,
      planId: PLAN_ID,
      planVersion: 1,
      planDigest: PLAN_DIGEST,
      baseSha: BASE_SHA,
    }));
    client.fact = commentFact(template.commentBody, 220);

    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () => await service.approve(RUN_ID, 220)),
    );
    expect(decisions.filter((decision) => decision.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 11 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM execution_plans WHERE plan_id = ?`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'active' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'ready', active_attempt_id: null, version: 8,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT source_kind, failed_attempt_id, root_review_attempt_id
       FROM review_approval_recovery_approvals
       WHERE run_id = ? AND failed_attempt_id = ?`,
    ).bind(RUN_ID, FAILED_ATTEMPT_ID).first()).toEqual({
      source_kind: 'lost_pre_effect',
      failed_attempt_id: FAILED_ATTEMPT_ID,
      root_review_attempt_id: ROOT_ATTEMPT_ID,
    });

    const recovery = new GitHubReviewApprovalRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    const recovered = await Promise.all(
      Array.from({ length: 20 }, async () => await recovery.reconcileBatch()),
    );
    expect(recovered.flat().filter((result) => result.created)).toHaveLength(1);
    const lineage = await env.DB_CONTROL.prepare(
      `SELECT source_kind, failed_attempt_id, root_review_attempt_id, replacement_attempt_id
       FROM review_approval_recoveries WHERE run_id = ? AND failed_attempt_id = ?`,
    ).bind(RUN_ID, FAILED_ATTEMPT_ID).first<{
      source_kind: string;
      failed_attempt_id: string;
      root_review_attempt_id: string;
      replacement_attempt_id: string;
    }>();
    expect(lineage).toMatchObject({
      source_kind: 'lost_pre_effect',
      failed_attempt_id: FAILED_ATTEMPT_ID,
      root_review_attempt_id: ROOT_ATTEMPT_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, recovered_from_attempt_id FROM attempts WHERE attempt_id = ?`,
    ).bind(lineage?.replacement_attempt_id).first()).toEqual({
      status: 'pending',
      recovered_from_attempt_id: ROOT_ATTEMPT_ID,
    });
  });

  it.each([
    'active_credential',
    'verification',
    'cancel_unsettled',
    'incident_missing',
  ] as const)('rejects unsafe lost replacement recovery evidence: %s', async (kind) => {
    await convertToLostPreEffectReplacement(
      kind === 'active_credential' ? 'active' : 'revoked',
    );
    if (kind === 'verification') {
      await env.DB_CONTROL.prepare(
        `INSERT INTO verification_suites (
           suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           lease_generation, head_sha, delivery_policy_digest,
           targeted_command_count, required_command_count, status, created_at, updated_at
         ) VALUES ('suite-lost-review-recovery', ?, ?, ?, 1, ?, 3, ?, ?, 1, 1,
                   'failed', ?, ?)`,
      ).bind(
        RUN_ID, FAILED_ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA,
        `sha256:${'4'.repeat(64)}`, NOW, NOW,
      ).run();
    }
    if (kind === 'cancel_unsettled') {
      await env.DB_CONTROL.prepare(
        `UPDATE outbox SET delivery_state = 'pending'
         WHERE outbox_id = 'workflow-cancel-review-recovery'`,
      ).run();
    }
    if (kind === 'incident_missing') {
      await env.DB_CONTROL.prepare(
        `DELETE FROM run_stuck_incidents
         WHERE incident_id = 'incident-review-recovery-lost'`,
      ).run();
    }
    const service = new GitHubCommitApprovalService(
      env.DB_CONTROL,
      new FakeCommentClient(),
      () => new Date(NOW),
    );
    await expect(service.template(RUN_ID)).rejects.toMatchObject({ code: 'state_conflict' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM review_approval_recovery_approvals
       WHERE failed_attempt_id = ?`,
    ).bind(FAILED_ATTEMPT_ID).first()).toEqual({ count: 0 });
  });

  it.each([
    'credential',
    'head_update',
    'commit',
    'verification',
    'cancel_unsettled',
    'wrong_blocker',
    'head_drift',
  ] as const)('rejects unsafe recovery evidence: %s', async (kind) => {
    if (kind === 'credential') {
      await env.DB_CONTROL.prepare(
        `INSERT INTO github_write_credentials (
           credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           approval_id, repository, lease_generation, status, created_at, updated_at
         ) VALUES ('credential-review-recovery', ?, ?, ?, 1, ?,
                   'approval-review-recovery-old', ?, 2, 'issuance_failed', ?, ?)` ,
      ).bind(RUN_ID, FAILED_ATTEMPT_ID, PLAN_ID, ITEM_ID, REPOSITORY, NOW, NOW).run();
    }
    if (kind === 'commit' || kind === 'head_update') {
      await env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, sha, summary, verification_status, observed_at, created_at
         ) VALUES ('evidence-unsafe-recovery', ?, ?, ?, 1, ?, 'commit', 'passed', ?,
                   'Unexpected failed Attempt commit.', 'unverified', ?, ?)` ,
      ).bind(RUN_ID, FAILED_ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW).run();
      if (kind === 'head_update') {
        await env.DB_CONTROL.prepare(
          `INSERT INTO attempt_head_updates (
             update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
             plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
           ) VALUES ('head-unsafe-recovery', 'evidence-unsafe-recovery', ?, ?, ?, 1, ?, 2,
                     ?, ?, ?, ?)` ,
        ).bind(RUN_ID, FAILED_ATTEMPT_ID, PLAN_ID, ITEM_ID, BASE_SHA, HEAD_SHA, BRANCH, NOW).run();
      }
    }
    if (kind === 'verification') {
      await env.DB_CONTROL.prepare(
        `INSERT INTO verification_suites (
           suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           lease_generation, head_sha, delivery_policy_digest,
           targeted_command_count, required_command_count, status, created_at, updated_at
         ) VALUES ('suite-unsafe-recovery', ?, ?, ?, 1, ?, 2, ?, ?, 1, 1,
                   'failed', ?, ?)` ,
      ).bind(
        RUN_ID, FAILED_ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA,
        `sha256:${'3'.repeat(64)}`, NOW, NOW,
      ).run();
    }
    if (kind === 'cancel_unsettled') {
      await env.DB_CONTROL.prepare(
        `UPDATE outbox SET delivery_state = 'pending' WHERE outbox_id = 'workflow-cancel-review-recovery'`,
      ).run();
    }
    if (kind === 'wrong_blocker') {
      await env.DB_CONTROL.prepare(
        `UPDATE run_blockers SET reason = 'repeated_fingerprint'
         WHERE blocker_id = 'blocker-review-recovery'`,
      ).run();
    }
    if (kind === 'head_drift') {
      await env.DB_CONTROL.prepare(
        `UPDATE attempts SET head_sha = ? WHERE attempt_id = ?`,
      ).bind('9'.repeat(40), FAILED_ATTEMPT_ID).run();
    }
    const service = new GitHubCommitApprovalService(
      env.DB_CONTROL,
      new FakeCommentClient(),
      () => new Date(NOW),
    );
    await expect(service.template(RUN_ID)).rejects.toMatchObject({ code: 'state_conflict' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM review_approval_recovery_approvals',
    ).first()).toEqual({ count: 0 });
  });
});
