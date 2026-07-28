import { canonicalSha256 } from '../domain/digest.js';
import type { PlanEffect } from '../domain/plan.js';
import {
  normalizeWorkflowReplayTarget,
  type WorkflowReplayEffectSnapshot,
  type WorkflowReplayFrom,
  type WorkflowRestartTarget,
} from '../domain/workflow-replay.js';

const MUTATING_EFFECTS = new Set<PlanEffect>([
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
]);

export type WorkflowReplayErrorCode =
  | 'not_found'
  | 'state_conflict'
  | 'target_invalid'
  | 'approval_required'
  | 'reconciliation_incomplete'
  | 'snapshot_conflict';

export class WorkflowReplayError extends Error {
  constructor(readonly code: WorkflowReplayErrorCode) {
    super(`Workflow replay failed: ${code}`);
    this.name = 'WorkflowReplayError';
  }
}

export interface ScheduleWorkflowReplayInput {
  runId: string;
  expectedRunVersion: number;
  from: WorkflowReplayFrom;
  reason: string;
}

export interface WorkflowReplayResult {
  replayId: string;
  outboxId: string;
  runId: string;
  planVersion: number;
  planItemId?: string;
  target: WorkflowRestartTarget;
  effectSnapshotDigest: string;
  created: boolean;
}

export type WorkflowReplayDeliveryDecision =
  | { kind: 'restart'; target: WorkflowRestartTarget }
  | { kind: 'settle'; settledCode: 'already_restarted' | 'approval_expired' | 'approval_invalid' | 'replay_stale' };

interface ActiveRunRow {
  run_id: string;
  state: string;
  version: number;
  task_revision: string;
  base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_id: string | null;
  plan_status: string | null;
}

interface ExistingReplayRow {
  replay_id: string;
  run_id: string;
  expected_run_version: number;
  plan_version: number;
  plan_item_id: string | null;
  target_step_name: string;
  target_step_type: WorkflowRestartTarget['type'];
  target_step_count: number;
  reason_digest: string;
  effect_snapshot_digest: string;
  restart_observed_at: string | null;
  outbox_id: string | null;
}

interface ApprovalRow {
  approval_id: string;
  decision: string;
  expires_at: string;
  created_at: string;
}

interface EffectRow {
  effect: PlanEffect;
  approval_id: string | null;
}

interface ReconciliationSource {
  sourceKind: 'outbox' | 'evidence';
  sourceRef: string;
  sourceDigest: string;
}

interface ReconciliationRow {
  source_kind: 'outbox' | 'evidence';
  source_ref: string;
  source_digest: string;
}

interface ReplayDeliveryRow extends ExistingReplayRow {
  plan_id: string;
  target_kind: 'system_step' | 'plan_item';
  run_state: string;
  run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_digest: string;
  plan_status: string;
  plan_base_sha: string;
  task_revision: string;
}

function replayPlanStateAllowed(
  runState: string,
  planStatus: string | null,
  targetKind: 'system_step' | 'plan_item',
): boolean {
  return planStatus === 'active' ||
    (targetKind === 'plan_item' && runState === 'succeeded' && planStatus === 'completed');
}

function optionalPlanItem(
  result: Omit<WorkflowReplayResult, 'planItemId'>,
  planItemId: string | null,
): WorkflowReplayResult {
  return planItemId === null ? result : { ...result, planItemId };
}

function isNonBlankReason(reason: string): boolean {
  return reason.length >= 2 && reason.length <= 1_000 && /\S/.test(reason);
}

/** Durable, version-fenced scheduler for an explicit Cloudflare Workflow restart. */
export class WorkflowReplayStore {
  constructor(private readonly db: D1Database) {}

