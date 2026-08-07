import { canonicalSha256 } from '../domain/digest.js';
import type {
  GitHubPullRequestFact,
  GitHubPullRequestRequest,
} from '../outbox/github-pull-request.js';
import {
  GitHubPullRequestObservationStore,
  type GitHubPullRequestObservationDisposition,
} from '../storage/github-pull-request-observation-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface GitHubPullRequestExternalFactClient {
  getPullRequest(
    request: GitHubPullRequestRequest,
    number: number,
  ): Promise<GitHubPullRequestFact>;
}

export interface GitHubPullRequestReconcilerOptions {
  now?: () => Date;
}

export interface GitHubPullRequestBatchResult {
  publicationId: string;
  disposition: GitHubPullRequestObservationDisposition | 'unavailable';
}

interface CandidateRow {
  publication_id: string;
  repository: string;
  title: string;
  body: string;
  body_digest: string;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  github_pr_number: number;
}

export class GitHubPullRequestReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubPullRequestExternalFactClient,
    options: GitHubPullRequestReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcilePublication(
    publicationId: string,
  ): Promise<GitHubPullRequestObservationDisposition | 'not_found'> {
    if (!ID_PATTERN.test(publicationId)) return 'not_found';
    const candidate = await this.candidate(publicationId);
    if (candidate === null) return 'not_found';
    const request: GitHubPullRequestRequest = {
      repository: candidate.repository,
      title: candidate.title,
      body: candidate.body,
      bodyDigest: candidate.body_digest,
      headBranch: candidate.head_branch,
      headSha: candidate.head_sha,
      baseBranch: candidate.base_branch,
    };
    const fact = await this.client.getPullRequest(request, candidate.github_pr_number);
    const factDigest = await canonicalSha256(fact);
    const identity = await canonicalSha256({
      source: 'github_api',
      publicationId,
      factDigest,
    });
    return await new GitHubPullRequestObservationStore(this.db).applyApiObservation({
      observationId: `github_pr_api_${identity.slice('sha256:'.length, 'sha256:'.length + 52)}`,
      factDigest,
      fact,
      observedAt: this.now().toISOString(),
    });
  }

  async reconcileBatch(limit = 25): Promise<GitHubPullRequestBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('GitHub pull request reconciliation limit is invalid');
    }
    const candidates = await this.db.prepare(
      `SELECT pull_request_publications.publication_id
       FROM pull_request_publications
       JOIN runs ON runs.run_id = pull_request_publications.run_id
       WHERE pull_request_publications.status = 'created_unverified'
         AND pull_request_publications.github_pr_number IS NOT NULL
         AND runs.state = 'verifying'
         AND runs.version = pull_request_publications.run_version
       ORDER BY pull_request_publications.updated_at,
                pull_request_publications.publication_id
       LIMIT ?`,
    ).bind(limit).all<{ publication_id: string }>();
    const results: GitHubPullRequestBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        const disposition = await this.reconcilePublication(candidate.publication_id);
        if (disposition !== 'not_found') {
          results.push({ publicationId: candidate.publication_id, disposition });
        }
      } catch {
        results.push({ publicationId: candidate.publication_id, disposition: 'unavailable' });
      }
    }
    return results;
  }

  private async candidate(publicationId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT pull_request_publications.publication_id,
              pull_request_publications.repository,
              pull_request_publications.title,
              pull_request_drafts.body,
              pull_request_publications.body_digest,
              pull_request_publications.head_branch,
              pull_request_publications.head_sha,
              pull_request_publications.base_branch,
              pull_request_publications.github_pr_number
       FROM pull_request_publications
       JOIN pull_request_drafts
         ON pull_request_drafts.draft_id = pull_request_publications.draft_id
       JOIN runs ON runs.run_id = pull_request_publications.run_id
       WHERE pull_request_publications.publication_id = ?
         AND pull_request_publications.status = 'created_unverified'
         AND pull_request_publications.github_pr_number IS NOT NULL
         AND runs.state = 'verifying'
         AND runs.version = pull_request_publications.run_version`,
    ).bind(publicationId).first<CandidateRow>();
  }
}
