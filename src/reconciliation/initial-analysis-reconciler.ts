import { canonicalSha256 } from '../domain/digest.js';
import { DEFAULT_MAX_ATTEMPTS, REPEATED_FAILURE_LIMIT } from '../domain/attempt-failure.js';
import {
  ANALYSIS_REPOSITORY_INVENTORY_POLICY_VERSION,
  ANALYSIS_REPOSITORY_MAX_PROMPT_PATH_BYTES,
  ANALYSIS_REPOSITORY_MAX_TRACKED_PATH_BYTES,
  ANALYSIS_REPOSITORY_MAX_TRACKED_PATHS,
} from '../domain/analysis-repository-inventory.js';
import type { AttemptResultSignalV1 } from '../domain/workflow-event.js';
import { RunStore, RunTransitionConflictError } from '../storage/run-store.js';

interface PreparedCandidateRow {
  run_id: string;
  attempt_id: string;
  event_id: string;
  sequence: number;
  payload_ref: string;
  digest: string;
  occurred_at: string;
}

interface RetryCandidateRow {
  run_id: string;
  failure_id: string;
  failed_attempt_id: string;
  retry_sequence: number;
}

interface CapacityCandidateRow extends RetryCandidateRow {
  blocker_id: string;
}

interface AdapterCapacityCandidateRow extends CapacityCandidateRow {
  capacity_recovery_id: string;
}

interface ToolBridgeCandidateRow extends CapacityCandidateRow {
  adapter_recovery_id: string;
  logs_trace_id: string;
}

interface ToolBridgeTransportCandidateRow extends CapacityCandidateRow {
  provider_recovery_id: string;
  logs_trace_id: string;
}

interface ToolBridgeScopeCandidateRow extends CapacityCandidateRow {
  transport_recovery_id: string;
  logs_trace_id: string;
}

const TIPSY_SLS_PROVIDER_POLICY_VERSION = 1;
const TIPSY_SLS_TRANSPORT_POLICY_VERSION = 2;
const TIPSY_SLS_CREDENTIAL_POLICY_VERSION = 3;

export interface InitialAnalysisReconcilerOptions {
  now?: () => Date;
}

function stableSuffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 56);
}

