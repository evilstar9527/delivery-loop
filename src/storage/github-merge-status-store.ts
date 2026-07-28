import {
  GitHubPullRequestMergeFactSchema,
  type GitHubPullRequestMergeFact,
} from '../domain/github-merge-status.js';
import { canonicalSha256 } from '../domain/digest.js';

const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface GitHubMergeWebhookObservation {
  deliveryId: string;
  payloadDigest: string;
  fact: GitHubPullRequestMergeFact;
  receivedAt: string;
}

export interface GitHubMergeApiObservation {
  observationId: string;
  factDigest: string;
  fact: GitHubPullRequestMergeFact;
  observedAt: string;
}

export type GitHubMergeObservationDisposition = 'applied' | 'duplicate' | 'ignored';
export type GitHubMergeStatusErrorCode =
  | 'observation_conflict'
  | 'merge_conflict'
  | 'state_conflict';

export class GitHubMergeStatusError extends Error {
  constructor(readonly code: GitHubMergeStatusErrorCode) {
    super(`GitHub merge status failed: ${code}`);
    this.name = 'GitHubMergeStatusError';
  }
}

interface ObservationRow {
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

interface MergeRow {
  merge_id: string;
  repository: string;
  github_pr_number: number;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  merge_sha: string;
  merged_by_login: string;
  merged_at: string;
  external_updated_at: string;
  evidence_id: string;
}

interface CandidateRow {
  run_id: string;
  run_version: number;
  run_state: string;
  task_target_environment: 'none' | 'test' | 'production';
  allow_test_deploy: number;
  allow_production_deploy: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  decision_id: string;
  decision_run_version: number;
  decision_head_sha: string;
  decision_base_sha: string;
  decision_created_at: string;
  publication_id: string;
  publication_status: string;
  repository: string;
  github_pr_number: number;
  github_pr_url: string;
  head_branch: string;
  publication_head_sha: string;
  base_branch: string;
  incomplete_required_count: number;
  merge_effect_count: number;
  test_deploy_effect_count: number;
  production_deploy_effect_count: number;
}

interface ProjectionResult {
  disposition: 'applied' | 'ignored';
  mergeId: string | null;
  reason: string | null;
}

function sameMerge(row: MergeRow, fact: GitHubPullRequestMergeFact): boolean {
  return row.repository === fact.repository && row.github_pr_number === fact.number &&
    row.head_branch === fact.headBranch && row.head_sha === fact.headSha &&
    row.base_branch === fact.baseBranch && row.merge_sha === fact.mergeSha &&
    row.merged_by_login === fact.mergedByLogin && row.merged_at === fact.mergedAt;
}

/** Projects a human/external GitHub merge; it never calls the merge mutation API. */
export class GitHubMergeStatusStore {
  constructor(private readonly db: D1Database) {}

  async applyWebhook(
    observation: GitHubMergeWebhookObservation,
  ): Promise<GitHubMergeObservationDisposition> {
    return await this.apply({
      observationId: `webhook_${observation.deliveryId}`,
      sourceKind: 'webhook',
      factDigest: observation.payloadDigest,
      fact: observation.fact,
      observedAt: observation.receivedAt,
    });
  }

  async applyApiObservation(
    observation: GitHubMergeApiObservation,
  ): Promise<GitHubMergeObservationDisposition> {
    return await this.apply({
      observationId: observation.observationId,
      sourceKind: 'api',
      factDigest: observation.factDigest,
      fact: observation.fact,
      observedAt: observation.observedAt,
    });
  }

