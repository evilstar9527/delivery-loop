import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
  type OutboxEffectOutcome,
} from './fenced-outbox.js';
import {
  TEST_ROLLBACK_WORKFLOW_FILE,
  type GitHubDispatchResult,
  type GitHubDispatchEffects,
} from './github-dispatcher.js';
import {
  QuotaControlError,
  QuotaControlStore,
} from '../storage/quota-control-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface TestRollbackOutboxProcessorOptions {
  allowedRepositories: readonly string[];
  controlPlaneUrl: string;
  now?: () => Date;
  generateLeaseToken?: () => string;
  outboxLeaseMs?: number;
  attemptLeaseMs?: number;
}

interface RollbackRow {
  rollback_id: string;
  source_kind: 'deployment_failure' | 'acceptance_failure';
  source_id: string;
  source_evidence_id: string;
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  attempt_id: string;
  repository: string;
  base_branch: string;
  ref_sha: string;
  workflow_path: string;
  policy_digest: string;
  contract_digest: string;
  status: string;
  github_run_id: string | null;
  run_state: string;
  current_run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_status: string;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  contract_declared: number;
  source_valid: number;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('rollback control plane URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) throw new Error('rollback control plane URL is invalid');
  return url.origin;
}

/** Dispatches only a previously observed, exact-SHA automatic test rollback contract. */
export class TestRollbackOutboxProcessor {
  private readonly fenced: FencedOutboxProcessor;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly controlPlaneUrl: string;
  private readonly now: () => Date;
  private readonly attemptLeaseMs: number;

