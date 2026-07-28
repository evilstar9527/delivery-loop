import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
  type OutboxEffectOutcome,
} from './fenced-outbox.js';
import {
  TEST_ACCEPTANCE_WORKFLOW_FILE,
  type GitHubDispatchResult,
  type GitHubDispatchEffects,
} from './github-dispatcher.js';
import {
  QuotaControlError,
  QuotaControlStore,
} from '../storage/quota-control-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface TestAcceptanceOutboxProcessorOptions {
  allowedRepositories: readonly string[];
  controlPlaneUrl: string;
  now?: () => Date;
  generateLeaseToken?: () => string;
  outboxLeaseMs?: number;
  attemptLeaseMs?: number;
}

interface AcceptanceRow {
  acceptance_id: string;
  deployment_id: string;
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_item_id: string;
  attempt_id: string;
  repository: string;
  base_branch: string;
  ref_sha: string;
  workflow_path: string;
  status: string;
  run_state: string;
  current_run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_status: string;
  progress_status: string;
  active_attempt_id: string | null;
  attempt_status: string;
  attempt_version: number;
  lease_generation: number;
  github_run_id: string | null;
  deployment_status: string;
  deployment_evidence_status: string | null;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('acceptance control plane URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== ''
  ) throw new Error('acceptance control plane URL is invalid');
  return url.origin;
}

/** Dispatches one fixed, read-only post-deployment acceptance workflow. */
export class TestAcceptanceOutboxProcessor {
  private readonly fenced: FencedOutboxProcessor;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly controlPlaneUrl: string;
  private readonly now: () => Date;
  private readonly attemptLeaseMs: number;

  constructor(
    private readonly db: D1Database,
    private readonly effects: GitHubDispatchEffects,
    options: TestAcceptanceOutboxProcessorOptions,
  ) {
    this.allowedRepositories = new Set(options.allowedRepositories);
    this.controlPlaneUrl = httpsOrigin(options.controlPlaneUrl);
    this.now = options.now ?? (() => new Date());
    this.attemptLeaseMs = options.attemptLeaseMs ?? 30 * 60_000;
    if (this.allowedRepositories.size === 0) {
      throw new Error('acceptance repository allowlist must not be empty');
    }
    if (!Number.isSafeInteger(this.attemptLeaseMs) || this.attemptLeaseMs <= 0) {
      throw new Error('acceptance attempt lease is invalid');
    }
    this.fenced = new FencedOutboxProcessor(
      db,
      'github_acceptance',
      async (outbox) => await this.perform(outbox),
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.generateLeaseToken === undefined
          ? {}
          : { generateLeaseToken: options.generateLeaseToken }),
        ...(options.outboxLeaseMs === undefined ? {} : { leaseMs: options.outboxLeaseMs }),
        unavailableErrorCode: 'github_acceptance_unavailable',
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
    if (outbox.kind !== 'test_acceptance_dispatch') {
      throw new OutboxEffectError('unsupported_acceptance_kind');
    }
    const prefix = 'd1://test-acceptances/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('test_acceptance_ref_invalid');
    }
    const acceptanceId = outbox.payloadRef.slice(prefix.length);
    if (!ID_PATTERN.test(acceptanceId)) {
      throw new OutboxEffectError('test_acceptance_ref_invalid');
    }
    const acceptance = await this.context(acceptanceId, outbox.runId);
    if (acceptance === null) throw new OutboxEffectError('test_acceptance_missing');
    if (acceptance.status !== 'scheduled') return;
    if (
      !this.allowedRepositories.has(acceptance.repository) ||
      acceptance.workflow_path !== TEST_ACCEPTANCE_WORKFLOW_FILE ||
      acceptance.run_state !== 'executing' ||
      acceptance.current_run_version !== acceptance.run_version ||
      acceptance.active_plan_id !== acceptance.plan_id ||
      acceptance.active_plan_version !== acceptance.plan_version ||
      acceptance.active_plan_digest !== acceptance.plan_digest ||
      acceptance.plan_status !== 'active' ||
      acceptance.progress_status !== 'in_progress' ||
      acceptance.active_attempt_id !== acceptance.attempt_id ||
      acceptance.attempt_status !== 'pending' || acceptance.attempt_version !== 0 ||
      acceptance.lease_generation !== 0 || acceptance.github_run_id !== null ||
      acceptance.deployment_status !== 'succeeded' ||
      acceptance.deployment_evidence_status !== 'verified'
    ) throw new OutboxEffectError('test_acceptance_stale');

