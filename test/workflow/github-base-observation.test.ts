/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import {
  GitHubBaseApiClient,
  GitHubBaseObservationReconciler,
  type GitHubBaseExternalFactClient,
  type GitHubBaseObservationResult,
} from '../../src/reconciliation/github-base-observation-reconciler.js';
import {
  AnalysisAttemptContextStore,
  AnalysisPlanProposalStore,
} from '../../src/storage/analysis-attempt-store.js';
import { PlanRevisionAnalysisReconciler } from
  '../../src/reconciliation/plan-revision-analysis-reconciler.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';

const RUN_ID = 'run-github-base-observation';
const TASK_ID = 'task-github-base-observation';
const PLAN_ID = 'plan-github-base-observation-v1';
const ANALYSIS_ATTEMPT_ID = 'attempt-github-base-analysis-v1';
const ACTIVE_ATTEMPT_ID = 'attempt-github-base-active-v1';
const REVIEW_ATTEMPT_ID = 'attempt-github-base-review-v1';
const REVIEW_FIX_ATTEMPT_ID = 'attempt-github-base-review-fix-v1';
const REVIEW_ID = 'review-github-base-v1';
const PUBLICATION_ID = 'publication-github-base-v1';
const DRAFT_ID = 'draft-github-base-v1';
const ITEM_ID = 'change-github-base-v1';
const REPOSITORY = 'example/delivery-target';
const BEFORE_SHA = 'a'.repeat(40);
const AFTER_SHA = 'b'.repeat(40);
const REVIEW_HEAD_SHA = 'c'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const REFERENCE_DIGEST = `sha256:${'d'.repeat(64)}`;
const COMPARISON_DIGEST = `sha256:${'e'.repeat(64)}`;
const NOW = '2026-07-25T23:00:00.000Z';
const DIAGNOSTIC_EVIDENCE_REF = 'd1://evidence/diagnostic_github_base_prior';

