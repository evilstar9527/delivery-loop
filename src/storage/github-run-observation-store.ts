export const DELIVERY_AGENT_WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';

export type GitHubWorkflowRunStatus =
  | 'requested'
  | 'queued'
  | 'waiting'
  | 'in_progress'
  | 'completed';

export interface GitHubWorkflowRunFact {
  repository: string;
  githubRunId: string;
  event: 'workflow_dispatch' | 'push' | 'pull_request' | 'deployment';
  status: GitHubWorkflowRunStatus;
  conclusion: string | null;
  headSha: string;
  headBranch: string;
  workflowPath: string;
  displayTitle: string;
  runAttempt: number;
  externalUpdatedAt: string;
}

export interface GitHubWebhookDelivery {
  deliveryId: string;
  payloadDigest: string;
  fact: GitHubWorkflowRunFact;
  receivedAt: string;
}

export type GitHubObservationDisposition = 'applied' | 'duplicate' | 'ignored';
export type GitHubDeliveryDisposition = GitHubObservationDisposition;

export interface GitHubApiObservation {
  observationId: string;
  factDigest: string;
  fact: GitHubWorkflowRunFact;
  observedAt: string;
}

type GitHubRunObservationErrorCode = 'delivery_conflict' | 'observation_conflict';

export class GitHubRunObservationError extends Error {
  constructor(readonly code: GitHubRunObservationErrorCode) {
    super(`GitHub run observation failed: ${code}`);
    this.name = 'GitHubRunObservationError';
  }
}