  private async apply(input: {
    observationId: string;
    sourceKind: 'webhook' | 'api';
    factDigest: string;
    fact: GitHubPullRequestMergeFact;
    observedAt: string;
  }): Promise<GitHubMergeObservationDisposition> {
    const parsed = GitHubPullRequestMergeFactSchema.safeParse(input.fact);
    if (
      !OBSERVATION_ID_PATTERN.test(input.observationId) ||
      !DIGEST_PATTERN.test(input.factDigest) || !parsed.success ||
      !Number.isFinite(Date.parse(input.observedAt))
    ) throw new GitHubMergeStatusError('state_conflict');
    const existing = await this.observation(input.observationId);
    if (existing !== null) {
      if (existing.fact_digest !== input.factDigest) {
        throw new GitHubMergeStatusError('observation_conflict');
      }
      if (existing.processing_state !== 'received') return 'duplicate';
    } else {
      await this.db.prepare(
        `INSERT INTO github_merge_observations (
           observation_id, source_kind, fact_digest, repository,
           github_pr_number, processing_state, external_updated_at, observed_at
         ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.observationId,
        input.sourceKind,
        input.factDigest,
        parsed.data.repository,
        parsed.data.number,
        parsed.data.externalUpdatedAt,
        input.observedAt,
      ).run();
      const persisted = await this.observation(input.observationId);
      if (persisted === null || persisted.fact_digest !== input.factDigest) {
        throw new GitHubMergeStatusError('observation_conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }
    const projection = await this.project(parsed.data, input.observedAt);
    await this.finalize(
      input.observationId,
      input.factDigest,
      projection,
      input.observedAt,
    );
    return projection.disposition;
  }

  private async project(
    fact: GitHubPullRequestMergeFact,
    observedAt: string,
  ): Promise<ProjectionResult> {
    const existing = await this.merge(fact.repository, fact.number);
    if (existing !== null) {
      if (!sameMerge(existing, fact)) {
        throw new GitHubMergeStatusError('merge_conflict');
      }
      return { disposition: 'applied', mergeId: existing.merge_id, reason: null };
    }
    const candidate = await this.candidate(fact.repository, fact.number);
    if (candidate === null) {
      return { disposition: 'ignored', mergeId: null, reason: 'binding_mismatch' };
    }
    if (!this.bindingMatches(candidate, fact)) {
      return {
        disposition: 'ignored',
        mergeId: null,
        reason: 'binding_mismatch',
      };
    }
    const deploymentDisposition = this.deploymentDisposition(candidate);
    if (deploymentDisposition === null) {
      return {
        disposition: 'ignored',
        mergeId: null,
        reason: 'deployment_policy_invalid',
      };
    }
    const identity = await canonicalSha256({
      runId: candidate.run_id,
      decisionId: candidate.decision_id,
      publicationId: candidate.publication_id,
      repository: fact.repository,
      number: fact.number,
      headSha: fact.headSha,
      mergeSha: fact.mergeSha,
    });
    const suffix = identity.slice('sha256:'.length, 'sha256:'.length + 48);
    const mergeId = `github_merge_${suffix}`;
    const evidenceId = `evidence_merge_${suffix}`;
    const factDigest = await canonicalSha256(fact);
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, plan_id, plan_version, kind, status, sha,
           external_url, artifact_digest, summary, verification_status,
           observed_at, created_at
         )
         SELECT ?, runs.run_id, plans.plan_id, plans.plan_version,
                'pull_request', 'passed', ?, publications.github_pr_url, ?,
                'Signed GitHub pull request merge', 'verified', ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN merge_gate_decisions AS decisions ON decisions.run_id = runs.run_id
         JOIN pull_request_publications AS publications
           ON publications.publication_id = decisions.publication_id
         WHERE runs.run_id = ? AND runs.state = 'ready_to_merge' AND runs.version = ?
           AND runs.active_plan_id = ? AND runs.active_plan_version = ?
           AND runs.active_plan_digest = ? AND plans.status = 'active'
           AND decisions.decision_id = ? AND decisions.run_version + 1 = runs.version
           AND decisions.plan_id = plans.plan_id
           AND decisions.plan_version = plans.plan_version
           AND decisions.plan_digest = plans.digest
           AND decisions.head_sha = ? AND decisions.base_sha = runs.base_sha
           AND publications.status = 'verified'
           AND publications.repository = ? AND publications.github_pr_number = ?
           AND publications.head_sha = decisions.head_sha
           AND publications.base_branch = ?
           AND NOT EXISTS (SELECT 1 FROM github_merges WHERE run_id = runs.run_id)
           AND ${this.deploymentSql(deploymentDisposition)}
         ON CONFLICT DO NOTHING`,
      ).bind(
        evidenceId,
        fact.mergeSha,
        factDigest,
        fact.mergedAt,
        observedAt,
        candidate.run_id,
        candidate.run_version,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.decision_id,
        fact.headSha,
        fact.repository,
        fact.number,
        fact.baseBranch,
      ),
      this.db.prepare(
        `INSERT INTO github_merges (
           merge_id, run_id, run_version, decision_id, publication_id,
           plan_id, plan_version, plan_digest, repository, github_pr_number,
           head_branch, head_sha, base_branch, base_sha, merge_sha,
           merged_by_login, merged_at, external_updated_at,
           deployment_disposition, evidence_id, created_at
         )
         SELECT ?, runs.run_id, runs.version, decisions.decision_id,
                publications.publication_id, plans.plan_id, plans.plan_version,
                plans.digest, publications.repository, publications.github_pr_number,
                publications.head_branch, decisions.head_sha,
                publications.base_branch, decisions.base_sha, ?, ?, ?, ?, ?, ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN merge_gate_decisions AS decisions ON decisions.run_id = runs.run_id
         JOIN pull_request_publications AS publications
           ON publications.publication_id = decisions.publication_id
         JOIN evidence ON evidence.evidence_id = ?
         WHERE runs.run_id = ? AND runs.state = 'ready_to_merge' AND runs.version = ?
           AND runs.active_plan_id = ? AND runs.active_plan_version = ?
           AND runs.active_plan_digest = ? AND plans.status = 'active'
           AND decisions.decision_id = ? AND decisions.run_version + 1 = runs.version
           AND decisions.plan_id = plans.plan_id
           AND decisions.plan_version = plans.plan_version
           AND decisions.plan_digest = plans.digest
           AND decisions.head_sha = ? AND decisions.base_sha = runs.base_sha
           AND publications.status = 'verified'
           AND publications.repository = ? AND publications.github_pr_number = ?
           AND publications.head_branch = ? AND publications.head_sha = ?
           AND publications.base_branch = ? AND publications.github_pr_url = ?
           AND evidence.run_id = runs.run_id AND evidence.plan_id = plans.plan_id
           AND evidence.plan_version = plans.plan_version
           AND evidence.kind = 'pull_request' AND evidence.status = 'passed'
           AND evidence.sha = ? AND evidence.external_url = publications.github_pr_url
           AND evidence.artifact_digest = ? AND evidence.verification_status = 'verified'
           AND ${this.deploymentSql(deploymentDisposition)}
         ON CONFLICT DO NOTHING`,
      ).bind(
        mergeId,
        fact.mergeSha,
        fact.mergedByLogin,
        fact.mergedAt,
        fact.externalUpdatedAt,
        deploymentDisposition,
        evidenceId,
        observedAt,
        evidenceId,
        candidate.run_id,
        candidate.run_version,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.decision_id,
        fact.headSha,
        fact.repository,
        fact.number,
        fact.headBranch,
        fact.headSha,
        fact.baseBranch,
        fact.url,
        fact.mergeSha,
        factDigest,
      ),
      this.db.prepare(
        `UPDATE runs SET state = 'merging', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'ready_to_merge' AND version = ?
           AND active_plan_id = ? AND active_plan_version = ?
           AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM github_merges
             WHERE merge_id = ? AND run_id = runs.run_id
               AND run_version = runs.version AND merge_sha = ?
           )`,
      ).bind(
        observedAt,
        candidate.run_id,
        candidate.run_version,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        mergeId,
        fact.mergeSha,
      ),
      this.db.prepare(
        `UPDATE runs SET state = ?, version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'merging' AND version = ?
           AND active_plan_id = ? AND active_plan_version = ?
           AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM github_merges
             WHERE merge_id = ? AND run_id = runs.run_id
               AND run_version + 1 = runs.version
               AND deployment_disposition = ? AND merge_sha = ?
           )`,
      ).bind(
        deploymentDisposition === 'production' ? 'deploying' : 'succeeded',
        observedAt,
        candidate.run_id,
        candidate.run_version + 1,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        mergeId,
        deploymentDisposition,
        fact.mergeSha,
      ),
    ]);
    const persisted = await this.merge(fact.repository, fact.number);
    if (persisted === null || !sameMerge(persisted, fact)) {
      throw new GitHubMergeStatusError('state_conflict');
    }
    return { disposition: 'applied', mergeId: persisted.merge_id, reason: null };
  }

