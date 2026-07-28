import { canonicalSha256 } from '../domain/digest.js';
import {
  pullRequestFactMatches,
  type GitHubPullRequestFact,
  type GitHubPullRequestRequest,
} from '../outbox/github-pull-request.js';

export interface GitHubPullRequestWebhookDelivery {
  deliveryId: string;
  payloadDigest: string;
  fact: GitHubPullRequestFact;
  receivedAt: string;
}

export interface GitHubPullRequestApiObservation {
  observationId: string;
  factDigest: string;
  fact: GitHubPullRequestFact;
  observedAt: string;
}

export type GitHubPullRequestObservationDisposition = 'applied' | 'duplicate' | 'ignored';

export type GitHubPullRequestObservationErrorCode =
  | 'delivery_conflict'
  | 'observation_conflict';

export class GitHubPullRequestObservationError extends Error {
  constructor(readonly code: GitHubPullRequestObservationErrorCode) {
    super(`GitHub pull request observation failed: ${code}`);
    this.name = 'GitHubPullRequestObservationError';
  }
}

interface ExistingRow {
  digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface PublicationProjectionRow {
  publication_id: string;
  run_id: string;
  run_version: number;
  repository: string;
  base_branch: string;
  head_branch: string;
  head_sha: string;
  title: string;
  body_digest: string;
  status: 'pending' | 'created_unverified' | 'verified';
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_external_updated_at: string | null;
  github_observation_version: number;
  evidence_id: string | null;
  body: string;
  draft_run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  attempt_id: string;
  run_state: string;
  current_run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_status: string;
}

interface ProjectionResult {
  disposition: 'applied' | 'ignored';
  publicationId: string | null;
  reason: string | null;
}

function validObservationTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function factAlreadyProjected(
  publication: PublicationProjectionRow,
  fact: GitHubPullRequestFact,
): boolean {
  return (
    publication.status === 'verified' &&
    publication.github_pr_number === fact.number &&
    publication.github_pr_url === fact.url &&
    publication.github_external_updated_at === fact.externalUpdatedAt &&
    publication.evidence_id !== null
  );
}

/** Signed webhook and REST reconciliation share one exact-fact projector. */
export class GitHubPullRequestObservationStore {
  constructor(private readonly db: D1Database) {}

