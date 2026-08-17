import { canonicalSha256 } from '../domain/digest.js';
import { assertExecutionFact } from '../executor/core/executor-registry.js';
import type { ExecutorPluginRegistry } from '../executor/core/executor-registry.js';
import type {
  ExecutionFact,
  ExecutionHandle,
  ExecutorStatus,
} from '../executor/core/executor-plugin.js';

export type ExecutorObservationIgnoreReason =
  | 'stale_external_fact'
  | 'status_regression'
  | 'terminal_conflict';

export type ExecutorObservationDisposition = 'applied' | 'duplicate' | 'ignored';

export interface RecordExecutorObservationInput {
  fact: ExecutionFact;
  observedAt: string;
}

export interface ExecutorObservationResult {
  disposition: ExecutorObservationDisposition;
  executionId: string;
  sequence: number;
  status: ExecutorStatus;
  factDigest: string;
  reason: ExecutorObservationIgnoreReason | null;
}

export class ExecutorObservationError extends Error {
  constructor(
    readonly code:
      | 'execution_not_found'
      | 'execution_not_observable'
      | 'execution_binding_conflict'
      | 'observation_invalid'
      | 'projection_conflict',
  ) {
    super(`Executor observation failed: ${code}`);
    this.name = 'ExecutorObservationError';
  }
}

interface ExecutionInstanceRow {
  execution_id: string;
  attempt_id: string;
  lease_generation: number;
  executor_profile_id: string;
  provider_kind: string;
  status: ExecutionInstanceStatus;
  provider_external_id: string | null;
  validated_handle_json: string | null;
  observation_sequence: number;
  external_updated_at: string | null;
}

interface ObservationRow {
  sequence: number;
  status: ExecutorStatus;
  fact_digest: string;
}

type ExecutionInstanceStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const TERMINAL_STATUSES = new Set<ExecutionInstanceStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'lost',
]);

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function projectedStatus(status: ExecutorStatus): ExecutionInstanceStatus {
  if (status === 'requested' || status === 'queued') return 'starting';
  return status;
}

function transitionReason(
  current: ExecutionInstanceStatus,
  incoming: ExecutorStatus,
): ExecutorObservationIgnoreReason | null {
  const projected = projectedStatus(incoming);
  if (TERMINAL_STATUSES.has(current)) {
    return current === projected ? null : 'terminal_conflict';
  }
  if (current === 'running' && projected === 'starting') return 'status_regression';
  return null;
}

function bindingMatches(row: ExecutionInstanceRow, fact: ExecutionFact): boolean {
  return (
    row.execution_id === fact.executionId &&
    row.attempt_id === fact.attemptId &&
    row.lease_generation === fact.leaseGeneration &&
    row.executor_profile_id === fact.profileId &&
    row.provider_kind === fact.kind &&
    row.provider_external_id === fact.externalId
  );
}

function observationId(factDigest: string): string {
  return `executor_observation_${factDigest.slice('sha256:'.length)}`;
}

/**
 * Immutable provider-fact ledger and monotonic execution-instance projector.
 * It deliberately does not complete/fail the Attempt: semantic runner result
 * ingestion and provider lifecycle observations remain separate authorities.
 */
export class ExecutorObservationStore {
  constructor(private readonly db: D1Database) {}

