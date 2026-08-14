/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubCommitApprovalService,
  githubCommitApprovalBody,
  type GitHubCommitApprovalClient,
  type GitHubCommitApprovalFact,
} from '../../src/github-commit-approval.js';
import { ImplementationPreEffectRecoveryReconciler } from '../../src/reconciliation/implementation-pre-effect-reconciler.js';

const NOW = '2026-08-14T05:00:00.000Z';
const RUN_ID = 'run-implementation-pre-effect-recovery';
const TASK_ID = 'task-implementation-pre-effect-recovery';
const PLAN_ID = 'plan-implementation-pre-effect-recovery';
const ITEM_ID = 'fix-speaker-name-mapping';
const ANALYSIS_ATTEMPT_ID = 'attempt-implementation-recovery-analysis';
const LOST_ATTEMPT_ID = 'attempt-implementation-recovery-lost';
const REPOSITORY = 'lightspeed-intelligence/tipsy-backend';
const BASE_SHA = 'a'.repeat(40);
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const TASK_DIGEST = `sha256:${'c'.repeat(64)}`;
const WORKFLOW_REF = 'evilstar9527/delivery-loop/.github/workflows/delivery-agent.yml@refs/heads/main';

class FakeCommentClient implements GitHubCommitApprovalClient {
  fact: GitHubCommitApprovalFact | null = null;
  async getCommitComment(): Promise<GitHubCommitApprovalFact> {
    if (this.fact === null) throw new Error('missing comment');
    return structuredClone(this.fact);
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM implementation_pre_effect_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM implementation_pre_effect_recovery_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
    env.DB_CONTROL.prepare('DELETE FROM approval_lineages'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM run_stuck_incidents'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
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

async function seed(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'owner', 'implementation-recovery', '1', ?, 'r2://task',
                 'user', 'owner', ?, 'main', 'test', 'bug', 'Recover implement',
                 'p1', 1, 1, 1, 0, 1, ?, ?)` ,
    ).bind(TASK_ID, TASK_DIGEST, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'blocked', 20, ?, 1, ?, ?, ?)` ,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 11, 'analysis', 'completed', ?, ?, ?, 3, 1, ?, ?)` ,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, WORKFLOW_REF, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'active', ?, 'Fix speaker names.', ?, ?)` ,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'change', 'Fix mapping', 'Use per-character names.', 1, 0)` ,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, version, lease_generation,
         github_status, github_conclusion, created_at, updated_at
       ) VALUES (?, ?, 12, 'implement', 'lost', ?, ?, ?, ?, 1, ?, 1, 3, 2,
                 'completed', 'failure', ?, ?)` ,
    ).bind(LOST_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, WORKFLOW_REF, PLAN_ID, ITEM_ID, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)` ,
    ).bind(PLAN_ID, ITEM_ID, LOST_ATTEMPT_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')` ,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'test:unit')` ,
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
      `INSERT INTO run_stuck_incidents (
         incident_id, run_id, state_kind, observed_run_state, run_version,
         attempt_id, threshold_seconds, action, status, detected_at,
         recovery_requested_at, resolved_at, resolution_code
       ) VALUES ('incident-implementation-recovery', ?, 'running', 'executing', 19,
                 ?, 90, 'fence_lost_attempt', 'resolved', ?, ?, ?, 'attempt_fenced')` ,
    ).bind(RUN_ID, LOST_ATTEMPT_ID, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('workflow-cancel-implementation-recovery', ?, 'workflow_cancel',
                 'cloudflare_workflows', 'd1://runs/cancel', 'cancel:implementation',
                 'settled', ?, ?)` ,
    ).bind(RUN_ID, NOW, NOW),
  ]);
}