function taskEnvelope(kind: 'requirement' | 'bug' = 'requirement'): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-github-base-observation',
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'github-base-observation',
      taskKey: TASK_ID,
      revision: 'revision-1',
    },
    actor: { type: 'system', id: 'github-base-observation' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind,
      title: 'Replan when the trusted base advances',
      description: 'Observe a pure fast-forward before replacing the active Plan.',
      acceptanceCriteria: ['The replacement Plan binds the observed base head.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: true,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

function fastForwardResult(): GitHubBaseObservationResult {
  return {
    disposition: 'fast_forward',
    fact: {
      schemaVersion: '1',
      repository: REPOSITORY,
      baseBranch: 'main',
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      relationship: 'ahead',
      aheadBy: 2,
      referenceDigest: REFERENCE_DIGEST,
      comparisonDigest: COMPARISON_DIGEST,
    },
  };
}

function nonFastForwardResult(): GitHubBaseObservationResult {
  return {
    disposition: 'non_fast_forward',
    fact: {
      schemaVersion: '1',
      repository: REPOSITORY,
      baseBranch: 'main',
      beforeSha: BEFORE_SHA,
      afterSha: AFTER_SHA,
      relationship: 'diverged',
      aheadBy: 2,
      behindBy: 1,
      mergeBaseSha: 'f'.repeat(40),
      referenceDigest: REFERENCE_DIGEST,
      comparisonDigest: COMPARISON_DIGEST,
    },
  };
}

class FakeBaseClient implements GitHubBaseExternalFactClient {
  readonly calls: Array<{ repository: string; baseBranch: string; beforeSha: string }> = [];

  constructor(
    private readonly result: GitHubBaseObservationResult,
    private readonly beforeReturn?: () => Promise<void>,
  ) {}

  async observeBase(
    repository: string,
    baseBranch: string,
    beforeSha: string,
  ): Promise<GitHubBaseObservationResult> {
    this.calls.push({ repository, baseBranch, beforeSha });
    await this.beforeReturn?.();
    return structuredClone(this.result);
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM automated_review_fix_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_reviews'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM base_conflict_approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM github_base_conflicts'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_analysis_retries'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM github_base_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM diagnostic_evidence_trace_sources'),
    env.DB_CONTROL.prepare('DELETE FROM diagnostic_evidence_bindings'),
    env.DB_CONTROL.prepare('DELETE FROM tool_call_traces'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seedActiveAutomatedReview(
  status: 'pending' | 'approved' | 'changes_requested',
  publicationStatus: 'created_unverified' | 'verified' = 'verified',
): Promise<void> {
  const body = '# Review the current Draft PR head.\n';
  const bodyDigest = await canonicalSha256(body);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'Apply the requested change',
                 'Apply and verify the requested change.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-github-base-review-head', ?, ?, ?, 1, ?, 'commit',
                 'passed', ?, 'Verified Draft PR head.', 'verified', ?, ?)`,
    ).bind(RUN_ID, ACTIVE_ATTEMPT_ID, PLAN_ID, ITEM_ID, REVIEW_HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'pull_request_open' WHERE run_id = ?`,
    ).bind(RUN_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-github-base-review', 'evidence-github-base-review-head',
                 ?, ?, ?, 1, ?, 2, ?, ?, 'agent/review/base-race', ?)`,
    ).bind(RUN_ID, ACTIVE_ATTEMPT_ID, PLAN_ID, ITEM_ID, BEFORE_SHA, REVIEW_HEAD_SHA, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id, head_sha,
         version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 3, 'analysis', 'running', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, ?, ?, 1, 1, ?, ?)`,
    ).bind(
      REVIEW_ATTEMPT_ID,
      RUN_ID,
      BEFORE_SHA,
      REPOSITORY,
      PLAN_ID,
      ITEM_ID,
      REVIEW_HEAD_SHA,
      NOW,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.prepare(
    `INSERT INTO pull_request_drafts (
       draft_id, run_id, run_version, task_id, task_revision, task_digest,
       plan_id, plan_version, plan_digest, attempt_id, head_update_id,
       head_sha, branch, body, body_digest, status, created_at
     ) SELECT ?, runs.run_id, runs.version, tasks.task_id, runs.task_revision,
              runs.task_digest, ?, 1, ?, ?, 'head-github-base-review', ?,
              'agent/review/base-race', ?, ?, 'prepared', ?
       FROM runs JOIN tasks ON tasks.task_id = runs.task_id
       WHERE runs.run_id = ?`,
  ).bind(
    DRAFT_ID,
    PLAN_ID,
    PLAN_DIGEST,
    ACTIVE_ATTEMPT_ID,
    REVIEW_HEAD_SHA,
    body,
    bodyDigest,
    NOW,
    RUN_ID,
  ).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO pull_request_publications (
       publication_id, run_id, run_version, draft_id, approval_id,
       repository, base_branch, head_branch, head_sha, title, body_digest,
       status, github_pr_number, github_pr_url, github_external_updated_at,
       github_observation_version, created_at, updated_at
     ) SELECT ?, runs.run_id, runs.version, ?, 'approval-github-base-v1', ?,
              'main', 'agent/review/base-race', ?, 'Review base race', ?,
              ?, 237, 'https://github.com/example/delivery-target/pull/237',
              ?, 1, ?, ? FROM runs WHERE runs.run_id = ?`,
  ).bind(
    PUBLICATION_ID,
    DRAFT_ID,
    REPOSITORY,
    REVIEW_HEAD_SHA,
    bodyDigest,
    publicationStatus,
    NOW,
    NOW,
    NOW,
    RUN_ID,
  ).run();
  if (publicationStatus === 'created_unverified') return;
  if (status === 'pending') {
    await env.DB_CONTROL.prepare(
      `INSERT INTO automated_reviews (
         review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
         prior_attempt_id, review_attempt_id, repository, github_pr_number,
         base_branch, branch, source_head_sha, iteration, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 237, 'main',
                 'agent/review/base-race', ?, 1, 'pending', ?, ?)`,
    ).bind(
      REVIEW_ID,
      RUN_ID,
      PUBLICATION_ID,
      PLAN_ID,
      ITEM_ID,
      ACTIVE_ATTEMPT_ID,
      REVIEW_ATTEMPT_ID,
      REPOSITORY,
      REVIEW_HEAD_SHA,
      NOW,
      NOW,
    ).run();
    return;
  }
  await env.DB_CONTROL.prepare(
    `INSERT INTO automated_reviews (
       review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
       prior_attempt_id, review_attempt_id, repository, github_pr_number,
       base_branch, branch, source_head_sha, iteration, status, result_ref,
       result_digest, feedback_body_digest, blocking_finding_count,
       minor_finding_count, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 237, 'main',
               'agent/review/base-race', ?, 1, ?,
               'r2://automated-reviews/base-race.json', ?, ?, ?, 0, ?, ?, ?)`,
  ).bind(
    REVIEW_ID,
    RUN_ID,
    PUBLICATION_ID,
    PLAN_ID,
    ITEM_ID,
    ACTIVE_ATTEMPT_ID,
    REVIEW_ATTEMPT_ID,
    REPOSITORY,
    REVIEW_HEAD_SHA,
    status,
    `sha256:${'7'.repeat(64)}`,
    `sha256:${'8'.repeat(64)}`,
    status === 'approved' ? 0 : 1,
    NOW,
    NOW,
    NOW,
  ).run();
  if (status === 'approved') return;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'completed', version = 2, lease_generation = 2,
                           updated_at = ? WHERE attempt_id = ?`,
    ).bind(NOW, REVIEW_ATTEMPT_ID),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'executing' WHERE run_id = ?`,
    ).bind(RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id, head_branch, head_sha,
         version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 4, 'review_fix', 'running', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, ?, 'agent/review/base-race', ?, 1, 1, ?, ?)`,
    ).bind(
      REVIEW_FIX_ATTEMPT_ID,
      RUN_ID,
      BEFORE_SHA,
      REPOSITORY,
      PLAN_ID,
      ITEM_ID,
      REVIEW_HEAD_SHA,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO automated_review_fix_attempts (
         review_id, fix_attempt_id, prior_attempt_id, branch, source_head_sha, created_at
       ) VALUES (?, ?, ?, 'agent/review/base-race', ?, ?)`,
    ).bind(REVIEW_ID, REVIEW_FIX_ATTEMPT_ID, ACTIVE_ATTEMPT_ID, REVIEW_HEAD_SHA, NOW),
  ]);
}

async function makeTaskWritableBug(): Promise<void> {
  const task = taskEnvelope('bug');
  const taskDigest = await taskRevisionDigest(task);
  const payloadKey = 'tasks/github-base-observation.json';
  await env.TASK_OBJECTS.put(payloadKey, JSON.stringify(task), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { taskDigest },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE tasks SET task_digest = ?, intent_kind = 'bug' WHERE task_id = ?`,
    ).bind(taskDigest, TASK_ID),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET task_digest = ? WHERE run_id = ?`,
    ).bind(taskDigest, RUN_ID),
  ]);
}

async function seedPriorDiagnosticEvidence(suffix = ''): Promise<string> {
  const evidenceId = `diagnostic_github_base_prior${suffix}`;
  const evidenceRef = `d1://evidence/${evidenceId}`;
  const logsTraceId = `tooltrace_github_base_logs${suffix}`;
  const requestTraceId = `tooltrace_github_base_request${suffix}`;
  const evidenceDigest = `sha256:${(suffix === '' ? '7' : '8').repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES (?, ?, ?, 'logs/search', 'logs:read', 'read', 20, 'success', ?)`,
    ).bind(logsTraceId, RUN_ID, ANALYSIS_ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       ) VALUES (?, ?, ?, 'traces/get', 'trace:read', 'read', 15, 'success', ?)`,
    ).bind(requestTraceId, RUN_ID, ANALYSIS_ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, kind, status, artifact_digest,
         summary, verification_status, observed_at, created_at
       ) VALUES (?, ?, ?, 'diagnostic', 'passed', ?,
                 'Sanitized prior diagnostic root cause.', 'verified', ?, ?)`,
    ).bind(evidenceId, RUN_ID, ANALYSIS_ATTEMPT_ID, evidenceDigest, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO diagnostic_evidence_bindings (
         evidence_id, run_id, attempt_id, locator_kinds_json, locator_digest,
         root_cause_digest, evidence_digest, created_at
       ) VALUES (?, ?, ?, '["uid"]', ?, ?, ?, ?)`,
    ).bind(
      evidenceId,
      RUN_ID,
      ANALYSIS_ATTEMPT_ID,
      `sha256:${'9'.repeat(64)}`,
      `sha256:${'a'.repeat(64)}`,
      evidenceDigest,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO diagnostic_evidence_trace_sources (evidence_id, position, trace_id)
       VALUES (?, 0, ?)`,
    ).bind(evidenceId, logsTraceId),
    env.DB_CONTROL.prepare(
      `INSERT INTO diagnostic_evidence_trace_sources (evidence_id, position, trace_id)
       VALUES (?, 1, ?)`,
    ).bind(evidenceId, requestTraceId),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plan_evidence_refs (plan_id, position, evidence_ref)
       VALUES (?, (SELECT COUNT(*) FROM execution_plan_evidence_refs WHERE plan_id = ?), ?)`,
    ).bind(PLAN_ID, PLAN_ID, evidenceRef),
  ]);
  return evidenceRef;
}

async function runningRevisionAuthorization(): Promise<Parameters<AnalysisAttemptContextStore['get']>[0]> {
  const revision = await env.DB_CONTROL.prepare(
    `SELECT COALESCE(
       (SELECT retry_attempt_id FROM plan_revision_analysis_retries
        WHERE revision_id = plan_revisions.revision_id
        ORDER BY retry_sequence DESC LIMIT 1),
       analysis_attempt_id
     ) AS analysis_attempt_id FROM plan_revisions`,
  ).first<{ analysis_attempt_id: string }>();
  if (revision === null) throw new Error('missing base re-analysis Attempt');
  await env.DB_CONTROL.prepare(
    `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
                         lease_token_digest = ?, lease_expires_at = ?, updated_at = ?
     WHERE attempt_id = ? AND status = 'pending'`,
  ).bind(
    `sha256:${'9'.repeat(64)}`,
    '2099-01-01T00:00:00.000Z',
    NOW,
    revision.analysis_attempt_id,
  ).run();
  return {
    attemptId: revision.analysis_attempt_id,
    runId: RUN_ID,
    mode: 'analysis',
    status: 'running',
    version: 1,
    leaseGeneration: 1,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    scopes: ['repo:read'],
  };
}

async function seed(): Promise<void> {
  const task = taskEnvelope();
  const taskDigest = await taskRevisionDigest(task);
  const payloadKey = 'tasks/github-base-observation.json';
  await env.TASK_OBJECTS.put(payloadKey, JSON.stringify(task), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
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
       ) VALUES (?, 'manual', 'github-base-observation', ?, 'revision-1', ?,
                 ?, 'system',
                 'github-base-observation', ?, 'main', 'test', 'requirement',
                 'Replan when the trusted base advances', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, taskDigest, `r2://${payloadKey}`, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 10, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BEFORE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BEFORE_SHA, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Execute the approved work on the original base.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BEFORE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, version, lease_generation,
         lease_token_digest, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, 3, 2, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(
      ACTIVE_ATTEMPT_ID,
      RUN_ID,
      BEFORE_SHA,
      REPOSITORY,
      PLAN_ID,
      `sha256:${'2'.repeat(64)}`,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest,
         tool_token_digest, lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-github-base-active', ?, ?, ?, ?, 2,
                 '["repo:read","checkpoint:write"]',
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      ACTIVE_ATTEMPT_ID,
      `sha256:${'3'.repeat(64)}`,
      `sha256:${'4'.repeat(64)}`,
      `sha256:${'5'.repeat(64)}`,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-github-base-v1', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BEFORE_SHA, `sha256:${'6'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('dispatch-github-base-old', ?, 'execution_dispatch',
                 'github_actions', ?, 'execution:github-base-old', 'pending', ?, ?)`,
    ).bind(RUN_ID, `d1://attempts/${ACTIVE_ATTEMPT_ID}`, NOW, NOW),
  ]);
}