interface DeliveryRow {
  payload_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface ApiObservationRow {
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface AttemptRow {
  attempt_id: string;
  repository: string | null;
  workflow_ref: string | null;
  github_run_id: string | null;
  github_head_sha: string | null;
  github_status: string | null;
  github_conclusion: string | null;
  github_external_updated_at: string | null;
  github_observation_version: number;
}

function workflowPathMatches(path: string, branch: string): boolean {
  return (
    path === DELIVERY_AGENT_WORKFLOW_PATH ||
    path === `${DELIVERY_AGENT_WORKFLOW_PATH}@refs/heads/${branch}`
  );
}

function bindingMatches(attempt: AttemptRow, fact: GitHubWorkflowRunFact): boolean {
  return (
    fact.event === 'workflow_dispatch' &&
    attempt.repository === fact.repository &&
    attempt.github_run_id === fact.githubRunId &&
    attempt.workflow_ref ===
      `${fact.repository}/${DELIVERY_AGENT_WORKFLOW_PATH}@refs/heads/${fact.headBranch}` &&
    workflowPathMatches(fact.workflowPath, fact.headBranch) &&
    attempt.github_head_sha === fact.headSha &&
    fact.displayTitle === `delivery-loop/${attempt.attempt_id}` &&
    fact.runAttempt === 1
  );
}

function isNewerObservation(current: string | null, incoming: string): boolean {
  const incomingTime = Date.parse(incoming);
  const currentTime = current === null ? Number.NEGATIVE_INFINITY : Date.parse(current);
  return Number.isFinite(incomingTime) && incomingTime > currentTime;
}

function factAlreadyProjected(attempt: AttemptRow, fact: GitHubWorkflowRunFact): boolean {
  return (
    attempt.github_status === fact.status &&
    attempt.github_conclusion === fact.conclusion &&
    attempt.github_external_updated_at === fact.externalUpdatedAt
  );
}

interface ProjectionResult {
  disposition: 'applied' | 'ignored';
  attemptId: string | null;
  reason: string | null;
}

/**
 * Projects signed GitHub external facts without modifying Attempt heartbeat/version fencing.
 * Delivery identity and GitHub's updated_at independently prevent replay and state regression.
 */
export class GitHubRunObservationStore {
  constructor(private readonly db: D1Database) {}

  async apply(delivery: GitHubWebhookDelivery): Promise<GitHubDeliveryDisposition> {
    const existing = await this.db
      .prepare(
        `SELECT payload_digest, processing_state
         FROM github_webhook_deliveries WHERE delivery_id = ?`,
      )
      .bind(delivery.deliveryId)
      .first<DeliveryRow>();
    if (existing !== null) {
      if (existing.payload_digest !== delivery.payloadDigest) {
        throw new GitHubRunObservationError('delivery_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    }

    if (existing === null) {
      await this.db
        .prepare(
          `INSERT INTO github_webhook_deliveries (
             delivery_id, event_type, payload_digest, repository, github_run_id,
             processing_state, external_updated_at, received_at
           ) VALUES (?, 'workflow_run', ?, ?, ?, 'received', ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          delivery.deliveryId,
          delivery.payloadDigest,
          delivery.fact.repository,
          delivery.fact.githubRunId,
          delivery.fact.externalUpdatedAt,
          delivery.receivedAt,
        )
        .run();
      const persisted = await this.delivery(delivery.deliveryId);
      if (persisted.payload_digest !== delivery.payloadDigest) {
        throw new GitHubRunObservationError('delivery_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }

    const projection = await this.projectFact(delivery.fact, delivery.receivedAt);
    await this.finalizeWebhook(delivery, projection);
    return projection.disposition;
  }

  async applyApiObservation(
    observation: GitHubApiObservation,
  ): Promise<GitHubObservationDisposition> {
    const existing = await this.db
      .prepare(
        `SELECT fact_digest, processing_state
         FROM github_api_observations WHERE observation_id = ?`,
      )
      .bind(observation.observationId)
      .first<ApiObservationRow>();
    if (existing !== null) {
      if (existing.fact_digest !== observation.factDigest) {
        throw new GitHubRunObservationError('observation_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    }
    if (existing === null) {
      await this.db
        .prepare(
          `INSERT INTO github_api_observations (
             observation_id, fact_digest, repository, github_run_id,
             processing_state, external_updated_at, observed_at
           ) VALUES (?, ?, ?, ?, 'received', ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          observation.observationId,
          observation.factDigest,
          observation.fact.repository,
          observation.fact.githubRunId,
          observation.fact.externalUpdatedAt,
          observation.observedAt,
        )
        .run();
      const persisted = await this.apiObservation(observation.observationId);
      if (persisted.fact_digest !== observation.factDigest) {
        throw new GitHubRunObservationError('observation_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }
    const projection = await this.projectFact(observation.fact, observation.observedAt);
    await this.finalizeApiObservation(observation, projection);
    return projection.disposition;
  }

  private async delivery(deliveryId: string): Promise<DeliveryRow> {
    const row = await this.db
      .prepare(
        `SELECT payload_digest, processing_state
         FROM github_webhook_deliveries WHERE delivery_id = ?`,
      )
      .bind(deliveryId)
      .first<DeliveryRow>();
    if (row === null) throw new GitHubRunObservationError('delivery_conflict');
    return row;
  }

  private async apiObservation(observationId: string): Promise<ApiObservationRow> {
    const row = await this.db
      .prepare(
        `SELECT fact_digest, processing_state
         FROM github_api_observations WHERE observation_id = ?`,
      )
      .bind(observationId)
      .first<ApiObservationRow>();
    if (row === null) throw new GitHubRunObservationError('observation_conflict');
    return row;
  }

  private async projectFact(
    fact: GitHubWorkflowRunFact,
    observedAt: string,
  ): Promise<ProjectionResult> {
    const attempt = await this.db
      .prepare(
        `SELECT attempt_id, repository, workflow_ref, github_run_id,
                github_head_sha,
                github_status, github_conclusion, github_external_updated_at,
                github_observation_version
         FROM attempts WHERE github_run_id = ?`,
      )
      .bind(fact.githubRunId)
      .first<AttemptRow>();
    if (attempt === null || !bindingMatches(attempt, fact)) {
      return { disposition: 'ignored', attemptId: null, reason: 'binding_mismatch' };
    }
    if (factAlreadyProjected(attempt, fact)) {
      return { disposition: 'applied', attemptId: attempt.attempt_id, reason: null };
    }
    if (!isNewerObservation(attempt.github_external_updated_at, fact.externalUpdatedAt)) {
      return {
        disposition: 'ignored',
        attemptId: attempt.attempt_id,
        reason: 'stale_external_fact',
      };
    }
    const result = await this.db
      .prepare(
        `UPDATE attempts
         SET github_status = ?, github_conclusion = ?, github_observed_at = ?,
             github_external_updated_at = ?,
             github_observation_version = github_observation_version + 1
         WHERE attempt_id = ?
           AND repository = ?
           AND workflow_ref = ?
           AND github_head_sha = ?
           AND github_run_id = ?
           AND github_observation_version = ?
           AND github_external_updated_at IS ?`,
      )
      .bind(
        fact.status,
        fact.conclusion,
        observedAt,
        fact.externalUpdatedAt,
        attempt.attempt_id,
        fact.repository,
        `${fact.repository}/${DELIVERY_AGENT_WORKFLOW_PATH}@refs/heads/${fact.headBranch}`,
        fact.headSha,
        fact.githubRunId,
        attempt.github_observation_version,
        attempt.github_external_updated_at,
      )
      .run();
    if (result.meta.changes === 1) {
      return { disposition: 'applied', attemptId: attempt.attempt_id, reason: null };
    }
    const current = await this.db
      .prepare(
        `SELECT attempt_id, repository, workflow_ref, github_run_id,
                github_head_sha,
                github_status, github_conclusion, github_external_updated_at,
                github_observation_version
         FROM attempts WHERE attempt_id = ?`,
      )
      .bind(attempt.attempt_id)
      .first<AttemptRow>();
    if (current !== null && factAlreadyProjected(current, fact)) {
      return { disposition: 'applied', attemptId: attempt.attempt_id, reason: null };
    }
    return { disposition: 'ignored', attemptId: attempt.attempt_id, reason: 'observation_race' };
  }

  private async finalizeWebhook(
    delivery: GitHubWebhookDelivery,
    projection: ProjectionResult,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_webhook_deliveries
         SET processing_state = ?, attempt_id = ?, ignore_reason = ?, processed_at = ?
         WHERE delivery_id = ? AND payload_digest = ? AND processing_state = 'received'`,
      )
      .bind(
        projection.disposition,
        projection.attemptId,
        projection.reason,
        delivery.receivedAt,
        delivery.deliveryId,
        delivery.payloadDigest,
      )
      .run();
  }

  private async finalizeApiObservation(
    observation: GitHubApiObservation,
    projection: ProjectionResult,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_api_observations
         SET processing_state = ?, attempt_id = ?, ignore_reason = ?, processed_at = ?
         WHERE observation_id = ? AND fact_digest = ? AND processing_state = 'received'`,
      )
      .bind(
        projection.disposition,
        projection.attemptId,
        projection.reason,
        observation.observedAt,
        observation.observationId,
        observation.factDigest,
      )
      .run();
  }
}
