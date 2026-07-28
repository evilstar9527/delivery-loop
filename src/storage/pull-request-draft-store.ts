import { z } from 'zod';
import {
  PullRequestDraftError,
  renderPullRequestDraftBody,
  type PullRequestDraftBodyInput,
} from '../domain/pull-request-draft.js';
import { canonicalSha256 } from '../domain/digest.js';
import { TaskEnvelopeSchema, taskRevisionDigest, type TaskEnvelope } from '../domain/task.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const PreparePullRequestDraftInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  headSha: z.string().regex(SHA_PATTERN),
}).strict();

export const PreparePullRequestDraftRequestBodySchema = PreparePullRequestDraftInputSchema.omit({
  runId: true,
});

export type PreparePullRequestDraftInput = z.infer<typeof PreparePullRequestDraftInputSchema>;
export type PullRequestDraftStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'task_payload_unavailable'
  | 'task_payload_conflict'
  | 'secret_detected'
  | 'body_too_large';

export class PullRequestDraftStoreError extends Error {
  constructor(readonly code: PullRequestDraftStoreErrorCode) {
    super(`Pull Request draft preparation failed: ${code}`);
    this.name = 'PullRequestDraftStoreError';
  }
}

export interface PullRequestDraftResult {
  draftId: string;
  created: boolean;
  status: 'prepared';
  runId: string;
  planId: string;
  planVersion: number;
  headSha: string;
  branch: string;
  bodyDigest: string;
  body: string;
}

interface CandidateRow {
  run_id: string;
  run_state: string;
  run_version: number;
  run_base_sha: string | null;
  run_task_digest: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  task_id: string;
  task_revision: string;
  task_digest: string;
  payload_ref: string;
  source_system: string;
  tenant_key: string;
  source_task_key: string;
  source_url: string | null;
  target_repository: string;
  target_base_branch: string;
  task_title: string;
  acceptance_criteria_count: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_base_sha: string;
  plan_status: string;
  plan_objective: string;
  attempt_id: string;
  attempt_mode: string;
  attempt_status: string;
  attempt_ordinal: number;
  attempt_head_sha: string | null;
  attempt_head_branch: string | null;
  head_update_id: string;
  head_parent_sha: string;
  head_sha: string;
  head_branch: string;
  commit_evidence_id: string;
  commit_evidence_kind: string;
  commit_evidence_status: string;
  commit_evidence_sha: string | null;
}

interface CoverageRow {
  criterion_index: number;
  item_id: string;
  progress_status: string;
  verification_id: string | null;
}

interface CriterionEvidenceRow {
  criterion_index: number;
  evidence_id: string;
}

interface ItemRow {
  item_id: string;
  title: string;
  progress_status: PullRequestDraftBodyInput['unfinishedItems'][number]['status'] | 'passed';
}

interface TestRow {
  evidence_id: string;
  command_ref: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  sha: string | null;
}

interface DraftRow {
  draft_id: string;
  run_id: string;
  plan_id: string;
  plan_version: number;
  head_sha: string;
  branch: string;
  body_digest: string;
  body: string;
  status: 'prepared';
}

interface ChildCriterionRow {
  criterion_index: number;
  criterion_digest: string;
  status: string;
  evidence_ids_digest: string;
}

interface ChildEvidenceRow {
  position: number;
  evidence_id: string;
}

interface ChildUnfinishedRow {
  position: number;
  item_id: string;
  status: string;
}

interface PullRequestDraftStoreOptions {
  secrets?: readonly string[];
}