  private bindingMatches(candidate: CandidateRow, fact: GitHubPullRequestMergeFact): boolean {
    return candidate.run_state === 'ready_to_merge' &&
      candidate.decision_run_version + 1 === candidate.run_version &&
      candidate.plan_status === 'active' && candidate.incomplete_required_count === 0 &&
      candidate.merge_effect_count === 1 &&
      candidate.repository === fact.repository &&
      candidate.github_pr_number === fact.number &&
      candidate.github_pr_url === fact.url &&
      candidate.head_branch === fact.headBranch &&
      candidate.publication_head_sha === fact.headSha &&
      candidate.decision_head_sha === fact.headSha &&
      candidate.base_branch === fact.baseBranch &&
      candidate.decision_base_sha.length === 40 &&
      Date.parse(fact.mergedAt) >= Date.parse(candidate.decision_created_at) &&
      Date.parse(fact.externalUpdatedAt) >= Date.parse(fact.mergedAt);
  }

  private deploymentDisposition(
    candidate: CandidateRow,
  ): 'none' | 'test' | 'production' | null {
    if (
      candidate.task_target_environment === 'none' &&
      candidate.allow_test_deploy === 0 && candidate.allow_production_deploy === 0 &&
      candidate.test_deploy_effect_count === 0 &&
      candidate.production_deploy_effect_count === 0
    ) return 'none';
    if (
      candidate.task_target_environment === 'test' &&
      candidate.allow_test_deploy === 1 && candidate.allow_production_deploy === 0 &&
      candidate.test_deploy_effect_count > 0 &&
      candidate.production_deploy_effect_count === 0
    ) return 'test';
    if (
      candidate.task_target_environment === 'production' &&
      candidate.allow_production_deploy === 1 &&
      candidate.production_deploy_effect_count > 0
    ) return 'production';
    return null;
  }

