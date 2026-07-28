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
        `SELECT attempt_id, repository, github_run_id
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
    const candidates = await this.db
      .prepare(
        `SELECT attempt_id, repository, github_run_id
         FROM attempts
         WHERE repository IS NOT NULL
           AND github_run_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM test_acceptances
             WHERE test_acceptances.attempt_id = attempts.attempt_id
           )
           AND (
             github_external_updated_at IS NULL
             OR github_status IS NULL
             OR github_status <> 'completed'
           )
         ORDER BY COALESCE(github_observed_at, created_at), attempt_id
         LIMIT ?`,
      )
      .bind(limit)
      .all<ReconciliationCandidate>();
    const results: GitHubBatchReconciliationResult[] = [];
    for (const candidate of candidates.results) {
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
