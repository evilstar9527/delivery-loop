import { canonicalSha256 } from '../domain/digest.js';
import {
  AutomatedReviewIdSchema,
  AutomatedReviewContextV1Schema,
  AutomatedReviewResultV1Schema,
  automatedReviewContextDigest,
  blockingFindingCount,
  minorFindingCount,
  renderAutomatedReviewFeedback,
  type AutomatedReviewContextV1,
  type AutomatedReviewResultV1,
} from '../domain/automated-review.js';
import { TaskEnvelopeSchema, taskRevisionDigest, type TaskEnvelope } from '../domain/task.js';
import { SecretScanner } from '../security/redaction.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_REVIEW_ITERATIONS = 3;

export type AutomatedReviewErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'approval_required'
  | 'task_payload_unavailable'
  | 'task_payload_conflict'
  | 'secret_detected'
  | 'storage_unavailable';

export class AutomatedReviewError extends Error {
  constructor(readonly code: AutomatedReviewErrorCode) {
    super(`automated review failed: ${code}`);
    this.name = 'AutomatedReviewError';
  }
}

interface ScheduleCandidateRow {
  publication_id: string;
  run_id: string;
  run_version: number;
  task_id: string;
  task_revision: string;
  repository: string;
  base_branch: string;
  github_pr_number: number | null;
  github_pr_url: string | null;
  head_branch: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  plan_item_id: string;
  progress_status: string;
  progress_version: number;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
  prior_attempt_id: string;
  prior_ordinal: number;
  prior_mode: string;
  prior_status: string;
  prior_base_sha: string;
  prior_head_sha: string | null;
  prior_head_branch: string | null;
  current_head_sha: string;
  workflow_ref: string | null;
  iteration: number;
  active_approval_count: number;
  unresolved_blocker_count: number;
}

interface ReviewRow {
  review_id: string;
  run_id: string;
  publication_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  prior_attempt_id: string;
  review_attempt_id: string;
  repository: string;
  github_pr_number: number;
  base_branch: string;
  branch: string;
  source_head_sha: string;
  iteration: number;
  status: 'pending' | 'approved' | 'changes_requested' | 'blocked';
  result_ref: string | null;
  result_digest: string | null;
  feedback_body_digest: string | null;
  blocking_finding_count: number | null;
  minor_finding_count: number | null;
}

interface ContextRow extends ReviewRow {
  attempt_status: string;
  attempt_version: number;
  attempt_lease_generation: number;
  attempt_base_sha: string;
  attempt_repository: string | null;
  run_state: string;
  run_task_revision: string;
  run_task_digest: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  task_payload_ref: string;
  task_target_repository: string;
  task_target_base_branch: string;
  plan_digest: string;
  plan_objective: string;
  plan_status: string;
  item_title: string;
  item_objective: string;
  progress_status: string;
  progress_active_attempt_id: string | null;
  latest_head_sha: string | null;
}

export interface CurrentAutomatedReviewStatus {
  iteration: number;
  status: 'pending' | 'approved' | 'changes_requested' | 'blocked';
  blockingFindingCount?: number;
  minorFindingCount?: number;
}

/** Reads the bounded review status only when it belongs to the verified current PR head. */
export class AutomatedReviewStatusStore {
  constructor(private readonly db: D1Database) {}

  async current(runId: string): Promise<CurrentAutomatedReviewStatus | null> {
    const row = await this.db.prepare(
      `SELECT reviews.iteration, reviews.status, reviews.blocking_finding_count,
              reviews.minor_finding_count
       FROM automated_reviews AS reviews
       JOIN pull_request_publications AS publications
         ON publications.publication_id = reviews.publication_id
       JOIN attempt_head_updates AS updates ON updates.update_id = (
         SELECT candidate.update_id
         FROM attempt_head_updates AS candidate
         JOIN attempts AS attempt ON attempt.attempt_id = candidate.attempt_id
         WHERE candidate.run_id = reviews.run_id
           AND candidate.plan_id = reviews.plan_id
           AND candidate.branch = publications.head_branch
         ORDER BY attempt.ordinal DESC, candidate.created_at DESC LIMIT 1
       )
       WHERE reviews.run_id = ? AND publications.status = 'verified'
         AND reviews.branch = publications.head_branch
         AND reviews.source_head_sha = updates.head_sha
       ORDER BY publications.updated_at DESC LIMIT 1`,
    ).bind(runId).first<Pick<ReviewRow,
      'iteration' | 'status' | 'blocking_finding_count' | 'minor_finding_count'>>();
    if (row === null) return null;
    return {
      iteration: row.iteration,
      status: row.status,
      ...(row.blocking_finding_count === null
        ? {} : { blockingFindingCount: row.blocking_finding_count }),
      ...(row.minor_finding_count === null
        ? {} : { minorFindingCount: row.minor_finding_count }),
    };
  }
}

export interface AutomatedReviewScheduleResult {
  reviewId: string;
  attemptId: string;
  outboxId: string;
  runId: string;
  headSha: string;
  iteration: number;
  created: boolean;
}

export interface AutomatedReviewCompletionResult {
  reviewId: string;
  status: 'approved' | 'changes_requested' | 'blocked';
  fixAttemptId?: string;
  created: boolean;
}

function suffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 52);
}

/** Claims one verified Draft PR head for a read-only automated review Attempt. */
export class AutomatedReviewScheduler {
  constructor(private readonly db: D1Database) {}

  async resumeFixedRuns(limit = 5, now = new Date()): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 25) {
      throw new Error('automated review limit must be between 1 and 25');
    }
    const candidates = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, plans.plan_id,
              plans.plan_version, plans.digest AS plan_digest,
              fixes.fix_attempt_id, updates.head_sha
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN automated_review_fix_attempts AS fixes ON fixes.fix_attempt_id = (
         SELECT attempt_id FROM attempts
         WHERE attempts.run_id = runs.run_id AND attempts.mode = 'review_fix'
           AND attempts.status = 'completed'
         ORDER BY attempts.ordinal DESC LIMIT 1
       )
       JOIN automated_reviews AS reviews ON reviews.review_id = fixes.review_id
       JOIN attempts ON attempts.attempt_id = fixes.fix_attempt_id
       JOIN attempt_head_updates AS updates ON updates.attempt_id = fixes.fix_attempt_id
       JOIN pull_request_publications AS publications
         ON publications.publication_id = reviews.publication_id
       WHERE runs.state = 'executing' AND plans.status = 'active'
         AND runs.active_plan_version = plans.plan_version
         AND runs.active_plan_digest = plans.digest
         AND reviews.status = 'changes_requested'
         AND reviews.run_id = runs.run_id AND reviews.plan_id = plans.plan_id
         AND reviews.plan_version = plans.plan_version
         AND reviews.source_head_sha = fixes.source_head_sha
         AND updates.parent_sha = fixes.source_head_sha
         AND updates.branch = fixes.branch AND attempts.head_sha = updates.head_sha
         AND attempts.head_branch = updates.branch
         AND publications.status = 'verified'
         AND publications.head_branch = fixes.branch
         AND NOT EXISTS (
           SELECT 1 FROM plan_items
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_items.plan_id
            AND plan_item_progress.item_id = plan_items.item_id
           WHERE plan_items.plan_id = plans.plan_id AND plan_items.required = 1
             AND plan_item_progress.status <> 'passed'
         )
         AND NOT EXISTS (
           SELECT 1 FROM run_blockers
           WHERE run_blockers.run_id = runs.run_id AND run_blockers.resolved_at IS NULL
         )
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{
      run_id: string;
      run_version: number;
      plan_id: string;
      plan_version: number;
      plan_digest: string;
      fix_attempt_id: string;
      head_sha: string;
    }>();
    let resumed = 0;
    for (const candidate of candidates.results) {
      const result = await this.db.prepare(
        `UPDATE runs SET state = 'pull_request_open', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'executing' AND version = ?
           AND active_plan_id = ? AND active_plan_version = ? AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM attempts
             JOIN automated_review_fix_attempts AS fixes
               ON fixes.fix_attempt_id = attempts.attempt_id
             JOIN automated_reviews AS reviews ON reviews.review_id = fixes.review_id
             JOIN attempt_head_updates AS updates ON updates.attempt_id = attempts.attempt_id
             WHERE attempts.attempt_id = ? AND attempts.status = 'completed'
               AND attempts.head_sha = ? AND updates.head_sha = ?
               AND reviews.status = 'changes_requested'
           )
           AND NOT EXISTS (
             SELECT 1 FROM plan_items
             JOIN plan_item_progress
               ON plan_item_progress.plan_id = plan_items.plan_id
              AND plan_item_progress.item_id = plan_items.item_id
             WHERE plan_items.plan_id = ? AND plan_items.required = 1
               AND plan_item_progress.status <> 'passed'
           )`,
      ).bind(
        now.toISOString(),
        candidate.run_id,
        candidate.run_version,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.fix_attempt_id,
        candidate.head_sha,
        candidate.head_sha,
        candidate.plan_id,
      ).run();
      resumed += result.meta.changes;
    }
    return resumed;
  }

  async scheduleBatch(limit = 5, now = new Date()): Promise<AutomatedReviewScheduleResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 25) {
      throw new Error('automated review limit must be between 1 and 25');
    }
    const rows = await this.db.prepare(
      `SELECT runs.run_id
       FROM runs
       JOIN pull_request_publications AS publications
         ON publications.run_id = runs.run_id AND publications.status = 'verified'
       WHERE runs.state = 'pull_request_open'
         AND NOT EXISTS (
           SELECT 1 FROM run_blockers
           WHERE run_blockers.run_id = runs.run_id AND run_blockers.resolved_at IS NULL
         )
       GROUP BY runs.run_id
       ORDER BY MIN(publications.updated_at), runs.run_id
       LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: AutomatedReviewScheduleResult[] = [];
    for (const row of rows.results) {
      const result = await this.scheduleRun(row.run_id, now);
      if (result !== null) results.push(result);
    }
    return results;
  }

  async scheduleRun(runId: string, now = new Date()): Promise<AutomatedReviewScheduleResult | null> {
    if (!ID_PATTERN.test(runId)) throw new AutomatedReviewError('invalid_request');
    const candidate = await this.candidate(runId, now.toISOString());
    if (candidate === null || !this.eligible(candidate)) return null;
    const identity = await canonicalSha256({
      schemaVersion: '1',
      runId: candidate.run_id,
      publicationId: candidate.publication_id,
      planId: candidate.plan_id,
      planVersion: candidate.plan_version,
      itemId: candidate.plan_item_id,
      priorAttemptId: candidate.prior_attempt_id,
      headSha: candidate.current_head_sha,
      iteration: candidate.iteration,
    });
    const stable = suffix(identity);
    const reviewId = AutomatedReviewIdSchema.parse(`automated_review_${stable}`);
    const attemptId = `attempt_auto_review_${stable}`;
    const outboxId = `dispatch_auto_review_${stable}`;
    const nowIso = now.toISOString();
    const batch = await this.db.batch([
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT ?, runs.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = runs.run_id),
                'analysis', 'pending', ?, ?, ?, 0, 0, ?, ?
         FROM runs
         JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = plans.plan_id AND progress.item_id = ?
         WHERE runs.run_id = ? AND runs.state = 'pull_request_open' AND runs.version = ?
           AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
           AND plans.status = 'active' AND progress.status = 'passed'
           AND progress.active_attempt_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM automated_reviews
             WHERE publication_id = ? AND source_head_sha = ?
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        attemptId,
        candidate.current_head_sha,
        candidate.repository,
        candidate.workflow_ref,
        nowIso,
        nowIso,
        candidate.plan_item_id,
        candidate.run_id,
        candidate.run_version,
        candidate.plan_version,
        candidate.plan_digest,
        candidate.publication_id,
        candidate.current_head_sha,
      ),
      this.db.prepare(
        `INSERT INTO automated_reviews (
           review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
           prior_attempt_id, review_attempt_id, repository, github_pr_number,
           base_branch, branch, source_head_sha, iteration, status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, attempts.attempt_id, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
         FROM attempts
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?
           AND attempts.mode = 'analysis' AND attempts.status = 'pending'
         ON CONFLICT DO NOTHING`,
      ).bind(
        reviewId,
        candidate.run_id,
        candidate.publication_id,
        candidate.plan_id,
        candidate.plan_version,
        candidate.plan_item_id,
        candidate.prior_attempt_id,
        candidate.repository,
        candidate.github_pr_number,
        candidate.base_branch,
        candidate.head_branch,
        candidate.current_head_sha,
        candidate.iteration,
        nowIso,
        nowIso,
        attemptId,
        candidate.run_id,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, run_id, 'analysis_dispatch', 'github_actions', ?, ?, 'pending', ?, ?
         FROM automated_reviews
         WHERE review_id = ? AND review_attempt_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${attemptId}`,
        `automated-review:${reviewId}`,
        nowIso,
        nowIso,
        reviewId,
        attemptId,
      ),
    ]);
    const persisted = await this.byHead(candidate.publication_id, candidate.current_head_sha);
    if (persisted === null) return null;
    if (persisted.review_id !== reviewId || persisted.review_attempt_id !== attemptId) {
      throw new AutomatedReviewError('state_conflict');
    }
    const outbox = await this.db.prepare(
      `SELECT outbox_id FROM outbox
       WHERE outbox_id = ? AND payload_ref = ? AND delivery_state IN ('pending', 'delivering', 'settled')`,
    ).bind(outboxId, `d1://attempts/${attemptId}`).first<{ outbox_id: string }>();
    if (outbox?.outbox_id !== outboxId) throw new AutomatedReviewError('state_conflict');
    return {
      reviewId,
      attemptId,
      outboxId,
      runId: candidate.run_id,
      headSha: candidate.current_head_sha,
      iteration: candidate.iteration,
      created: batch[1]?.meta.changes === 1,
    };
  }

  private async candidate(runId: string, nowIso: string): Promise<ScheduleCandidateRow | null> {
    return await this.db.prepare(
      `SELECT publications.publication_id, runs.run_id,
              runs.version AS run_version, tasks.task_id, runs.task_revision,
              publications.repository, publications.base_branch,
              publications.github_pr_number, publications.github_pr_url,
              publications.head_branch,
              plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
              plans.status AS plan_status, prior.plan_item_id,
              progress.status AS progress_status, progress.version AS progress_version,
              progress.active_attempt_id, progress.protected_path_gate_id,
              prior.attempt_id AS prior_attempt_id, prior.ordinal AS prior_ordinal,
              prior.mode AS prior_mode, prior.status AS prior_status,
              prior.base_sha AS prior_base_sha, prior.head_sha AS prior_head_sha,
              prior.head_branch AS prior_head_branch,
              head_updates.head_sha AS current_head_sha, prior.workflow_ref,
              (SELECT COUNT(*) + 1 FROM automated_reviews AS previous
               WHERE previous.run_id = runs.run_id AND previous.plan_id = plans.plan_id
                 AND previous.status IN ('changes_requested', 'blocked')) AS iteration,
              (SELECT COUNT(*) FROM trusted_effect_approvals AS approval
               WHERE approval.run_id = runs.run_id
                 AND approval.task_revision = runs.task_revision
                 AND approval.plan_id = plans.plan_id
                 AND approval.plan_version = plans.plan_version
                 AND approval.plan_digest = plans.digest
                 AND approval.base_sha = runs.base_sha
                 AND approval.effect = 'repo_write'
                 AND approval.decision = 'approve' AND approval.expires_at > ?
                 AND NOT EXISTS (
                   SELECT 1 FROM invalidated_approvals
                   WHERE invalidated_approvals.approval_id = approval.approval_id
                 )) AS active_approval_count,
              (SELECT COUNT(*) FROM run_blockers
               WHERE run_blockers.run_id = runs.run_id
                 AND run_blockers.resolved_at IS NULL) AS unresolved_blocker_count
       FROM pull_request_publications AS publications
       JOIN runs ON runs.run_id = publications.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN attempt_head_updates AS head_updates
         ON head_updates.update_id = (
           SELECT candidate.update_id FROM attempt_head_updates AS candidate
           JOIN attempts AS candidate_attempt ON candidate_attempt.attempt_id = candidate.attempt_id
           WHERE candidate.run_id = runs.run_id AND candidate.plan_id = plans.plan_id
             AND candidate.branch = publications.head_branch
           ORDER BY candidate_attempt.ordinal DESC, candidate.created_at DESC LIMIT 1
         )
       JOIN attempts AS prior ON prior.attempt_id = head_updates.attempt_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = prior.plan_id AND progress.item_id = prior.plan_item_id
       WHERE runs.run_id = ? AND runs.state = 'pull_request_open'
         AND publications.status = 'verified'
         AND publications.github_pr_number IS NOT NULL
         AND publications.github_pr_url IS NOT NULL
       ORDER BY publications.updated_at DESC LIMIT 1`,
    ).bind(nowIso, runId).first<ScheduleCandidateRow>();
  }

  private eligible(row: ScheduleCandidateRow): boolean {
    return row.plan_status === 'active' &&
      row.github_pr_number !== null && row.github_pr_url !== null &&
      row.iteration >= 1 && row.iteration <= MAX_REVIEW_ITERATIONS &&
      (row.prior_mode === 'implement' || row.prior_mode === 'review_fix') &&
      row.prior_status === 'completed' &&
      row.prior_head_sha === row.current_head_sha &&
      row.prior_head_branch === row.head_branch &&
      row.workflow_ref !== null &&
      row.progress_status === 'passed' && row.active_attempt_id === null &&
      row.protected_path_gate_id === null &&
      row.active_approval_count === 1 && row.unresolved_blocker_count === 0 &&
      SHA_PATTERN.test(row.current_head_sha);
  }

  private async byHead(publicationId: string, headSha: string): Promise<ReviewRow | null> {
    return await this.db.prepare(
      `SELECT * FROM automated_reviews WHERE publication_id = ? AND source_head_sha = ?`,
    ).bind(publicationId, headSha).first<ReviewRow>();
  }
}