  private deploymentSql(disposition: 'none' | 'test' | 'production'): string {
    if (disposition === 'none') {
      return `tasks.target_environment = 'none'
        AND tasks.allow_test_deploy = 0 AND tasks.allow_production_deploy = 0
        AND NOT EXISTS (
          SELECT 1 FROM plan_item_effects
          WHERE plan_item_effects.plan_id = plans.plan_id
            AND plan_item_effects.effect IN ('test_deploy', 'production_deploy')
        )`;
    }
    if (disposition === 'test') {
      return `tasks.target_environment = 'test' AND tasks.allow_test_deploy = 1
        AND tasks.allow_production_deploy = 0
        AND EXISTS (
          SELECT 1 FROM plan_item_effects
          WHERE plan_item_effects.plan_id = plans.plan_id
            AND plan_item_effects.effect = 'test_deploy'
        )
        AND NOT EXISTS (
          SELECT 1 FROM plan_item_effects
          WHERE plan_item_effects.plan_id = plans.plan_id
            AND plan_item_effects.effect = 'production_deploy'
        )`;
    }
    return `tasks.target_environment = 'production'
      AND tasks.allow_production_deploy = 1
      AND EXISTS (
        SELECT 1 FROM plan_item_effects
        WHERE plan_item_effects.plan_id = plans.plan_id
          AND plan_item_effects.effect = 'production_deploy'
      )`;
  }

  private async candidate(repository: string, number: number): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, runs.state AS run_state,
              tasks.target_environment AS task_target_environment,
              tasks.allow_test_deploy, tasks.allow_production_deploy,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              plans.status AS plan_status, decisions.decision_id,
              decisions.run_version AS decision_run_version,
              decisions.head_sha AS decision_head_sha,
              decisions.base_sha AS decision_base_sha,
              decisions.created_at AS decision_created_at,
              publications.publication_id, publications.status AS publication_status,
              publications.repository, publications.github_pr_number,
              publications.github_pr_url, publications.head_branch,
              publications.head_sha AS publication_head_sha,
              publications.base_branch,
              (SELECT COUNT(*) FROM plan_items
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = plan_items.plan_id
                AND plan_item_progress.item_id = plan_items.item_id
               WHERE plan_items.plan_id = plans.plan_id AND plan_items.required = 1
                 AND plan_item_progress.status <> 'passed') AS incomplete_required_count,
              (SELECT COUNT(*) FROM plan_item_effects
               WHERE plan_item_effects.plan_id = plans.plan_id
                 AND plan_item_effects.effect = 'merge') AS merge_effect_count,
              (SELECT COUNT(*) FROM plan_item_effects
               WHERE plan_item_effects.plan_id = plans.plan_id
                 AND plan_item_effects.effect = 'test_deploy') AS test_deploy_effect_count,
              (SELECT COUNT(*) FROM plan_item_effects
               WHERE plan_item_effects.plan_id = plans.plan_id
                 AND plan_item_effects.effect = 'production_deploy')
                AS production_deploy_effect_count
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN merge_gate_decisions AS decisions ON decisions.run_id = runs.run_id
       JOIN pull_request_publications AS publications
         ON publications.publication_id = decisions.publication_id
       WHERE runs.state = 'ready_to_merge' AND publications.status = 'verified'
         AND publications.repository = ? AND publications.github_pr_number = ?
         AND decisions.run_version + 1 = runs.version
         AND decisions.plan_id = plans.plan_id
         AND decisions.plan_version = plans.plan_version
         AND decisions.plan_digest = plans.digest
         AND decisions.head_sha = publications.head_sha
         AND decisions.base_sha = runs.base_sha
       ORDER BY decisions.created_at DESC, decisions.decision_id DESC LIMIT 1`,
    ).bind(repository, number).first<CandidateRow>();
  }

  private async merge(repository: string, number: number): Promise<MergeRow | null> {
    return await this.db.prepare(
      `SELECT merge_id, repository, github_pr_number, head_branch, head_sha,
              base_branch, merge_sha, merged_by_login, merged_at,
              external_updated_at, evidence_id
       FROM github_merges WHERE repository = ? AND github_pr_number = ?`,
    ).bind(repository, number).first<MergeRow>();
  }

  private async observation(observationId: string): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT fact_digest, processing_state
       FROM github_merge_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
  }

  private async finalize(
    observationId: string,
    factDigest: string,
    projection: ProjectionResult,
    observedAt: string,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE github_merge_observations
       SET processing_state = ?, merge_id = ?, ignore_reason = ?, processed_at = ?
       WHERE observation_id = ? AND fact_digest = ? AND processing_state = 'received'`,
    ).bind(
      projection.disposition,
      projection.mergeId,
      projection.reason,
      observedAt,
      observationId,
      factDigest,
    ).run();
  }
}