/** Builds and freezes a public PR body only from durable, independently verified facts. */
export class PullRequestDraftStore {
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly taskObjects: R2Bucket,
    options: PullRequestDraftStoreOptions = {},
  ) {
    this.secrets = [...(options.secrets ?? [])];
  }

  async prepare(rawInput: unknown, now = new Date()): Promise<PullRequestDraftResult> {
    const parsed = PreparePullRequestDraftInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PullRequestDraftStoreError('invalid_request');
    const input = parsed.data;
    const candidate = await this.candidate(input);
    if (candidate === null) {
      const run = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(input.runId)
        .first<{ run_id: string }>();
      throw new PullRequestDraftStoreError(run === null ? 'not_found' : 'state_conflict');
    }
    await this.assertCandidate(candidate, input);
    const task = await this.task(candidate);
    const [coverage, criterionEvidence, items, tests, effects] = await Promise.all([
      this.coverage(candidate.plan_id),
      this.criterionEvidence(candidate.plan_id),
      this.items(candidate.plan_id),
      this.tests(candidate.plan_id, candidate.head_sha),
      this.effects(candidate.plan_id),
    ]);
    const acceptanceCriteria = await this.acceptanceCriteria(
      task,
      candidate,
      coverage,
      criterionEvidence,
    );
    if (tests.length === 0) throw new PullRequestDraftStoreError('state_conflict');
    const completedItems = items
      .filter((item) => item.progress_status === 'passed')
      .map((item) => ({ id: item.item_id, title: item.title }));
    const unfinishedItems = items
      .filter((item) => item.progress_status !== 'passed')
      .map((item) => ({
        id: item.item_id,
        title: item.title,
        status: item.progress_status as PullRequestDraftBodyInput['unfinishedItems'][number]['status'],
      }));
    const bodyInput: PullRequestDraftBodyInput = {
      source: {
        system: task.source.system,
        tenantKey: task.source.tenantKey,
        taskKey: task.source.taskKey,
        revision: task.source.revision,
        ...(task.source.url === undefined ? {} : { url: task.source.url }),
        title: task.intent.title,
      },
      repository: candidate.target_repository,
      plan: {
        id: candidate.plan_id,
        version: candidate.plan_version,
        digest: candidate.plan_digest,
        objective: candidate.plan_objective,
      },
      head: { branch: candidate.head_branch, sha: candidate.head_sha },
      completedItems,
      acceptanceCriteria,
      risks: this.risks(effects, unfinishedItems.length > 0),
      tests: tests.map((test) => ({
        evidenceId: test.evidence_id,
        commandRef: test.command_ref!,
        exitCode: test.exit_code!,
        durationMs: test.duration_ms!,
        headSha: test.sha!,
      })),
      unfinishedItems,
      rollback: effects.some((effect) => effect === 'test_deploy' || effect === 'production_deploy')
        ? `Revert bot commit ${candidate.head_sha}; reverse any deployment only through the repository-declared rollback contract.`
        : `Revert bot commit ${candidate.head_sha}; no deployment is part of this Draft PR.`,
    };
    let body: string;
    try {
      body = renderPullRequestDraftBody(bodyInput, { secrets: this.secrets });
    } catch (error) {
      if (error instanceof PullRequestDraftError) {
        if (error.code === 'secret_detected') {
          throw new PullRequestDraftStoreError('secret_detected');
        }
        if (error.code === 'body_too_large') {
          throw new PullRequestDraftStoreError('body_too_large');
        }
        throw new PullRequestDraftStoreError('state_conflict');
      }
      throw error;
    }
    const bodyDigest = await canonicalSha256(body);
    const identity = await canonicalSha256({
      runId: candidate.run_id,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      headSha: candidate.head_sha,
      bodyDigest,
    });
    const draftId = `pr_draft_${identity.slice('sha256:'.length, 'sha256:'.length + 52)}`;
    const criteria = await Promise.all(acceptanceCriteria.map(async (criterion) => ({
      index: criterion.index,
      criterionDigest: await canonicalSha256(criterion.text),
      evidenceIdsDigest: await canonicalSha256([...criterion.evidenceIds].sort()),
    })));
    const nowIso = now.toISOString();
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO pull_request_drafts (
           draft_id, run_id, run_version, task_id, task_revision, task_digest,
           plan_id, plan_version, plan_digest, attempt_id, head_update_id,
           head_sha, branch, body, body_digest, status, created_at
         )
         SELECT ?, runs.run_id, runs.version, tasks.task_id, tasks.task_revision,
                tasks.task_digest, execution_plans.plan_id,
                execution_plans.plan_version, execution_plans.digest,
                attempts.attempt_id, attempt_head_updates.update_id,
                attempt_head_updates.head_sha, attempt_head_updates.branch,
                ?, ?, 'prepared', ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         JOIN attempt_head_updates
           ON attempt_head_updates.run_id = runs.run_id
          AND attempt_head_updates.plan_id = execution_plans.plan_id
          AND attempt_head_updates.head_sha = ?
         JOIN attempts ON attempts.attempt_id = attempt_head_updates.attempt_id
         WHERE runs.run_id = ? AND runs.state = 'verifying' AND runs.version = ?
           AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
           AND execution_plans.plan_version = ? AND execution_plans.digest = ?
           AND execution_plans.status = 'active'
           AND attempts.status = 'completed'
           AND attempts.head_sha = attempt_head_updates.head_sha
           AND attempts.head_branch = attempt_head_updates.branch
           AND NOT EXISTS (
             SELECT 1 FROM plan_items
             JOIN plan_item_progress
               ON plan_item_progress.plan_id = plan_items.plan_id
              AND plan_item_progress.item_id = plan_items.item_id
             WHERE plan_items.plan_id = execution_plans.plan_id
               AND plan_items.required = 1
               AND plan_item_progress.status <> 'passed'
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        draftId,
        body,
        bodyDigest,
        nowIso,
        input.headSha,
        input.runId,
        input.expectedRunVersion,
        input.planVersion,
        input.planDigest,
        input.planVersion,
        input.planDigest,
      ),
      ...criteria.map((criterion) => this.db.prepare(
        `INSERT INTO pull_request_draft_criteria (
           draft_id, criterion_index, criterion_digest, status, evidence_ids_digest
         )
         SELECT ?, ?, ?, 'passed', ?
         WHERE EXISTS (
           SELECT 1 FROM pull_request_drafts
           WHERE draft_id = ? AND body_digest = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(
        draftId,
        criterion.index,
        criterion.criterionDigest,
        criterion.evidenceIdsDigest,
        draftId,
        bodyDigest,
      )),
      ...tests.map((test, position) => this.db.prepare(
        `INSERT INTO pull_request_draft_evidence (draft_id, position, evidence_id)
         SELECT ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM pull_request_drafts
           WHERE draft_id = ? AND body_digest = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(draftId, position, test.evidence_id, draftId, bodyDigest)),
      ...unfinishedItems.map((item, position) => this.db.prepare(
        `INSERT INTO pull_request_draft_unfinished_items (
           draft_id, position, item_id, status
         )
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM pull_request_drafts
           WHERE draft_id = ? AND body_digest = ?
         )
         ON CONFLICT DO NOTHING`,
      ).bind(draftId, position, item.id, item.status, draftId, bodyDigest)),
    ];
    const results = await this.db.batch(statements);
    return await this.result(
      draftId,
      input,
      bodyDigest,
      body,
      criteria,
      tests,
      unfinishedItems,
      results[0]?.meta.changes === 1,
    );
  }

  private async candidate(input: PreparePullRequestDraftInput): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha AS run_base_sha, runs.task_digest AS run_task_digest,
              runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              tasks.task_id, tasks.task_revision, tasks.task_digest,
              tasks.payload_ref, tasks.source_system, tasks.tenant_key,
              tasks.source_task_key, tasks.source_url, tasks.target_repository,
              tasks.target_base_branch, tasks.title AS task_title,
              tasks.acceptance_criteria_count,
              execution_plans.plan_id, execution_plans.plan_version,
              execution_plans.digest AS plan_digest,
              execution_plans.base_sha AS plan_base_sha,
              execution_plans.status AS plan_status,
              execution_plans.objective AS plan_objective,
              attempts.attempt_id, attempts.mode AS attempt_mode,
              attempts.status AS attempt_status, attempts.ordinal AS attempt_ordinal,
              attempts.head_sha AS attempt_head_sha,
              attempts.head_branch AS attempt_head_branch,
              attempt_head_updates.update_id AS head_update_id,
              attempt_head_updates.parent_sha AS head_parent_sha,
              attempt_head_updates.head_sha, attempt_head_updates.branch AS head_branch,
              commit_evidence.evidence_id AS commit_evidence_id,
              commit_evidence.kind AS commit_evidence_kind,
              commit_evidence.status AS commit_evidence_status,
              commit_evidence.sha AS commit_evidence_sha
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
       JOIN attempt_head_updates
         ON attempt_head_updates.run_id = runs.run_id
        AND attempt_head_updates.plan_id = execution_plans.plan_id
        AND attempt_head_updates.head_sha = ?
       JOIN attempts ON attempts.attempt_id = attempt_head_updates.attempt_id
       JOIN evidence AS commit_evidence
         ON commit_evidence.evidence_id = attempt_head_updates.evidence_id
       WHERE runs.run_id = ?
         AND attempts.ordinal = (
           SELECT MAX(latest.ordinal) FROM attempts AS latest
           WHERE latest.run_id = runs.run_id
             AND latest.mode IN ('implement', 'review_fix')
         )
       ORDER BY attempts.ordinal DESC
       LIMIT 1`,
    ).bind(input.headSha, input.runId).first<CandidateRow>();
  }

  private async assertCandidate(
    row: CandidateRow,
    input: PreparePullRequestDraftInput,
  ): Promise<void> {
    if (
      row.run_state !== 'verifying' ||
      row.run_version !== input.expectedRunVersion ||
      row.run_base_sha === null ||
      row.run_task_digest !== row.task_digest ||
      row.active_plan_id !== row.plan_id ||
      row.active_plan_version !== input.planVersion ||
      row.active_plan_digest !== input.planDigest ||
      row.plan_version !== input.planVersion ||
      row.plan_digest !== input.planDigest ||
      row.plan_status !== 'active' ||
      row.plan_base_sha !== row.run_base_sha ||
      (row.attempt_mode !== 'implement' && row.attempt_mode !== 'review_fix') ||
      row.attempt_status !== 'completed' ||
      row.attempt_head_sha !== input.headSha ||
      row.attempt_head_branch !== row.head_branch ||
      row.head_branch !== `agent/${row.task_id}/${row.attempt_id}` ||
      row.head_sha !== input.headSha ||
      row.head_parent_sha === row.head_sha ||
      row.commit_evidence_kind !== 'commit' ||
      row.commit_evidence_status !== 'passed' ||
      row.commit_evidence_sha !== row.head_sha ||
      row.acceptance_criteria_count <= 0
    ) {
      throw new PullRequestDraftStoreError('state_conflict');
    }
    const readiness = await this.db.prepare(
      `SELECT
         SUM(CASE WHEN plan_items.required = 1 THEN 1 ELSE 0 END) AS required_count,
         SUM(CASE WHEN plan_items.required = 1 AND plan_item_progress.status = 'passed'
                  THEN 1 ELSE 0 END) AS passed_count,
         SUM(CASE WHEN plan_item_progress.protected_path_gate_id IS NOT NULL
                  THEN 1 ELSE 0 END) AS gate_count,
         SUM(CASE WHEN plan_items.required = 1 AND NOT EXISTS (
           SELECT 1 FROM plan_item_verifications
           WHERE plan_item_verifications.plan_id = plan_items.plan_id
             AND plan_item_verifications.plan_item_id = plan_items.item_id
             AND plan_item_verifications.status = 'passed'
         ) THEN 1 ELSE 0 END) AS missing_verification_count
       FROM plan_items
       JOIN plan_item_progress
         ON plan_item_progress.plan_id = plan_items.plan_id
        AND plan_item_progress.item_id = plan_items.item_id
       WHERE plan_items.plan_id = ?`,
    ).bind(row.plan_id).first<{
      required_count: number;
      passed_count: number;
      gate_count: number;
      missing_verification_count: number;
    }>();
    if (
      readiness === null ||
      readiness.required_count <= 0 ||
      readiness.passed_count !== readiness.required_count ||
      readiness.gate_count !== 0 ||
      readiness.missing_verification_count !== 0
    ) {
      throw new PullRequestDraftStoreError('state_conflict');
    }
  }

  private async task(row: CandidateRow): Promise<TaskEnvelope> {
    if (!row.payload_ref.startsWith('r2://')) {
      throw new PullRequestDraftStoreError('task_payload_conflict');
    }
    const key = row.payload_ref.slice('r2://'.length);
    if (key.length === 0 || key.includes('..')) {
      throw new PullRequestDraftStoreError('task_payload_conflict');
    }
    const object = await this.taskObjects.get(key);
    if (object === null) throw new PullRequestDraftStoreError('task_payload_unavailable');
    let task: TaskEnvelope;
    try {
      task = TaskEnvelopeSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new PullRequestDraftStoreError('task_payload_conflict');
    }
    if (
      await taskRevisionDigest(task) !== row.task_digest ||
      object.customMetadata?.taskDigest !== row.task_digest ||
      task.source.system !== row.source_system ||
      task.source.tenantKey !== row.tenant_key ||
      task.source.taskKey !== row.source_task_key ||
      task.source.revision !== row.task_revision ||
      (task.source.url ?? null) !== row.source_url ||
      task.intent.title !== row.task_title ||
      task.intent.acceptanceCriteria.length !== row.acceptance_criteria_count ||
      `${task.target.owner}/${task.target.repo}` !== row.target_repository ||
      task.target.baseBranch !== row.target_base_branch
    ) {
      throw new PullRequestDraftStoreError('task_payload_conflict');
    }
    return task;
  }

  private async coverage(planId: string): Promise<CoverageRow[]> {
    const result = await this.db.prepare(
      `SELECT plan_item_acceptance_criteria.acceptance_criterion_index AS criterion_index,
              plan_items.item_id, plan_item_progress.status AS progress_status,
              plan_item_verifications.verification_id
       FROM plan_item_acceptance_criteria
       JOIN plan_items
         ON plan_items.plan_id = plan_item_acceptance_criteria.plan_id
        AND plan_items.item_id = plan_item_acceptance_criteria.item_id
       JOIN plan_item_progress
         ON plan_item_progress.plan_id = plan_items.plan_id
        AND plan_item_progress.item_id = plan_items.item_id
       LEFT JOIN plan_item_verifications
         ON plan_item_verifications.plan_id = plan_items.plan_id
        AND plan_item_verifications.plan_item_id = plan_items.item_id
        AND plan_item_verifications.status = 'passed'
       WHERE plan_items.plan_id = ? AND plan_items.required = 1
       ORDER BY criterion_index, plan_items.position`,
    ).bind(planId).all<CoverageRow>();
    if (!result.success) throw new PullRequestDraftStoreError('state_conflict');
    return result.results;
  }

  private async criterionEvidence(planId: string): Promise<CriterionEvidenceRow[]> {
    const result = await this.db.prepare(
      `SELECT DISTINCT
              plan_item_acceptance_criteria.acceptance_criterion_index AS criterion_index,
              evidence.evidence_id
       FROM plan_item_acceptance_criteria
       JOIN plan_item_verifications
         ON plan_item_verifications.plan_id = plan_item_acceptance_criteria.plan_id
        AND plan_item_verifications.plan_item_id = plan_item_acceptance_criteria.item_id
        AND plan_item_verifications.status = 'passed'
       JOIN plan_item_done_when_evidence
         ON plan_item_done_when_evidence.verification_id = plan_item_verifications.verification_id
       JOIN evidence ON evidence.evidence_id = plan_item_done_when_evidence.evidence_id
       WHERE plan_item_acceptance_criteria.plan_id = ?
         AND evidence.status = 'passed' AND evidence.verification_status = 'verified'
       ORDER BY criterion_index, evidence.evidence_id`,
    ).bind(planId).all<CriterionEvidenceRow>();
    if (!result.success) throw new PullRequestDraftStoreError('state_conflict');
    return result.results;
  }

  private async acceptanceCriteria(
    task: TaskEnvelope,
    candidate: CandidateRow,
    coverage: CoverageRow[],
    criterionEvidence: CriterionEvidenceRow[],
  ): Promise<PullRequestDraftBodyInput['acceptanceCriteria']> {
    return task.intent.acceptanceCriteria.map((text, index) => {
      const covered = coverage.filter((row) => row.criterion_index === index);
      const evidenceIds = criterionEvidence
        .filter((row) => row.criterion_index === index)
        .map((row) => row.evidence_id);
      if (
        covered.length === 0 ||
        covered.some((row) => row.progress_status !== 'passed' || row.verification_id === null) ||
        evidenceIds.length === 0 ||
        index >= candidate.acceptance_criteria_count
      ) {
        throw new PullRequestDraftStoreError('state_conflict');
      }
      return { index, text, status: 'passed' as const, evidenceIds };
    });
  }

  private async items(planId: string): Promise<ItemRow[]> {
    const result = await this.db.prepare(
      `SELECT plan_items.item_id, plan_items.title,
              plan_item_progress.status AS progress_status
       FROM plan_items
       JOIN plan_item_progress
         ON plan_item_progress.plan_id = plan_items.plan_id
        AND plan_item_progress.item_id = plan_items.item_id
       WHERE plan_items.plan_id = ?
       ORDER BY plan_items.position`,
    ).bind(planId).all<ItemRow>();
    if (!result.success || result.results.length === 0) {
      throw new PullRequestDraftStoreError('state_conflict');
    }
    return result.results;
  }

  private async tests(planId: string, headSha: string): Promise<TestRow[]> {
    const result = await this.db.prepare(
      `SELECT evidence.evidence_id, evidence.command_ref, evidence.exit_code,
              evidence.duration_ms, evidence.sha
       FROM verification_suites
       JOIN verification_suite_commands
         ON verification_suite_commands.suite_id = verification_suites.suite_id
        AND verification_suite_commands.result_status = 'passed'
       JOIN evidence ON evidence.evidence_id = verification_suite_commands.evidence_id
       WHERE verification_suites.plan_id = ?
         AND verification_suites.head_sha = ?
         AND verification_suites.status = 'completed'
         AND evidence.kind = 'test' AND evidence.status = 'passed'
         AND evidence.verification_status = 'verified'
         AND evidence.sha = verification_suites.head_sha
         AND evidence.command_ref IS NOT NULL
         AND evidence.exit_code = 0 AND evidence.duration_ms IS NOT NULL
       ORDER BY verification_suites.created_at, verification_suite_commands.position`,
    ).bind(planId, headSha).all<TestRow>();
    if (
      !result.success ||
      result.results.some((row) =>
        row.command_ref === null ||
        row.exit_code !== 0 ||
        row.duration_ms === null ||
        row.sha !== headSha)
    ) {
      throw new PullRequestDraftStoreError('state_conflict');
    }
    return result.results;
  }

  private async effects(planId: string): Promise<string[]> {
    const result = await this.db.prepare(
      `SELECT DISTINCT effect FROM plan_item_effects
       WHERE plan_id = ? ORDER BY effect`,
    ).bind(planId).all<{ effect: string }>();
    if (!result.success) throw new PullRequestDraftStoreError('state_conflict');
    return result.results.map((row) => row.effect);
  }

  private risks(effects: string[], hasUnfinishedItems: boolean): string[] {
    const risks = ['Review the exact repository diff and required checks before merge.'];
    if (effects.includes('repo_write')) {
      risks.push('Repository write changes application behavior; merge remains human-controlled.');
    }
    if (effects.includes('test_deploy')) risks.push('A test deployment effect is declared but not performed by this Draft PR.');
    if (effects.includes('production_deploy')) risks.push('Production deployment requires a separate protected approval and is not performed here.');
    if (hasUnfinishedItems) risks.push('Optional Plan items remain unfinished and are listed below.');
    return risks;
  }

  private async result(
    draftId: string,
    input: PreparePullRequestDraftInput,
    bodyDigest: string,
    body: string,
    criteria: Array<{ index: number; criterionDigest: string; evidenceIdsDigest: string }>,
    tests: TestRow[],
    unfinishedItems: PullRequestDraftBodyInput['unfinishedItems'],
    created: boolean,
  ): Promise<PullRequestDraftResult> {
    const row = await this.db.prepare(
      `SELECT draft_id, run_id, plan_id, plan_version, head_sha, branch,
              body_digest, body, status
       FROM pull_request_drafts WHERE draft_id = ?`,
    ).bind(draftId).first<DraftRow>();
    if (
      row === null ||
      row.run_id !== input.runId ||
      row.plan_version !== input.planVersion ||
      row.head_sha !== input.headSha ||
      row.body_digest !== bodyDigest ||
      row.body !== body ||
      row.status !== 'prepared'
    ) {
      throw new PullRequestDraftStoreError('state_conflict');
    }
    const [persistedCriteria, persistedEvidence, persistedUnfinished] = await Promise.all([
      this.db.prepare(
        `SELECT criterion_index, criterion_digest, status, evidence_ids_digest
         FROM pull_request_draft_criteria WHERE draft_id = ? ORDER BY criterion_index`,
      ).bind(draftId).all<ChildCriterionRow>(),
      this.db.prepare(
        `SELECT position, evidence_id FROM pull_request_draft_evidence
         WHERE draft_id = ? ORDER BY position`,
      ).bind(draftId).all<ChildEvidenceRow>(),
      this.db.prepare(
        `SELECT position, item_id, status FROM pull_request_draft_unfinished_items
         WHERE draft_id = ? ORDER BY position`,
      ).bind(draftId).all<ChildUnfinishedRow>(),
    ]);
    if (
      !persistedCriteria.success ||
      persistedCriteria.results.length !== criteria.length ||
      persistedCriteria.results.some((entry, index) =>
        entry.criterion_index !== criteria[index]?.index ||
        entry.criterion_digest !== criteria[index]?.criterionDigest ||
        entry.status !== 'passed' ||
        entry.evidence_ids_digest !== criteria[index]?.evidenceIdsDigest) ||
      !persistedEvidence.success ||
      persistedEvidence.results.length !== tests.length ||
      persistedEvidence.results.some((entry, index) =>
        entry.position !== index || entry.evidence_id !== tests[index]?.evidence_id) ||
      !persistedUnfinished.success ||
      persistedUnfinished.results.length !== unfinishedItems.length ||
      persistedUnfinished.results.some((entry, index) =>
        entry.position !== index ||
        entry.item_id !== unfinishedItems[index]?.id ||
        entry.status !== unfinishedItems[index]?.status)
    ) {
      throw new PullRequestDraftStoreError('state_conflict');
    }
    return {
      draftId: row.draft_id,
      created,
      status: 'prepared',
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      headSha: row.head_sha,
      branch: row.branch,
      bodyDigest: row.body_digest,
      body: row.body,
    };
  }
}