    const quota = new QuotaControlStore(this.db);
    const now = this.now();
    try {
      await quota.reserveAttemptConcurrency(acceptance.attempt_id, now);
    } catch (error) {
      if (error instanceof QuotaControlError && error.code === 'quota_exceeded') {
        throw new OutboxEffectError('quota_concurrency_exceeded');
      }
      throw error;
    }
    // Workflow dispatch can be externally successful even when the HTTP result
    // is ambiguous, so keep the slot until reconciliation/terminal state.
    const dispatch: GitHubDispatchResult = await this.effects.ensureDispatch({
      repository: acceptance.repository,
      workflowFile: TEST_ACCEPTANCE_WORKFLOW_FILE,
      ref: `refs/heads/${acceptance.base_branch}`,
      inputs: {
        schema_version: '1',
        acceptance_id: acceptance.acceptance_id,
        ref_sha: acceptance.ref_sha,
        control_plane_url: this.controlPlaneUrl,
      },
    });
    if (!/^[1-9][0-9]{0,31}$/.test(dispatch.githubRunId)) {
      throw new OutboxEffectError('github_acceptance_run_id_invalid');
    }
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.attemptLeaseMs).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_acceptances
         SET status = 'dispatched', github_run_id = ?, updated_at = ?
         WHERE acceptance_id = ? AND status = 'scheduled' AND github_run_id IS NULL
           AND EXISTS (
             SELECT 1 FROM runs
             JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
             JOIN plan_item_progress AS progress
               ON progress.plan_id = test_acceptances.plan_id
              AND progress.item_id = test_acceptances.plan_item_id
             JOIN attempts ON attempts.attempt_id = test_acceptances.attempt_id
             JOIN test_deployments AS deployments
               ON deployments.deployment_id = test_acceptances.deployment_id
             JOIN evidence ON evidence.evidence_id = deployments.evidence_id
             WHERE runs.run_id = test_acceptances.run_id
               AND runs.version = test_acceptances.run_version
               AND runs.state = 'executing'
               AND runs.active_plan_id = test_acceptances.plan_id
               AND runs.active_plan_version = test_acceptances.plan_version
               AND runs.active_plan_digest = test_acceptances.plan_digest
               AND plans.status = 'active'
               AND progress.status = 'in_progress'
               AND progress.active_attempt_id = test_acceptances.attempt_id
               AND attempts.status = 'pending' AND attempts.version = 0
               AND attempts.lease_generation = 0
               AND deployments.status = 'succeeded'
               AND evidence.kind = 'deployment' AND evidence.status = 'passed'
               AND evidence.verification_status = 'verified'
           )`,
      ).bind(dispatch.githubRunId, nowIso, acceptanceId),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'starting', version = 1, lease_generation = 1,
             lease_expires_at = ?, github_run_id = ?, github_status = 'requested',
             github_observed_at = ?, updated_at = ?
         WHERE attempt_id = ? AND run_id = ? AND mode = 'deploy'
           AND status = 'pending' AND version = 0 AND lease_generation = 0
           AND github_run_id IS NULL
           AND EXISTS (
             SELECT 1 FROM test_acceptances
             WHERE acceptance_id = ? AND status = 'dispatched'
               AND github_run_id = ?
           )`,
      ).bind(
        leaseExpiresAt,
        dispatch.githubRunId,
        nowIso,
        nowIso,
        acceptance.attempt_id,
        acceptance.run_id,
        acceptanceId,
        dispatch.githubRunId,
      ),
    ]);
    const persisted = await this.context(acceptanceId, outbox.runId);
    if (
      persisted?.status === 'dispatched' &&
      persisted.github_run_id === dispatch.githubRunId &&
      persisted.attempt_status === 'starting' && persisted.attempt_version === 1 &&
      persisted.lease_generation === 1
    ) return;
    return { settledCode: 'acceptance_dispatch_stale_after_effect' };
  }

  private async context(acceptanceId: string, runId: string): Promise<AcceptanceRow | null> {
    return await this.db.prepare(
      `SELECT acceptances.acceptance_id, acceptances.deployment_id,
              acceptances.run_id, acceptances.run_version, acceptances.plan_id,
              acceptances.plan_version, acceptances.plan_digest,
              acceptances.plan_item_id, acceptances.attempt_id,
              acceptances.repository, acceptances.base_branch, acceptances.ref_sha,
              acceptances.workflow_path, acceptances.status, acceptances.github_run_id,
              runs.state AS run_state, runs.version AS current_run_version,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              plans.status AS plan_status, progress.status AS progress_status,
              progress.active_attempt_id, attempts.status AS attempt_status,
              attempts.version AS attempt_version, attempts.lease_generation,
              deployments.status AS deployment_status,
              evidence.verification_status AS deployment_evidence_status
       FROM test_acceptances AS acceptances
       JOIN runs ON runs.run_id = acceptances.run_id
       JOIN execution_plans AS plans ON plans.plan_id = acceptances.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = acceptances.plan_id
        AND progress.item_id = acceptances.plan_item_id
       JOIN attempts ON attempts.attempt_id = acceptances.attempt_id
       JOIN test_deployments AS deployments
         ON deployments.deployment_id = acceptances.deployment_id
       LEFT JOIN evidence ON evidence.evidence_id = deployments.evidence_id
       WHERE acceptances.acceptance_id = ? AND acceptances.run_id = ?`,
    ).bind(acceptanceId, runId).first<AcceptanceRow>();
  }
}