  constructor(
    private readonly db: D1Database,
    private readonly effects: GitHubDispatchEffects,
    options: TestRollbackOutboxProcessorOptions,
  ) {
    this.allowedRepositories = new Set(options.allowedRepositories);
    this.controlPlaneUrl = httpsOrigin(options.controlPlaneUrl);
    this.now = options.now ?? (() => new Date());
    this.attemptLeaseMs = options.attemptLeaseMs ?? 30 * 60_000;
    if (this.allowedRepositories.size === 0) {
      throw new Error('rollback repository allowlist must not be empty');
    }
    if (!Number.isSafeInteger(this.attemptLeaseMs) || this.attemptLeaseMs <= 0) {
      throw new Error('rollback attempt lease is invalid');
    }
    this.fenced = new FencedOutboxProcessor(
      db,
      'github_test_rollback',
      async (outbox) => await this.perform(outbox),
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.generateLeaseToken === undefined
          ? {}
          : { generateLeaseToken: options.generateLeaseToken }),
        ...(options.outboxLeaseMs === undefined ? {} : { leaseMs: options.outboxLeaseMs }),
        unavailableErrorCode: 'github_test_rollback_unavailable',
      },
    );
  }

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    return await this.fenced.deliver(outboxId);
  }

  async drain(limit = 25): Promise<OutboxDeliveryResult[]> {
    return await this.fenced.drain(limit);
  }

  private async perform(outbox: FencedOutboxRecord): Promise<OutboxEffectOutcome | void> {
    if (outbox.kind !== 'test_rollback_dispatch') {
      throw new OutboxEffectError('unsupported_test_rollback_kind');
    }
    const prefix = 'd1://test-rollbacks/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('test_rollback_ref_invalid');
    }
    const rollbackId = outbox.payloadRef.slice(prefix.length);
    if (!ID_PATTERN.test(rollbackId)) {
      throw new OutboxEffectError('test_rollback_ref_invalid');
    }
    const rollback = await this.context(rollbackId, outbox.runId);
    if (rollback === null) throw new OutboxEffectError('test_rollback_missing');
    if (rollback.status !== 'scheduled') return;
    if (
      !this.allowedRepositories.has(rollback.repository) ||
      rollback.workflow_path !== TEST_ROLLBACK_WORKFLOW_FILE ||
      !['executing', 'blocked'].includes(rollback.run_state) ||
      rollback.current_run_version !== rollback.run_version ||
      rollback.active_plan_id !== rollback.plan_id ||
      rollback.active_plan_version !== rollback.plan_version ||
      rollback.active_plan_digest !== rollback.plan_digest ||
      !['active', 'blocked'].includes(rollback.plan_status) ||
      rollback.attempt_status !== 'pending' || rollback.attempt_version !== 0 ||
      rollback.lease_generation !== 0 || rollback.github_run_id !== null ||
      rollback.contract_declared !== 1 || rollback.source_valid !== 1
    ) throw new OutboxEffectError('test_rollback_stale');

    const quota = new QuotaControlStore(this.db);
    const now = this.now();
    try {
      await quota.reserveAttemptConcurrency(rollback.attempt_id, now);
    } catch (error) {
      if (error instanceof QuotaControlError && error.code === 'quota_exceeded') {
        throw new OutboxEffectError('quota_concurrency_exceeded');
      }
      throw error;
    }
    // An ambiguous dispatch is reconciled by stable rollback identity. Releasing
    // here could undercount a Workflow that GitHub already started.
    const dispatch: GitHubDispatchResult = await this.effects.ensureDispatch({
      repository: rollback.repository,
      workflowFile: TEST_ROLLBACK_WORKFLOW_FILE,
      ref: `refs/heads/${rollback.base_branch}`,
      inputs: {
        schema_version: '1',
        rollback_id: rollback.rollback_id,
        source_kind: rollback.source_kind,
        ref_sha: rollback.ref_sha,
        control_plane_url: this.controlPlaneUrl,
      },
    });
    if (!/^[1-9][0-9]{0,31}$/.test(dispatch.githubRunId)) {
      throw new OutboxEffectError('github_test_rollback_run_id_invalid');
    }
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.attemptLeaseMs).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_rollbacks
         SET status = 'dispatched', github_run_id = ?, updated_at = ?
         WHERE rollback_id = ? AND status = 'scheduled' AND github_run_id IS NULL
           AND EXISTS (
             SELECT 1 FROM runs
             JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
             JOIN attempts ON attempts.attempt_id = test_rollbacks.attempt_id
             JOIN test_rollback_contract_observations AS observations
               ON observations.observation_id = test_rollbacks.contract_observation_id
             WHERE runs.run_id = test_rollbacks.run_id
               AND runs.version = test_rollbacks.run_version
               AND runs.state IN ('executing', 'blocked')
               AND runs.active_plan_id = test_rollbacks.plan_id
               AND runs.active_plan_version = test_rollbacks.plan_version
               AND runs.active_plan_digest = test_rollbacks.plan_digest
               AND plans.status IN ('active', 'blocked')
               AND attempts.status = 'pending' AND attempts.version = 0
               AND attempts.lease_generation = 0
               AND observations.disposition = 'declared'
               AND observations.policy_digest = test_rollbacks.policy_digest
               AND observations.contract_digest = test_rollbacks.contract_digest
           )`,
      ).bind(dispatch.githubRunId, nowIso, rollbackId),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'starting', version = 1, lease_generation = 1,
             lease_expires_at = ?, github_run_id = ?, github_status = 'requested',
             github_observed_at = ?, updated_at = ?
         WHERE attempt_id = ? AND run_id = ? AND mode = 'deploy'
           AND status = 'pending' AND version = 0 AND lease_generation = 0
           AND github_run_id IS NULL
           AND EXISTS (
             SELECT 1 FROM test_rollbacks
             WHERE rollback_id = ? AND status = 'dispatched'
               AND github_run_id = ?
           )`,
      ).bind(
        leaseExpiresAt,
        dispatch.githubRunId,
        nowIso,
        nowIso,
        rollback.attempt_id,
        rollback.run_id,
        rollbackId,
        dispatch.githubRunId,
      ),
    ]);
    const persisted = await this.context(rollbackId, outbox.runId);
    if (
      persisted?.status === 'dispatched' &&
      persisted.github_run_id === dispatch.githubRunId &&
      persisted.attempt_status === 'starting' && persisted.attempt_version === 1 &&
      persisted.lease_generation === 1
    ) return;
    return { settledCode: 'test_rollback_dispatch_stale_after_effect' };
  }

  private async context(rollbackId: string, runId: string): Promise<RollbackRow | null> {
    return await this.db.prepare(
      `SELECT rollbacks.rollback_id, rollbacks.source_kind, rollbacks.source_id,
              rollbacks.source_evidence_id, rollbacks.run_id, rollbacks.run_version,
              rollbacks.plan_id, rollbacks.plan_version, rollbacks.plan_digest,
              rollbacks.attempt_id, rollbacks.repository, rollbacks.base_branch,
              rollbacks.ref_sha, rollbacks.workflow_path, rollbacks.policy_digest,
              rollbacks.contract_digest, rollbacks.status, rollbacks.github_run_id,
              runs.state AS run_state, runs.version AS current_run_version,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              plans.status AS plan_status, attempts.status AS attempt_status,
              attempts.version AS attempt_version, attempts.lease_generation,
              EXISTS (
                SELECT 1 FROM test_rollback_contract_observations AS observations
                WHERE observations.observation_id = rollbacks.contract_observation_id
                  AND observations.disposition = 'declared'
                  AND observations.source_kind = rollbacks.source_kind
                  AND observations.source_id = rollbacks.source_id
                  AND observations.source_evidence_id = rollbacks.source_evidence_id
                  AND observations.repository = rollbacks.repository
                  AND observations.ref_sha = rollbacks.ref_sha
                  AND observations.policy_digest = rollbacks.policy_digest
                  AND observations.contract_digest = rollbacks.contract_digest
              ) AS contract_declared,
              CASE rollbacks.source_kind
                WHEN 'deployment_failure' THEN EXISTS (
                  SELECT 1 FROM test_deployments AS source
                  JOIN evidence ON evidence.evidence_id = source.evidence_id
                  JOIN attempts AS failed ON failed.attempt_id = source.attempt_id
                  WHERE source.deployment_id = rollbacks.source_id
                    AND source.evidence_id = rollbacks.source_evidence_id
                    AND source.status = 'failed'
                    AND source.external_state IN ('failure', 'error')
                    AND evidence.kind = 'deployment' AND evidence.status = 'failed'
                    AND evidence.verification_status = 'verified'
                    AND failed.status = 'failed'
                )
                WHEN 'acceptance_failure' THEN EXISTS (
                  SELECT 1 FROM test_acceptances AS source
                  JOIN evidence ON evidence.evidence_id = source.evidence_id
                  JOIN attempts AS failed ON failed.attempt_id = source.attempt_id
                  JOIN test_deployments AS deployment
                    ON deployment.deployment_id = source.deployment_id
                  JOIN evidence AS deployment_evidence
                    ON deployment_evidence.evidence_id = deployment.evidence_id
                  WHERE source.acceptance_id = rollbacks.source_id
                    AND source.evidence_id = rollbacks.source_evidence_id
                    AND source.status = 'failed' AND source.external_state = 'completed'
                    AND evidence.kind = 'test' AND evidence.status = 'failed'
                    AND evidence.verification_status = 'verified'
                    AND failed.status = 'failed' AND deployment.status = 'succeeded'
                    AND deployment_evidence.kind = 'deployment'
                    AND deployment_evidence.status = 'passed'
                    AND deployment_evidence.verification_status = 'verified'
                )
                ELSE 0
              END AS source_valid
       FROM test_rollbacks AS rollbacks
       JOIN runs ON runs.run_id = rollbacks.run_id
       JOIN execution_plans AS plans ON plans.plan_id = rollbacks.plan_id
       JOIN attempts ON attempts.attempt_id = rollbacks.attempt_id
       WHERE rollbacks.rollback_id = ? AND rollbacks.run_id = ?`,
    ).bind(rollbackId, runId).first<RollbackRow>();
  }
}
