import { z } from 'zod';
import { IdentityMapper } from './auth/identity-mapper.js';
import { canonicalSha256 } from './domain/digest.js';
import { GITHUB_API_USER_AGENT, githubApiFetch } from './github-api.js';
import type { GitHubBaseObservationTokenProvider } from './reconciliation/github-base-observation-reconciler.js';
import {
  IdentityBoundApprovalError,
  IdentityBoundApprovalStore,
  type IdentityBoundApprovalResult,
} from './storage/identity-bound-approval-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_COMMENT_BYTES = 2 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SOURCE_AGE_MS = 24 * 60 * 60_000;
const APPROVAL_TTL_MS = 60 * 60_000;

export const GitHubCommitApprovalRequestSchema = z.object({
  commentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export interface GitHubCommitApprovalFact {
  schemaVersion: '1';
  repository: string;
  commentId: number;
  commitSha: string;
  authorLogin: string;
  authorType: 'User';
  authorAssociation: 'OWNER' | 'MEMBER' | 'COLLABORATOR' | 'CONTRIBUTOR' | 'NONE';
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface GitHubCommitApprovalClient {
  getCommitComment(repository: string, commentId: number): Promise<GitHubCommitApprovalFact>;
}

export class GitHubCommitApprovalError extends Error {
  constructor(readonly code:
    | 'invalid_request'
    | 'not_found'
    | 'state_conflict'
    | 'external_unavailable'
    | 'fact_rejected') {
    super(`GitHub commit approval failed: ${code}`);
    this.name = 'GitHubCommitApprovalError';
  }
}

interface CandidateRow {
  run_id: string;
  run_version: number;
  base_sha: string;
  task_id: string;
  task_revision: string;
  repository: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  recovery_failed_attempt_id: string | null;
  recovery_root_attempt_id: string | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function apiOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GitHub API URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new Error('GitHub API URL is invalid');
  return url.origin;
}

export class GitHubCommitApprovalApiClient implements GitHubCommitApprovalClient {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    private readonly tokenProvider: GitHubBaseObservationTokenProvider,
    options: { apiBaseUrl?: string; fetch?: typeof globalThis.fetch } = {},
  ) {
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = githubApiFetch(options.fetch);
  }

  async getCommitComment(repository: string, commentId: number): Promise<GitHubCommitApprovalFact> {
    if (!REPOSITORY_PATTERN.test(repository) || !Number.isSafeInteger(commentId) || commentId <= 0) {
      throw new GitHubCommitApprovalError('invalid_request');
    }
    let token: string;
    try {
      token = await this.tokenProvider.getBaseObservationToken(repository);
    } catch {
      throw new GitHubCommitApprovalError('external_unavailable');
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBaseUrl}/repos/${repository}/comments/${commentId}`,
        {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'user-agent': GITHUB_API_USER_AGENT,
            'x-github-api-version': '2022-11-28',
          },
        },
      );
    } catch {
      throw new GitHubCommitApprovalError('external_unavailable');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new GitHubCommitApprovalError('external_unavailable');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new GitHubCommitApprovalError('external_unavailable');
    }
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
      throw new GitHubCommitApprovalError('external_unavailable');
    }
    let raw: Record<string, unknown> | null;
    try {
      raw = object(JSON.parse(text) as unknown);
    } catch {
      throw new GitHubCommitApprovalError('external_unavailable');
    }
    const user = object(raw?.user);
    if (
      raw === null || raw.id !== commentId || typeof raw.commit_id !== 'string' ||
      typeof raw.body !== 'string' || typeof raw.created_at !== 'string' ||
      typeof raw.updated_at !== 'string' || typeof raw.html_url !== 'string' ||
      user === null || typeof user.login !== 'string' || user.type !== 'User' ||
      !['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'].includes(
        String(raw.author_association),
      )
    ) throw new GitHubCommitApprovalError('external_unavailable');
    return {
      schemaVersion: '1',
      repository,
      commentId,
      commitSha: raw.commit_id,
      authorLogin: user.login,
      authorType: 'User',
      authorAssociation: raw.author_association as GitHubCommitApprovalFact['authorAssociation'],
      body: raw.body,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      url: raw.html_url,
    };
  }
}

export function githubCommitApprovalBody(candidate: {
  runId: string;
  runVersion: number;
  planId: string;
  planVersion: number;
  planDigest: string;
  baseSha: string;
}): string {
  return [
    '/delivery-loop approve repo_write',
    `run: ${candidate.runId}`,
    `run-version: ${candidate.runVersion}`,
    `plan: ${candidate.planId}`,
    `plan-version: ${candidate.planVersion}`,
    `plan-digest: ${candidate.planDigest}`,
    `base-sha: ${candidate.baseSha}`,
  ].join('\n');
}

export class GitHubCommitApprovalService {
  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubCommitApprovalClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async template(runId: string): Promise<{
    repository: string;
    baseSha: string;
    commentBody: string;
  }> {
    const candidate = await this.candidate(runId);
    if (candidate === null) {
      const exists = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(runId).first();
      throw new GitHubCommitApprovalError(exists === null ? 'not_found' : 'state_conflict');
    }
    return {
      repository: candidate.repository,
      baseSha: candidate.base_sha,
      commentBody: githubCommitApprovalBody(this.templateInput(candidate)),
    };
  }

  async approve(runId: string, commentId: number): Promise<IdentityBoundApprovalResult> {
    if (!ID_PATTERN.test(runId) || !Number.isSafeInteger(commentId) || commentId <= 0) {
      throw new GitHubCommitApprovalError('invalid_request');
    }
    const candidate = await this.candidate(runId);
    if (candidate === null) {
      const exists = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(runId).first();
      throw new GitHubCommitApprovalError(exists === null ? 'not_found' : 'state_conflict');
    }
    let fact: GitHubCommitApprovalFact;
    try {
      fact = await this.client.getCommitComment(candidate.repository, commentId);
    } catch (error) {
      if (error instanceof GitHubCommitApprovalError) throw error;
      throw new GitHubCommitApprovalError('external_unavailable');
    }
    const now = this.now();
    const expectedBody = githubCommitApprovalBody(this.templateInput(candidate));
    const bodyBytes = new TextEncoder().encode(fact.body).length;
    const createdAt = Date.parse(fact.createdAt);
    const url = this.validUrl(fact, candidate.repository, candidate.base_sha);
    if (
      fact.schemaVersion !== '1' || fact.repository !== candidate.repository ||
      fact.commentId !== commentId || fact.commitSha !== candidate.base_sha ||
      fact.authorType !== 'User' ||
      !['OWNER', 'MEMBER'].includes(fact.authorAssociation) ||
      !LOGIN_PATTERN.test(fact.authorLogin) || bodyBytes < 1 || bodyBytes > MAX_COMMENT_BYTES ||
      fact.body !== expectedBody || fact.updatedAt !== fact.createdAt ||
      !Number.isFinite(createdAt) || createdAt < now.getTime() - MAX_SOURCE_AGE_MS ||
      createdAt > now.getTime() + 5 * 60_000 || url === null
    ) throw new GitHubCommitApprovalError('fact_rejected');

    const login = fact.authorLogin.toLowerCase();
    const principal = `user:${login}`;
    const channel = `github:${candidate.repository}`;
    const mapper = new IdentityMapper(this.db);
    await mapper.bind(principal, ['human', 'approve:repo_write'], now.toISOString());
    await mapper.bindChannelIdentity(channel, login, principal, now.toISOString());
    const bodyDigest = await canonicalSha256(fact.body);
    const eventDigest = await canonicalSha256({
      repository: fact.repository,
      commentId: fact.commentId,
      commitSha: fact.commitSha,
      authorLogin: login,
      authorType: fact.authorType,
      authorAssociation: fact.authorAssociation,
      bodyDigest,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
      url,
    });
    try {
      return await new IdentityBoundApprovalStore(this.db, { now: this.now })
        .decideTrustedGitHubRepoWrite({
          runId: candidate.run_id,
          expectedRunVersion: candidate.run_version,
          planVersion: candidate.plan_version,
          effect: 'repo_write',
          decision: 'approve',
          expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
          source: {
            schemaVersion: '1',
            provider: 'github',
            tenantKey: candidate.repository,
            externalEventId: `commit-comment-${commentId}`,
            externalSubject: login,
            eventDigest,
            occurredAt: fact.createdAt,
          },
        });
    } catch (error) {
      if (error instanceof IdentityBoundApprovalError) {
        throw new GitHubCommitApprovalError(
          error.code === 'not_found' ? 'not_found' : 'state_conflict',
        );
      }
      throw error;
    }
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    if (!ID_PATTERN.test(runId)) throw new GitHubCommitApprovalError('invalid_request');
    const nowIso = this.now().toISOString();
    return await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, runs.base_sha,
              tasks.task_id, runs.task_revision,
              tasks.target_repository AS repository,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              recovery.failed_attempt_id AS recovery_failed_attempt_id,
              recovery.root_review_attempt_id AS recovery_root_attempt_id
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       LEFT JOIN repo_write_recovery_candidates_v3 AS recovery
         ON recovery.run_id = runs.run_id
        AND recovery.run_version = runs.version
        AND recovery.plan_id = plans.plan_id
        AND recovery.plan_version = plans.plan_version
       WHERE runs.run_id = ?
         AND runs.base_sha IS NOT NULL AND tasks.allow_repository_write = 1
         AND (
           (runs.state = 'awaiting_approval' AND plans.status = 'active'
            AND recovery.failed_attempt_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM review_approval_recovery_approvals AS pending_recovery
              WHERE pending_recovery.run_id = runs.run_id
                AND NOT EXISTS (
                  SELECT 1 FROM review_approval_recoveries
                  WHERE review_approval_recoveries.recovery_approval_id =
                        pending_recovery.recovery_approval_id
                )
            ))
           OR
           (runs.state = 'blocked' AND recovery.failed_attempt_id IS NOT NULL
            AND (
              (recovery.source_kind = 'failed_dependency' AND plans.status = 'blocked')
              OR (recovery.source_kind IN ('lost_pre_effect', 'implement_lost_pre_effect')
                  AND plans.status = 'active')
            ))
           OR
           (runs.state = 'executing' AND recovery.failed_attempt_id IS NOT NULL
            AND recovery.source_kind = 'automated_fix_failed_pre_effect'
            AND plans.status = 'active')
           OR
           (runs.state = 'pull_request_open' AND plans.status = 'active'
            AND EXISTS (
              SELECT 1
              FROM automated_reviews AS reviews
              JOIN attempts AS root ON root.attempt_id = reviews.review_attempt_id
              JOIN plan_item_progress AS progress
                ON progress.plan_id = reviews.plan_id
               AND progress.item_id = reviews.plan_item_id
              JOIN pull_request_publications AS publications
                ON publications.publication_id = reviews.publication_id
              WHERE reviews.run_id = runs.run_id AND reviews.plan_id = plans.plan_id
                AND reviews.plan_version = plans.plan_version
                AND reviews.status = 'pending'
                AND root.run_id = runs.run_id AND root.mode = 'analysis'
                AND root.status IN ('failed', 'lost', 'starting', 'running')
                AND root.result_event_id IS NULL
                AND root.github_status = 'completed'
                AND root.github_conclusion IS NOT NULL
                AND root.github_conclusion <> 'success'
                AND (
                  root.status IN ('failed', 'lost')
                  OR (root.lease_expires_at IS NOT NULL AND root.lease_expires_at <= ?)
                )
                AND root.base_sha = reviews.source_head_sha
                AND root.repository = reviews.repository
                AND root.workflow_ref IS NOT NULL
                AND progress.status = 'passed' AND progress.active_attempt_id IS NULL
                AND publications.status = 'verified'
                AND publications.run_id = reviews.run_id
                AND publications.repository = reviews.repository
                AND publications.github_pr_number = reviews.github_pr_number
                AND publications.base_branch = reviews.base_branch
                AND publications.head_branch = reviews.branch
                AND publications.head_sha = reviews.source_head_sha
                AND reviews.source_head_sha = (
                  SELECT updates.head_sha
                  FROM attempt_head_updates AS updates
                  JOIN attempts AS head_attempt
                    ON head_attempt.attempt_id = updates.attempt_id
                  WHERE updates.run_id = reviews.run_id
                    AND updates.plan_id = reviews.plan_id
                    AND updates.branch = reviews.branch
                  ORDER BY head_attempt.ordinal DESC, updates.created_at DESC LIMIT 1
                )
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM attempts AS replacement
                    WHERE replacement.recovered_from_attempt_id = root.attempt_id
                  )
                  OR (
                    1 = (
                      SELECT COUNT(*) FROM attempts AS replacement_count
                      WHERE replacement_count.recovered_from_attempt_id = root.attempt_id
                    )
                    AND EXISTS (
                      SELECT 1 FROM attempts AS replacement
                      WHERE replacement.recovered_from_attempt_id = root.attempt_id
                      AND replacement.run_id = reviews.run_id
                      AND replacement.mode = 'analysis'
                      AND replacement.status IN ('failed', 'lost', 'starting', 'running')
                      AND replacement.result_event_id IS NULL
                      AND replacement.github_status = 'completed'
                      AND replacement.github_conclusion IS NOT NULL
                      AND replacement.github_conclusion <> 'success'
                      AND (
                        replacement.status IN ('failed', 'lost')
                        OR (replacement.lease_expires_at IS NOT NULL
                            AND replacement.lease_expires_at <= ?)
                      )
                      AND replacement.base_sha = reviews.source_head_sha
                      AND replacement.repository = reviews.repository
                      AND replacement.workflow_ref IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1
                        FROM automated_review_replacement_redispatches AS redispatch
                        WHERE redispatch.replacement_attempt_id = replacement.attempt_id
                      )
                    )
                  )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM run_blockers
                  WHERE run_blockers.run_id = reviews.run_id
                    AND run_blockers.resolved_at IS NULL
                )
            ))
         )
         AND plans.base_sha = runs.base_sha
         AND plans.plan_version = runs.active_plan_version
         AND plans.digest = runs.active_plan_digest
         AND EXISTS (
           SELECT 1 FROM plan_item_effects
           WHERE plan_item_effects.plan_id = plans.plan_id
             AND plan_item_effects.effect = 'repo_write'
         )
       LIMIT 1`,
    ).bind(runId, nowIso, nowIso).first<CandidateRow>();
  }

  private templateInput(candidate: CandidateRow) {
    if (
      !REPOSITORY_PATTERN.test(candidate.repository) || !SHA_PATTERN.test(candidate.base_sha) ||
      !ID_PATTERN.test(candidate.plan_id) || candidate.plan_version < 1 ||
      !DIGEST_PATTERN.test(candidate.plan_digest)
    ) throw new GitHubCommitApprovalError('state_conflict');
    return {
      runId: candidate.run_id,
      runVersion: candidate.run_version,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      planDigest: candidate.plan_digest,
      baseSha: candidate.base_sha,
    };
  }

  private validUrl(
    fact: GitHubCommitApprovalFact,
    repository: string,
    baseSha: string,
  ): string | null {
    let url: URL;
    try {
      url = new URL(fact.url);
    } catch {
      return null;
    }
    if (
      url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      url.username !== '' || url.password !== '' || url.search !== '' ||
      url.pathname.toLowerCase() !== `/${repository.toLowerCase()}/commit/${baseSha}` ||
      url.hash !== `#commitcomment-${fact.commentId}`
    ) return null;
    return url.href;
  }
}