  async schedule(
    input: ScheduleWorkflowReplayInput,
    now = new Date(),
  ): Promise<WorkflowReplayResult> {
    if (
      !Number.isSafeInteger(input.expectedRunVersion) ||
      input.expectedRunVersion < 0 ||
      !isNonBlankReason(input.reason)
    ) {
      throw new WorkflowReplayError('target_invalid');
    }
    let target: WorkflowRestartTarget;
    try {
      target = normalizeWorkflowReplayTarget(input.from);
    } catch {
      throw new WorkflowReplayError('target_invalid');
    }
    const reasonDigest = await canonicalSha256({ reason: input.reason });
    const existing = await this.existing(input.runId, input.expectedRunVersion);
    if (existing !== null) {
      return this.matchExisting(existing, input, target, reasonDigest);
    }

    const run = await this.activeRun(input.runId);
    if (run === null) throw new WorkflowReplayError('not_found');
    if (
      run.version !== input.expectedRunVersion ||
      run.state === 'cancelled' ||
      run.base_sha === null ||
      run.active_plan_id === null ||
      run.active_plan_version === null ||
      run.active_plan_digest === null ||
      run.plan_id !== run.active_plan_id
    ) {
      const raced = await this.existing(input.runId, input.expectedRunVersion);
      if (raced !== null) return this.matchExisting(raced, input, target, reasonDigest);
      throw new WorkflowReplayError('state_conflict');
    }

    const targetKind = 'stepName' in input.from ? 'system_step' : 'plan_item';
    if (!replayPlanStateAllowed(run.state, run.plan_status, targetKind)) {
      throw new WorkflowReplayError('state_conflict');
    }
    let planItemId: string | null = null;
    let startPosition = 0;
    if ('planVersion' in input.from) {
      if (input.from.planVersion !== run.active_plan_version) {
        throw new WorkflowReplayError('target_invalid');
      }
      const item = await this.db
        .prepare(
          `SELECT kind, position FROM plan_items
           WHERE plan_id = ? AND item_id = ?`,
        )
        .bind(run.active_plan_id, input.from.planItemId)
        .first<{ kind: string; position: number }>();
      if (item === null || item.kind !== 'verification') {
        throw new WorkflowReplayError('target_invalid');
      }
      planItemId = input.from.planItemId;
      startPosition = item.position;
    }

    const replayRun = {
      ...run,
      base_sha: run.base_sha,
      active_plan_id: run.active_plan_id,
      active_plan_version: run.active_plan_version,
      active_plan_digest: run.active_plan_digest,
    };
    const effects = await this.effectSnapshot(
      replayRun,
      startPosition,
      now.toISOString(),
    );
    const reconciliations = await this.reconciliationSnapshot(
      run.run_id,
      run.active_plan_id,
      startPosition,
    );
    const effectSnapshotDigest = await canonicalSha256({
      target,
      effects,
      reconciliations,
    });
    const identityDigest = await canonicalSha256({
      runId: run.run_id,
      expectedRunVersion: input.expectedRunVersion,
      planId: run.active_plan_id,
      planVersion: run.active_plan_version,
      planItemId,
      target,
      reasonDigest,
      effectSnapshotDigest,
    });
    const suffix = identityDigest.slice('sha256:'.length, 'sha256:'.length + 48);
    const replayId = `replay_${suffix}`;
    const outboxId = `outbox_replay_${suffix}`;
    const nowIso = now.toISOString();
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE runs SET version = version + 1, updated_at = ?
           WHERE run_id = ? AND version = ? AND state <> 'cancelled'
             AND active_plan_id = ? AND active_plan_version = ?
             AND active_plan_digest = ?`,
        )
        .bind(
          nowIso,
          run.run_id,
          input.expectedRunVersion,
          run.active_plan_id,
          run.active_plan_version,
          run.active_plan_digest,
        ),
      this.db
        .prepare(
          `INSERT INTO workflow_replays (
             replay_id, run_id, expected_run_version, plan_id, plan_version,
             plan_item_id, target_kind, target_step_name, target_step_type,
             target_step_count, reason_digest, effect_snapshot_digest,
             created_at, updated_at
           )
           SELECT ?, runs.run_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM runs
           WHERE runs.run_id = ? AND runs.version = ?
             AND runs.state <> 'cancelled'
             AND runs.active_plan_id = ? AND runs.active_plan_version = ?
             AND runs.active_plan_digest = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          replayId,
          input.expectedRunVersion,
          run.active_plan_id,
          run.active_plan_version,
          planItemId,
          targetKind,
          target.name,
          target.type,
          target.count,
          reasonDigest,
          effectSnapshotDigest,
          nowIso,
          nowIso,
          run.run_id,
          input.expectedRunVersion + 1,
          run.active_plan_id,
          run.active_plan_version,
          run.active_plan_digest,
        ),
    ];
    for (const effect of effects) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO workflow_replay_effects (replay_id, effect, approval_id)
             SELECT ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM workflow_replays WHERE replay_id = ?
             ) ON CONFLICT DO NOTHING`,
          )
          .bind(replayId, effect.effect, effect.approvalId ?? null, replayId),
      );
    }
    for (const source of reconciliations) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO workflow_replay_reconciliations (
               replay_id, source_kind, source_ref, source_digest
             ) SELECT ?, ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM workflow_replays WHERE replay_id = ?
             ) ON CONFLICT DO NOTHING`,
          )
          .bind(
            replayId,
            source.sourceKind,
            source.sourceRef,
            source.sourceDigest,
            replayId,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, ?, 'workflow_replay', 'cloudflare_workflows', ?, ?,
                  'pending', ?, ?
           WHERE EXISTS (SELECT 1 FROM workflow_replays WHERE replay_id = ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          outboxId,
          run.run_id,
          `d1://workflow-replays/${replayId}`,
          `workflow-replay:${replayId}`,
          nowIso,
          nowIso,
          replayId,
        ),
    );

    const results = await this.db.batch(statements);
    const persisted = await this.existing(input.runId, input.expectedRunVersion);
    if (persisted === null) throw new WorkflowReplayError('state_conflict');
    const result = this.matchExisting(persisted, input, target, reasonDigest);
    return { ...result, created: results[1]?.meta.changes === 1 };
  }

  async prepareDelivery(
    replayId: string,
    now = new Date(),
  ): Promise<WorkflowReplayDeliveryDecision> {
    const replay = await this.db
      .prepare(
        `SELECT workflow_replays.*,
                runs.state AS run_state, runs.version AS run_version,
                runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
                execution_plans.digest AS plan_digest,
                execution_plans.status AS plan_status,
                execution_plans.base_sha AS plan_base_sha,
                execution_plans.task_revision
         FROM workflow_replays
         JOIN runs ON runs.run_id = workflow_replays.run_id
         JOIN execution_plans ON execution_plans.plan_id = workflow_replays.plan_id
         WHERE workflow_replays.replay_id = ?`,
      )
      .bind(replayId)
      .first<ReplayDeliveryRow>();
    if (replay === null) throw new WorkflowReplayError('not_found');
    if (replay.restart_observed_at !== null) {
      return { kind: 'settle', settledCode: 'already_restarted' };
    }
    if (
      replay.run_state === 'cancelled' ||
      replay.run_version !== replay.expected_run_version + 1 ||
      replay.active_plan_id !== replay.plan_id ||
      replay.active_plan_version !== replay.plan_version ||
      replay.active_plan_digest !== replay.plan_digest ||
      !replayPlanStateAllowed(replay.run_state, replay.plan_status, replay.target_kind)
    ) {
      return { kind: 'settle', settledCode: 'replay_stale' };
    }

    const effects = await this.db
      .prepare(
        `SELECT effect, approval_id FROM workflow_replay_effects
         WHERE replay_id = ? ORDER BY effect`,
      )
      .bind(replayId)
      .all<EffectRow>();
    for (const effect of effects.results) {
      if (!MUTATING_EFFECTS.has(effect.effect)) continue;
      if (effect.approval_id === null) {
        return { kind: 'settle', settledCode: 'approval_invalid' };
      }
      const approval = await this.db
        .prepare(
          `SELECT approval_id, decision, expires_at, created_at
           FROM trusted_effect_approvals AS approvals
           WHERE approval_id = ? AND run_id = ? AND task_revision = ?
             AND plan_id = ? AND plan_version = ? AND plan_digest = ?
             AND base_sha = ? AND effect = ?
             AND NOT EXISTS (
               SELECT 1 FROM invalidated_approvals
               WHERE invalidated_approvals.approval_id = approvals.approval_id
             )`,
        )
        .bind(
          effect.approval_id,
          replay.run_id,
          replay.task_revision,
          replay.plan_id,
          replay.plan_version,
          replay.plan_digest,
          replay.plan_base_sha,
          effect.effect,
        )
        .first<ApprovalRow>();
      if (approval === null || approval.decision !== 'approve') {
        return { kind: 'settle', settledCode: 'approval_invalid' };
      }
      if (approval.expires_at <= now.toISOString()) {
        return { kind: 'settle', settledCode: 'approval_expired' };
      }
      const newerDecision = await this.db
        .prepare(
          `SELECT decision FROM trusted_effect_approvals AS approvals
           WHERE run_id = ? AND task_revision = ? AND plan_id = ?
             AND plan_version = ? AND plan_digest = ? AND base_sha = ?
             AND effect = ?
             AND (created_at > ? OR (created_at = ? AND approval_id > ?))
           ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
        )
        .bind(
          replay.run_id,
          replay.task_revision,
          replay.plan_id,
          replay.plan_version,
          replay.plan_digest,
          replay.plan_base_sha,
          effect.effect,
          approval.created_at,
          approval.created_at,
          approval.approval_id,
        )
        .first<{ decision: string }>();
      if (newerDecision?.decision === 'reject') {
        return { kind: 'settle', settledCode: 'approval_invalid' };
      }
    }

    const startPosition = await this.startPosition(
      replay.plan_id,
      replay.target_kind,
      replay.plan_item_id,
    );
    const currentReconciliations = await this.reconciliationSnapshot(
      replay.run_id,
      replay.plan_id,
      startPosition,
    );
    const storedReconciliations = await this.db
      .prepare(
        `SELECT source_kind, source_ref, source_digest
         FROM workflow_replay_reconciliations
         WHERE replay_id = ? ORDER BY source_kind, source_ref`,
      )
      .bind(replayId)
      .all<ReconciliationRow>();
    if (
      JSON.stringify(currentReconciliations) !==
      JSON.stringify(
        storedReconciliations.results.map((row) => ({
          sourceKind: row.source_kind,
          sourceRef: row.source_ref,
          sourceDigest: row.source_digest,
        })),
      )
    ) {
      throw new WorkflowReplayError('reconciliation_incomplete');
    }
    const target: WorkflowRestartTarget = {
      name: replay.target_step_name,
      type: replay.target_step_type,
      count: replay.target_step_count,
    };
    const normalizedEffects: WorkflowReplayEffectSnapshot[] = effects.results.map((row) =>
      row.approval_id === null
        ? { effect: row.effect }
        : { effect: row.effect, approvalId: row.approval_id },
    );
    const digest = await canonicalSha256({
      target,
      effects: normalizedEffects,
      reconciliations: currentReconciliations,
    });
    if (digest !== replay.effect_snapshot_digest) {
      throw new WorkflowReplayError('snapshot_conflict');
    }
    return { kind: 'restart', target };
  }

  async markRestartObserved(replayId: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE workflow_replays
         SET restart_observed_at = COALESCE(restart_observed_at, ?), updated_at = ?
         WHERE replay_id = ?`,
      )
      .bind(now.toISOString(), now.toISOString(), replayId)
      .run();
    const row = await this.db
      .prepare('SELECT restart_observed_at FROM workflow_replays WHERE replay_id = ?')
      .bind(replayId)
      .first<{ restart_observed_at: string | null }>();
    if (row?.restart_observed_at === null || row === null) {
      throw new WorkflowReplayError('state_conflict');
    }
  }

  private async activeRun(runId: string): Promise<ActiveRunRow | null> {
    return await this.db
      .prepare(
        `SELECT runs.run_id, runs.state, runs.version, runs.task_revision,
                runs.base_sha, runs.active_plan_id, runs.active_plan_version,
                runs.active_plan_digest, execution_plans.plan_id,
                execution_plans.status AS plan_status
         FROM runs
         LEFT JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         WHERE runs.run_id = ?`,
      )
      .bind(runId)
      .first<ActiveRunRow>();
  }

  private async existing(
    runId: string,
    expectedRunVersion: number,
  ): Promise<ExistingReplayRow | null> {
    return await this.db
      .prepare(
        `SELECT workflow_replays.replay_id, workflow_replays.run_id,
                workflow_replays.expected_run_version, workflow_replays.plan_version,
                workflow_replays.plan_item_id, workflow_replays.target_step_name,
                workflow_replays.target_step_type, workflow_replays.target_step_count,
                workflow_replays.reason_digest, workflow_replays.effect_snapshot_digest,
                workflow_replays.restart_observed_at, outbox.outbox_id
         FROM workflow_replays
         LEFT JOIN outbox
           ON outbox.payload_ref = 'd1://workflow-replays/' || workflow_replays.replay_id
          AND outbox.kind = 'workflow_replay'
         WHERE workflow_replays.run_id = ?
           AND workflow_replays.expected_run_version = ?`,
      )
      .bind(runId, expectedRunVersion)
      .first<ExistingReplayRow>();
  }

  private matchExisting(
    existing: ExistingReplayRow,
    input: ScheduleWorkflowReplayInput,
    target: WorkflowRestartTarget,
    reasonDigest: string,
  ): WorkflowReplayResult {
    const requestedPlanItemId = 'planItemId' in input.from ? input.from.planItemId : null;
    const requestedPlanVersion =
      'planVersion' in input.from ? input.from.planVersion : existing.plan_version;
    if (
      existing.outbox_id === null ||
      existing.reason_digest !== reasonDigest ||
      existing.plan_version !== requestedPlanVersion ||
      existing.plan_item_id !== requestedPlanItemId ||
      existing.target_step_name !== target.name ||
      existing.target_step_type !== target.type ||
      existing.target_step_count !== target.count
    ) {
      throw new WorkflowReplayError('state_conflict');
    }
    return optionalPlanItem(
      {
        replayId: existing.replay_id,
        outboxId: existing.outbox_id,
        runId: existing.run_id,
        planVersion: existing.plan_version,
        target,
        effectSnapshotDigest: existing.effect_snapshot_digest,
        created: false,
      },
      existing.plan_item_id,
    );
  }

  private async effectSnapshot(
    run: ActiveRunRow & {
      base_sha: string;
      active_plan_id: string;
      active_plan_version: number;
      active_plan_digest: string;
    },
    startPosition: number,
    nowIso: string,
  ): Promise<WorkflowReplayEffectSnapshot[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT plan_item_effects.effect
         FROM plan_item_effects
         JOIN plan_items
           ON plan_items.plan_id = plan_item_effects.plan_id
          AND plan_items.item_id = plan_item_effects.item_id
         WHERE plan_item_effects.plan_id = ? AND plan_items.position >= ?
         ORDER BY plan_item_effects.effect`,
      )
      .bind(run.active_plan_id, startPosition)
      .all<{ effect: PlanEffect }>();
    const snapshots: WorkflowReplayEffectSnapshot[] = [];
    for (const row of results) {
      if (!MUTATING_EFFECTS.has(row.effect)) {
        snapshots.push({ effect: row.effect });
        continue;
      }
      const approval = await this.db
        .prepare(
          `SELECT approval_id, decision, expires_at, created_at
           FROM trusted_effect_approvals AS approvals
           WHERE run_id = ? AND task_revision = ? AND plan_id = ?
             AND plan_version = ? AND plan_digest = ? AND base_sha = ?
             AND effect = ?
             AND NOT EXISTS (
               SELECT 1 FROM invalidated_approvals
               WHERE invalidated_approvals.approval_id = approvals.approval_id
             )
           ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
        )
        .bind(
          run.run_id,
          run.task_revision,
          run.active_plan_id,
          run.active_plan_version,
          run.active_plan_digest,
          run.base_sha,
          row.effect,
        )
        .first<ApprovalRow>();
      if (
        approval === null ||
        approval.decision !== 'approve' ||
        approval.expires_at <= nowIso
      ) {
        throw new WorkflowReplayError('approval_required');
      }
      snapshots.push({ effect: row.effect, approvalId: approval.approval_id });
    }
    return snapshots;
  }

  private async reconciliationSnapshot(
    runId: string,
    planId: string,
    startPosition: number,
  ): Promise<ReconciliationSource[]> {
    const sources: ReconciliationSource[] = [];
    const outboxes = await this.db
      .prepare(
        `SELECT outbox_id, kind, dedupe_key, delivery_state
         FROM outbox
         WHERE run_id = ?
           AND (kind LIKE '%dispatch%' OR kind IN (
             'pull_request', 'test_deploy', 'merge', 'production_deploy'
           ))
         ORDER BY outbox_id`,
      )
      .bind(runId)
      .all<{
        outbox_id: string;
        kind: string;
        dedupe_key: string;
        delivery_state: string;
      }>();
    for (const row of outboxes.results) {
      if (row.delivery_state !== 'settled') {
        throw new WorkflowReplayError('reconciliation_incomplete');
      }
      sources.push({
        sourceKind: 'outbox',
        sourceRef: `d1://outbox/${row.outbox_id}`,
        sourceDigest: await canonicalSha256({
          outboxId: row.outbox_id,
          kind: row.kind,
          dedupeKey: row.dedupe_key,
          deliveryState: row.delivery_state,
        }),
      });
    }

    const facts = await this.db
      .prepare(
        `SELECT DISTINCT plan_item_external_facts.external_fact
         FROM plan_item_external_facts
         JOIN plan_items
           ON plan_items.plan_id = plan_item_external_facts.plan_id
          AND plan_items.item_id = plan_item_external_facts.item_id
         WHERE plan_item_external_facts.plan_id = ? AND plan_items.position >= ?
         ORDER BY plan_item_external_facts.external_fact`,
      )
      .bind(planId, startPosition)
      .all<{ external_fact: 'github_pr' | 'github_check' | 'deployment' }>();
    const evidenceKind = {
      github_pr: 'pull_request',
      github_check: 'check',
      deployment: 'deployment',
    } as const;
    for (const fact of facts.results) {
      const evidence = await this.db
        .prepare(
          `SELECT evidence.evidence_id, evidence.kind, evidence.status,
                  evidence.verification_status, evidence.sha,
                  evidence.artifact_digest, evidence.external_url
           FROM evidence
           JOIN plan_items
             ON plan_items.plan_id = evidence.plan_id
            AND plan_items.item_id = evidence.plan_item_id
           WHERE evidence.run_id = ? AND evidence.plan_id = ?
             AND plan_items.position >= ? AND evidence.kind = ?
           ORDER BY evidence.evidence_id`,
        )
        .bind(runId, planId, startPosition, evidenceKind[fact.external_fact])
        .all<{
          evidence_id: string;
          kind: string;
          status: string;
          verification_status: string;
          sha: string | null;
          artifact_digest: string | null;
          external_url: string | null;
        }>();
      for (const row of evidence.results) {
        if (row.status !== 'passed' || row.verification_status !== 'verified') {
          throw new WorkflowReplayError('reconciliation_incomplete');
        }
        sources.push({
          sourceKind: 'evidence',
          sourceRef: `d1://evidence/${row.evidence_id}`,
          sourceDigest: await canonicalSha256({
            evidenceId: row.evidence_id,
            kind: row.kind,
            status: row.status,
            verificationStatus: row.verification_status,
            sha: row.sha,
            artifactDigest: row.artifact_digest,
            externalUrl: row.external_url,
          }),
        });
      }
    }
    return sources.sort((left, right) =>
      `${left.sourceKind}:${left.sourceRef}`.localeCompare(
        `${right.sourceKind}:${right.sourceRef}`,
      ),
    );
  }

  private async startPosition(
    planId: string,
    targetKind: 'system_step' | 'plan_item',
    planItemId: string | null,
  ): Promise<number> {
    if (targetKind === 'system_step') return 0;
    if (planItemId === null) throw new WorkflowReplayError('snapshot_conflict');
    const row = await this.db
      .prepare('SELECT kind, position FROM plan_items WHERE plan_id = ? AND item_id = ?')
      .bind(planId, planItemId)
      .first<{ kind: string; position: number }>();
    if (row === null || row.kind !== 'verification') {
      throw new WorkflowReplayError('snapshot_conflict');
    }
    return row.position;
  }
}