/** Rehydrates the exact immutable Task/Plan/PR snapshot for a read-only review. */
export class AutomatedReviewContextStore {
  constructor(
    private readonly db: D1Database,
    private readonly taskObjects: R2Bucket,
  ) {}

  async get(authorization: RunnerAuthorization): Promise<AutomatedReviewContextV1 | null> {
    const row = await this.row(authorization.attemptId);
    if (row === null) return null;
    this.assertRow(row, authorization);
    const task = await this.task(row);
    const [doneWhen, commandRefs] = await Promise.all([
      this.strings(
        `SELECT condition AS value FROM plan_item_done_when
         WHERE plan_id = ? AND item_id = ? ORDER BY position`,
        row.plan_id,
        row.plan_item_id,
      ),
      this.strings(
        `SELECT command_ref AS value FROM plan_item_command_refs
         WHERE plan_id = ? AND item_id = ? ORDER BY command_ref`,
        row.plan_id,
        row.plan_item_id,
      ),
    ]);
    return AutomatedReviewContextV1Schema.parse({
      schemaVersion: '1',
      kind: 'automated_review',
      attempt: {
        id: row.review_attempt_id,
        runId: row.run_id,
        mode: 'analysis',
        version: row.attempt_version,
        leaseGeneration: row.attempt_lease_generation,
        baseSha: row.attempt_base_sha,
      },
      review: {
        id: row.review_id,
        iteration: row.iteration,
        publicationId: row.publication_id,
        repository: row.repository,
        pullRequestNumber: row.github_pr_number,
        baseBranch: row.base_branch,
        headBranch: row.branch,
        headSha: row.source_head_sha,
      },
      task: {
        revision: task.source.revision,
        digest: row.run_task_digest,
        title: task.intent.title,
        description: task.intent.description,
        acceptanceCriteria: task.intent.acceptanceCriteria,
      },
      plan: {
        id: row.plan_id,
        version: row.plan_version,
        digest: row.plan_digest,
        objective: row.plan_objective,
        item: {
          id: row.plan_item_id,
          title: row.item_title,
          objective: row.item_objective,
          doneWhen,
          commandRefs,
        },
      },
    });
  }

