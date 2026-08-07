import { TaskEnvelopeSchema, taskRevisionDigest, type TaskEnvelope } from '../domain/task.js';
import { canonicalSha256 } from '../domain/digest.js';
import { isExactExecutionToolActions } from '../domain/tool-bridge.js';
import type { EvidenceKind, PlanEffect, PlanItemV1 } from '../domain/plan.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';
import { z } from 'zod';

export type ExecutionAttemptErrorCode =
  | 'attempt_context_mismatch'
  | 'task_payload_unavailable'
  | 'task_payload_conflict'
  | 'review_payload_unavailable'
  | 'review_payload_conflict'
  | 'plan_item_conflict';

export class ExecutionAttemptError extends Error {
  constructor(readonly code: ExecutionAttemptErrorCode) {
    super(`Execution Attempt operation failed: ${code}`);
    this.name = 'ExecutionAttemptError';
  }
}

interface ExecutionContextRow {
  attempt_id: string;
  run_id: string;
  mode: string;
  status: string;
  version: number;
  lease_generation: number;
  base_sha: string;
  head_sha: string | null;
  repository: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  run_base_sha: string | null;
  run_state: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  task_id: string;
  task_revision: string;
  task_digest: string;
  payload_ref: string;
  target_repository: string;
  target_base_branch: string;
  allow_repository_write: number;
  plan_base_sha: string | null;
  plan_digest: string | null;
  plan_status: string | null;
  item_kind: string | null;
  item_title: string | null;
  item_objective: string | null;
  item_required: number | null;
  progress_status: string | null;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
}

interface RepairRow {
  failed_attempt_id: string;
  source_suite_id: string;
  source_evidence_id: string;
  source_head_sha: string;
  failure_fact_digest: string;
  phase: string;
  command_ref: string;
  exit_code: number | null;
}

interface ReviewFeedbackRow {
  feedback_id: string;
  github_review_id: string;
  body_ref: string;
  body_digest: string;
  source_head_sha: string;
  branch: string;
  review_url: string;
  submitted_at: string;
}

interface BaseRebaseRow {
  source_attempt_id: string;
  source_branch: string;
  source_head_sha: string;
  old_base_sha: string;
  new_base_sha: string;
  target_branch: string;
  status: string;
}

const ReviewFeedbackObjectSchema = z.object({
  schemaVersion: z.literal('1'),
  reviewId: z.string().regex(/^[0-9]+$/),
  body: z.string().min(1).max(65_536),
  bodyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().min(1).max(240),
  url: z.url().max(2_000),
  submittedAt: z.iso.datetime({ offset: true }),
}).strict();

export interface ExecutionAttemptContext {
  schemaVersion: '1';
  attempt: {
    id: string;
    runId: string;
    taskId: string;
    mode: 'implement' | 'review_fix';
    version: number;
    leaseGeneration: number;
    baseSha: string;
    checkoutSha: string;
    repository: string;
    baseBranch: string;
    planId: string;
    planVersion: number;
    planItemId: string;
    targetBranch: string;
    targetBranchMode: 'new' | 'existing_fast_forward';
  };
  task: TaskEnvelope;
  item: {
    id: string;
    kind: PlanItemV1['kind'];
    title: string;
    objective: string;
    required: boolean;
    doneWhen: string[];
    commandRefs: string[];
    evidenceKinds: EvidenceKind[];
    effects: PlanEffect[];
  };
  repair?: {
    failedAttemptId: string;
    sourceSuiteId: string;
    sourceEvidenceId: string;
    sourceHeadSha: string;
    failureFactDigest: string;
    phase: 'targeted' | 'required_verify';
    commandRef: string;
    exitCode: number;
  };
  reviewFeedback?: {
    reviewId: string;
    body: string;
    bodyDigest: string;
    sourceHeadSha: string;
    branch: string;
    url: string;
    submittedAt: string;
  };
  baseRebase?: {
    sourceAttemptId: string;
    sourceBranch: string;
    sourceHeadSha: string;
    oldBaseSha: string;
    newBaseSha: string;
  };
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Returns only the exact active execution Item and digest-verified Task body. */
export class ExecutionAttemptContextStore {
  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
  ) {}

