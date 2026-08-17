import { canonicalSha256 } from '../domain/digest.js';
import { assertFrozenExecutionSpec } from '../executor/core/executor-registry.js';
import type { ExecutorPluginRegistry } from '../executor/core/executor-registry.js';
import type { FrozenExecutionSpec } from '../executor/core/executor-plugin.js';
import { GITHUB_ACTIONS_EXECUTOR_KIND } from
  '../executor/plugins/github-actions/github-actions-plugin.js';
import { QuotaControlError, QuotaControlStore } from '../storage/quota-control-store.js';
import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
} from './fenced-outbox.js';

interface ExecutionInstanceRow {
  execution_id: string;
  attempt_id: string;
  attempt_version: number;
  lease_generation: number;
  executor_profile_id: string;
  executor_route_version: number | null;
  spec_digest: string;
  spec_json: string;
  status: string;
  provider_external_id: string | null;
  validated_handle_json: string | null;
}

export interface AgentExecutorOutboxProcessorOptions {
  now?: () => Date;
  generateLeaseToken?: () => string;
  outboxLeaseMs?: number;
  attemptLeaseMs?: number;
}

function parseSpec(raw: string): FrozenExecutionSpec {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new OutboxEffectError('executor_spec_invalid');
  }
  try {
    assertFrozenExecutionSpec(value as FrozenExecutionSpec);
  } catch {
    throw new OutboxEffectError('executor_spec_invalid');
  }
  return value as FrozenExecutionSpec;
}

/** Provider-neutral semantic outbox processor; D1 remains the Attempt authority. */
export class AgentExecutorOutboxProcessor {
  private readonly now: () => Date;
  private readonly attemptLeaseMs: number;
  private readonly fenced: FencedOutboxProcessor;