function fact(body: string): GitHubCommitApprovalFact {
  return {
    schemaVersion: '1', repository: REPOSITORY, commentId: 301,
    commitSha: BASE_SHA, authorLogin: 'evilstar9527', authorType: 'User',
    authorAssociation: 'MEMBER', body, createdAt: NOW, updatedAt: NOW,
    url: `https://github.com/${REPOSITORY}/commit/${BASE_SHA}#commitcomment-301`,
  };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('implementation pre-effect recovery', () => {
  it('requires one fresh approval and creates one exact replacement under concurrency', async () => {
    const client = new FakeCommentClient();
    const service = new GitHubCommitApprovalService(env.DB_CONTROL, client, () => new Date(NOW));
    const template = await service.template(RUN_ID);
    expect(template.commentBody).toBe(githubCommitApprovalBody({
      runId: RUN_ID, runVersion: 20, planId: PLAN_ID, planVersion: 1,
      planDigest: PLAN_DIGEST, baseSha: BASE_SHA,
    }));
    client.fact = fact(template.commentBody);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () => await service.approve(RUN_ID, 301)),
    );
    expect(decisions.filter((decision) => decision.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 21 });

    const reconciler = new ImplementationPreEffectRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    const batches = await Promise.all(
      Array.from({ length: 20 }, async () => await reconciler.reconcileBatch()),
    );
    expect(batches.flat().filter((result) => result.created)).toHaveLength(1);
    const recovery = await env.DB_CONTROL.prepare(
      `SELECT failed_attempt_id, replacement_attempt_id
       FROM implementation_pre_effect_recoveries WHERE run_id = ?`,
    ).bind(RUN_ID).first<{ failed_attempt_id: string; replacement_attempt_id: string }>();
    expect(recovery?.failed_attempt_id).toBe(LOST_ATTEMPT_ID);
    expect(await env.DB_CONTROL.prepare(
      `SELECT ordinal, mode, status, recovered_from_attempt_id, head_sha, head_branch
       FROM attempts WHERE attempt_id = ?`,
    ).bind(recovery?.replacement_attempt_id).first()).toEqual({
      ordinal: 13, mode: 'implement', status: 'pending',
      recovered_from_attempt_id: LOST_ATTEMPT_ID, head_sha: null, head_branch: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 22 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE kind = 'execution_dispatch' AND payload_ref = ?`,
    ).bind(`d1://attempts/${recovery?.replacement_attempt_id}`).first()).toEqual({ count: 1 });
  });

  it('opens the same fresh approval path when a credential-only repair blocker is unresolved', async () => {
    const dependencyAttemptId = 'attempt-implementation-recovery-credential-repair';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id, version,
           lease_generation, github_status, github_conclusion, created_at, updated_at
         ) VALUES (?, ?, 13, 'review_fix', 'failed', ?, ?, ?, ?, 1, ?, 1, 1,
                   'completed', 'failure', ?, ?)`,
      ).bind(
        dependencyAttemptId, RUN_ID, BASE_SHA, REPOSITORY, WORKFLOW_REF,
        PLAN_ID, ITEM_ID, NOW, NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_failures (
           failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
           retry_scope_digest, fingerprint_digest, failure_class, failure_code,
           failure_site, needed_human_input, scope_attempt_count,
           consecutive_fingerprint_count, revoked_lease_generation, occurred_at, created_at
         ) VALUES ('failure-credential-repair', ?, ?, 13, 'event-credential-repair', 1,
                   ?, ?, 'tool_error', 'tool_unavailable', 'external_reconciliation',
                   'resolve_external_dependency', 3, 1, 1, ?, ?)`,
      ).bind(
        RUN_ID, dependencyAttemptId, `sha256:${'d'.repeat(64)}`,
        `sha256:${'e'.repeat(64)}`, NOW, NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO run_blockers (
           blocker_id, run_id, reason, needed_human_input, retry_scope_digest,
           fingerprint_digest, attempt_count, consecutive_fingerprint_count, created_at
         ) VALUES ('blocker-credential-repair', ?, 'external_dependency',
                   'resolve_external_dependency', ?, ?, 3, 1, ?)`,
      ).bind(
        RUN_ID, `sha256:${'d'.repeat(64)}`, `sha256:${'e'.repeat(64)}`, NOW,
      ),
    ]);
    const client = new FakeCommentClient();
    const service = new GitHubCommitApprovalService(env.DB_CONTROL, client, () => new Date(NOW));
    const template = await service.template(RUN_ID);
    client.fact = fact(template.commentBody);
    const decision = await service.approve(RUN_ID, 301);
    expect(decision.created).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 21 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT resolved_at IS NOT NULL AS resolved FROM run_blockers WHERE blocker_id = ?`,
    ).bind('blocker-credential-repair').first()).toEqual({ resolved: 1 });
  });

  it.each(['credential', 'head', 'checkpoint', 'unsettled_cancel'] as const)(
    'rejects unsafe pre-effect recovery state: %s',
    async (kind) => {
      if (kind === 'credential') {
        const approvalBody = githubCommitApprovalBody({
          runId: RUN_ID, runVersion: 20, planId: PLAN_ID, planVersion: 1,
          planDigest: PLAN_DIGEST, baseSha: BASE_SHA,
        });
        const client = new FakeCommentClient();
        client.fact = fact(approvalBody);
        await new GitHubCommitApprovalService(
          env.DB_CONTROL,
          client,
          () => new Date(NOW),
        ).approve(RUN_ID, 301);
        await env.DB_CONTROL.prepare(
          `INSERT INTO github_write_credentials (
             credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
             approval_id, repository, lease_generation, status, created_at, updated_at
           ) VALUES ('credential-unsafe-implementation', ?, ?, ?, 1, ?,
                     (SELECT approval_id FROM approvals WHERE run_id = ? LIMIT 1),
                     ?, 2, 'issuance_failed', ?, ?)` ,
        ).bind(
          RUN_ID, LOST_ATTEMPT_ID, PLAN_ID, ITEM_ID, RUN_ID, REPOSITORY, NOW, NOW,
        ).run();
      } else if (kind === 'head') {
        await env.DB_CONTROL.prepare(
          `UPDATE attempts SET head_sha = ? WHERE attempt_id = ?`,
        ).bind('d'.repeat(40), LOST_ATTEMPT_ID).run();
      } else if (kind === 'checkpoint') {
        await env.DB_CONTROL.prepare(
          `INSERT INTO checkpoints (
             checkpoint_id, attempt_id, sequence, plan_id, plan_version,
             plan_item_id, head_sha, payload_ref, payload_digest,
             summary, next_step, created_at
           ) VALUES ('checkpoint-unsafe-implementation', ?, 1, ?, 1, ?, ?,
                     'r2://checkpoint', ?, 'safe summary', 'continue', ?)` ,
        ).bind(
          LOST_ATTEMPT_ID, PLAN_ID, ITEM_ID, BASE_SHA,
          `sha256:${'e'.repeat(64)}`, NOW,
        ).run();
      } else {
        await env.DB_CONTROL.prepare(
          `UPDATE outbox SET delivery_state = 'pending'
           WHERE outbox_id = 'workflow-cancel-implementation-recovery'`,
        ).run();
      }
      const service = new GitHubCommitApprovalService(
        env.DB_CONTROL,
        new FakeCommentClient(),
        () => new Date(NOW),
      );
      if (kind === 'credential') {
        const reconciler = new ImplementationPreEffectRecoveryReconciler(
          env.DB_CONTROL,
          () => new Date(NOW),
        );
        expect(await reconciler.reconcileBatch()).toEqual([]);
        expect(await env.DB_CONTROL.prepare(
          'SELECT COUNT(*) AS count FROM implementation_pre_effect_recoveries',
        ).first()).toEqual({ count: 0 });
      } else {
        await expect(service.template(RUN_ID)).rejects.toMatchObject({ code: 'state_conflict' });
      }
    },
  );
});