/** Recovers a failed root analysis without replacing its Task, Run, or Workflow. */
export class InitialAnalysisReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    options: InitialAnalysisReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileBatch(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const activated = await this.reconcilePreparedPlans(limit);
    const remaining = limit - activated;
    if (remaining === 0) return activated;
    const capacityRecovered = await this.reconcileCapacityFailures(remaining);
    const retryRemaining = remaining - capacityRecovered;
    if (retryRemaining === 0) return activated + capacityRecovered;
    const adapterRecovered = await this.reconcileInventoryAdapterFailures(retryRemaining);
    const finalRemaining = retryRemaining - adapterRecovered;
    if (finalRemaining === 0) return activated + capacityRecovered + adapterRecovered;
    const scopeRecovered = await this.reconcileToolBridgeScopeFailures(finalRemaining);
    const transportRemaining = finalRemaining - scopeRecovered;
    if (transportRemaining === 0) {
      return activated + capacityRecovered + adapterRecovered + scopeRecovered;
    }
    const transportRecovered = await this.reconcileToolBridgeTransportFailures(transportRemaining);
    const providerRemaining = transportRemaining - transportRecovered;
    if (providerRemaining === 0) {
      return activated + capacityRecovered + adapterRecovered + scopeRecovered + transportRecovered;
    }
    const toolBridgeRecovered = await this.reconcileToolBridgeFailures(providerRemaining);
    const ordinaryRemaining = providerRemaining - toolBridgeRecovered;
    if (ordinaryRemaining === 0) {
      return activated + capacityRecovered + adapterRecovered + scopeRecovered + transportRecovered +
        toolBridgeRecovered;
    }
    return activated + capacityRecovered + adapterRecovered + scopeRecovered + transportRecovered +
      toolBridgeRecovered +
      await this.reconcileFailedAttempts(ordinaryRemaining);
  }

  /** Activates a replacement Plan only after its Runner callback is durable in D1. */
  async reconcilePreparedPlans(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const result = await this.db.prepare(
      `SELECT runs.run_id, current.attempt_id, current.result_event_id AS event_id,
              current.result_sequence AS sequence,
              current.result_payload_ref AS payload_ref,
              current.result_digest AS digest,
              signals.occurred_at
       FROM runs
       JOIN initial_analysis_retries AS retries
         ON retries.run_id = runs.run_id
        AND NOT EXISTS (
          SELECT 1 FROM initial_analysis_retries AS later
          WHERE later.run_id = retries.run_id
            AND later.retry_sequence > retries.retry_sequence
        )
       JOIN attempts AS current ON current.attempt_id = retries.retry_attempt_id
       JOIN execution_plans AS plans
         ON plans.run_id = runs.run_id
        AND plans.created_by_attempt_id = current.attempt_id
       JOIN workflow_signals AS signals
         ON signals.run_id = runs.run_id
        AND signals.attempt_id = current.attempt_id
        AND signals.event_id = current.result_event_id
        AND signals.sequence = current.result_sequence
        AND signals.payload_ref = current.result_payload_ref
        AND signals.digest = current.result_digest
       WHERE runs.state = 'planning'
         AND runs.active_plan_id IS NULL
         AND runs.active_plan_version IS NULL
         AND runs.active_plan_digest IS NULL
         AND current.mode = 'analysis' AND current.status = 'running'
         AND current.base_sha = runs.base_sha
         AND current.result_event_id IS NOT NULL
         AND current.result_sequence IS NOT NULL
         AND current.result_payload_ref = 'd1://execution-plans/' || plans.plan_id
         AND current.result_digest = plans.digest
         AND plans.plan_version = 1 AND plans.base_sha = runs.base_sha
         AND plans.status = 'validated'
         AND NOT EXISTS (
           SELECT 1 FROM plan_revisions
           WHERE plan_revisions.run_id = runs.run_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM run_blockers
           WHERE run_blockers.run_id = runs.run_id
             AND run_blockers.resolved_at IS NULL
         )
       ORDER BY current.result_reported_at, runs.run_id
       LIMIT ?`,
    ).bind(limit).all<PreparedCandidateRow>();
    let activated = 0;
    const store = new RunStore(this.db);
    for (const candidate of result.results) {
      const signal: AttemptResultSignalV1 = {
        schemaVersion: '1',
        eventId: candidate.event_id,
        runId: candidate.run_id,
        type: 'attempt_completed',
        attemptId: candidate.attempt_id,
        sequence: candidate.sequence,
        payloadRef: candidate.payload_ref,
        digest: candidate.digest,
        occurredAt: candidate.occurred_at,
      };
      try {
        await store.activateAnalysisPlan(signal, this.now().toISOString());
        activated += 1;
      } catch (error) {
        if (!(error instanceof RunTransitionConflictError)) throw error;
      }
    }
    return activated;
  }

  async reconcileFailedAttempts(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const candidates = await this.candidates(limit);
    let created = 0;
    for (const candidate of candidates) {
      if (await this.schedule(candidate)) created += 1;
    }
    return created;
  }

  /**
   * Re-arms one read-only root analysis blocked by the former repository
   * inventory ceiling. Other failure sites/codes remain blocked.
   */
  async reconcileCapacityFailures(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const result = await this.db.prepare(
      `SELECT runs.run_id, failures.failure_id,
              failed.attempt_id AS failed_attempt_id,
              blockers.blocker_id,
              COALESCE(current_retry.retry_sequence, 0) + 1 AS retry_sequence
       FROM runs
       LEFT JOIN initial_analysis_retries AS current_retry
         ON current_retry.run_id = runs.run_id
        AND NOT EXISTS (
          SELECT 1 FROM initial_analysis_retries AS later
          WHERE later.run_id = current_retry.run_id
            AND later.retry_sequence > current_retry.retry_sequence
        )
       JOIN attempts AS failed
         ON failed.attempt_id = COALESCE(
           current_retry.retry_attempt_id,
           (SELECT root.attempt_id FROM attempts AS root
            WHERE root.run_id = runs.run_id AND root.mode = 'analysis'
            ORDER BY root.ordinal LIMIT 1)
         )
       JOIN attempt_failures AS failures
         ON failures.attempt_id = failed.attempt_id AND failures.run_id = runs.run_id
       JOIN run_blockers AS blockers
         ON blockers.run_id = runs.run_id
        AND blockers.resolved_at IS NULL
        AND blockers.retry_scope_digest = failures.retry_scope_digest
        AND blockers.fingerprint_digest = failures.fingerprint_digest
       WHERE runs.state = 'blocked'
         AND runs.active_plan_id IS NULL
         AND runs.active_plan_version IS NULL
         AND runs.active_plan_digest IS NULL
         AND failed.mode = 'analysis' AND failed.status = 'failed'
         AND failed.base_sha = runs.base_sha
         AND failures.failure_class = 'unknown'
         AND failures.failure_code = 'unknown_failure'
         AND failures.failure_site = 'repo_snapshot'
         AND failures.needed_human_input = 'manual_investigation'
         AND failures.scope_attempt_count >= ?
         AND failures.consecutive_fingerprint_count >= ?
         AND blockers.reason IN ('repeated_fingerprint', 'attempt_limit')
         AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         AND NOT EXISTS (
           SELECT 1 FROM initial_analysis_capacity_recoveries AS recovery
           WHERE recovery.run_id = runs.run_id
              OR recovery.blocker_id = blockers.blocker_id
              OR recovery.failure_id = failures.failure_id
              OR recovery.failed_attempt_id = failed.attempt_id
         )
       ORDER BY failures.created_at, runs.run_id
       LIMIT ?`,
    ).bind(DEFAULT_MAX_ATTEMPTS, REPEATED_FAILURE_LIMIT, limit).all<CapacityCandidateRow>();
    let recovered = 0;
    for (const candidate of result.results) {
      if (await this.scheduleCapacityRecovery(candidate)) recovered += 1;
    }
    return recovered;
  }

  /** Re-arms the one v2 capacity replacement rejected by the adapter's stale v1 limit. */
  async reconcileInventoryAdapterFailures(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const result = await this.db.prepare(
      `SELECT runs.run_id, failures.failure_id,
              failed.attempt_id AS failed_attempt_id, blockers.blocker_id,
              capacity.recovery_id AS capacity_recovery_id,
              current_retry.retry_sequence + 1 AS retry_sequence
       FROM runs
       JOIN initial_analysis_retries AS current_retry
         ON current_retry.run_id = runs.run_id
        AND NOT EXISTS (
          SELECT 1 FROM initial_analysis_retries AS later
          WHERE later.run_id = current_retry.run_id
            AND later.retry_sequence > current_retry.retry_sequence
        )
       JOIN attempts AS failed ON failed.attempt_id = current_retry.retry_attempt_id
       JOIN initial_analysis_capacity_recoveries AS capacity
         ON capacity.run_id = runs.run_id
        AND capacity.replacement_attempt_id = failed.attempt_id
        AND capacity.inventory_policy_version = ?
       JOIN attempt_failures AS failures
         ON failures.attempt_id = failed.attempt_id AND failures.run_id = runs.run_id
       JOIN run_blockers AS blockers
         ON blockers.run_id = runs.run_id AND blockers.resolved_at IS NULL
        AND blockers.retry_scope_digest = failures.retry_scope_digest
        AND blockers.fingerprint_digest = failures.fingerprint_digest
       WHERE runs.state = 'blocked' AND runs.active_plan_id IS NULL
         AND failed.mode = 'analysis' AND failed.status = 'failed'
         AND failed.base_sha = runs.base_sha
         AND failures.failure_class = 'invalid_output'
         AND failures.failure_code = 'invalid_agent_output'
         AND failures.failure_site = 'agent_output'
         AND failures.needed_human_input = 'manual_investigation'
         AND failures.scope_attempt_count >= 4
         AND blockers.reason = 'attempt_limit'
         AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (SELECT 1 FROM tool_call_traces WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (
           SELECT 1 FROM initial_analysis_inventory_adapter_recoveries AS recovery
           WHERE recovery.run_id = runs.run_id
              OR recovery.capacity_recovery_id = capacity.recovery_id
              OR recovery.failure_id = failures.failure_id
              OR recovery.failed_attempt_id = failed.attempt_id
         )
       ORDER BY failures.created_at, runs.run_id LIMIT ?`,
    ).bind(ANALYSIS_REPOSITORY_INVENTORY_POLICY_VERSION, limit)
      .all<AdapterCapacityCandidateRow>();
    let recovered = 0;
    for (const candidate of result.results) {
      if (await this.scheduleInventoryAdapterRecovery(candidate)) recovered += 1;
    }
    return recovered;
  }

  /**
   * Re-arms only the first real tool call made by the v2 adapter replacement
   * when the retired Cloudflare-telemetry provider returned an upstream error.
   */
  async reconcileToolBridgeFailures(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const result = await this.db.prepare(
      `SELECT runs.run_id, failures.failure_id,
              failed.attempt_id AS failed_attempt_id, blockers.blocker_id,
              adapter.recovery_id AS adapter_recovery_id,
              traces.trace_id AS logs_trace_id,
              current_retry.retry_sequence + 1 AS retry_sequence
       FROM runs
       JOIN initial_analysis_retries AS current_retry
         ON current_retry.run_id = runs.run_id
        AND NOT EXISTS (
          SELECT 1 FROM initial_analysis_retries AS later
          WHERE later.run_id = current_retry.run_id
            AND later.retry_sequence > current_retry.retry_sequence
        )
       JOIN attempts AS failed ON failed.attempt_id = current_retry.retry_attempt_id
       JOIN initial_analysis_inventory_adapter_recoveries AS adapter
         ON adapter.run_id = runs.run_id
        AND adapter.replacement_attempt_id = failed.attempt_id
       JOIN attempt_failures AS failures
         ON failures.attempt_id = failed.attempt_id AND failures.run_id = runs.run_id
       JOIN run_blockers AS blockers
         ON blockers.run_id = runs.run_id AND blockers.resolved_at IS NULL
        AND blockers.retry_scope_digest = failures.retry_scope_digest
        AND blockers.fingerprint_digest = failures.fingerprint_digest
       JOIN tool_call_traces AS traces
         ON traces.attempt_id = failed.attempt_id AND traces.run_id = runs.run_id
        AND traces.tool_path = 'logs/search' AND traces.action = 'logs:read'
        AND traces.effect = 'read' AND traces.result_category = 'upstream_error'
       WHERE runs.state = 'blocked' AND runs.active_plan_id IS NULL
         AND failed.mode = 'analysis' AND failed.status = 'failed'
         AND failed.base_sha = runs.base_sha
         AND failures.failure_class = 'tool_error'
         AND failures.failure_code = 'tool_unavailable'
         AND failures.failure_site = 'tool_logs_search'
         AND failures.needed_human_input = 'resolve_external_dependency'
         AND blockers.reason IN ('external_dependency', 'attempt_limit')
         AND blockers.needed_human_input = 'resolve_external_dependency'
         AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         AND (SELECT COUNT(*) FROM tool_call_traces WHERE attempt_id = failed.attempt_id) = 1
         AND EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
         AND EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (SELECT 1 FROM evidence WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (
           SELECT 1 FROM initial_analysis_tool_bridge_recoveries AS recovery
           WHERE recovery.run_id = runs.run_id
              OR recovery.adapter_recovery_id = adapter.recovery_id
              OR recovery.blocker_id = blockers.blocker_id
              OR recovery.failure_id = failures.failure_id
              OR recovery.failed_attempt_id = failed.attempt_id
              OR recovery.logs_trace_id = traces.trace_id
         )
       ORDER BY failures.created_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<ToolBridgeCandidateRow>();
    let recovered = 0;
    for (const candidate of result.results) {
      if (await this.scheduleToolBridgeRecovery(candidate)) recovered += 1;
    }
    return recovered;
  }

  /** Re-arms the exact provider replacement rejected locally by workerd redirect mode. */
  async reconcileToolBridgeTransportFailures(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const result = await this.db.prepare(
      `SELECT runs.run_id, failures.failure_id,
              failed.attempt_id AS failed_attempt_id, blockers.blocker_id,
              provider.recovery_id AS provider_recovery_id,
              traces.trace_id AS logs_trace_id,
              current_retry.retry_sequence + 1 AS retry_sequence
       FROM runs
       JOIN initial_analysis_retries AS current_retry
         ON current_retry.run_id = runs.run_id
        AND NOT EXISTS (
          SELECT 1 FROM initial_analysis_retries AS later
          WHERE later.run_id = current_retry.run_id
            AND later.retry_sequence > current_retry.retry_sequence
        )
       JOIN attempts AS failed ON failed.attempt_id = current_retry.retry_attempt_id
       JOIN initial_analysis_tool_bridge_recoveries AS provider
         ON provider.run_id = runs.run_id
        AND provider.replacement_attempt_id = failed.attempt_id
        AND provider.provider_policy_version = ?
       JOIN attempt_failures AS failures
         ON failures.attempt_id = failed.attempt_id AND failures.run_id = runs.run_id
       JOIN run_blockers AS blockers
         ON blockers.run_id = runs.run_id AND blockers.resolved_at IS NULL
        AND blockers.retry_scope_digest = failures.retry_scope_digest
        AND blockers.fingerprint_digest = failures.fingerprint_digest
       JOIN tool_call_traces AS traces
         ON traces.attempt_id = failed.attempt_id AND traces.run_id = runs.run_id
        AND traces.tool_path = 'logs/search' AND traces.action = 'logs:read'
        AND traces.effect = 'read' AND traces.result_category = 'upstream_error'
       WHERE runs.state = 'blocked' AND runs.active_plan_id IS NULL
         AND failed.mode = 'analysis' AND failed.status = 'failed'
         AND failed.base_sha = runs.base_sha
         AND failures.failure_class = 'tool_error'
         AND failures.failure_code = 'tool_unavailable'
         AND failures.failure_site = 'tool_logs_search'
         AND failures.needed_human_input = 'resolve_external_dependency'
         AND blockers.reason IN ('external_dependency', 'attempt_limit', 'repeated_fingerprint')
         AND blockers.needed_human_input = 'resolve_external_dependency'
         AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         AND (SELECT COUNT(*) FROM tool_call_traces WHERE attempt_id = failed.attempt_id) = 1
         AND EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
         AND EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (SELECT 1 FROM evidence WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (
           SELECT 1 FROM initial_analysis_tool_bridge_transport_recoveries AS recovery
           WHERE recovery.run_id = runs.run_id
              OR recovery.provider_recovery_id = provider.recovery_id
              OR recovery.blocker_id = blockers.blocker_id
              OR recovery.failure_id = failures.failure_id
              OR recovery.failed_attempt_id = failed.attempt_id
              OR recovery.logs_trace_id = traces.trace_id
         )
       ORDER BY failures.created_at, runs.run_id LIMIT ?`,
    ).bind(TIPSY_SLS_PROVIDER_POLICY_VERSION, limit).all<ToolBridgeTransportCandidateRow>();
    let recovered = 0;
    for (const candidate of result.results) {
      if (await this.scheduleToolBridgeTransportRecovery(candidate)) recovered += 1;
    }
    return recovered;
  }

  /** Re-arms the exact transport replacement hidden by the stale leaf-only SK scope. */
  async reconcileToolBridgeScopeFailures(limit = 5): Promise<number> {
    this.assertLimit(limit);
    const result = await this.db.prepare(
      `SELECT runs.run_id, failures.failure_id,
              failed.attempt_id AS failed_attempt_id, blockers.blocker_id,
              transport.recovery_id AS transport_recovery_id,
              traces.trace_id AS logs_trace_id,
              current_retry.retry_sequence + 1 AS retry_sequence
       FROM runs
       JOIN initial_analysis_retries AS current_retry
         ON current_retry.run_id = runs.run_id
        AND NOT EXISTS (
          SELECT 1 FROM initial_analysis_retries AS later
          WHERE later.run_id = current_retry.run_id
            AND later.retry_sequence > current_retry.retry_sequence
        )
       JOIN attempts AS failed ON failed.attempt_id = current_retry.retry_attempt_id
       JOIN initial_analysis_tool_bridge_transport_recoveries AS transport
         ON transport.run_id = runs.run_id
        AND transport.replacement_attempt_id = failed.attempt_id
        AND transport.transport_policy_version = ?
       JOIN attempt_failures AS failures
         ON failures.attempt_id = failed.attempt_id AND failures.run_id = runs.run_id
       JOIN run_blockers AS blockers
         ON blockers.run_id = runs.run_id AND blockers.resolved_at IS NULL
        AND blockers.retry_scope_digest = failures.retry_scope_digest
        AND blockers.fingerprint_digest = failures.fingerprint_digest
       JOIN tool_call_traces AS traces
         ON traces.attempt_id = failed.attempt_id AND traces.run_id = runs.run_id
        AND traces.tool_path = 'logs/search' AND traces.action = 'logs:read'
        AND traces.effect = 'read' AND traces.result_category = 'upstream_error'
       WHERE runs.state = 'blocked' AND runs.active_plan_id IS NULL
         AND failed.mode = 'analysis' AND failed.status = 'failed'
         AND failed.base_sha = runs.base_sha
         AND failures.failure_class = 'tool_error'
         AND failures.failure_code = 'tool_unavailable'
         AND failures.failure_site = 'tool_logs_search'
         AND failures.needed_human_input = 'resolve_external_dependency'
         AND blockers.reason IN ('external_dependency', 'attempt_limit', 'repeated_fingerprint')
         AND blockers.needed_human_input = 'resolve_external_dependency'
         AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
         AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         AND (SELECT COUNT(*) FROM tool_call_traces WHERE attempt_id = failed.attempt_id) = 1
         AND EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
         AND EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (SELECT 1 FROM evidence WHERE attempt_id = failed.attempt_id)
         AND NOT EXISTS (
           SELECT 1 FROM initial_analysis_tool_bridge_scope_recoveries AS recovery
           WHERE recovery.run_id = runs.run_id
              OR recovery.transport_recovery_id = transport.recovery_id
              OR recovery.blocker_id = blockers.blocker_id
              OR recovery.failure_id = failures.failure_id
              OR recovery.failed_attempt_id = failed.attempt_id
              OR recovery.logs_trace_id = traces.trace_id
         )
       ORDER BY failures.created_at, runs.run_id LIMIT ?`,
    ).bind(TIPSY_SLS_TRANSPORT_POLICY_VERSION, limit).all<ToolBridgeScopeCandidateRow>();
    let recovered = 0;
    for (const candidate of result.results) {
      if (await this.scheduleToolBridgeScopeRecovery(candidate)) recovered += 1;
    }
    return recovered;
  }

  private assertLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Initial analysis reconciliation limit must be between 1 and 100');
    }
  }

  private async candidates(limit: number): Promise<RetryCandidateRow[]> {
    const result = await this.db.prepare(
      `SELECT runs.run_id, failures.failure_id,
              failed.attempt_id AS failed_attempt_id,
              COALESCE(current_retry.retry_sequence, 0) + 1 AS retry_sequence
       FROM runs
       LEFT JOIN initial_analysis_retries AS current_retry
         ON current_retry.run_id = runs.run_id
        AND NOT EXISTS (
          SELECT 1 FROM initial_analysis_retries AS later
          WHERE later.run_id = current_retry.run_id
            AND later.retry_sequence > current_retry.retry_sequence
        )
       JOIN attempts AS failed
         ON failed.attempt_id = COALESCE(
           current_retry.retry_attempt_id,
           (SELECT root.attempt_id FROM attempts AS root
            WHERE root.run_id = runs.run_id AND root.mode = 'analysis'
            ORDER BY root.ordinal LIMIT 1)
         )
       JOIN attempt_failures AS failures
         ON failures.attempt_id = failed.attempt_id
        AND failures.run_id = runs.run_id
       WHERE runs.state = 'planning'
         AND runs.active_plan_id IS NULL
         AND runs.active_plan_version IS NULL
         AND runs.active_plan_digest IS NULL
         AND failed.mode = 'analysis' AND failed.status = 'failed'
         AND failed.base_sha = runs.base_sha
         AND failures.scope_attempt_count < ?
         AND failures.consecutive_fingerprint_count < ?
         AND NOT EXISTS (
           SELECT 1 FROM plan_revisions
           WHERE plan_revisions.run_id = runs.run_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM automated_reviews
           WHERE automated_reviews.run_id = runs.run_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM run_blockers
           WHERE run_blockers.run_id = runs.run_id
             AND run_blockers.resolved_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM execution_plans AS proposal
           WHERE proposal.run_id = runs.run_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM initial_analysis_retries AS consumed
           WHERE consumed.failure_id = failures.failure_id
              OR consumed.failed_attempt_id = failed.attempt_id
         )
       ORDER BY failures.created_at, runs.run_id
       LIMIT ?`,
    ).bind(DEFAULT_MAX_ATTEMPTS, REPEATED_FAILURE_LIMIT, limit).all<RetryCandidateRow>();
    return result.results;
  }

  private async schedule(candidate: RetryCandidateRow): Promise<boolean> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      runId: candidate.run_id,
      failureId: candidate.failure_id,
      failedAttemptId: candidate.failed_attempt_id,
      retrySequence: candidate.retry_sequence,
    });
    const suffix = stableSuffix(identity);
    const retryId = `initial_analysis_retry_${suffix}`;
    // attemptResultEventName() prefixes this ID; keep the combined Cloudflare
    // Workflow event name below its 100-byte platform limit.
    const attemptId = `analysis_retry_${suffix}`;
    const outboxId = `dispatch_initial_analysis_retry_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT ?, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'analysis', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, 0, 0, ?, ?
         FROM attempts AS failed
         JOIN attempt_failures AS failures
           ON failures.failure_id = ? AND failures.attempt_id = failed.attempt_id
         JOIN runs ON runs.run_id = failed.run_id
         WHERE failed.attempt_id = ? AND failed.mode = 'analysis'
           AND failed.status = 'failed'
           AND runs.state = 'planning'
           AND runs.base_sha = failed.base_sha
           AND runs.active_plan_id IS NULL
           AND runs.active_plan_version IS NULL
           AND runs.active_plan_digest IS NULL
           AND failures.scope_attempt_count < ?
           AND failures.consecutive_fingerprint_count < ?
           AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
           AND NOT EXISTS (
             SELECT 1 FROM run_blockers
             WHERE run_id = runs.run_id AND resolved_at IS NULL
           )
           AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
           AND NOT EXISTS (
             SELECT 1 FROM initial_analysis_retries AS consumed
             WHERE consumed.failure_id = failures.failure_id
                OR consumed.failed_attempt_id = failed.attempt_id
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        attemptId,
        nowIso,
        nowIso,
        candidate.failure_id,
        candidate.failed_attempt_id,
        DEFAULT_MAX_ATTEMPTS,
        REPEATED_FAILURE_LIMIT,
      ),
      this.db.prepare(
        `INSERT INTO initial_analysis_retries (
           retry_id, run_id, failure_id, failed_attempt_id,
           retry_attempt_id, retry_sequence, created_at
         )
         SELECT ?, failed.run_id, failures.failure_id, failed.attempt_id,
                retry.attempt_id, ?, ?
         FROM attempt_failures AS failures
         JOIN attempts AS failed ON failed.attempt_id = failures.attempt_id
         JOIN attempts AS retry
           ON retry.attempt_id = ? AND retry.run_id = failed.run_id
          AND retry.mode = 'analysis' AND retry.status = 'pending'
         WHERE failures.failure_id = ? AND failed.attempt_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        retryId,
        candidate.retry_sequence,
        nowIso,
        attemptId,
        candidate.failure_id,
        candidate.failed_attempt_id,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, retries.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM initial_analysis_retries AS retries
         JOIN attempts ON attempts.attempt_id = retries.retry_attempt_id
         JOIN runs ON runs.run_id = retries.run_id
         WHERE retries.retry_id = ? AND retries.retry_attempt_id = ?
           AND runs.state = 'planning' AND runs.active_plan_id IS NULL
           AND attempts.status = 'pending'
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${attemptId}`,
        `analysis-initial-retry:${candidate.failure_id}`,
        nowIso,
        nowIso,
        retryId,
        attemptId,
      ),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1 &&
      results[2]?.meta.changes === 1;
  }

  private async scheduleCapacityRecovery(candidate: CapacityCandidateRow): Promise<boolean> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      kind: 'initial_analysis_repository_capacity',
      inventoryPolicyVersion: ANALYSIS_REPOSITORY_INVENTORY_POLICY_VERSION,
      runId: candidate.run_id,
      blockerId: candidate.blocker_id,
      failureId: candidate.failure_id,
      failedAttemptId: candidate.failed_attempt_id,
    });
    const suffix = stableSuffix(identity);
    const recoveryId = `initial_analysis_capacity_${suffix}`;
    const retryId = `initial_analysis_retry_${suffix}`;
    const attemptId = `analysis_retry_${suffix}`;
    const outboxId = `dispatch_initial_analysis_retry_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO initial_analysis_capacity_recoveries (
           recovery_id, run_id, blocker_id, failure_id, failed_attempt_id,
           replacement_attempt_id, inventory_policy_version,
           max_tracked_paths, max_tracked_path_bytes, created_at
         )
         SELECT ?, runs.run_id, blockers.blocker_id, failures.failure_id,
                failed.attempt_id, ?, ?, ?, ?, ?
         FROM runs
         JOIN attempts AS failed ON failed.attempt_id = ? AND failed.run_id = runs.run_id
         JOIN attempt_failures AS failures
           ON failures.failure_id = ? AND failures.attempt_id = failed.attempt_id
         JOIN run_blockers AS blockers
           ON blockers.blocker_id = ? AND blockers.run_id = runs.run_id
          AND blockers.resolved_at IS NULL
          AND blockers.retry_scope_digest = failures.retry_scope_digest
          AND blockers.fingerprint_digest = failures.fingerprint_digest
         WHERE runs.run_id = ? AND runs.state = 'blocked'
           AND runs.active_plan_id IS NULL
           AND failed.mode = 'analysis' AND failed.status = 'failed'
           AND failed.base_sha = runs.base_sha
           AND failures.failure_class = 'unknown'
           AND failures.failure_code = 'unknown_failure'
           AND failures.failure_site = 'repo_snapshot'
           AND failures.needed_human_input = 'manual_investigation'
           AND failures.scope_attempt_count >= ?
           AND failures.consecutive_fingerprint_count >= ?
           AND blockers.reason IN ('repeated_fingerprint', 'attempt_limit')
           AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         ON CONFLICT DO NOTHING`,
      ).bind(
        recoveryId,
        attemptId,
        ANALYSIS_REPOSITORY_INVENTORY_POLICY_VERSION,
        ANALYSIS_REPOSITORY_MAX_TRACKED_PATHS,
        ANALYSIS_REPOSITORY_MAX_TRACKED_PATH_BYTES,
        nowIso,
        candidate.failed_attempt_id,
        candidate.failure_id,
        candidate.blocker_id,
        candidate.run_id,
        DEFAULT_MAX_ATTEMPTS,
        REPEATED_FAILURE_LIMIT,
      ),
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT recovery.replacement_attempt_id, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'analysis', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, 0, 0, ?, ?
         FROM initial_analysis_capacity_recoveries AS recovery
         JOIN attempts AS failed ON failed.attempt_id = recovery.failed_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND recovery.replacement_attempt_id = ?
           AND runs.state = 'blocked' AND failed.status = 'failed'
         ON CONFLICT DO NOTHING`,
      ).bind(nowIso, nowIso, recoveryId, attemptId),
      this.db.prepare(
        `INSERT INTO initial_analysis_retries (
           retry_id, run_id, failure_id, failed_attempt_id,
           retry_attempt_id, retry_sequence, created_at
         )
         SELECT ?, recovery.run_id, recovery.failure_id, recovery.failed_attempt_id,
                attempts.attempt_id, ?, ?
         FROM initial_analysis_capacity_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
          AND attempts.run_id = recovery.run_id AND attempts.status = 'pending'
         WHERE recovery.recovery_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(retryId, candidate.retry_sequence, nowIso, recoveryId),
      this.db.prepare(
        `UPDATE run_blockers SET resolved_at = ?,
             resolution_code = 'analysis_repository_capacity_v2'
         WHERE blocker_id = ? AND run_id = ? AND resolved_at IS NULL
           AND EXISTS (
             SELECT 1 FROM initial_analysis_retries AS retry
             WHERE retry.retry_id = ? AND retry.retry_attempt_id = ?
           )`,
      ).bind(nowIso, candidate.blocker_id, candidate.run_id, retryId, attemptId),
      this.db.prepare(
        `UPDATE runs SET state = 'planning', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'blocked' AND active_plan_id IS NULL
           AND EXISTS (
             SELECT 1 FROM initial_analysis_capacity_recoveries AS recovery
             JOIN run_blockers AS blocker ON blocker.blocker_id = recovery.blocker_id
             WHERE recovery.recovery_id = ?
               AND recovery.replacement_attempt_id = ?
               AND blocker.resolved_at = ?
               AND blocker.resolution_code = 'analysis_repository_capacity_v2'
           )`,
      ).bind(nowIso, candidate.run_id, recoveryId, attemptId, nowIso),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, recovery.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM initial_analysis_capacity_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND recovery.replacement_attempt_id = ?
           AND runs.state = 'planning' AND attempts.status = 'pending'
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${attemptId}`,
        `analysis-capacity-recovery:${candidate.failure_id}`,
        nowIso,
        nowIso,
        recoveryId,
        attemptId,
      ),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }

  private async scheduleInventoryAdapterRecovery(
    candidate: AdapterCapacityCandidateRow,
  ): Promise<boolean> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      kind: 'initial_analysis_inventory_adapter_capacity',
      inventoryPolicyVersion: ANALYSIS_REPOSITORY_INVENTORY_POLICY_VERSION,
      runId: candidate.run_id,
      capacityRecoveryId: candidate.capacity_recovery_id,
      blockerId: candidate.blocker_id,
      failureId: candidate.failure_id,
      failedAttemptId: candidate.failed_attempt_id,
    });
    const suffix = stableSuffix(identity);
    const recoveryId = `initial_analysis_adapter_${suffix}`;
    const retryId = `initial_analysis_retry_${suffix}`;
    const attemptId = `analysis_retry_${suffix}`;
    const outboxId = `dispatch_initial_analysis_retry_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO initial_analysis_inventory_adapter_recoveries (
           recovery_id, run_id, capacity_recovery_id, blocker_id, failure_id,
           failed_attempt_id, replacement_attempt_id, inventory_policy_version,
           max_prompt_path_bytes, created_at
         )
         SELECT ?, runs.run_id, capacity.recovery_id, blockers.blocker_id,
                failures.failure_id, failed.attempt_id, ?, ?, ?, ?
         FROM runs
         JOIN attempts AS failed ON failed.attempt_id = ? AND failed.run_id = runs.run_id
         JOIN initial_analysis_capacity_recoveries AS capacity
           ON capacity.recovery_id = ? AND capacity.run_id = runs.run_id
          AND capacity.replacement_attempt_id = failed.attempt_id
         JOIN attempt_failures AS failures
           ON failures.failure_id = ? AND failures.attempt_id = failed.attempt_id
         JOIN run_blockers AS blockers
           ON blockers.blocker_id = ? AND blockers.run_id = runs.run_id
          AND blockers.resolved_at IS NULL
          AND blockers.retry_scope_digest = failures.retry_scope_digest
          AND blockers.fingerprint_digest = failures.fingerprint_digest
         WHERE runs.run_id = ? AND runs.state = 'blocked'
           AND runs.active_plan_id IS NULL
           AND failed.mode = 'analysis' AND failed.status = 'failed'
           AND failures.failure_class = 'invalid_output'
           AND failures.failure_code = 'invalid_agent_output'
           AND failures.failure_site = 'agent_output'
           AND failures.needed_human_input = 'manual_investigation'
           AND failures.scope_attempt_count >= 4 AND blockers.reason = 'attempt_limit'
           AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM tool_call_traces WHERE attempt_id = failed.attempt_id)
         ON CONFLICT DO NOTHING`,
      ).bind(
        recoveryId, attemptId, ANALYSIS_REPOSITORY_INVENTORY_POLICY_VERSION,
        ANALYSIS_REPOSITORY_MAX_PROMPT_PATH_BYTES, nowIso,
        candidate.failed_attempt_id, candidate.capacity_recovery_id,
        candidate.failure_id, candidate.blocker_id, candidate.run_id,
      ),
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT recovery.replacement_attempt_id, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'analysis', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, 0, 0, ?, ?
         FROM initial_analysis_inventory_adapter_recoveries AS recovery
         JOIN attempts AS failed ON failed.attempt_id = recovery.failed_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'blocked'
           AND failed.status = 'failed' ON CONFLICT DO NOTHING`,
      ).bind(nowIso, nowIso, recoveryId),
      this.db.prepare(
        `INSERT INTO initial_analysis_retries (
           retry_id, run_id, failure_id, failed_attempt_id,
           retry_attempt_id, retry_sequence, created_at
         )
         SELECT ?, recovery.run_id, recovery.failure_id, recovery.failed_attempt_id,
                attempts.attempt_id, ?, ?
         FROM initial_analysis_inventory_adapter_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
          AND attempts.status = 'pending'
         WHERE recovery.recovery_id = ? ON CONFLICT DO NOTHING`,
      ).bind(retryId, candidate.retry_sequence, nowIso, recoveryId),
      this.db.prepare(
        `UPDATE run_blockers SET resolved_at = ?,
             resolution_code = 'analysis_inventory_adapter_capacity_v2'
         WHERE blocker_id = ? AND run_id = ? AND resolved_at IS NULL
           AND EXISTS (SELECT 1 FROM initial_analysis_retries
                       WHERE retry_id = ? AND retry_attempt_id = ?)`,
      ).bind(nowIso, candidate.blocker_id, candidate.run_id, retryId, attemptId),
      this.db.prepare(
        `UPDATE runs SET state = 'planning', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'blocked' AND active_plan_id IS NULL
           AND EXISTS (
             SELECT 1 FROM initial_analysis_inventory_adapter_recoveries AS recovery
             JOIN run_blockers AS blocker ON blocker.blocker_id = recovery.blocker_id
             WHERE recovery.recovery_id = ? AND blocker.resolved_at = ?
               AND blocker.resolution_code = 'analysis_inventory_adapter_capacity_v2'
           )`,
      ).bind(nowIso, candidate.run_id, recoveryId, nowIso),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, recovery.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM initial_analysis_inventory_adapter_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'planning'
           AND attempts.status = 'pending' ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId, `d1://attempts/${attemptId}`,
        `analysis-inventory-adapter-recovery:${candidate.failure_id}`,
        nowIso, nowIso, recoveryId,
      ),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }

  private async scheduleToolBridgeRecovery(candidate: ToolBridgeCandidateRow): Promise<boolean> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      kind: 'initial_analysis_tipsy_sls_tool_bridge',
      providerPolicyVersion: TIPSY_SLS_PROVIDER_POLICY_VERSION,
      runId: candidate.run_id,
      adapterRecoveryId: candidate.adapter_recovery_id,
      blockerId: candidate.blocker_id,
      failureId: candidate.failure_id,
      failedAttemptId: candidate.failed_attempt_id,
      logsTraceId: candidate.logs_trace_id,
    });
    const suffix = stableSuffix(identity);
    const recoveryId = `initial_analysis_tool_bridge_${suffix}`;
    const retryId = `initial_analysis_retry_${suffix}`;
    const attemptId = `analysis_retry_${suffix}`;
    const outboxId = `dispatch_initial_analysis_retry_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO initial_analysis_tool_bridge_recoveries (
           recovery_id, run_id, adapter_recovery_id, blocker_id, failure_id,
           failed_attempt_id, logs_trace_id, replacement_attempt_id,
           provider_policy_version, created_at
         )
         SELECT ?, runs.run_id, adapter.recovery_id, blockers.blocker_id,
                failures.failure_id, failed.attempt_id, traces.trace_id, ?, ?, ?
         FROM runs
         JOIN attempts AS failed ON failed.attempt_id = ? AND failed.run_id = runs.run_id
         JOIN initial_analysis_inventory_adapter_recoveries AS adapter
           ON adapter.recovery_id = ? AND adapter.run_id = runs.run_id
          AND adapter.replacement_attempt_id = failed.attempt_id
         JOIN attempt_failures AS failures
           ON failures.failure_id = ? AND failures.attempt_id = failed.attempt_id
         JOIN run_blockers AS blockers
           ON blockers.blocker_id = ? AND blockers.run_id = runs.run_id
          AND blockers.resolved_at IS NULL
          AND blockers.retry_scope_digest = failures.retry_scope_digest
          AND blockers.fingerprint_digest = failures.fingerprint_digest
         JOIN tool_call_traces AS traces
           ON traces.trace_id = ? AND traces.attempt_id = failed.attempt_id
          AND traces.run_id = runs.run_id
         WHERE runs.run_id = ? AND runs.state = 'blocked'
           AND runs.active_plan_id IS NULL
           AND failed.mode = 'analysis' AND failed.status = 'failed'
           AND failures.failure_class = 'tool_error'
           AND failures.failure_code = 'tool_unavailable'
           AND failures.failure_site = 'tool_logs_search'
           AND failures.needed_human_input = 'resolve_external_dependency'
           AND blockers.reason IN ('external_dependency', 'attempt_limit')
           AND blockers.needed_human_input = 'resolve_external_dependency'
           AND traces.tool_path = 'logs/search' AND traces.action = 'logs:read'
           AND traces.effect = 'read' AND traces.result_category = 'upstream_error'
           AND (SELECT COUNT(*) FROM tool_call_traces WHERE attempt_id = failed.attempt_id) = 1
           AND EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
           AND EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM evidence WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         ON CONFLICT DO NOTHING`,
      ).bind(
        recoveryId, attemptId, TIPSY_SLS_PROVIDER_POLICY_VERSION, nowIso,
        candidate.failed_attempt_id, candidate.adapter_recovery_id,
        candidate.failure_id, candidate.blocker_id, candidate.logs_trace_id,
        candidate.run_id,
      ),
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT recovery.replacement_attempt_id, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'analysis', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, 0, 0, ?, ?
         FROM initial_analysis_tool_bridge_recoveries AS recovery
         JOIN attempts AS failed ON failed.attempt_id = recovery.failed_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'blocked'
           AND failed.status = 'failed' ON CONFLICT DO NOTHING`,
      ).bind(nowIso, nowIso, recoveryId),
      this.db.prepare(
        `INSERT INTO initial_analysis_retries (
           retry_id, run_id, failure_id, failed_attempt_id,
           retry_attempt_id, retry_sequence, created_at
         )
         SELECT ?, recovery.run_id, recovery.failure_id, recovery.failed_attempt_id,
                attempts.attempt_id, ?, ?
         FROM initial_analysis_tool_bridge_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
          AND attempts.status = 'pending'
         WHERE recovery.recovery_id = ? ON CONFLICT DO NOTHING`,
      ).bind(retryId, candidate.retry_sequence, nowIso, recoveryId),
      this.db.prepare(
        `UPDATE run_blockers SET resolved_at = ?,
             resolution_code = 'analysis_tipsy_sls_tool_bridge_v1'
         WHERE blocker_id = ? AND run_id = ? AND resolved_at IS NULL
           AND EXISTS (SELECT 1 FROM initial_analysis_retries
                       WHERE retry_id = ? AND retry_attempt_id = ?)`,
      ).bind(nowIso, candidate.blocker_id, candidate.run_id, retryId, attemptId),
      this.db.prepare(
        `UPDATE runs SET state = 'planning', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'blocked' AND active_plan_id IS NULL
           AND EXISTS (
             SELECT 1 FROM initial_analysis_tool_bridge_recoveries AS recovery
             JOIN run_blockers AS blocker ON blocker.blocker_id = recovery.blocker_id
             WHERE recovery.recovery_id = ? AND blocker.resolved_at = ?
               AND blocker.resolution_code = 'analysis_tipsy_sls_tool_bridge_v1'
           )`,
      ).bind(nowIso, candidate.run_id, recoveryId, nowIso),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, recovery.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM initial_analysis_tool_bridge_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'planning'
           AND attempts.status = 'pending' ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId, `d1://attempts/${attemptId}`,
        `analysis-tool-bridge-recovery:${candidate.failure_id}`,
        nowIso, nowIso, recoveryId,
      ),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }

  private async scheduleToolBridgeTransportRecovery(
    candidate: ToolBridgeTransportCandidateRow,
  ): Promise<boolean> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      kind: 'initial_analysis_tool_bridge_workerd_redirect_manual',
      transportPolicyVersion: TIPSY_SLS_TRANSPORT_POLICY_VERSION,
      runId: candidate.run_id,
      providerRecoveryId: candidate.provider_recovery_id,
      blockerId: candidate.blocker_id,
      failureId: candidate.failure_id,
      failedAttemptId: candidate.failed_attempt_id,
      logsTraceId: candidate.logs_trace_id,
    });
    const suffix = stableSuffix(identity);
    const recoveryId = `initial_analysis_tool_transport_${suffix}`;
    const retryId = `initial_analysis_retry_${suffix}`;
    const attemptId = `analysis_retry_${suffix}`;
    const outboxId = `dispatch_initial_analysis_retry_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO initial_analysis_tool_bridge_transport_recoveries (
           recovery_id, run_id, provider_recovery_id, blocker_id, failure_id,
           failed_attempt_id, logs_trace_id, replacement_attempt_id,
           transport_policy_version, created_at
         )
         SELECT ?, runs.run_id, provider.recovery_id, blockers.blocker_id,
                failures.failure_id, failed.attempt_id, traces.trace_id, ?, ?, ?
         FROM runs
         JOIN attempts AS failed ON failed.attempt_id = ? AND failed.run_id = runs.run_id
         JOIN initial_analysis_tool_bridge_recoveries AS provider
           ON provider.recovery_id = ? AND provider.run_id = runs.run_id
          AND provider.replacement_attempt_id = failed.attempt_id
          AND provider.provider_policy_version = ?
         JOIN attempt_failures AS failures
           ON failures.failure_id = ? AND failures.attempt_id = failed.attempt_id
         JOIN run_blockers AS blockers
           ON blockers.blocker_id = ? AND blockers.run_id = runs.run_id
          AND blockers.resolved_at IS NULL
          AND blockers.retry_scope_digest = failures.retry_scope_digest
          AND blockers.fingerprint_digest = failures.fingerprint_digest
         JOIN tool_call_traces AS traces
           ON traces.trace_id = ? AND traces.attempt_id = failed.attempt_id
          AND traces.run_id = runs.run_id
         WHERE runs.run_id = ? AND runs.state = 'blocked'
           AND runs.active_plan_id IS NULL
           AND failed.mode = 'analysis' AND failed.status = 'failed'
           AND failed.base_sha = runs.base_sha
           AND failures.failure_class = 'tool_error'
           AND failures.failure_code = 'tool_unavailable'
           AND failures.failure_site = 'tool_logs_search'
           AND failures.needed_human_input = 'resolve_external_dependency'
           AND blockers.reason IN ('external_dependency', 'attempt_limit', 'repeated_fingerprint')
           AND blockers.needed_human_input = 'resolve_external_dependency'
           AND traces.tool_path = 'logs/search' AND traces.action = 'logs:read'
           AND traces.effect = 'read' AND traces.result_category = 'upstream_error'
           AND (SELECT COUNT(*) FROM tool_call_traces WHERE attempt_id = failed.attempt_id) = 1
           AND EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
           AND EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM evidence WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         ON CONFLICT DO NOTHING`,
      ).bind(
        recoveryId, attemptId, TIPSY_SLS_TRANSPORT_POLICY_VERSION, nowIso,
        candidate.failed_attempt_id, candidate.provider_recovery_id,
        TIPSY_SLS_PROVIDER_POLICY_VERSION, candidate.failure_id,
        candidate.blocker_id, candidate.logs_trace_id, candidate.run_id,
      ),
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT recovery.replacement_attempt_id, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'analysis', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, 0, 0, ?, ?
         FROM initial_analysis_tool_bridge_transport_recoveries AS recovery
         JOIN attempts AS failed ON failed.attempt_id = recovery.failed_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'blocked'
           AND failed.status = 'failed' ON CONFLICT DO NOTHING`,
      ).bind(nowIso, nowIso, recoveryId),
      this.db.prepare(
        `INSERT INTO initial_analysis_retries (
           retry_id, run_id, failure_id, failed_attempt_id,
           retry_attempt_id, retry_sequence, created_at
         )
         SELECT ?, recovery.run_id, recovery.failure_id, recovery.failed_attempt_id,
                attempts.attempt_id, ?, ?
         FROM initial_analysis_tool_bridge_transport_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
          AND attempts.status = 'pending'
         WHERE recovery.recovery_id = ? ON CONFLICT DO NOTHING`,
      ).bind(retryId, candidate.retry_sequence, nowIso, recoveryId),
      this.db.prepare(
        `UPDATE run_blockers SET resolved_at = ?,
             resolution_code = 'analysis_tool_bridge_workerd_redirect_manual_v2'
         WHERE blocker_id = ? AND run_id = ? AND resolved_at IS NULL
           AND EXISTS (SELECT 1 FROM initial_analysis_retries
                       WHERE retry_id = ? AND retry_attempt_id = ?)`,
      ).bind(nowIso, candidate.blocker_id, candidate.run_id, retryId, attemptId),
      this.db.prepare(
        `UPDATE runs SET state = 'planning', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'blocked' AND active_plan_id IS NULL
           AND EXISTS (
             SELECT 1 FROM initial_analysis_tool_bridge_transport_recoveries AS recovery
             JOIN run_blockers AS blocker ON blocker.blocker_id = recovery.blocker_id
             WHERE recovery.recovery_id = ? AND blocker.resolved_at = ?
               AND blocker.resolution_code = 'analysis_tool_bridge_workerd_redirect_manual_v2'
           )`,
      ).bind(nowIso, candidate.run_id, recoveryId, nowIso),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, recovery.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM initial_analysis_tool_bridge_transport_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'planning'
           AND attempts.status = 'pending' ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId, `d1://attempts/${attemptId}`,
        `analysis-tool-transport-recovery:${candidate.failure_id}`,
        nowIso, nowIso, recoveryId,
      ),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }

  private async scheduleToolBridgeScopeRecovery(
    candidate: ToolBridgeScopeCandidateRow,
  ): Promise<boolean> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      kind: 'initial_analysis_tool_bridge_tipsy_namespace_scope',
      credentialPolicyVersion: TIPSY_SLS_CREDENTIAL_POLICY_VERSION,
      runId: candidate.run_id,
      transportRecoveryId: candidate.transport_recovery_id,
      blockerId: candidate.blocker_id,
      failureId: candidate.failure_id,
      failedAttemptId: candidate.failed_attempt_id,
      logsTraceId: candidate.logs_trace_id,
    });
    const suffix = stableSuffix(identity);
    const recoveryId = `initial_analysis_tool_scope_${suffix}`;
    const retryId = `initial_analysis_retry_${suffix}`;
    const attemptId = `analysis_retry_${suffix}`;
    const outboxId = `dispatch_initial_analysis_retry_${suffix}`;
    const nowIso = this.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO initial_analysis_tool_bridge_scope_recoveries (
           recovery_id, run_id, transport_recovery_id, blocker_id, failure_id,
           failed_attempt_id, logs_trace_id, replacement_attempt_id,
           credential_policy_version, created_at
         )
         SELECT ?, runs.run_id, transport.recovery_id, blockers.blocker_id,
                failures.failure_id, failed.attempt_id, traces.trace_id, ?, ?, ?
         FROM runs
         JOIN attempts AS failed ON failed.attempt_id = ? AND failed.run_id = runs.run_id
         JOIN initial_analysis_tool_bridge_transport_recoveries AS transport
           ON transport.recovery_id = ? AND transport.run_id = runs.run_id
          AND transport.replacement_attempt_id = failed.attempt_id
          AND transport.transport_policy_version = ?
         JOIN attempt_failures AS failures
           ON failures.failure_id = ? AND failures.attempt_id = failed.attempt_id
         JOIN run_blockers AS blockers
           ON blockers.blocker_id = ? AND blockers.run_id = runs.run_id
          AND blockers.resolved_at IS NULL
          AND blockers.retry_scope_digest = failures.retry_scope_digest
          AND blockers.fingerprint_digest = failures.fingerprint_digest
         JOIN tool_call_traces AS traces
           ON traces.trace_id = ? AND traces.attempt_id = failed.attempt_id
          AND traces.run_id = runs.run_id
         WHERE runs.run_id = ? AND runs.state = 'blocked'
           AND runs.active_plan_id IS NULL
           AND failed.mode = 'analysis' AND failed.status = 'failed'
           AND failed.base_sha = runs.base_sha
           AND failures.failure_class = 'tool_error'
           AND failures.failure_code = 'tool_unavailable'
           AND failures.failure_site = 'tool_logs_search'
           AND failures.needed_human_input = 'resolve_external_dependency'
           AND blockers.reason IN ('external_dependency', 'attempt_limit', 'repeated_fingerprint')
           AND blockers.needed_human_input = 'resolve_external_dependency'
           AND traces.tool_path = 'logs/search' AND traces.action = 'logs:read'
           AND traces.effect = 'read' AND traces.result_category = 'upstream_error'
           AND (SELECT COUNT(*) FROM tool_call_traces WHERE attempt_id = failed.attempt_id) = 1
           AND EXISTS (SELECT 1 FROM quota_model_reservations WHERE attempt_id = failed.attempt_id)
           AND EXISTS (SELECT 1 FROM model_usage WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM evidence WHERE attempt_id = failed.attempt_id)
           AND NOT EXISTS (SELECT 1 FROM execution_plans WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM plan_revisions WHERE run_id = runs.run_id)
           AND NOT EXISTS (SELECT 1 FROM automated_reviews WHERE run_id = runs.run_id)
         ON CONFLICT DO NOTHING`,
      ).bind(
        recoveryId, attemptId, TIPSY_SLS_CREDENTIAL_POLICY_VERSION, nowIso,
        candidate.failed_attempt_id, candidate.transport_recovery_id,
        TIPSY_SLS_TRANSPORT_POLICY_VERSION, candidate.failure_id,
        candidate.blocker_id, candidate.logs_trace_id, candidate.run_id,
      ),
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT recovery.replacement_attempt_id, failed.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = failed.run_id),
                'analysis', 'pending', failed.base_sha, failed.repository,
                failed.workflow_ref, 0, 0, ?, ?
         FROM initial_analysis_tool_bridge_scope_recoveries AS recovery
         JOIN attempts AS failed ON failed.attempt_id = recovery.failed_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'blocked'
           AND failed.status = 'failed' ON CONFLICT DO NOTHING`,
      ).bind(nowIso, nowIso, recoveryId),
      this.db.prepare(
        `INSERT INTO initial_analysis_retries (
           retry_id, run_id, failure_id, failed_attempt_id,
           retry_attempt_id, retry_sequence, created_at
         )
         SELECT ?, recovery.run_id, recovery.failure_id, recovery.failed_attempt_id,
                attempts.attempt_id, ?, ?
         FROM initial_analysis_tool_bridge_scope_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
          AND attempts.status = 'pending'
         WHERE recovery.recovery_id = ? ON CONFLICT DO NOTHING`,
      ).bind(retryId, candidate.retry_sequence, nowIso, recoveryId),
      this.db.prepare(
        `UPDATE run_blockers SET resolved_at = ?,
             resolution_code = 'analysis_tool_bridge_tipsy_namespace_scope_v3'
         WHERE blocker_id = ? AND run_id = ? AND resolved_at IS NULL
           AND EXISTS (SELECT 1 FROM initial_analysis_retries
                       WHERE retry_id = ? AND retry_attempt_id = ?)`,
      ).bind(nowIso, candidate.blocker_id, candidate.run_id, retryId, attemptId),
      this.db.prepare(
        `UPDATE runs SET state = 'planning', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'blocked' AND active_plan_id IS NULL
           AND EXISTS (
             SELECT 1 FROM initial_analysis_tool_bridge_scope_recoveries AS recovery
             JOIN run_blockers AS blocker ON blocker.blocker_id = recovery.blocker_id
             WHERE recovery.recovery_id = ? AND blocker.resolved_at = ?
               AND blocker.resolution_code = 'analysis_tool_bridge_tipsy_namespace_scope_v3'
           )`,
      ).bind(nowIso, candidate.run_id, recoveryId, nowIso),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, recovery.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM initial_analysis_tool_bridge_scope_recoveries AS recovery
         JOIN attempts ON attempts.attempt_id = recovery.replacement_attempt_id
         JOIN runs ON runs.run_id = recovery.run_id
         WHERE recovery.recovery_id = ? AND runs.state = 'planning'
           AND attempts.status = 'pending' ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId, `d1://attempts/${attemptId}`,
        `analysis-tool-scope-recovery:${candidate.failure_id}`,
        nowIso, nowIso, recoveryId,
      ),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }
}
