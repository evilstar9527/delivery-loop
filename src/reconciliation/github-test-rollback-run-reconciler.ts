import { canonicalSha256 } from '../domain/digest.js';
import type { GitHubWorkflowRunFact } from '../storage/github-run-observation-store.js';
import {
  GitHubTestRollbackStatusStore,
  type GitHubTestRollbackObservationDisposition,
} from '../storage/github-test-rollback-status-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface GitHubTestRollbackExternalFactClient {
  getRollbackWorkflowRun(
    repository: string,
    githubRunId: string,
  ): Promise<GitHubWorkflowRunFact>;
}

interface CandidateRow {
  rollback_id: string;
  repository: string;
  github_run_id: string;
}

export interface GitHubTestRollbackBatchResult {
  rollbackId: string;
  disposition: GitHubTestRollbackObservationDisposition | 'unavailable';
}

/** Repairs a lost rollback workflow_run delivery through the same projector. */
export class GitHubTestRollbackRunReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubTestRollbackExternalFactClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileRollback(
    rollbackId: string,
  ): Promise<GitHubTestRollbackObservationDisposition | 'not_found'> {
    if (!ID_PATTERN.test(rollbackId)) return 'not_found';
    const candidate = await this.db.prepare(
      `SELECT rollback_id, repository, github_run_id
       FROM test_rollbacks WHERE rollback_id = ? AND github_run_id IS NOT NULL`,
    ).bind(rollbackId).first<CandidateRow>();
    if (candidate === null) return 'not_found';
    const fact = await this.client.getRollbackWorkflowRun(
      candidate.repository,
      candidate.github_run_id,
    );
    const factDigest = await canonicalSha256(fact);
    const identity = await canonicalSha256({
      source: 'github_api',
      rollbackId: candidate.rollback_id,
      repository: candidate.repository,
      githubRunId: candidate.github_run_id,
      factDigest,
    });
    return await new GitHubTestRollbackStatusStore(this.db).applyApiObservation({
      observationId: `api_${identity.slice('sha256:'.length, 'sha256:'.length + 56)}`,
      factDigest,
      fact,
      observedAt: this.now().toISOString(),
    });
  }

  async reconcileBatch(limit = 25): Promise<GitHubTestRollbackBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('test rollback run reconciliation limit must be between 1 and 100');
    }
    const candidates = await this.db.prepare(
      `SELECT rollback_id, repository, github_run_id
       FROM test_rollbacks
       WHERE github_run_id IS NOT NULL AND status IN ('dispatched', 'running')
       ORDER BY COALESCE(external_updated_at, updated_at), rollback_id LIMIT ?`,
    ).bind(limit).all<CandidateRow>();
    const results: GitHubTestRollbackBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        const disposition = await this.reconcileRollback(candidate.rollback_id);
        if (disposition !== 'not_found') {
          results.push({ rollbackId: candidate.rollback_id, disposition });
        }
      } catch {
        results.push({ rollbackId: candidate.rollback_id, disposition: 'unavailable' });
      }
    }
    return results;
  }
}

