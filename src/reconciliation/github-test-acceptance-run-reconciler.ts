import { canonicalSha256 } from '../domain/digest.js';
import type { GitHubWorkflowRunFact } from '../storage/github-run-observation-store.js';
import {
  GitHubTestAcceptanceStatusStore,
  type GitHubTestAcceptanceObservationDisposition,
} from '../storage/github-test-acceptance-status-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface GitHubTestAcceptanceExternalFactClient {
  getWorkflowRun(repository: string, githubRunId: string): Promise<GitHubWorkflowRunFact>;
}

interface CandidateRow {
  acceptance_id: string;
  repository: string;
  github_run_id: string;
}

export interface GitHubTestAcceptanceBatchResult {
  acceptanceId: string;
  disposition: GitHubTestAcceptanceObservationDisposition | 'unavailable';
}

/** Repairs a lost workflow_run webhook through the same acceptance projector. */
export class GitHubTestAcceptanceRunReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubTestAcceptanceExternalFactClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileAcceptance(
    acceptanceId: string,
  ): Promise<GitHubTestAcceptanceObservationDisposition | 'not_found'> {
    if (!ID_PATTERN.test(acceptanceId)) return 'not_found';
    const candidate = await this.db.prepare(
      `SELECT acceptance_id, repository, github_run_id
       FROM test_acceptances
       WHERE acceptance_id = ? AND github_run_id IS NOT NULL`,
    ).bind(acceptanceId).first<CandidateRow>();
    if (candidate === null) return 'not_found';
    const fact = await this.client.getWorkflowRun(
      candidate.repository,
      candidate.github_run_id,
    );
    const factDigest = await canonicalSha256(fact);
    const identity = await canonicalSha256({
      source: 'github_api',
      acceptanceId: candidate.acceptance_id,
      repository: candidate.repository,
      githubRunId: candidate.github_run_id,
      factDigest,
    });
    return await new GitHubTestAcceptanceStatusStore(this.db).applyApiObservation({
      observationId:
        `api_${identity.slice('sha256:'.length, 'sha256:'.length + 56)}`,
      factDigest,
      fact,
      observedAt: this.now().toISOString(),
    });
  }

  async reconcileBatch(limit = 25): Promise<GitHubTestAcceptanceBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('test acceptance run reconciliation limit must be between 1 and 100');
    }
    const candidates = await this.db.prepare(
      `SELECT acceptance_id, repository, github_run_id
       FROM test_acceptances
       WHERE github_run_id IS NOT NULL
         AND status IN ('dispatched', 'running')
       ORDER BY COALESCE(external_updated_at, updated_at), acceptance_id
       LIMIT ?`,
    ).bind(limit).all<CandidateRow>();
    const results: GitHubTestAcceptanceBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        const disposition = await this.reconcileAcceptance(candidate.acceptance_id);
        if (disposition !== 'not_found') {
          results.push({ acceptanceId: candidate.acceptance_id, disposition });
        }
      } catch {
        results.push({ acceptanceId: candidate.acceptance_id, disposition: 'unavailable' });
      }
    }
    return results;
  }
}