  async record(input: RecordExecutorObservationInput): Promise<ExecutorObservationResult> {
    try {
      assertExecutionFact(input.fact);
    } catch {
      throw new ExecutorObservationError('observation_invalid');
    }
    if (!validTimestamp(input.observedAt)) {
      throw new ExecutorObservationError('observation_invalid');
    }
    const factDigest = await canonicalSha256(input.fact);
    const row = await this.execution(input.fact.executionId);
    if (
      row.status === 'pending' ||
      row.provider_external_id === null ||
      row.validated_handle_json === null
    ) {
      throw new ExecutorObservationError('execution_not_observable');
    }
    if (!bindingMatches(row, input.fact)) {
      throw new ExecutorObservationError('execution_binding_conflict');
    }

    const existing = await this.observationByDigest(row.execution_id, factDigest);
    if (existing !== null) {
      return this.result('duplicate', row.execution_id, existing, null);
    }
    if (
      row.external_updated_at !== null &&
      Date.parse(input.fact.externalUpdatedAt) <= Date.parse(row.external_updated_at)
    ) {
      return {
        disposition: 'ignored',
        executionId: row.execution_id,
        sequence: row.observation_sequence,
        status: input.fact.status,
        factDigest,
        reason: 'stale_external_fact',
      };
    }
    const ignoredReason = transitionReason(row.status, input.fact.status);
    if (ignoredReason !== null) {
      return {
        disposition: 'ignored',
        executionId: row.execution_id,
        sequence: row.observation_sequence,
        status: input.fact.status,
        factDigest,
        reason: ignoredReason,
      };
    }

    const nextSequence = row.observation_sequence + 1;
    const nextStatus = projectedStatus(input.fact.status);
    const id = observationId(factDigest);
    const factsJson = JSON.stringify(input.fact.facts);
    const terminalAt = TERMINAL_STATUSES.has(nextStatus)
      ? input.fact.externalUpdatedAt
      : null;
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO executor_observations (
           observation_id, execution_id, sequence, status, fact_digest,
           external_updated_at, facts_json, observed_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM attempt_execution_instances
           WHERE execution_id = ? AND attempt_id = ? AND lease_generation = ?
             AND executor_profile_id = ? AND provider_kind = ?
             AND provider_external_id = ? AND validated_handle_json IS NOT NULL
             AND status = ? AND observation_sequence = ?
             AND external_updated_at IS ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        id,
        row.execution_id,
        nextSequence,
        input.fact.status,
        factDigest,
        input.fact.externalUpdatedAt,
        factsJson,
        input.observedAt,
        row.execution_id,
        row.attempt_id,
        row.lease_generation,
        row.executor_profile_id,
        row.provider_kind,
        row.provider_external_id,
        row.status,
        row.observation_sequence,
        row.external_updated_at,
      ),
      this.db.prepare(
        `UPDATE attempt_execution_instances
         SET status = ?, observation_sequence = ?, external_updated_at = ?,
             terminal_at = CASE WHEN ? IS NULL THEN terminal_at
                                ELSE COALESCE(terminal_at, ?) END,
             updated_at = ?
         WHERE execution_id = ? AND status = ? AND observation_sequence = ?
           AND external_updated_at IS ?
           AND EXISTS (
             SELECT 1 FROM executor_observations
             WHERE observation_id = ? AND execution_id = ? AND sequence = ?
               AND fact_digest = ?
           )`,
      ).bind(
        nextStatus,
        nextSequence,
        input.fact.externalUpdatedAt,
        terminalAt,
        terminalAt,
        input.observedAt,
        row.execution_id,
        row.status,
        row.observation_sequence,
        row.external_updated_at,
        id,
        row.execution_id,
        nextSequence,
        factDigest,
      ),
    ]);
    if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
      return {
        disposition: 'applied',
        executionId: row.execution_id,
        sequence: nextSequence,
        status: input.fact.status,
        factDigest,
        reason: null,
      };
    }

    const racedObservation = await this.observationByDigest(row.execution_id, factDigest);
    if (racedObservation !== null) {
      return this.result('duplicate', row.execution_id, racedObservation, null);
    }
    const current = await this.execution(row.execution_id);
    if (
      current.external_updated_at !== null &&
      Date.parse(input.fact.externalUpdatedAt) <= Date.parse(current.external_updated_at)
    ) {
      return {
        disposition: 'ignored',
        executionId: row.execution_id,
        sequence: current.observation_sequence,
        status: input.fact.status,
        factDigest,
        reason: 'stale_external_fact',
      };
    }
    throw new ExecutorObservationError('projection_conflict');
  }

  private async execution(executionId: string): Promise<ExecutionInstanceRow> {
    const row = await this.db.prepare(
      `SELECT execution_id, attempt_id, lease_generation, executor_profile_id,
              provider_kind, status, provider_external_id, validated_handle_json,
              observation_sequence, external_updated_at
       FROM attempt_execution_instances WHERE execution_id = ?`,
    ).bind(executionId).first<ExecutionInstanceRow>();
    if (row === null) throw new ExecutorObservationError('execution_not_found');
    return row;
  }

  private async observationByDigest(
    executionId: string,
    factDigest: string,
  ): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT sequence, status, fact_digest
       FROM executor_observations
       WHERE execution_id = ? AND fact_digest = ?`,
    ).bind(executionId, factDigest).first<ObservationRow>();
  }

  private result(
    disposition: 'duplicate',
    executionId: string,
    observation: ObservationRow,
    reason: null,
  ): ExecutorObservationResult {
    return {
      disposition,
      executionId,
      sequence: observation.sequence,
      status: observation.status,
      factDigest: observation.fact_digest,
      reason,
    };
  }
}

export interface ExecutorObservationServiceOptions {
  now?: () => Date;
}

/** Loads the immutable provider handle, observes through the selected plugin, and records it. */
export class ExecutorObservationService {
  private readonly now: () => Date;
  private readonly store: ExecutorObservationStore;

  constructor(
    private readonly db: D1Database,
    private readonly plugins: ExecutorPluginRegistry,
    options: ExecutorObservationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = new ExecutorObservationStore(db);
  }

  async observe(executionId: string): Promise<ExecutorObservationResult> {
    if (!ID_PATTERN.test(executionId)) {
      throw new ExecutorObservationError('execution_not_found');
    }
    const row = await this.db.prepare(
      `SELECT validated_handle_json
       FROM attempt_execution_instances WHERE execution_id = ?`,
    ).bind(executionId).first<{ validated_handle_json: string | null }>();
    if (row === null) throw new ExecutorObservationError('execution_not_found');
    if (row.validated_handle_json === null) {
      throw new ExecutorObservationError('execution_not_observable');
    }
    let handle: ExecutionHandle;
    try {
      handle = JSON.parse(row.validated_handle_json) as ExecutionHandle;
    } catch {
      throw new ExecutorObservationError('execution_binding_conflict');
    }
    const fact = await this.plugins.observe(handle);
    return await this.store.record({
      fact,
      observedAt: this.now().toISOString(),
    });
  }
}