  async get(authorization: RunnerAuthorization): Promise<ExecutionAttemptContext> {
    if (authorization.mode === 'analysis') {
      throw new ExecutionAttemptError('attempt_context_mismatch');
    }
    const row = await this.row(authorization);
    this.assertRow(row, authorization);
    const task = await this.task(row);
    const [doneWhen, commandRefs, evidenceKinds, effects] = await Promise.all([
      this.strings(
        `SELECT condition AS value FROM plan_item_done_when
         WHERE plan_id = ? AND item_id = ? ORDER BY position`,
        row.plan_id!,
        row.plan_item_id!,
      ),
      this.strings(
        `SELECT command_ref AS value FROM plan_item_command_refs
         WHERE plan_id = ? AND item_id = ? ORDER BY command_ref`,
        row.plan_id!,
        row.plan_item_id!,
      ),
      this.strings(
        `SELECT evidence_kind AS value FROM plan_item_evidence_kinds
         WHERE plan_id = ? AND item_id = ? ORDER BY evidence_kind`,
        row.plan_id!,
        row.plan_item_id!,
      ),
      this.strings(
        `SELECT effect AS value FROM plan_item_effects
         WHERE plan_id = ? AND item_id = ? ORDER BY effect`,
        row.plan_id!,
        row.plan_item_id!,
      ),
    ]);
    if (
      doneWhen.length === 0 ||
      !commandRefs.some((ref) => ref.startsWith('test:')) ||
      !commandRefs.some((ref) => ref.startsWith('verify:')) ||
      !evidenceKinds.includes('test') ||
      !effects.includes('repo_write')
    ) {
      throw new ExecutionAttemptError('plan_item_conflict');
    }
    const mode = authorization.mode;
    const repair = mode === 'review_fix' ? await this.repair(row) : undefined;
    const reviewFeedback = mode === 'review_fix'
      ? await this.reviewFeedback(row)
      : undefined;
    const baseRebase = mode === 'review_fix'
      ? await this.baseRebase(row)
      : undefined;
    if (
      (mode === 'review_fix' &&
        Number(repair !== undefined) +
          Number(reviewFeedback !== undefined) +
          Number(baseRebase !== undefined) !== 1) ||
      (mode === 'implement' &&
        (repair !== undefined || reviewFeedback !== undefined || baseRebase !== undefined))
    ) {
      throw new ExecutionAttemptError('attempt_context_mismatch');
    }
    const targetBranch = reviewFeedback?.branch ?? `agent/${row.task_id}/${row.attempt_id}`;
    if (targetBranch.length > 240) throw new ExecutionAttemptError('attempt_context_mismatch');
    return {
      schemaVersion: '1',
      attempt: {
        id: row.attempt_id,
        runId: row.run_id,
        taskId: row.task_id,
        mode,
        version: row.version,
        leaseGeneration: row.lease_generation,
        baseSha: row.base_sha,
        checkoutSha: row.head_sha ?? row.base_sha,
        repository: row.repository!,
        baseBranch: row.target_base_branch,
        planId: row.plan_id!,
        planVersion: row.plan_version!,
        planItemId: row.plan_item_id!,
        targetBranch,
        targetBranchMode: reviewFeedback === undefined ? 'new' : 'existing_fast_forward',
      },
      task,
      item: {
        id: row.plan_item_id!,
        kind: row.item_kind as PlanItemV1['kind'],
        title: row.item_title!,
        objective: row.item_objective!,
        required: row.item_required === 1,
        doneWhen,
        commandRefs,
        evidenceKinds: evidenceKinds as EvidenceKind[],
        effects: effects as PlanEffect[],
      },
      ...(repair === undefined ? {} : { repair }),
      ...(reviewFeedback === undefined ? {} : { reviewFeedback }),
      ...(baseRebase === undefined ? {} : { baseRebase }),
    };
  }

