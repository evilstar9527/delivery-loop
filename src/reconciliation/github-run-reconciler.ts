import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubRunObservationStore,
  type GitHubObservationDisposition,
  type GitHubWorkflowRunFact,
} from '../storage/github-run-observation-store.js';

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface GitHubRunExternalFactClient {
  getWorkflowRun(repository: string, githubRunId: string): Promise<GitHubWorkflowRunFact>;
}

export interface GitHubRunReconcilerOptions {
  now?: () => Date;
}

export interface GitHubBatchReconciliationResult {
  attemptId: string;
  disposition: GitHubObservationDisposition | 'unavailable';
}

interface ReconciliationCandidate {
  attempt_id: string;
  repository: string;
  github_run_id: string;
}

interface AtRiskCandidate {
  attempt_id: string;
  repository: string | null;
  github_run_id: string | null;
  github_external_updated_at: string | null;
  github_status: string | null;
  test_acceptance_id: string | null;
}

export class GitHubRunReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubRunExternalFactClient,
    options: GitHubRunReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileAttempt(
    attemptId: string,
  ): Promise<GitHubObservationDisposition | 'not_found'> {
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) return 'not_found';
    const candidate = await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.repository, attempts.github_run_id
         FROM attempts
         WHERE attempt_id = ? AND repository IS NOT NULL AND github_run_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM test_acceptances
             WHERE test_acceptances.attempt_id = attempts.attempt_id
           )`,
      )
      .bind(attemptId)
      .first<ReconciliationCandidate>();
    if (candidate === null) return 'not_found';
    const fact = await this.client.getWorkflowRun(candidate.repository, candidate.github_run_id);
    const factDigest = await canonicalSha256(fact);
    const identityDigest = await canonicalSha256({
      source: 'github_api',
      repository: candidate.repository,
      githubRunId: candidate.github_run_id,
      factDigest,
    });
    return await new GitHubRunObservationStore(this.db).applyApiObservation({
      observationId: `github_api_${identityDigest.slice('sha256:'.length, 'sha256:'.length + 56)}`,
      factDigest,
      fact,
      observedAt: this.now().toISOString(),
    });
  }

  async reconcileBatch(limit = 25): Promise<GitHubBatchReconciliationResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('GitHub reconciliation limit must be between 1 and 100');
    }
    // A durable Runner result still needs an external GitHub fact, but it must
    // not sit behind an unbounded terminal backlog when the webhook is lost.
    // The rank changes only which read-only GET is served first; the shared
    // observation projector remains the sole authority for external status.
    const candidates = await this.db
      .prepare(
        `SELECT attempt_id, repository, github_run_id
         FROM attempts JOIN runs ON runs.run_id = attempts.run_id
         WHERE attempts.repository IS NOT NULL
           AND attempts.github_run_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM test_acceptances
             WHERE test_acceptances.attempt_id = attempts.attempt_id
           )
           AND (
             attempts.github_external_updated_at IS NULL
             OR attempts.github_status IS NULL
             OR attempts.github_status <> 'completed'
           )
         ORDER BY
           CASE
             WHEN attempts.status IN ('starting', 'running')
              AND attempts.result_event_id IS NOT NULL
              AND runs.state IN (
                'triaging', 'awaiting_approval', 'planning', 'executing',
                'verifying', 'awaiting_review', 'deploying'
              ) THEN 0
             WHEN attempts.status IN ('starting', 'running')
              AND runs.state IN (
                'triaging', 'awaiting_approval', 'planning', 'executing',
                'verifying', 'awaiting_review', 'deploying'
              ) THEN 1
             ELSE 2
           END,
           COALESCE(attempts.github_observed_at, attempts.created_at),
           attempts.attempt_id
         LIMIT ?`,
      )
      .bind(limit)
      .all<ReconciliationCandidate>();
    return await this.reconcileCandidates(candidates.results);
  }

  async reconcileAtRiskBatch(
    limit = 5,
    runningThresholdSeconds = 90,
  ): Promise<GitHubBatchReconciliationResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('GitHub reconciliation limit must be between 1 and 100');
    }
    if (
      !Number.isSafeInteger(runningThresholdSeconds) ||
      runningThresholdSeconds < 60 || runningThresholdSeconds > 604800
    ) {
      throw new Error('GitHub at-risk threshold must be between 60 and 604800 seconds');
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error('GitHub reconciliation time is invalid');
    }
    const nowIso = now.toISOString();
    const heartbeatCutoff = new Date(
      now.getTime() - runningThresholdSeconds * 1_000,
    ).toISOString();
    const candidates = await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.repository, attempts.github_run_id,
              attempts.github_external_updated_at, attempts.github_status,
              test_acceptances.attempt_id AS test_acceptance_id
       FROM attempts JOIN runs ON runs.run_id = attempts.run_id
       LEFT JOIN test_acceptances ON test_acceptances.attempt_id = attempts.attempt_id
       WHERE attempts.status IN ('starting', 'running')
         AND attempts.result_event_id IS NULL
         AND attempts.lease_expires_at IS NOT NULL
         AND runs.state IN (
           'triaging', 'awaiting_approval', 'planning', 'executing',
           'verifying', 'awaiting_review', 'deploying'
         )
         AND (
           attempts.lease_expires_at <= ?
           OR COALESCE(attempts.heartbeat_at, attempts.updated_at) <= ?
         )
       ORDER BY COALESCE(attempts.heartbeat_at, attempts.updated_at), attempts.attempt_id
       LIMIT ?`,
    ).bind(nowIso, heartbeatCutoff, limit).all<AtRiskCandidate>();
    const reconcilable = candidates.results.filter((candidate) =>
      candidate.repository !== null && candidate.github_run_id !== null &&
      candidate.test_acceptance_id === null &&
      (
        candidate.github_external_updated_at === null || candidate.github_status === null ||
        candidate.github_status !== 'completed'
      )
    ) as ReconciliationCandidate[];
    return await this.reconcileCandidates(reconcilable);
  }

  private async reconcileCandidates(
    candidates: ReconciliationCandidate[],
  ): Promise<GitHubBatchReconciliationResult[]> {
    const results: GitHubBatchReconciliationResult[] = [];
    for (const candidate of candidates) {
      try {
        const disposition = await this.reconcileAttempt(candidate.attempt_id);
        if (disposition !== 'not_found') {
          results.push({ attemptId: candidate.attempt_id, disposition });
        }
      } catch {
        results.push({ attemptId: candidate.attempt_id, disposition: 'unavailable' });
      }
    }
    return results;
  }
}