  private async row(attemptId: string): Promise<ContextRow | null> {
    return await this.db.prepare(
      `SELECT reviews.*,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation AS attempt_lease_generation,
              attempts.base_sha AS attempt_base_sha,
              attempts.repository AS attempt_repository,
              runs.state AS run_state, runs.task_revision AS run_task_revision,
              runs.task_digest AS run_task_digest, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              tasks.payload_ref AS task_payload_ref,
              tasks.target_repository AS task_target_repository,
              tasks.target_base_branch AS task_target_base_branch,
              plans.digest AS plan_digest, plans.objective AS plan_objective,
              plans.status AS plan_status,
              items.title AS item_title, items.objective AS item_objective,
              progress.status AS progress_status,
              progress.active_attempt_id AS progress_active_attempt_id,
              (SELECT updates.head_sha
               FROM attempt_head_updates AS updates
               JOIN attempts AS head_attempt ON head_attempt.attempt_id = updates.attempt_id
               WHERE updates.run_id = reviews.run_id
                 AND updates.plan_id = reviews.plan_id
                 AND updates.branch = reviews.branch
               ORDER BY head_attempt.ordinal DESC, updates.created_at DESC
               LIMIT 1) AS latest_head_sha
       FROM automated_reviews AS reviews
       JOIN attempts ON attempts.attempt_id = reviews.review_attempt_id
       JOIN runs ON runs.run_id = reviews.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = reviews.plan_id
       JOIN plan_items AS items
         ON items.plan_id = reviews.plan_id AND items.item_id = reviews.plan_item_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = reviews.plan_id AND progress.item_id = reviews.plan_item_id
       WHERE reviews.review_attempt_id = ?`,
    ).bind(attemptId).first<ContextRow>();
  }