  async applyWebhook(
    delivery: GitHubPullRequestWebhookDelivery,
  ): Promise<GitHubPullRequestObservationDisposition> {
    const existing = await this.webhookDelivery(delivery.deliveryId);
    if (existing !== null) {
      if (existing.digest !== delivery.payloadDigest) {
        throw new GitHubPullRequestObservationError('delivery_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    }
    if (existing === null) {
      await this.db.prepare(
        `INSERT INTO github_pull_request_webhook_deliveries (
           delivery_id, event_type, payload_digest, repository, github_pr_number,
           processing_state, external_updated_at, received_at
         ) VALUES (?, 'pull_request', ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        delivery.deliveryId,
        delivery.payloadDigest,
        delivery.fact.repository,
        delivery.fact.number,
        delivery.fact.externalUpdatedAt,
        delivery.receivedAt,
      ).run();
      const persisted = await this.webhookDelivery(delivery.deliveryId);
      if (persisted === null || persisted.digest !== delivery.payloadDigest) {
        throw new GitHubPullRequestObservationError('delivery_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }
    const projection = await this.project(delivery.fact, delivery.receivedAt);
    await this.db.prepare(
      `UPDATE github_pull_request_webhook_deliveries
       SET processing_state = ?, publication_id = ?, ignore_reason = ?, processed_at = ?
       WHERE delivery_id = ? AND payload_digest = ? AND processing_state = 'received'`,
    ).bind(
      projection.disposition,
      projection.publicationId,
      projection.reason,
      delivery.receivedAt,
      delivery.deliveryId,
      delivery.payloadDigest,
    ).run();
    return projection.disposition;
  }

  async applyApiObservation(
    observation: GitHubPullRequestApiObservation,
  ): Promise<GitHubPullRequestObservationDisposition> {
    const existing = await this.apiObservation(observation.observationId);
    if (existing !== null) {
      if (existing.digest !== observation.factDigest) {
        throw new GitHubPullRequestObservationError('observation_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    }
    if (existing === null) {
      await this.db.prepare(
        `INSERT INTO github_pull_request_api_observations (
           observation_id, fact_digest, repository, github_pr_number,
           processing_state, external_updated_at, observed_at
         ) VALUES (?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        observation.observationId,
        observation.factDigest,
        observation.fact.repository,
        observation.fact.number,
        observation.fact.externalUpdatedAt,
        observation.observedAt,
      ).run();
      const persisted = await this.apiObservation(observation.observationId);
      if (persisted === null || persisted.digest !== observation.factDigest) {
        throw new GitHubPullRequestObservationError('observation_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }
    const projection = await this.project(observation.fact, observation.observedAt);
    await this.db.prepare(
      `UPDATE github_pull_request_api_observations
       SET processing_state = ?, publication_id = ?, ignore_reason = ?, processed_at = ?
       WHERE observation_id = ? AND fact_digest = ? AND processing_state = 'received'`,
    ).bind(
      projection.disposition,
      projection.publicationId,
      projection.reason,
      observation.observedAt,
      observation.observationId,
      observation.factDigest,
    ).run();
    return projection.disposition;
  }

  private async project(fact: GitHubPullRequestFact, observedAt: string): Promise<ProjectionResult> {
    if (!validObservationTime(observedAt)) {
      return { disposition: 'ignored', publicationId: null, reason: 'observation_time_invalid' };
    }
    const publication = await this.candidate(fact.repository, fact.headBranch);
    if (publication === null) {
      return { disposition: 'ignored', publicationId: null, reason: 'binding_mismatch' };
    }
    if (factAlreadyProjected(publication, fact)) {
      return { disposition: 'applied', publicationId: publication.publication_id, reason: null };
    }
    const request: GitHubPullRequestRequest = {
      repository: publication.repository,
      title: publication.title,
      body: publication.body,
      bodyDigest: publication.body_digest,
      headBranch: publication.head_branch,
      headSha: publication.head_sha,
      baseBranch: publication.base_branch,
    };
    if (
      !pullRequestFactMatches(fact, request) ||
      (publication.github_pr_number !== null && publication.github_pr_number !== fact.number) ||
      publication.draft_run_version !== publication.run_version ||
      publication.run_state !== 'verifying' ||
      publication.current_run_version !== publication.run_version ||
      publication.active_plan_id !== publication.plan_id ||
      publication.active_plan_version !== publication.plan_version ||
      publication.active_plan_digest !== publication.plan_digest ||
      publication.plan_status !== 'active'
    ) {
      return {
        disposition: 'ignored',
        publicationId: publication.publication_id,
        reason: 'binding_mismatch',
      };
    }
    const incomingTime = Date.parse(fact.externalUpdatedAt);
    const currentTime = publication.github_external_updated_at === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(publication.github_external_updated_at);
    if (!Number.isFinite(incomingTime) || incomingTime <= currentTime) {
      return {
        disposition: 'ignored',
        publicationId: publication.publication_id,
        reason: 'stale_external_fact',
      };
    }
    const evidenceDigest = await canonicalSha256({
      publicationId: publication.publication_id,
      repository: fact.repository,
      number: fact.number,
      headSha: fact.headSha,
      bodyDigest: fact.bodyDigest,
    });
    const evidenceId = `evidence_pr_${evidenceDigest.slice('sha256:'.length, 'sha256:'.length + 52)}`;
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version,
           kind, status, sha, external_url, artifact_ref, artifact_digest,
           summary, verification_status, observed_at, created_at
         )
         SELECT ?, pull_request_publications.run_id, pull_request_drafts.attempt_id,
                pull_request_drafts.plan_id, pull_request_drafts.plan_version,
                'pull_request', 'passed', pull_request_publications.head_sha, ?,
                ?, pull_request_publications.body_digest,
                'GitHub externally verified the Draft PR.', 'verified', ?, ?
         FROM pull_request_publications
         JOIN pull_request_drafts
           ON pull_request_drafts.draft_id = pull_request_publications.draft_id
         JOIN runs ON runs.run_id = pull_request_publications.run_id
         WHERE pull_request_publications.publication_id = ?
           AND pull_request_publications.status IN ('pending', 'created_unverified')
           AND pull_request_publications.github_observation_version = ?
           AND pull_request_publications.github_external_updated_at IS ?
           AND runs.state = 'verifying'
           AND runs.version = pull_request_publications.run_version
           AND runs.active_plan_id = pull_request_drafts.plan_id
           AND runs.active_plan_version = pull_request_drafts.plan_version
           AND runs.active_plan_digest = pull_request_drafts.plan_digest
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        fact.url,
        `d1://pull-request-publications/${publication.publication_id}`,
        fact.externalUpdatedAt,
        observedAt,
        publication.publication_id,
        publication.github_observation_version,
        publication.github_external_updated_at,
      ),
      this.db.prepare(
        `UPDATE pull_request_publications
         SET status = 'verified', github_pr_number = ?, github_pr_url = ?,
             github_external_updated_at = ?,
             github_observation_version = github_observation_version + 1,
             evidence_id = ?, updated_at = ?
         WHERE publication_id = ?
           AND status IN ('pending', 'created_unverified')
           AND github_observation_version = ?
           AND github_external_updated_at IS ?
           AND (github_pr_number IS NULL OR github_pr_number = ?)
           AND EXISTS (
             SELECT 1 FROM evidence
             WHERE evidence.evidence_id = ?
               AND evidence.run_id = pull_request_publications.run_id
               AND evidence.kind = 'pull_request'
               AND evidence.status = 'passed'
               AND evidence.sha = pull_request_publications.head_sha
               AND evidence.external_url = ?
               AND evidence.artifact_digest = pull_request_publications.body_digest
               AND evidence.verification_status = 'verified'
           )`,
      ).bind(
        fact.number,
        fact.url,
        fact.externalUpdatedAt,
        evidenceId,
        observedAt,
        publication.publication_id,
        publication.github_observation_version,
        publication.github_external_updated_at,
        fact.number,
        evidenceId,
        fact.url,
      ),
      this.db.prepare(
        `UPDATE runs
         SET state = 'pull_request_open', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'verifying' AND version = ?
           AND active_plan_id = ? AND active_plan_version = ?
           AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM pull_request_publications
             WHERE pull_request_publications.publication_id = ?
               AND pull_request_publications.run_id = runs.run_id
               AND pull_request_publications.status = 'verified'
               AND pull_request_publications.evidence_id = ?
           )`,
      ).bind(
        observedAt,
        publication.run_id,
        publication.current_run_version,
        publication.plan_id,
        publication.plan_version,
        publication.plan_digest,
        publication.publication_id,
        evidenceId,
      ),
    ]);
    if (
      results[1]?.meta.changes === 1 &&
      results[2]?.meta.changes === 1
    ) {
      return { disposition: 'applied', publicationId: publication.publication_id, reason: null };
    }
    const current = await this.candidate(fact.repository, fact.headBranch);
    if (current !== null && factAlreadyProjected(current, fact)) {
      return { disposition: 'applied', publicationId: current.publication_id, reason: null };
    }
    return {
      disposition: 'ignored',
      publicationId: publication.publication_id,
      reason: 'observation_race',
    };
  }

  private async candidate(
    repository: string,
    headBranch: string,
  ): Promise<PublicationProjectionRow | null> {
    return await this.db.prepare(
      `SELECT pull_request_publications.*,
              pull_request_drafts.body,
              pull_request_drafts.run_version AS draft_run_version,
              pull_request_drafts.plan_id, pull_request_drafts.plan_version,
              pull_request_drafts.plan_digest, pull_request_drafts.attempt_id,
              runs.state AS run_state, runs.version AS current_run_version,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              execution_plans.status AS plan_status
       FROM pull_request_publications
       JOIN pull_request_drafts
         ON pull_request_drafts.draft_id = pull_request_publications.draft_id
       JOIN runs ON runs.run_id = pull_request_publications.run_id
       JOIN execution_plans ON execution_plans.plan_id = pull_request_drafts.plan_id
       WHERE pull_request_publications.repository = ?
         AND pull_request_publications.head_branch = ?`,
    ).bind(repository, headBranch).first<PublicationProjectionRow>();
  }

  private async webhookDelivery(deliveryId: string): Promise<ExistingRow | null> {
    const row = await this.db.prepare(
      `SELECT payload_digest AS digest, processing_state
       FROM github_pull_request_webhook_deliveries WHERE delivery_id = ?`,
    ).bind(deliveryId).first<ExistingRow>();
    return row;
  }

  private async apiObservation(observationId: string): Promise<ExistingRow | null> {
    return await this.db.prepare(
      `SELECT fact_digest AS digest, processing_state
       FROM github_pull_request_api_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ExistingRow>();
  }
}