  constructor(
    private readonly db: D1Database,
    private readonly plugins: ExecutorPluginRegistry,
    options: AgentExecutorOutboxProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.attemptLeaseMs = options.attemptLeaseMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.attemptLeaseMs) || this.attemptLeaseMs <= 0) {
      throw new Error('attempt lease duration must be a positive integer');
    }
    this.fenced = new FencedOutboxProcessor(
      db,
      'agent_executor',
      async (outbox) => await this.perform(outbox),
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.generateLeaseToken === undefined
          ? {}
          : { generateLeaseToken: options.generateLeaseToken }),
        ...(options.outboxLeaseMs === undefined ? {} : { leaseMs: options.outboxLeaseMs }),
        unavailableErrorCode: 'executor_unavailable',
      },
    );
  }

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    return await this.fenced.deliver(outboxId);
  }

  async drain(limit = 25): Promise<OutboxDeliveryResult[]> {
    return await this.fenced.drain(limit);
  }

  private async perform(outbox: FencedOutboxRecord): Promise<void> {
    if (outbox.kind !== 'agent_execution_start') {
      throw new OutboxEffectError('unsupported_executor_kind');
    }
    const prefix = 'd1://attempt-executions/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('executor_ref_invalid');
    }
    const executionId = outbox.payloadRef.slice(prefix.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(executionId)) {
      throw new OutboxEffectError('executor_ref_invalid');
    }
    const instance = await this.db.prepare(
      `SELECT execution_id, attempt_id, attempt_version, lease_generation,
              executor_profile_id, executor_route_version, spec_digest, spec_json,
              status, provider_external_id, validated_handle_json
       FROM attempt_execution_instances
       WHERE execution_id = ? AND outbox_id = ?`,
    ).bind(executionId, outbox.outboxId).first<ExecutionInstanceRow>();
    if (instance === null) throw new OutboxEffectError('executor_instance_missing');
    const spec = parseSpec(instance.spec_json);
    if (
      spec.executionId !== instance.execution_id ||
      spec.attemptId !== instance.attempt_id ||
      spec.runId !== outbox.runId ||
      spec.leaseGeneration !== instance.lease_generation ||
      spec.profile.profileId !== instance.executor_profile_id ||
      await canonicalSha256(spec) !== instance.spec_digest
    ) {
      throw new OutboxEffectError('executor_spec_conflict');
    }
    if (instance.status !== 'pending') {
      if (
        instance.status === 'starting' &&
        instance.provider_external_id !== null &&
        instance.validated_handle_json !== null
      ) return;
      throw new OutboxEffectError('executor_instance_stale');
    }

    const now = this.now();
    if (spec.role === 'work') {
      try {
        await new QuotaControlStore(this.db).reserveAttemptConcurrency(spec.attemptId, now);
      } catch (error) {
        if (error instanceof QuotaControlError && error.code === 'quota_exceeded') {
          throw new OutboxEffectError('quota_concurrency_exceeded');
        }
        throw error;
      }
    }
    const started = await this.plugins.ensureStarted(spec);
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.attemptLeaseMs).toISOString();
    const handleJson = JSON.stringify(started.handle);
    if (spec.role === 'publisher') {
      await this.persistPublisherStart(instance, spec, started.handle.externalId, handleJson, nowIso);
      return;
    }
    const githubRunId = started.handle.kind === GITHUB_ACTIONS_EXECUTOR_KIND
      ? started.handle.externalId
      : null;
    const githubHeadSha = started.handle.kind === GITHUB_ACTIONS_EXECUTOR_KIND
      ? (started.handle.attributes.executorHeadSha ?? null)
      : null;
    if (
      (githubRunId !== null && !/^[0-9]+$/.test(githubRunId)) ||
      (githubHeadSha !== null && !/^[a-f0-9]{40}$/.test(githubHeadSha)) ||
      (githubRunId === null) !== (githubHeadSha === null)
    ) {
      throw new OutboxEffectError('executor_github_projection_invalid');
    }
    await this.db.batch([
      this.db.prepare(
        `UPDATE attempts
         SET status = 'starting', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_expires_at = ?,
             github_run_id = COALESCE(?, github_run_id),
             github_head_sha = COALESCE(?, github_head_sha),
             github_status = CASE WHEN ? IS NULL THEN github_status ELSE 'requested' END,
             github_observed_at = CASE WHEN ? IS NULL THEN github_observed_at ELSE ? END,
             updated_at = ?
         WHERE attempt_id = ? AND run_id = ? AND status = 'pending'
           AND version = ? AND lease_generation + 1 = ?
           AND executor_profile_id = ?
           AND executor_route_version IS ?
           AND (
             (mode = 'analysis' AND EXISTS (
               SELECT 1 FROM runs
               WHERE runs.run_id = attempts.run_id
                 AND runs.state IN (
                   'planning', 'replanning', 'verifying', 'pull_request_open'
                 )
             ))
             OR
             (mode IN ('implement', 'review_fix') AND EXISTS (
               SELECT 1
               FROM runs
               JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = attempts.plan_id
                AND plan_item_progress.item_id = attempts.plan_item_id
               WHERE runs.run_id = attempts.run_id
                 AND runs.state IN ('executing', 'verifying')
                 AND runs.active_plan_id = attempts.plan_id
                 AND runs.active_plan_version = attempts.plan_version
                 AND execution_plans.status = 'active'
                 AND plan_item_progress.status = 'in_progress'
                 AND plan_item_progress.active_attempt_id = attempts.attempt_id
             ))
           )`,
      ).bind(
        leaseExpiresAt,
        githubRunId,
        githubHeadSha,
        githubRunId,
        githubRunId,
        nowIso,
        nowIso,
        spec.attemptId,
        spec.runId,
        instance.attempt_version,
        spec.leaseGeneration,
        instance.executor_profile_id,
        instance.executor_route_version,
      ),
      this.db.prepare(
        `UPDATE attempt_execution_instances
         SET status = 'starting', provider_external_id = ?,
             validated_handle_json = ?, started_at = ?, updated_at = ?
         WHERE execution_id = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempts.attempt_id = attempt_execution_instances.attempt_id
               AND attempts.status = 'starting'
               AND attempts.version = attempt_execution_instances.attempt_version + 1
               AND attempts.lease_generation = attempt_execution_instances.lease_generation
               AND attempts.executor_profile_id =
                   attempt_execution_instances.executor_profile_id
               AND attempts.executor_route_version IS
                   attempt_execution_instances.executor_route_version
           )`,
      ).bind(
        started.handle.externalId,
        handleJson,
        nowIso,
        nowIso,
        executionId,
      ),
    ]);
    const persisted = await this.db.prepare(
      `SELECT status, provider_external_id, validated_handle_json
       FROM attempt_execution_instances WHERE execution_id = ?`,
    ).bind(executionId).first<{
      status: string;
      provider_external_id: string | null;
      validated_handle_json: string | null;
    }>();
    if (
      persisted === null ||
      persisted.status !== 'starting' ||
      persisted.provider_external_id !== started.handle.externalId ||
      persisted.validated_handle_json !== handleJson
    ) {
      throw new OutboxEffectError('executor_projection_conflict');
    }
  }

  private async persistPublisherStart(
    instance: ExecutionInstanceRow,
    spec: FrozenExecutionSpec,
    externalId: string,
    handleJson: string,
    nowIso: string,
  ): Promise<void> {
    if (spec.patchArtifactId === undefined) {
      throw new OutboxEffectError('executor_spec_invalid');
    }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE attempt_execution_instances
         SET status = 'starting', provider_external_id = ?, validated_handle_json = ?,
             started_at = ?, updated_at = ?
         WHERE execution_id = ? AND status = 'pending'
           AND execution_role = 'publisher'
           AND attempt_version = ? AND lease_generation = ?
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempts.attempt_id = attempt_execution_instances.attempt_id
               AND attempts.status = 'running'
               AND attempts.version = attempt_execution_instances.attempt_version
               AND attempts.lease_generation = attempt_execution_instances.lease_generation
           )`,
      ).bind(
        externalId, handleJson, nowIso, nowIso, instance.execution_id,
        instance.attempt_version, instance.lease_generation,
      ),
      this.db.prepare(
        `UPDATE executor_patch_publications
         SET status = 'running', started_at = ?
         WHERE publisher_execution_id = ? AND patch_id = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM attempt_execution_instances
             WHERE execution_id = executor_patch_publications.publisher_execution_id
               AND status = 'starting' AND validated_handle_json = ?
           )`,
      ).bind(nowIso, instance.execution_id, spec.patchArtifactId, handleJson),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new OutboxEffectError('executor_projection_conflict');
    }
  }
}