  private assertRow(row: ContextRow, authorization: RunnerAuthorization): void {
    if (
      authorization.mode !== 'analysis' || row.review_attempt_id !== authorization.attemptId ||
      row.run_id !== authorization.runId || row.attempt_status !== 'running' ||
      row.attempt_version !== authorization.version ||
      row.attempt_lease_generation !== authorization.leaseGeneration ||
      row.status !== 'pending' || row.run_state !== 'pull_request_open' ||
      row.attempt_base_sha !== row.source_head_sha ||
      row.attempt_repository !== row.repository ||
      row.task_target_repository !== row.repository ||
      row.task_target_base_branch !== row.base_branch ||
      row.active_plan_id !== row.plan_id || row.active_plan_version !== row.plan_version ||
      row.active_plan_digest !== row.plan_digest || row.plan_status !== 'active' ||
      row.progress_status !== 'passed' || row.progress_active_attempt_id !== null
      || row.latest_head_sha !== row.source_head_sha
    ) throw new AutomatedReviewError('state_conflict');
  }

  private async task(row: ContextRow): Promise<TaskEnvelope> {
    if (!row.task_payload_ref.startsWith('r2://')) {
      throw new AutomatedReviewError('task_payload_conflict');
    }
    const key = row.task_payload_ref.slice('r2://'.length);
    if (key.length === 0 || key.includes('..')) {
      throw new AutomatedReviewError('task_payload_conflict');
    }
    const object = await this.taskObjects.get(key);
    if (object === null) throw new AutomatedReviewError('task_payload_unavailable');
    let task: TaskEnvelope;
    try {
      task = TaskEnvelopeSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new AutomatedReviewError('task_payload_conflict');
    }
    if (
      await taskRevisionDigest(task) !== row.run_task_digest ||
      object.customMetadata?.taskDigest !== row.run_task_digest ||
      task.source.revision !== row.run_task_revision ||
      `${task.target.owner}/${task.target.repo}` !== row.repository ||
      task.target.baseBranch !== row.base_branch
    ) throw new AutomatedReviewError('task_payload_conflict');
    return task;
  }

  private async strings(sql: string, planId: string, itemId: string): Promise<string[]> {
    const result = await this.db.prepare(sql).bind(planId, itemId).all<{ value: string }>();
    if (!result.success) throw new AutomatedReviewError('state_conflict');
    return result.results.map((row) => row.value);
  }
}

/** Persists a head-bound review verdict and opens at most one review_fix effect. */
export class AutomatedReviewResultStore {
  constructor(
    private readonly db: D1Database,
    private readonly taskObjects: R2Bucket,
    private readonly secrets: readonly string[] = [],
  ) {}