async function seedUnchangedBatchCandidates(count: number): Promise<string[]> {
  const runIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const taskId = `task-github-base-fair-${suffix}`;
    const runId = `run-github-base-fair-${suffix}`;
    const attemptId = `attempt-github-base-fair-${suffix}`;
    const planId = `plan-github-base-fair-${suffix}`;
    runIds.push(runId);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO tasks (
           task_id, source_system, tenant_key, source_task_key, task_revision,
           task_digest, payload_ref, actor_type, actor_id, target_repository,
           target_base_branch, target_environment, intent_kind, title, priority,
           acceptance_criteria_count, allow_repository_write, allow_test_deploy,
           allow_production_deploy, require_human_approval, created_at, updated_at
         ) VALUES (?, 'manual', 'github-base-observation', ?, 'revision-1', ?, ?,
                   'system', 'github-base-observation', ?, 'main', 'test',
                   'requirement', 'Observe unchanged base fairly', 'p2', 1,
                   0, 0, 0, 1, ?, ?)`,
      ).bind(
        taskId,
        taskId,
        `sha256:${suffix.padEnd(64, '0')}`,
        `r2://tasks/${taskId}.json`,
        REPOSITORY,
        NOW,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha,
           workflow_instance_id, state, version, active_plan_id,
           active_plan_version, active_plan_digest, created_at, updated_at
         ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'awaiting_approval', 2, ?, 1, ?, ?, ?)`,
      ).bind(
        runId,
        taskId,
        `sha256:${suffix.padEnd(64, '0')}`,
        BEFORE_SHA,
        runId,
        planId,
        `sha256:${suffix.padEnd(64, '1')}`,
        NOW,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         ) VALUES (?, ?, 1, 'analysis', 'completed', ?, ?,
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   1, 1, ?, ?)`,
      ).bind(attemptId, runId, BEFORE_SHA, REPOSITORY, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO execution_plans (
           plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
           created_by_attempt_id, objective, created_at, updated_at
         ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                   'Observe unchanged base fairly.', ?, ?)`,
      ).bind(
        planId,
        runId,
        BEFORE_SHA,
        `sha256:${suffix.padEnd(64, '1')}`,
        attemptId,
        NOW,
        NOW,
      ),
    ]);
  }
  return runIds;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('trusted GitHub base SHA resolution', () => {
  it('invokes the default runtime fetch through globalThis instead of the client receiver', async () => {
    const usedGlobalReceiver: boolean[] = [];
    const fetchImplementation = vi.fn(function (this: unknown) {
      usedGlobalReceiver.push(this === globalThis);
      return Promise.resolve(new Response(JSON.stringify({
        ref: 'refs/heads/main',
        object: { type: 'commit', sha: AFTER_SHA },
      }), { status: 200 }));
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      const client = new GitHubBaseApiClient({
        async getBaseObservationToken() {
          return 'test-github-base-read-token';
        },
      }, { apiBaseUrl: 'https://github-api.example.test' });

      await expect(client.resolveBaseSha(REPOSITORY, 'main')).resolves.toBe(AFTER_SHA);
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(usedGlobalReceiver).toEqual([true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves the exact target branch through a repository-scoped read token', async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      userAgent: string | null;
    }> = [];
    const client = new GitHubBaseApiClient({
      async getBaseObservationToken(repository) {
        expect(repository).toBe(REPOSITORY);
        return 'test-github-base-read-token';
      },
    }, {
      apiBaseUrl: 'https://github-api.example.test',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get('authorization'),
          userAgent: headers.get('user-agent'),
        });
        return new Response(JSON.stringify({
          ref: 'refs/heads/release/phase-1',
          object: { type: 'commit', sha: AFTER_SHA },
        }), { status: 200 });
      },
    });

    await expect(client.resolveBaseSha(REPOSITORY, 'release/phase-1')).resolves.toBe(AFTER_SHA);
    expect(requests).toEqual([{
      url: 'https://github-api.example.test/repos/example/delivery-target/git/ref/heads/release/phase-1',
      authorization: 'Bearer test-github-base-read-token',
      userAgent: 'delivery-loop-control-plane',
    }]);
  });

  it('rejects unsafe branches and malformed GitHub reference facts', async () => {
    let tokenRequests = 0;
    let fetchRequests = 0;
    const client = new GitHubBaseApiClient({
      async getBaseObservationToken() {
        tokenRequests += 1;
        return 'test-github-base-read-token';
      },
    }, {
      apiBaseUrl: 'https://github-api.example.test',
      fetch: async () => {
        fetchRequests += 1;
        return new Response(JSON.stringify({
          ref: 'refs/heads/main',
          object: { type: 'tag', sha: AFTER_SHA },
        }), { status: 200 });
      },
    });

    await expect(client.resolveBaseSha(REPOSITORY, '../main')).rejects.toThrow(
      'GitHub base reference request is invalid',
    );
    expect(tokenRequests).toBe(0);
    expect(fetchRequests).toBe(0);
    await expect(client.resolveBaseSha(REPOSITORY, 'main')).rejects.toThrow(
      'GitHub base reference response is invalid',
    );
    expect(tokenRequests).toBe(1);
    expect(fetchRequests).toBe(1);
  });
});

describe('GitHub base observation reconciliation', () => {
  it('does not race a Draft PR publication that still needs external verification', async () => {
    await seedActiveAutomatedReview('approved', 'created_unverified');
    const directClient = new FakeBaseClient(fastForwardResult());
    const direct = new GitHubBaseObservationReconciler(env.DB_CONTROL, directClient, {
      now: () => new Date(NOW),
    });
    expect(await direct.reconcileRun(RUN_ID)).toBe('not_found');
    expect(directClient.calls).toEqual([]);

    const batchClient = new FakeBaseClient(fastForwardResult());
    const batch = new GitHubBaseObservationReconciler(env.DB_CONTROL, batchClient, {
      now: () => new Date(NOW),
    });
    expect(await batch.reconcileBatch(10)).toEqual([]);
    expect(batchClient.calls).toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revisions',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_base_observations',
    ).first()).toEqual({ count: 0 });
  });

  it('does not let a stale unverified publication block the current Run base', async () => {
    const makePublicationStale = async (): Promise<void> => {
      await seedActiveAutomatedReview('approved', 'created_unverified');
      await env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'executing', version = version + 1,
                         updated_at = ? WHERE run_id = ?`,
      ).bind(NOW, RUN_ID).run();
    };

    await makePublicationStale();
    const directClient = new FakeBaseClient(fastForwardResult());
    const direct = new GitHubBaseObservationReconciler(env.DB_CONTROL, directClient, {
      now: () => new Date(NOW),
    });
    expect(await direct.reconcileRun(RUN_ID)).toBe('replanning');
    expect(directClient.calls).toHaveLength(1);

    await reset();
    await seed();
    await makePublicationStale();
    const batchClient = new FakeBaseClient(fastForwardResult());
    const batch = new GitHubBaseObservationReconciler(env.DB_CONTROL, batchClient, {
      now: () => new Date(NOW),
    });
    expect(await batch.reconcileBatch(10)).toEqual([{
      runId: RUN_ID,
      disposition: 'replanning',
    }]);
    expect(batchClient.calls).toHaveLength(1);
  });

  it.each(['pending', 'changes_requested'] as const)(
    'does not start base replanning while the current Plan automated review is %s',
    async (reviewStatus) => {
      await seedActiveAutomatedReview(reviewStatus);
      const runBefore = await env.DB_CONTROL.prepare(
        `SELECT state, version, base_sha, active_plan_id,
                active_plan_version, active_plan_digest
         FROM runs WHERE run_id = ?`,
      ).bind(RUN_ID).first();
      const planBefore = await env.DB_CONTROL.prepare(
        `SELECT status, base_sha, digest FROM execution_plans WHERE plan_id = ?`,
      ).bind(PLAN_ID).first();
      const reviewBefore = await env.DB_CONTROL.prepare(
        `SELECT status, result_ref, result_digest, updated_at
         FROM automated_reviews WHERE review_id = ?`,
      ).bind(REVIEW_ID).first();

      const directClient = new FakeBaseClient(fastForwardResult());
      const direct = new GitHubBaseObservationReconciler(env.DB_CONTROL, directClient, {
        now: () => new Date(NOW),
      });
      expect(await direct.reconcileRun(RUN_ID)).toBe('not_found');
      expect(directClient.calls).toEqual([]);

      const batchClient = new FakeBaseClient(fastForwardResult());
      const batch = new GitHubBaseObservationReconciler(env.DB_CONTROL, batchClient, {
        now: () => new Date(NOW),
      });
      expect(await batch.reconcileBatch(10)).toEqual([]);
      expect(batchClient.calls).toEqual([]);
      expect(await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM plan_revisions',
      ).first()).toEqual({ count: 0 });
      expect(await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM github_base_observations',
      ).first()).toEqual({ count: 0 });
      expect(await env.DB_CONTROL.prepare(
        `SELECT state, version, base_sha, active_plan_id,
                active_plan_version, active_plan_digest
         FROM runs WHERE run_id = ?`,
      ).bind(RUN_ID).first()).toEqual(runBefore);
      expect(await env.DB_CONTROL.prepare(
        `SELECT status, base_sha, digest FROM execution_plans WHERE plan_id = ?`,
      ).bind(PLAN_ID).first()).toEqual(planBefore);
      expect(await env.DB_CONTROL.prepare(
        `SELECT status, result_ref, result_digest, updated_at
         FROM automated_reviews WHERE review_id = ?`,
      ).bind(REVIEW_ID).first()).toEqual(reviewBefore);
    },
  );

  it('resumes base observation after the current Plan automated review is approved', async () => {
    await seedActiveAutomatedReview('approved');
    const client = new FakeBaseClient(fastForwardResult());
    const reconciler = new GitHubBaseObservationReconciler(env.DB_CONTROL, client, {
      now: () => new Date(NOW),
    });

    expect(await reconciler.reconcileRun(RUN_ID)).toBe('replanning');
    expect(client.calls).toEqual([{
      repository: REPOSITORY,
      baseBranch: 'main',
      beforeSha: BEFORE_SHA,
    }]);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revisions',
    ).first()).toEqual({ count: 1 });
  });

  it('converges 20 fast-forward observations to one immutable source fact and re-analysis', async () => {
    await makeTaskWritableBug();
    expect(await seedPriorDiagnosticEvidence()).toBe(DIAGNOSTIC_EVIDENCE_REF);
    const client = new FakeBaseClient(fastForwardResult());
    const reconciler = new GitHubBaseObservationReconciler(env.DB_CONTROL, client, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun(RUN_ID)),
    );
    expect(results.filter((result) => result === 'replanning')).toHaveLength(1);
    expect(results.every((result) => ['replanning', 'duplicate', 'stale'].includes(result))).toBe(true);
    expect(client.calls).toHaveLength(20);

    const fact = fastForwardResult();
    if (fact.disposition !== 'fast_forward') throw new Error('invalid test fact');
    const sourceDigest = await canonicalSha256(fact.fact);
    const observation = await env.DB_CONTROL.prepare(
      `SELECT observation_id, run_id, expected_run_version, prior_plan_id,
              prior_plan_version, prior_plan_digest, repository, base_branch,
              before_sha, after_sha, relationship, ahead_by,
              reference_digest, comparison_digest, source_digest
       FROM github_base_observations`,
    ).first<Record<string, unknown>>();
    expect(observation).toMatchObject({
      run_id: RUN_ID,
      expected_run_version: 10,
      prior_plan_id: PLAN_ID,
      prior_plan_version: 1,
      prior_plan_digest: PLAN_DIGEST,
      repository: REPOSITORY,
      base_branch: 'main',
      before_sha: BEFORE_SHA,
      after_sha: AFTER_SHA,
      relationship: 'ahead',
      ahead_by: 2,
      reference_digest: REFERENCE_DIGEST,
      comparison_digest: COMPARISON_DIGEST,
      source_digest: sourceDigest,
    });
    const observationId = String(observation?.observation_id);
    expect(await env.DB_CONTROL.prepare(
      `SELECT source_ref, run_id, expected_run_version, prior_plan_id,
              source_kind, source_digest, requested_base_sha
       FROM plan_revision_source_facts`,
    ).first()).toEqual({
      source_ref: `d1://github-base-observations/${observationId}`,
      run_id: RUN_ID,
      expected_run_version: 10,
      prior_plan_id: PLAN_ID,
      source_kind: 'base_update',
      source_digest: sourceDigest,
      requested_base_sha: AFTER_SHA,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revisions',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE mode = 'analysis' AND status = 'pending'`,
    ).first()).toEqual({ count: 1 });
    const initial = await env.DB_CONTROL.prepare(
      'SELECT analysis_attempt_id FROM plan_revisions',
    ).first<{ analysis_attempt_id: string }>();
    if (initial === null) throw new Error('missing initial re-analysis Attempt');
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET status = 'failed', version = 1, lease_generation = 1,
                             updated_at = ? WHERE attempt_id = ?`,
      ).bind(NOW, initial.analysis_attempt_id),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_failures (
           failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
           retry_scope_digest, fingerprint_digest, failure_class, failure_code,
           failure_site, needed_human_input, scope_attempt_count,
           consecutive_fingerprint_count, revoked_lease_generation,
           occurred_at, created_at
         ) SELECT 'failure-github-base-analysis', run_id, attempt_id, ordinal,
                  'event-github-base-analysis', 1, ?, ?, 'invalid_output',
                  'invalid_agent_output', 'agent_output', 'manual_investigation',
                  1, 1, 1, ?, ?
           FROM attempts WHERE attempt_id = ?`,
      ).bind(
        `sha256:${'4'.repeat(64)}`,
        `sha256:${'5'.repeat(64)}`,
        NOW,
        NOW,
        initial.analysis_attempt_id,
      ),
    ]);
    expect(await new PlanRevisionAnalysisReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).reconcileBatch(5)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_analysis_retries',
    ).first()).toEqual({ count: 1 });
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 2, lease_generation = 2
       WHERE attempt_id = ?`,
    ).bind(initial.analysis_attempt_id).run();
    await expect(new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId: initial.analysis_attempt_id,
      runId: RUN_ID,
      mode: 'analysis',
      status: 'running',
      version: 2,
      leaseGeneration: 2,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['repo:read'],
    })).rejects.toMatchObject({ code: 'revision_source_conflict' });
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'failed' WHERE attempt_id = ?`,
    ).bind(initial.analysis_attempt_id).run();
    const authorization = await runningRevisionAuthorization();
    const revisionContext = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get(authorization);
    expect(revisionContext.revisionSource).toEqual({
      schemaVersion: '1',
      kind: 'base_update',
      digest: sourceDigest,
      data: fact.fact,
    });
    expect(revisionContext.carriedDiagnosticEvidenceRef).toBe(
      DIAGNOSTIC_EVIDENCE_REF,
    );
    const proposalStore = new AnalysisPlanProposalStore(env.DB_CONTROL);
    const replacementContent = {
      objective: 'Repair the bug on the newly observed base and verify the committed result.',
      assumptions: ['The prior verified diagnostic remains the trusted root-cause authority.'],
      evidenceRefs: [DIAGNOSTIC_EVIDENCE_REF],
      items: [{
        id: 'repair-on-new-base',
        kind: 'change',
        title: 'Repair and verify on the new base',
        objective: 'Inspect the advanced base and apply the smallest compatible repair.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The carried root cause is repaired and trusted verification passes.'],
        verification: {
          commandRefs: ['test:unit', 'verify:all'],
          evidenceKinds: ['commit', 'test'],
        },
        effects: ['logs_read', 'repo_write'],
        dependsOn: [],
        required: true,
      }],
    };
    await expect(proposalStore.save(
      authorization,
      {
        ...replacementContent,
        evidenceRefs: ['d1://evidence/diagnostic_agent_selected'],
      },
      NOW,
    )).rejects.toMatchObject({ code: 'plan_evidence_conflict' });
    await expect(proposalStore.save(
      authorization,
      {
        ...replacementContent,
        evidenceRefs: [],
        items: replacementContent.items.map((item) => ({
          ...item,
          effects: ['repo_write'],
          verification: {
            commandRefs: ['test:unit', 'verify:all'],
            evidenceKinds: ['commit', 'test'],
          },
        })),
      },
      NOW,
    )).rejects.toMatchObject({ code: 'plan_evidence_conflict' });
    const replacement = await proposalStore.save(
      authorization,
      replacementContent,
      NOW,
    );
    expect(replacement.plan).toMatchObject({
      runId: RUN_ID,
      version: 2,
      baseSha: AFTER_SHA,
      evidenceRefs: [DIAGNOSTIC_EVIDENCE_REF],
      status: 'validated',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'planning', version: 11, base_sha: AFTER_SHA });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({
      status: 'cancelled',
      version: 4,
      lease_generation: 3,
      lease_token_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM approval_invalidations',
    ).first()).toEqual({ count: 1 });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE github_base_observations SET after_sha = ? WHERE observation_id = ?`,
    ).bind('f'.repeat(40), observationId).run()).rejects.toThrow(
      'github_base_observation_is_immutable',
    );
  });

  it('fails closed when writable BUG base replanning has missing or multiple prior diagnostic refs', async () => {
    const contextStore = new AnalysisAttemptContextStore(env.DB_CONTROL, env.TASK_OBJECTS);
    await makeTaskWritableBug();
    await new GitHubBaseObservationReconciler(
      env.DB_CONTROL,
      new FakeBaseClient(fastForwardResult()),
      { now: () => new Date(NOW) },
    ).reconcileRun(RUN_ID);
    await expect(contextStore.get(await runningRevisionAuthorization())).rejects.toMatchObject({
      code: 'revision_source_conflict',
    });

    await reset();
    await seed();
    await makeTaskWritableBug();
    await seedPriorDiagnosticEvidence();
    await seedPriorDiagnosticEvidence('_duplicate');
    await new GitHubBaseObservationReconciler(
      env.DB_CONTROL,
      new FakeBaseClient(fastForwardResult()),
      { now: () => new Date(NOW) },
    ).reconcileRun(RUN_ID);
    await expect(contextStore.get(await runningRevisionAuthorization())).rejects.toMatchObject({
      code: 'revision_source_conflict',
    });
  });

  it('blocks a non-fast-forward history with one immutable human-action projection', async () => {
    const client = new FakeBaseClient(nonFastForwardResult());
    const reconciler = new GitHubBaseObservationReconciler(env.DB_CONTROL, client, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun(RUN_ID)),
    );
    expect(results.every((result) => result === 'blocked')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT run_id, expected_run_version, prior_plan_id, repository, base_branch,
              before_sha, after_sha, relationship, blocker_reason,
              needed_human_input
       FROM github_base_conflicts`,
    ).first()).toEqual({
      run_id: RUN_ID,
      expected_run_version: 10,
      prior_plan_id: PLAN_ID,
      repository: REPOSITORY,
      base_branch: 'main',
      before_sha: BEFORE_SHA,
      after_sha: AFTER_SHA,
      relationship: 'diverged',
      blocker_reason: 'base_history_diverged',
      needed_human_input: 'manual_rebase',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'blocked', version: 11, base_sha: BEFORE_SHA });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM execution_plans WHERE plan_id = ?',
    ).bind(PLAN_ID).first()).toEqual({ status: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({
      status: 'cancelled',
      version: 4,
      lease_generation: 3,
      lease_token_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM base_conflict_approval_invalidations',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM invalidated_approvals',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox
       WHERE outbox_id = 'dispatch-github-base-old'`,
    ).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: 'base_history_diverged',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state FROM outbox WHERE kind = 'workflow_cancel'`,
    ).first()).toEqual({ delivery_state: 'pending' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });
    expect(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)).toMatchObject({
      run: {
        state: 'blocked',
        blocker: {
          kind: 'base_history_conflict',
          reason: 'base_history_diverged',
          repository: REPOSITORY,
          baseBranch: 'main',
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          relationship: 'diverged',
          neededHumanInput: {
            code: 'manual_rebase',
          },
        },
      },
    });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE github_base_conflicts SET after_sha = ?`,
    ).bind('1'.repeat(40)).run()).rejects.toThrow('github_base_conflict_is_immutable');
  });

  it('leaves zero source facts for unchanged, stale, and ineligible Runs', async () => {
    const unchanged = new GitHubBaseObservationReconciler(env.DB_CONTROL, new FakeBaseClient({
      disposition: 'unchanged',
      headSha: BEFORE_SHA,
    }));
    expect(await unchanged.reconcileBatch(10)).toEqual([
      { runId: RUN_ID, disposition: 'unchanged' },
    ]);

    const stale = new GitHubBaseObservationReconciler(
      env.DB_CONTROL,
      new FakeBaseClient(fastForwardResult(), async () => {
        await env.DB_CONTROL.prepare(
          'UPDATE runs SET version = version + 1 WHERE run_id = ?',
        ).bind(RUN_ID).run();
      }),
    );
    expect(await stale.reconcileRun(RUN_ID)).toBe('stale');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_base_observations',
    ).first()).toEqual({ count: 0 });

    await env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'merging' WHERE run_id = ?`,
    ).bind(RUN_ID).run();
    const ineligibleClient = new FakeBaseClient(fastForwardResult());
    expect(await new GitHubBaseObservationReconciler(
      env.DB_CONTROL,
      ineligibleClient,
    ).reconcileRun(RUN_ID)).toBe('not_found');
    expect(ineligibleClient.calls).toEqual([]);
  });

  it('rotates a bounded batch so unchanged Runs cannot starve later candidates', async () => {
    const additionalRunIds = await seedUnchangedBatchCandidates(5);
    let now = new Date('2026-07-25T23:00:00.000Z');
    const client = new FakeBaseClient({ disposition: 'unchanged', headSha: BEFORE_SHA });
    const reconciler = new GitHubBaseObservationReconciler(env.DB_CONTROL, client, {
      now: () => now,
    });

    const first = await reconciler.reconcileBatch(5);
    now = new Date(now.getTime() + 60_000);
    const second = await reconciler.reconcileBatch(5);

    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map(({ runId }) => runId))).toEqual(
      new Set([RUN_ID, ...additionalRunIds]),
    );
  });
});