  private async row(authorization: RunnerAuthorization): Promise<ExecutionContextRow> {
    const row = await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.run_id, attempts.mode, attempts.status,
              attempts.version, attempts.lease_generation, attempts.base_sha,
              attempts.head_sha, attempts.repository, attempts.plan_id,
              attempts.plan_version, attempts.plan_item_id,
              runs.base_sha AS run_base_sha, runs.state AS run_state,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              tasks.task_id, tasks.task_revision, tasks.task_digest, tasks.payload_ref,
              tasks.target_repository, tasks.target_base_branch,
              tasks.allow_repository_write,
              execution_plans.base_sha AS plan_base_sha,
              execution_plans.digest AS plan_digest,
              execution_plans.status AS plan_status,
              plan_items.kind AS item_kind, plan_items.title AS item_title,
              plan_items.objective AS item_objective,
              plan_items.required AS item_required,
              plan_item_progress.status AS progress_status,
              plan_item_progress.active_attempt_id,
              plan_item_progress.protected_path_gate_id
       FROM attempts
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
       LEFT JOIN plan_items
         ON plan_items.plan_id = attempts.plan_id
        AND plan_items.item_id = attempts.plan_item_id
       LEFT JOIN plan_item_progress
         ON plan_item_progress.plan_id = attempts.plan_id
        AND plan_item_progress.item_id = attempts.plan_item_id
       WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
    ).bind(authorization.attemptId, authorization.runId).first<ExecutionContextRow>();
    if (row === null) throw new ExecutionAttemptError('attempt_context_mismatch');
    return row;
  }

  private assertRow(row: ExecutionContextRow, authorization: RunnerAuthorization): void {
    if (
      (authorization.mode !== 'implement' && authorization.mode !== 'review_fix') ||
      row.mode !== authorization.mode ||
      row.status !== 'running' ||
      row.version !== authorization.version ||
      row.lease_generation !== authorization.leaseGeneration ||
      !isExactExecutionToolActions(authorization.scopes) ||
      row.repository === null ||
      row.repository !== row.target_repository ||
      row.allow_repository_write !== 1 ||
      row.plan_id === null ||
      row.plan_version === null ||
      row.plan_item_id === null ||
      row.run_base_sha === null ||
      row.base_sha !== row.run_base_sha ||
      row.plan_base_sha !== row.run_base_sha ||
      row.active_plan_id !== row.plan_id ||
      row.active_plan_version !== row.plan_version ||
      row.active_plan_digest !== row.plan_digest ||
      row.plan_status !== 'active' ||
      (row.run_state !== 'executing' && row.run_state !== 'verifying') ||
      row.progress_status !== 'in_progress' ||
      row.active_attempt_id !== row.attempt_id ||
      row.protected_path_gate_id !== null ||
      row.item_kind === null ||
      row.item_title === null ||
      row.item_objective === null ||
      row.item_required !== 1 ||
      (row.mode === 'review_fix' && row.head_sha === null) ||
      (row.head_sha !== null && !SHA_PATTERN.test(row.head_sha))
    ) {
      throw new ExecutionAttemptError('attempt_context_mismatch');
    }
  }

  private async task(row: ExecutionContextRow): Promise<TaskEnvelope> {
    if (!row.payload_ref.startsWith('r2://')) {
      throw new ExecutionAttemptError('task_payload_conflict');
    }
    const key = row.payload_ref.slice('r2://'.length);
    if (key.length === 0 || key.includes('..')) {
      throw new ExecutionAttemptError('task_payload_conflict');
    }
    const object = await this.objects.get(key);
    if (object === null) throw new ExecutionAttemptError('task_payload_unavailable');
    let task: TaskEnvelope;
    try {
      task = TaskEnvelopeSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new ExecutionAttemptError('task_payload_conflict');
    }
    if (
      await taskRevisionDigest(task) !== row.task_digest ||
      object.customMetadata?.taskDigest !== row.task_digest ||
      task.source.revision !== row.task_revision ||
      `${task.target.owner}/${task.target.repo}` !== row.target_repository ||
      task.target.baseBranch !== row.target_base_branch ||
      !task.policy.allowRepositoryWrite
    ) {
      throw new ExecutionAttemptError('task_payload_conflict');
    }
    return task;
  }

  private async repair(
    row: ExecutionContextRow,
  ): Promise<NonNullable<ExecutionAttemptContext['repair']> | undefined> {
    const repair = await this.db.prepare(
      `SELECT attempt_repairs.failed_attempt_id, attempt_repairs.source_suite_id,
              attempt_repairs.source_evidence_id, attempt_repairs.source_head_sha,
              attempt_repairs.failure_fact_digest,
              verification_suite_commands.phase,
              verification_suite_commands.command_ref,
              evidence.exit_code
       FROM attempt_repairs
       JOIN verification_suite_commands
         ON verification_suite_commands.suite_id = attempt_repairs.source_suite_id
        AND verification_suite_commands.evidence_id = attempt_repairs.source_evidence_id
       JOIN evidence ON evidence.evidence_id = attempt_repairs.source_evidence_id
       WHERE attempt_repairs.repair_attempt_id = ?
         AND attempt_repairs.run_id = ?
         AND attempt_repairs.plan_id = ?
         AND attempt_repairs.plan_version = ?
         AND attempt_repairs.plan_item_id = ?`,
    ).bind(
      row.attempt_id,
      row.run_id,
      row.plan_id,
      row.plan_version,
      row.plan_item_id,
    ).first<RepairRow>();
    if (repair === null) return undefined;
    if (
      repair.source_head_sha !== row.head_sha ||
      !DIGEST_PATTERN.test(repair.failure_fact_digest) ||
      (repair.phase !== 'targeted' && repair.phase !== 'required_verify') ||
      repair.exit_code === null ||
      !Number.isSafeInteger(repair.exit_code) ||
      repair.exit_code <= 0 ||
      repair.exit_code > 255
    ) {
      throw new ExecutionAttemptError('attempt_context_mismatch');
    }
    return {
      failedAttemptId: repair.failed_attempt_id,
      sourceSuiteId: repair.source_suite_id,
      sourceEvidenceId: repair.source_evidence_id,
      sourceHeadSha: repair.source_head_sha,
      failureFactDigest: repair.failure_fact_digest,
      phase: repair.phase,
      commandRef: repair.command_ref,
      exitCode: repair.exit_code,
    };
  }

  private async reviewFeedback(
    row: ExecutionContextRow,
  ): Promise<NonNullable<ExecutionAttemptContext['reviewFeedback']> | undefined> {
    const feedback = await this.db.prepare(
      `SELECT github_review_feedbacks.feedback_id,
              github_review_feedbacks.github_review_id,
              github_review_feedbacks.body_ref,
              github_review_feedbacks.body_digest,
              github_review_feedbacks.source_head_sha,
              github_review_feedbacks.branch,
              github_review_feedbacks.review_url,
              github_review_feedbacks.submitted_at
       FROM review_feedback_attempts
       JOIN github_review_feedbacks
         ON github_review_feedbacks.feedback_id = review_feedback_attempts.feedback_id
       JOIN attempts AS requested_attempt ON requested_attempt.attempt_id = ?
       WHERE review_feedback_attempts.review_attempt_id =
             COALESCE(requested_attempt.recovered_from_attempt_id, requested_attempt.attempt_id)
         AND github_review_feedbacks.run_id = ?
         AND github_review_feedbacks.plan_id = ?
         AND github_review_feedbacks.plan_version = ?
         AND github_review_feedbacks.plan_item_id = ?
         AND review_feedback_attempts.source_head_sha = github_review_feedbacks.source_head_sha
         AND review_feedback_attempts.branch = github_review_feedbacks.branch`,
    ).bind(
      row.attempt_id,
      row.run_id,
      row.plan_id,
      row.plan_version,
      row.plan_item_id,
    ).first<ReviewFeedbackRow>();
    if (feedback === null) return undefined;
    if (
      feedback.source_head_sha !== row.head_sha ||
      !DIGEST_PATTERN.test(feedback.body_digest) ||
      !feedback.body_ref.startsWith('r2://')
    ) throw new ExecutionAttemptError('attempt_context_mismatch');
    const key = feedback.body_ref.slice('r2://'.length);
    if (key.length === 0 || key.includes('..')) {
      throw new ExecutionAttemptError('review_payload_conflict');
    }
    const object = await this.objects.get(key);
    if (object === null) throw new ExecutionAttemptError('review_payload_unavailable');
    let payload: z.infer<typeof ReviewFeedbackObjectSchema>;
    try {
      payload = ReviewFeedbackObjectSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new ExecutionAttemptError('review_payload_conflict');
    }
    if (
      payload.reviewId !== feedback.github_review_id ||
      payload.bodyDigest !== feedback.body_digest ||
      await canonicalSha256(payload.body) !== feedback.body_digest ||
      payload.sourceHeadSha !== feedback.source_head_sha ||
      payload.branch !== feedback.branch ||
      payload.url !== feedback.review_url ||
      payload.submittedAt !== feedback.submitted_at ||
      object.customMetadata?.schemaVersion !== '1' ||
      object.customMetadata?.feedbackId !== feedback.feedback_id ||
      object.customMetadata?.bodyDigest !== feedback.body_digest ||
      object.customMetadata?.sourceHeadSha !== feedback.source_head_sha
    ) {
      throw new ExecutionAttemptError('review_payload_conflict');
    }
    return {
      reviewId: payload.reviewId,
      body: payload.body,
      bodyDigest: payload.bodyDigest,
      sourceHeadSha: payload.sourceHeadSha,
      branch: payload.branch,
      url: payload.url,
      submittedAt: payload.submittedAt,
    };
  }

  private async baseRebase(
    row: ExecutionContextRow,
  ): Promise<NonNullable<ExecutionAttemptContext['baseRebase']> | undefined> {
    const rebase = await this.db.prepare(
      `SELECT source_attempt_id, source_branch, source_head_sha,
              old_base_sha, new_base_sha, target_branch, status
       FROM base_rebase_attempts
       WHERE rebase_attempt_id = ? AND run_id = ?
         AND target_plan_id = ? AND target_plan_version = ?
         AND plan_item_id = ?`,
    ).bind(
      row.attempt_id,
      row.run_id,
      row.plan_id,
      row.plan_version,
      row.plan_item_id,
    ).first<BaseRebaseRow>();
    if (rebase === null) return undefined;
    if (
      rebase.status !== 'scheduled' ||
      rebase.source_head_sha !== row.head_sha ||
      rebase.new_base_sha !== row.base_sha ||
      rebase.target_branch !== `agent/${row.task_id}/${row.attempt_id}` ||
      rebase.source_branch !== `agent/${row.task_id}/${rebase.source_attempt_id}`
    ) throw new ExecutionAttemptError('attempt_context_mismatch');
    return {
      sourceAttemptId: rebase.source_attempt_id,
      sourceBranch: rebase.source_branch,
      sourceHeadSha: rebase.source_head_sha,
      oldBaseSha: rebase.old_base_sha,
      newBaseSha: rebase.new_base_sha,
    };
  }

  private async strings(sql: string, planId: string, itemId: string): Promise<string[]> {
    const result = await this.db.prepare(sql).bind(planId, itemId).all<{ value: string }>();
    if (!result.success || result.results.some((row) => typeof row.value !== 'string')) {
      throw new ExecutionAttemptError('plan_item_conflict');
    }
    return result.results.map((row) => row.value);
  }
}