  async complete(
    authorization: RunnerAuthorization,
    rawResult: unknown,
    now = new Date(),
  ): Promise<AutomatedReviewCompletionResult> {
    const result = AutomatedReviewResultV1Schema.safeParse(rawResult);
    if (!result.success) throw new AutomatedReviewError('invalid_request');
    const row = await this.review(authorization.attemptId);
    if (row === null) throw new AutomatedReviewError('not_found');
    if (row.status !== 'pending') return await this.existing(row, result.data);
    const context = await new AutomatedReviewContextStore(this.db, this.taskObjects)
      .get(authorization);
    if (context === null || await automatedReviewContextDigest(context) !== result.data.contextDigest) {
      throw new AutomatedReviewError('state_conflict');
    }
    if (new SecretScanner({ secrets: this.secrets }).scan(result.data).length > 0) {
      throw new AutomatedReviewError('secret_detected');
    }
    const blocking = blockingFindingCount(result.data);
    const minor = minorFindingCount(result.data);
    const resultDigest = await canonicalSha256(result.data);
    const feedbackBody = renderAutomatedReviewFeedback(result.data);
    const feedbackBodyDigest = await canonicalSha256(feedbackBody);
    const objectKey = `automated-reviews/${row.review_id}/${resultDigest.slice('sha256:'.length)}.json`;
    const resultRef = `r2://${objectKey}`;
    try {
      await this.taskObjects.put(objectKey, JSON.stringify(result.data), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          schemaVersion: '1',
          reviewId: row.review_id,
          resultDigest,
          sourceHeadSha: row.source_head_sha,
        },
      });
    } catch {
      throw new AutomatedReviewError('storage_unavailable');
    }
    const nowIso = now.toISOString();
    const terminalStatus = blocking === 0
      ? 'approved'
      : row.iteration >= MAX_REVIEW_ITERATIONS ? 'blocked' : 'changes_requested';
    const fixIdentity = await canonicalSha256({
      reviewId: row.review_id,
      resultDigest,
      kind: 'review_fix',
    });
    const fixAttemptId = `attempt_auto_review_fix_${suffix(fixIdentity)}`;
    const outboxId = `dispatch_auto_review_fix_${suffix(fixIdentity)}`;
    const blockerId = `blocker_auto_review_${suffix(fixIdentity)}`;
    const cancelOutboxId = `cancel_auto_review_${suffix(fixIdentity)}`;
    const retryScopeDigest = await canonicalSha256({
      runId: row.run_id,
      planId: row.plan_id,
      itemId: row.plan_item_id,
      kind: 'automated_review',
    });
    const fingerprintDigest = await canonicalSha256({
      reviewId: row.review_id,
      resultDigest,
      blocking,
    });
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `UPDATE automated_reviews
         SET status = ?, result_ref = ?, result_digest = ?, feedback_body_digest = ?,
             blocking_finding_count = ?, minor_finding_count = ?,
             completed_at = ?, updated_at = ?
         WHERE review_id = ? AND review_attempt_id = ? AND status = 'pending'
           AND source_head_sha = ?
           AND (? <> 'changes_requested' OR EXISTS (
             SELECT 1
             FROM runs
             JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
             JOIN plan_item_progress AS progress
               ON progress.plan_id = plans.plan_id AND progress.item_id = ?
             WHERE runs.run_id = automated_reviews.run_id
               AND runs.state = 'pull_request_open'
               AND plans.plan_id = automated_reviews.plan_id
               AND plans.plan_version = automated_reviews.plan_version
               AND plans.status = 'active'
               AND progress.status = 'passed' AND progress.active_attempt_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM run_blockers
                 WHERE run_blockers.run_id = runs.run_id
                   AND run_blockers.resolved_at IS NULL
               )
               AND 1 = (
                 SELECT COUNT(*) FROM trusted_effect_approvals AS approval
                 WHERE approval.run_id = runs.run_id
                   AND approval.task_revision = runs.task_revision
                   AND approval.plan_id = plans.plan_id
                   AND approval.plan_version = plans.plan_version
                   AND approval.plan_digest = plans.digest
                   AND approval.base_sha = runs.base_sha
                   AND approval.effect = 'repo_write'
                   AND approval.decision = 'approve' AND approval.expires_at > ?
                   AND NOT EXISTS (
                     SELECT 1 FROM invalidated_approvals
                     WHERE invalidated_approvals.approval_id = approval.approval_id
                   )
               )
           ))`,
      ).bind(
        terminalStatus,
        resultRef,
        resultDigest,
        feedbackBodyDigest,
        blocking,
        minor,
        nowIso,
        nowIso,
        row.review_id,
        row.review_attempt_id,
        row.source_head_sha,
        terminalStatus,
        row.plan_item_id,
        nowIso,
      ),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'completed', version = version + 1,
             result_event_id = ?, result_sequence = 1,
             result_payload_ref = ?, result_digest = ?, result_reported_at = ?,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND run_id = ? AND mode = 'analysis' AND status = 'running'
           AND version = ? AND lease_generation = ?
           AND EXISTS (
             SELECT 1 FROM automated_reviews
             WHERE review_id = ? AND review_attempt_id = attempts.attempt_id
               AND result_digest = ?
           )`,
      ).bind(
        `automated_review_result_${suffix(resultDigest)}`,
        resultRef,
        resultDigest,
        nowIso,
        nowIso,
        row.review_attempt_id,
        row.run_id,
        authorization.version,
        authorization.leaseGeneration,
        row.review_id,
        resultDigest,
      ),
      this.db.prepare(
        `UPDATE attempt_tokens SET revoked_at = ?
         WHERE attempt_id = ? AND lease_generation = ? AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM attempts
             WHERE attempt_id = ? AND status = 'completed' AND result_digest = ?
           )`,
      ).bind(
        nowIso,
        row.review_attempt_id,
        authorization.leaseGeneration,
        row.review_attempt_id,
        resultDigest,
      ),
      this.db.prepare(
        `INSERT INTO attempt_revocations (
           revocation_id, run_id, attempt_id, reason, revoked_lease_generation,
           attempt_version, occurred_at, created_at
         )
         SELECT ?, run_id, attempt_id, 'completed', lease_generation, version, ?, ?
         FROM attempts WHERE attempt_id = ? AND status = 'completed' AND result_digest = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        `revoke_auto_review_${row.review_attempt_id}_${authorization.leaseGeneration}`,
        nowIso,
        nowIso,
        row.review_attempt_id,
        resultDigest,
      ),
    ];
    if (terminalStatus === 'changes_requested') {
      statements.push(
        this.db.prepare(
          `INSERT INTO attempts (
             attempt_id, run_id, ordinal, mode, status, base_sha, repository,
             workflow_ref, plan_id, plan_version, plan_item_id,
             claimed_progress_version, head_sha, version, lease_generation,
             created_at, updated_at
           )
           SELECT ?, reviews.run_id,
                  (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                   FROM attempts AS existing WHERE existing.run_id = reviews.run_id),
                  'review_fix', 'pending', prior.base_sha, reviews.repository,
                  prior.workflow_ref, reviews.plan_id, reviews.plan_version,
                  reviews.plan_item_id, progress.version, reviews.source_head_sha,
                  0, 0, ?, ?
           FROM automated_reviews AS reviews
           JOIN attempts AS prior ON prior.attempt_id = reviews.prior_attempt_id
           JOIN runs ON runs.run_id = reviews.run_id
           JOIN plan_item_progress AS progress
             ON progress.plan_id = reviews.plan_id AND progress.item_id = reviews.plan_item_id
           WHERE reviews.review_id = ? AND reviews.status = 'changes_requested'
             AND reviews.result_digest = ? AND runs.state = 'pull_request_open'
             AND progress.status = 'passed' AND progress.active_attempt_id IS NULL
             AND 1 = (
               SELECT COUNT(*) FROM trusted_effect_approvals AS approval
               JOIN execution_plans AS plans ON plans.plan_id = reviews.plan_id
               WHERE approval.run_id = reviews.run_id
                 AND approval.task_revision = runs.task_revision
                 AND approval.plan_id = reviews.plan_id
                 AND approval.plan_version = reviews.plan_version
                 AND approval.plan_digest = plans.digest
                 AND approval.base_sha = runs.base_sha
                 AND approval.effect = 'repo_write' AND approval.decision = 'approve'
                 AND approval.expires_at > ?
                 AND NOT EXISTS (
                   SELECT 1 FROM invalidated_approvals
                   WHERE invalidated_approvals.approval_id = approval.approval_id
                 )
             )
           ON CONFLICT DO NOTHING`,
        ).bind(fixAttemptId, nowIso, nowIso, row.review_id, resultDigest, nowIso),
        this.db.prepare(
          `INSERT INTO automated_review_fix_attempts (
             review_id, fix_attempt_id, prior_attempt_id, branch, source_head_sha, created_at
           )
           SELECT review_id, ?, prior_attempt_id, branch, source_head_sha, ?
           FROM automated_reviews
           WHERE review_id = ? AND status = 'changes_requested'
             AND EXISTS (SELECT 1 FROM attempts WHERE attempt_id = ? AND status = 'pending')
           ON CONFLICT DO NOTHING`,
        ).bind(fixAttemptId, nowIso, row.review_id, fixAttemptId),
        this.db.prepare(
          `UPDATE plan_item_progress
           SET status = 'in_progress', active_attempt_id = ?, version = version + 1, updated_at = ?
           WHERE plan_id = ? AND item_id = ? AND status = 'passed'
             AND active_attempt_id IS NULL
             AND EXISTS (
               SELECT 1 FROM automated_review_fix_attempts
               WHERE review_id = ? AND fix_attempt_id = ?
             )`,
        ).bind(fixAttemptId, nowIso, row.plan_id, row.plan_item_id, row.review_id, fixAttemptId),
        this.db.prepare(
          `UPDATE runs SET state = 'executing', version = version + 1, updated_at = ?
           WHERE run_id = ? AND state = 'pull_request_open'
             AND EXISTS (
               SELECT 1 FROM plan_item_progress
               WHERE plan_id = ? AND item_id = ?
                 AND status = 'in_progress' AND active_attempt_id = ?
             )`,
        ).bind(nowIso, row.run_id, row.plan_id, row.plan_item_id, fixAttemptId),
        this.db.prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, run_id, 'execution_dispatch', 'github_actions', ?, ?, 'pending', ?, ?
           FROM attempts WHERE attempt_id = ? AND status = 'pending'
             AND EXISTS (
               SELECT 1 FROM runs WHERE run_id = attempts.run_id AND state = 'executing'
             )
           ON CONFLICT DO NOTHING`,
        ).bind(
          outboxId,
          `d1://attempts/${fixAttemptId}`,
          `automated-review-fix:${row.review_id}`,
          nowIso,
          nowIso,
          fixAttemptId,
        ),
      );
    } else if (terminalStatus === 'blocked') {
      statements.push(
        this.db.prepare(
          `INSERT INTO run_blockers (
             blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
             attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
           )
           SELECT ?, run_id, 'attempt_limit', ?, ?, ?, ?, 'manual_investigation', ?
           FROM automated_reviews WHERE review_id = ? AND status = 'blocked'
           ON CONFLICT DO NOTHING`,
        ).bind(
          blockerId,
          retryScopeDigest,
          fingerprintDigest,
          row.iteration,
          row.iteration,
          nowIso,
          row.review_id,
        ),
        this.db.prepare(
          `UPDATE plan_item_progress SET status = 'blocked', active_attempt_id = NULL,
             version = version + 1, updated_at = ?
           WHERE plan_id = ? AND item_id = ? AND status = 'passed'
             AND EXISTS (
               SELECT 1 FROM run_blockers WHERE blocker_id = ? AND resolved_at IS NULL
             )`,
        ).bind(nowIso, row.plan_id, row.plan_item_id, blockerId),
        this.db.prepare(
          `UPDATE execution_plans SET status = 'blocked', updated_at = ?
           WHERE plan_id = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM run_blockers WHERE blocker_id = ? AND resolved_at IS NULL
             )`,
        ).bind(nowIso, row.plan_id, blockerId),
        this.db.prepare(
          `UPDATE runs SET state = 'blocked', version = version + 1, updated_at = ?
           WHERE run_id = ? AND state = 'pull_request_open'
             AND EXISTS (
               SELECT 1 FROM run_blockers WHERE blocker_id = ? AND resolved_at IS NULL
             )`,
        ).bind(nowIso, row.run_id, blockerId),
        this.db.prepare(
          `INSERT INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, created_at, updated_at
           )
           SELECT ?, run_id, 'workflow_cancel', 'cloudflare_workflows', ?, ?, 'pending', ?, ?
           FROM runs WHERE run_id = ? AND state = 'blocked'
           ON CONFLICT DO NOTHING`,
        ).bind(
          cancelOutboxId,
          `d1://runs/${row.run_id}`,
          `workflow-cancel:auto-review:${row.review_id}`,
          nowIso,
          nowIso,
          row.run_id,
        ),
      );
    }
    await this.db.batch(statements);
    const persisted = await this.review(row.review_attempt_id);
    if (persisted === null || persisted.result_digest !== resultDigest ||
      persisted.status !== terminalStatus) throw new AutomatedReviewError('state_conflict');
    const attempt = await this.db.prepare(
      `SELECT status, result_digest FROM attempts WHERE attempt_id = ?`,
    ).bind(row.review_attempt_id).first<{ status: string; result_digest: string | null }>();
    if (attempt?.status !== 'completed' || attempt.result_digest !== resultDigest) {
      throw new AutomatedReviewError('state_conflict');
    }
    if (terminalStatus === 'changes_requested') {
      const fix = await this.db.prepare(
        `SELECT fix_attempt_id FROM automated_review_fix_attempts WHERE review_id = ?`,
      ).bind(row.review_id).first<{ fix_attempt_id: string }>();
      if (fix?.fix_attempt_id !== fixAttemptId) throw new AutomatedReviewError('approval_required');
      return { reviewId: row.review_id, status: terminalStatus, fixAttemptId, created: true };
    }
    return { reviewId: row.review_id, status: terminalStatus, created: true };
  }

  async replay(
    attemptId: string,
    token: string,
    rawResult: unknown,
  ): Promise<AutomatedReviewCompletionResult> {
    if (!ID_PATTERN.test(attemptId) || token.length === 0 || token.length > 20_000) {
      throw new AutomatedReviewError('invalid_request');
    }
    const result = AutomatedReviewResultV1Schema.safeParse(rawResult);
    if (!result.success) throw new AutomatedReviewError('invalid_request');
    const tokenDigest = await canonicalSha256(token);
    const tokenRow = await this.db.prepare(
      `SELECT token_id FROM attempt_tokens
       WHERE attempt_id = ? AND token_digest = ?`,
    ).bind(attemptId, tokenDigest).first<{ token_id: string }>();
    if (tokenRow === null) throw new AutomatedReviewError('not_found');
    const row = await this.review(attemptId);
    if (row === null) throw new AutomatedReviewError('not_found');
    return await this.existing(row, result.data);
  }

  private async existing(
    row: ReviewRow,
    result: AutomatedReviewResultV1,
  ): Promise<AutomatedReviewCompletionResult> {
    if (row.status === 'pending' || row.result_digest === null) {
      throw new AutomatedReviewError('state_conflict');
    }
    if (row.result_digest !== await canonicalSha256(result)) {
      throw new AutomatedReviewError('state_conflict');
    }
    const fix = await this.db.prepare(
      `SELECT fix_attempt_id FROM automated_review_fix_attempts WHERE review_id = ?`,
    ).bind(row.review_id).first<{ fix_attempt_id: string }>();
    return {
      reviewId: row.review_id,
      status: row.status,
      ...(fix === null ? {} : { fixAttemptId: fix.fix_attempt_id }),
      created: false,
    };
  }

  private async review(attemptId: string): Promise<ReviewRow | null> {
    return await this.db.prepare(
      `SELECT * FROM automated_reviews WHERE review_attempt_id = ?`,
    ).bind(attemptId).first<ReviewRow>();
  }
}
