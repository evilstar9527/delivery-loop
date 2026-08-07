import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  SupplementalContextDataSchema,
} from '../domain/revision-source.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
} from '../domain/task.js';
import { DELIVERY_AGENT_WORKFLOW_FILE } from '../outbox/github-dispatcher.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

const PlanRevisionSourceKindSchema = z.enum([
  'review_feedback',
  'supplemental_context',
  'base_update',
]);

export const BeginPlanRevisionInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  activePlanVersion: z.number().int().positive(),
  activePlanDigest: z.string().regex(DIGEST_PATTERN),
  sourceKind: PlanRevisionSourceKindSchema,
  sourceRef: z.string().min(1).max(500),
  sourceDigest: z.string().regex(DIGEST_PATTERN),
  requestedBaseSha: z.string().regex(SHA_PATTERN),
}).strict();

export const ActivatePlanRevisionInputSchema = z.object({
  revisionId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  planId: z.string().regex(ID_PATTERN),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

export const ReviewPlanRevisionRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
}).strict();

export const GitHubBaseObservationFactSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().regex(REPOSITORY_PATTERN),
  baseBranch: z.string().regex(BRANCH_PATTERN),
  beforeSha: z.string().regex(SHA_PATTERN),
  afterSha: z.string().regex(SHA_PATTERN),
  relationship: z.literal('ahead'),
  aheadBy: z.number().int().positive(),
  referenceDigest: z.string().regex(DIGEST_PATTERN),
  comparisonDigest: z.string().regex(DIGEST_PATTERN),
}).strict().refine(
  (value) => value.beforeSha !== value.afterSha &&
    !value.baseBranch.includes('..') &&
    !value.baseBranch.includes('//'),
  { message: 'GitHub base observation binding is invalid' },
);

export const BeginBaseObservationRevisionInputSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  fact: GitHubBaseObservationFactSchema,
  observedAt: z.iso.datetime({ offset: true }),
}).strict();

export const BeginSupplementalContextRevisionInputSchema = z.object({
  priorTaskId: z.string().regex(ID_PATTERN),
  task: TaskEnvelopeSchema,
  payloadRef: z.string().regex(/^r2:\/\/tasks\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.json$/),
  contextRef: z.string().regex(
    /^r2:\/\/supplemental-context\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.json$/,
  ),
  context: SupplementalContextDataSchema,
  currentRun: z.object({
    runId: z.string().regex(ID_PATTERN),
    expectedRunVersion: z.number().int().nonnegative(),
    taskRevision: z.string().min(1).max(500),
    planVersion: z.number().int().positive(),
    planDigest: z.string().regex(DIGEST_PATTERN),
    baseSha: z.string().regex(SHA_PATTERN),
  }).strict(),
}).strict();

export type BeginPlanRevisionInput = z.infer<typeof BeginPlanRevisionInputSchema>;
export type ActivatePlanRevisionInput = z.infer<typeof ActivatePlanRevisionInputSchema>;
export type ReviewPlanRevisionRequest = z.infer<typeof ReviewPlanRevisionRequestSchema>;
export type GitHubBaseObservationFact = z.infer<typeof GitHubBaseObservationFactSchema>;
export type BeginBaseObservationRevisionInput = z.infer<
  typeof BeginBaseObservationRevisionInputSchema
>;
export type BeginSupplementalContextRevisionInput = z.infer<
  typeof BeginSupplementalContextRevisionInputSchema
>;

export type PlanRevisionErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'state_conflict'
  | 'no_change';

export class PlanRevisionError extends Error {
  constructor(readonly code: PlanRevisionErrorCode) {
    super(`Plan revision operation failed: ${code}`);
    this.name = 'PlanRevisionError';
  }
}

export interface BeginPlanRevisionResult {
  revisionId: string;
  analysisAttemptId: string;
  dispatchOutboxId: string;
  created: boolean;
  runVersion: number;
}

export interface ActivatePlanRevisionResult {
  revisionId: string;
  planId: string;
  planVersion: number;
  planDigest: string;
  created: boolean;
  runVersion: number;
  changes: {
    body: boolean;
    base: boolean;
    effects: boolean;
  };
}

interface BeginCandidateRow {
  run_id: string;
  task_id: string;
  run_state: string;
  run_version: number;
  run_base_sha: string;
  task_revision: string;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
  plan_status: string;
  plan_base_sha: string;
  repository: string;
  base_branch: string;
}

interface BeginProjectionRow {
  revision_id: string;
  analysis_attempt_id: string;
  status: string;
  run_state: string;
  run_version: number;
  run_base_sha: string;
  outbox_id: string;
}

interface SourceFactRow {
  run_id: string;
  expected_run_version: number;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  source_kind: string;
  source_digest: string;
  requested_base_sha: string;
}

interface ReviewRevisionCandidateRow {
  feedback_id: string;
  expected_run_version: number;
  github_review_id: string;
  body_digest: string;
  source_head_sha: string;
  branch: string;
  review_url: string;
  submitted_at: string;
  review_attempt_id: string;
  attempt_run_id: string;
  attempt_mode: string;
  attempt_status: string;
  attempt_version: number;
  attempt_lease_generation: number;
  attempt_lease_expires_at: string | null;
  attempt_plan_id: string;
  attempt_plan_version: number;
  attempt_plan_item_id: string;
  attempt_head_sha: string;
  attempt_head_branch: string | null;
  run_id: string;
  run_state: string;
  run_version: number;
  run_base_sha: string;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
  plan_status: string;
  progress_status: string;
  progress_active_attempt_id: string | null;
  publication_status: string;
  publication_head_sha: string;
  publication_head_branch: string;
  current_branch_head_sha: string | null;
  lineage_count: number;
  repair_count: number;
}

interface BaseObservationRow {
  observation_id: string;
  run_id: string;
  expected_run_version: number;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  repository: string;
  base_branch: string;
  before_sha: string;
  after_sha: string;
  relationship: string;
  ahead_by: number;
  reference_digest: string;
  comparison_digest: string;
  source_digest: string;
}

interface ActivationCandidateRow {
  revision_id: string;
  revision_status: string;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  prior_base_sha: string;
  requested_base_sha: string;
  analysis_attempt_id: string;
  run_id: string;
  run_state: string;
  run_version: number;
  run_base_sha: string;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
  prior_plan_status: string;
  new_plan_id: string;
  new_plan_version: number;
  new_plan_digest: string;
  new_plan_base_sha: string;
  new_plan_status: string;
  new_plan_created_by_attempt_id: string;
  analysis_attempt_status: string;
}

interface ActivatedProjectionRow {
  revision_id: string;
  new_plan_id: string;
  new_plan_version: number;
  new_plan_digest: string;
  body_changed: number;
  base_changed: number;
  effects_changed: number;
  run_state: string;
  run_version: number;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
}

const REPLAN_RUN_STATES = new Set([
  'awaiting_approval',
  'executing',
  'verifying',
  'pull_request_open',
  'awaiting_review',
  'ready_to_merge',
  'blocked',
]);

function stableSuffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 52);
}

function sourceRefMatches(kind: BeginPlanRevisionInput['sourceKind'], ref: string): boolean {
  switch (kind) {
    case 'review_feedback':
      return /^d1:\/\/github-review-feedbacks\/[A-Za-z0-9_-]+$/.test(ref);
    case 'supplemental_context':
      return /^r2:\/\/supplemental-context\/[A-Za-z0-9_./-]+\.json$/.test(ref) &&
        !ref.includes('..');
    case 'base_update':
      return /^d1:\/\/github-base-observations\/[A-Za-z0-9_-]+$/.test(ref);
  }
}

/** Durable re-analysis and immutable active-Plan replacement boundary. */
export class PlanRevisionStore {
  constructor(private readonly db: D1Database) {}

  async begin(rawInput: unknown, now = new Date()): Promise<BeginPlanRevisionResult> {
    const parsed = BeginPlanRevisionInputSchema.safeParse(rawInput);
    if (!parsed.success || !sourceRefMatches(parsed.data.sourceKind, parsed.data.sourceRef)) {
      throw new PlanRevisionError('invalid_request');
    }
    return await this.beginPrepared(parsed.data, now);
  }

  async beginFromReviewFeedback(
    authorization: RunnerAuthorization,
    rawRequest: unknown,
    now = new Date(),
  ): Promise<BeginPlanRevisionResult> {
    const parsed = ReviewPlanRevisionRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new PlanRevisionError('invalid_request');
    const request = parsed.data;
    if (
      authorization.mode !== 'review_fix' ||
      authorization.version !== request.expectedVersion ||
      authorization.leaseGeneration !== request.leaseGeneration
    ) throw new PlanRevisionError('state_conflict');

    const candidate = await this.reviewRevisionCandidate(authorization.attemptId);
    if (
      candidate === null ||
      candidate.review_attempt_id !== authorization.attemptId ||
      candidate.attempt_run_id !== authorization.runId ||
      candidate.run_id !== authorization.runId ||
      candidate.attempt_mode !== 'review_fix' ||
      candidate.lineage_count !== 1 ||
      candidate.repair_count !== 0 ||
      candidate.attempt_plan_id !== candidate.active_plan_id ||
      candidate.attempt_plan_version !== candidate.active_plan_version ||
      candidate.plan_status !== 'active' ||
      candidate.attempt_head_sha !== candidate.source_head_sha ||
      candidate.attempt_head_branch !== null ||
      candidate.publication_status !== 'verified' ||
      candidate.publication_head_sha !== candidate.source_head_sha ||
      candidate.publication_head_branch !== candidate.branch ||
      candidate.current_branch_head_sha !== candidate.source_head_sha ||
      candidate.progress_status !== 'in_progress' ||
      candidate.progress_active_attempt_id !== authorization.attemptId
    ) throw new PlanRevisionError('state_conflict');

    const sourceRef = `d1://github-review-feedbacks/${candidate.feedback_id}`;
    const sourceDigest = await canonicalSha256({
      schemaVersion: '1',
      sourceKind: 'review_feedback',
      feedbackId: candidate.feedback_id,
      githubReviewId: candidate.github_review_id,
      bodyDigest: candidate.body_digest,
      sourceHeadSha: candidate.source_head_sha,
      branch: candidate.branch,
      reviewUrl: candidate.review_url,
      submittedAt: candidate.submitted_at,
    });
    const existingSource = await this.sourceFact(sourceRef);
    if (existingSource !== null) {
      if (
        existingSource.run_id !== candidate.run_id ||
        existingSource.prior_plan_id !== candidate.attempt_plan_id ||
        existingSource.prior_plan_version !== candidate.attempt_plan_version ||
        existingSource.source_kind !== 'review_feedback' ||
        existingSource.source_digest !== sourceDigest ||
        existingSource.requested_base_sha !== candidate.run_base_sha ||
        candidate.attempt_status !== 'cancelled' ||
        candidate.attempt_version !== request.expectedVersion + 1 ||
        candidate.attempt_lease_generation !== request.leaseGeneration + 1
      ) throw new PlanRevisionError('state_conflict');
      return await this.begin({
        runId: existingSource.run_id,
        expectedRunVersion: existingSource.expected_run_version,
        activePlanVersion: existingSource.prior_plan_version,
        activePlanDigest: existingSource.prior_plan_digest,
        sourceKind: 'review_feedback',
        sourceRef,
        sourceDigest,
        requestedBaseSha: existingSource.requested_base_sha,
      }, now);
    }

    const nowIso = now.toISOString();
    if (
      candidate.attempt_status !== 'running' ||
      candidate.attempt_version !== request.expectedVersion ||
      candidate.attempt_lease_generation !== request.leaseGeneration ||
      candidate.attempt_lease_expires_at === null ||
      candidate.attempt_lease_expires_at <= nowIso ||
      candidate.run_state !== 'executing' ||
      candidate.run_version !== candidate.expected_run_version
    ) throw new PlanRevisionError('state_conflict');
    const input = BeginPlanRevisionInputSchema.parse({
      runId: candidate.run_id,
      expectedRunVersion: candidate.expected_run_version,
      activePlanVersion: candidate.active_plan_version,
      activePlanDigest: candidate.active_plan_digest,
      sourceKind: 'review_feedback',
      sourceRef,
      sourceDigest,
      requestedBaseSha: candidate.run_base_sha,
    });
    const sourceInsert = this.db.prepare(
      `INSERT INTO plan_revision_source_facts (
         source_ref, run_id, expected_run_version, prior_plan_id,
         prior_plan_version, prior_plan_digest, source_kind, source_digest,
         requested_base_sha, observed_at, created_at
       )
       SELECT ?, runs.run_id, runs.version, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              'review_feedback', ?, runs.base_sha, ?, ?
       FROM attempts
       JOIN review_feedback_attempts AS lineage
         ON lineage.review_attempt_id = attempts.attempt_id
       JOIN github_review_feedbacks AS feedback
         ON feedback.feedback_id = lineage.feedback_id
       JOIN runs ON runs.run_id = feedback.run_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = feedback.plan_id
        AND progress.item_id = feedback.plan_item_id
       JOIN pull_request_publications AS publication
         ON publication.publication_id = feedback.publication_id
       WHERE attempts.attempt_id = ? AND attempts.run_id = ?
         AND attempts.mode = 'review_fix' AND attempts.status = 'running'
         AND attempts.version = ? AND attempts.lease_generation = ?
         AND attempts.lease_token_digest IS NOT NULL
         AND attempts.lease_expires_at > ?
         AND attempts.plan_id = feedback.plan_id
         AND attempts.plan_version = feedback.plan_version
         AND attempts.plan_item_id = feedback.plan_item_id
         AND attempts.head_sha = feedback.source_head_sha
         AND attempts.head_branch IS NULL
         AND lineage.branch = feedback.branch
         AND lineage.source_head_sha = feedback.source_head_sha
         AND runs.state = 'executing' AND runs.version = ?
         AND runs.base_sha = ?
         AND runs.active_plan_id = feedback.plan_id
         AND runs.active_plan_version = feedback.plan_version
         AND runs.active_plan_digest = plans.digest
         AND plans.status = 'active'
         AND progress.status = 'in_progress'
         AND progress.active_attempt_id = attempts.attempt_id
         AND publication.status = 'verified'
         AND publication.head_branch = feedback.branch
         AND publication.head_sha = feedback.source_head_sha
         AND (SELECT COUNT(*) FROM review_feedback_attempts AS exact_lineage
              WHERE exact_lineage.review_attempt_id = attempts.attempt_id) = 1
         AND NOT EXISTS (
           SELECT 1 FROM attempt_repairs
           WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
         )
         AND feedback.source_head_sha = (
           SELECT candidate_updates.head_sha
           FROM attempt_head_updates AS candidate_updates
           JOIN attempts AS candidate_attempt
             ON candidate_attempt.attempt_id = candidate_updates.attempt_id
           WHERE candidate_updates.run_id = runs.run_id
             AND candidate_updates.plan_id = feedback.plan_id
             AND candidate_updates.branch = feedback.branch
           ORDER BY candidate_attempt.ordinal DESC, candidate_updates.created_at DESC
           LIMIT 1
         )
       ON CONFLICT DO NOTHING`,
    ).bind(
      sourceRef,
      sourceDigest,
      candidate.submitted_at,
      nowIso,
      authorization.attemptId,
      authorization.runId,
      request.expectedVersion,
      request.leaseGeneration,
      nowIso,
      candidate.expected_run_version,
      candidate.run_base_sha,
    );
    return await this.beginPrepared(input, now, [sourceInsert]);
  }

  async beginFromSupplementalContext(
    rawInput: unknown,
    now = new Date(),
  ): Promise<BeginPlanRevisionResult> {
    const parsed = BeginSupplementalContextRevisionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PlanRevisionError('invalid_request');
    const input = parsed.data;
    const { task, currentRun, context } = input;
    const [ids, taskDigest, contextDigest, eventDigest] = await Promise.all([
      taskRevisionIds(task),
      taskRevisionDigest(task),
      canonicalSha256(context),
      canonicalSha256({
        schemaVersion: '1',
        sourceSystem: task.source.system,
        tenantKey: task.source.tenantKey,
        eventId: task.eventId,
      }),
    ]);
    const contextIdentity = await canonicalSha256({
      schemaVersion: '1',
      priorTaskId: input.priorTaskId,
      newTaskId: ids.taskId,
      contextDigest,
    });
    const contextId = `supplemental_context_${stableSuffix(contextIdentity)}`;
    const expectedPayloadRef =
      `r2://tasks/${ids.taskId}/${taskDigest.slice('sha256:'.length)}.json`;
    const expectedContextRef =
      `r2://supplemental-context/${contextId}/${contextDigest.slice('sha256:'.length)}.json`;
    if (
      input.payloadRef !== expectedPayloadRef ||
      input.contextRef !== expectedContextRef ||
      context.source.system !== task.source.system ||
      context.source.tenantKey !== task.source.tenantKey ||
      context.source.taskKey !== task.source.taskKey ||
      context.source.priorRevision !== currentRun.taskRevision ||
      context.source.revision !== task.source.revision ||
      context.source.priorRevision === context.source.revision ||
      context.actor.type !== task.actor.type ||
      context.actor.id !== task.actor.id
    ) throw new PlanRevisionError('invalid_request');

    const nowIso = now.toISOString();
    const repository = `${task.target.owner}/${task.target.repo}`;
    const allowedStates =
      "('awaiting_approval','executing','verifying','pull_request_open'," +
      "'awaiting_review','ready_to_merge','blocked')";
    const lineageGuard =
      `NOT EXISTS (
         SELECT 1 FROM supplemental_context_revisions AS conflicting
         WHERE conflicting.prior_task_id = prior.task_id
           AND (
             conflicting.new_task_id <> ? OR
             conflicting.context_ref <> ? OR
             conflicting.context_digest <> ? OR
             conflicting.apply_to_current_run <> 1 OR
             conflicting.applied_run_id <> ?
           )
       )`;
    const eventGuard =
      `NOT EXISTS (
         SELECT 1 FROM supplemental_context_revisions AS conflicting_event
         WHERE conflicting_event.event_digest = ?
           AND conflicting_event.context_id <> ?
       )`;
    const currentGuard =
      `current.run_id = ? AND current.task_id = prior.task_id
       AND current.state IN ${allowedStates} AND current.version = ?
       AND current.task_revision = ? AND current.base_sha = ?
       AND current.active_plan_version = ? AND current.active_plan_digest = ?
       AND active.status = 'active' AND active.base_sha = current.base_sha`;
    const sourceStatements: D1PreparedStatement[] = [
      this.db.prepare(
        `INSERT INTO tasks (
           task_id, source_system, tenant_key, source_task_key, task_revision, source_url,
           task_digest, payload_ref, actor_type, actor_id, target_repository,
           target_base_branch, target_environment, intent_kind, title, priority,
           acceptance_criteria_count, allow_repository_write, allow_test_deploy,
           allow_production_deploy, require_human_approval, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM tasks AS prior
         JOIN runs AS current ON current.task_id = prior.task_id
         JOIN execution_plans AS active ON active.plan_id = current.active_plan_id
         WHERE prior.task_id = ?
           AND prior.source_system = ? AND prior.tenant_key = ?
           AND prior.source_task_key = ? AND prior.task_revision = ?
           AND prior.target_repository = ? AND prior.target_base_branch = ?
           AND prior.target_environment = ? AND prior.intent_kind = ?
           AND prior.allow_repository_write = ? AND prior.allow_test_deploy = ?
           AND prior.allow_production_deploy = ? AND prior.require_human_approval = ?
           AND ${currentGuard}
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        ids.taskId,
        task.source.system,
        task.source.tenantKey,
        task.source.taskKey,
        task.source.revision,
        task.source.url ?? null,
        taskDigest,
        input.payloadRef,
        task.actor.type,
        task.actor.id,
        repository,
        task.target.baseBranch,
        task.target.environment,
        task.intent.kind,
        task.intent.title,
        task.intent.priority,
        task.intent.acceptanceCriteria.length,
        task.policy.allowRepositoryWrite ? 1 : 0,
        task.policy.allowTestDeploy ? 1 : 0,
        task.policy.allowProductionDeploy ? 1 : 0,
        task.policy.requireHumanApproval ? 1 : 0,
        nowIso,
        nowIso,
        input.priorTaskId,
        task.source.system,
        task.source.tenantKey,
        task.source.taskKey,
        currentRun.taskRevision,
        repository,
        task.target.baseBranch,
        task.target.environment,
        task.intent.kind,
        task.policy.allowRepositoryWrite ? 1 : 0,
        task.policy.allowTestDeploy ? 1 : 0,
        task.policy.allowProductionDeploy ? 1 : 0,
        task.policy.requireHumanApproval ? 1 : 0,
        currentRun.runId,
        currentRun.expectedRunVersion,
        currentRun.taskRevision,
        currentRun.baseSha,
        currentRun.planVersion,
        currentRun.planDigest,
        ids.taskId,
        input.contextRef,
        contextDigest,
        currentRun.runId,
        eventDigest,
        contextId,
      ),
      this.db.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha, workflow_instance_id,
           state, version, created_at, updated_at
         )
         SELECT ?, next.task_id, next.task_revision, next.task_digest,
                current.base_sha, ?, 'cancelled', 1, ?, ?
         FROM tasks AS next
         JOIN tasks AS prior ON prior.task_id = ?
         JOIN runs AS current ON current.task_id = prior.task_id
         JOIN execution_plans AS active ON active.plan_id = current.active_plan_id
         WHERE next.task_id = ? AND next.task_digest = ? AND next.payload_ref = ?
           AND ${currentGuard}
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        ids.runId,
        ids.runId,
        nowIso,
        nowIso,
        input.priorTaskId,
        ids.taskId,
        taskDigest,
        input.payloadRef,
        currentRun.runId,
        currentRun.expectedRunVersion,
        currentRun.taskRevision,
        currentRun.baseSha,
        currentRun.planVersion,
        currentRun.planDigest,
        ids.taskId,
        input.contextRef,
        contextDigest,
        currentRun.runId,
        eventDigest,
        contextId,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, last_error_code, created_at, updated_at
         )
         SELECT ?, absorbed.run_id, 'workflow_create', 'cloudflare_workflows', ?, ?,
                'settled', 'supplemental_context_absorbed', ?, ?
         FROM runs AS absorbed
         JOIN tasks AS next ON next.task_id = absorbed.task_id
         JOIN tasks AS prior ON prior.task_id = ?
         JOIN runs AS current ON current.task_id = prior.task_id
         JOIN execution_plans AS active ON active.plan_id = current.active_plan_id
         WHERE absorbed.run_id = ? AND absorbed.task_id = ?
           AND absorbed.state = 'cancelled' AND absorbed.version = 1
           AND next.task_digest = ? AND next.payload_ref = ?
           AND ${currentGuard}
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        ids.workflowCreateOutboxId,
        `d1://runs/${ids.runId}`,
        `workflow-create:${ids.runId}`,
        nowIso,
        nowIso,
        input.priorTaskId,
        ids.runId,
        ids.taskId,
        taskDigest,
        input.payloadRef,
        currentRun.runId,
        currentRun.expectedRunVersion,
        currentRun.taskRevision,
        currentRun.baseSha,
        currentRun.planVersion,
        currentRun.planDigest,
        ids.taskId,
        input.contextRef,
        contextDigest,
        currentRun.runId,
        eventDigest,
        contextId,
      ),
      this.db.prepare(
        `INSERT INTO supplemental_context_revisions (
           context_id, event_digest, prior_task_id, prior_task_revision,
           new_task_id, new_task_revision, new_task_digest, new_run_id,
           context_ref, context_digest, apply_to_current_run, applied_run_id,
           expected_run_version, prior_plan_id, prior_plan_version,
           prior_plan_digest, base_sha, created_at
         )
         SELECT ?, ?, prior.task_id, prior.task_revision,
                next.task_id, next.task_revision, next.task_digest, absorbed.run_id,
                ?, ?, 1, current.run_id, current.version, current.active_plan_id,
                current.active_plan_version, current.active_plan_digest,
                current.base_sha, ?
         FROM tasks AS prior
         JOIN tasks AS next ON next.task_id = ?
         JOIN runs AS absorbed ON absorbed.run_id = ? AND absorbed.task_id = next.task_id
         JOIN outbox AS absorbed_intent
           ON absorbed_intent.outbox_id = ? AND absorbed_intent.run_id = absorbed.run_id
         JOIN runs AS current ON current.task_id = prior.task_id
         JOIN execution_plans AS active ON active.plan_id = current.active_plan_id
         WHERE prior.task_id = ? AND prior.task_revision = ?
           AND next.task_digest = ? AND next.payload_ref = ?
           AND absorbed.state = 'cancelled' AND absorbed.version = 1
           AND absorbed_intent.kind = 'workflow_create'
           AND absorbed_intent.delivery_state = 'settled'
           AND absorbed_intent.last_error_code = 'supplemental_context_absorbed'
           AND ${currentGuard}
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        contextId,
        eventDigest,
        input.contextRef,
        contextDigest,
        nowIso,
        ids.taskId,
        ids.runId,
        ids.workflowCreateOutboxId,
        input.priorTaskId,
        currentRun.taskRevision,
        taskDigest,
        input.payloadRef,
        currentRun.runId,
        currentRun.expectedRunVersion,
        currentRun.taskRevision,
        currentRun.baseSha,
        currentRun.planVersion,
        currentRun.planDigest,
        ids.taskId,
        input.contextRef,
        contextDigest,
        currentRun.runId,
        eventDigest,
        contextId,
      ),
      this.db.prepare(
        `INSERT INTO plan_revision_source_facts (
           source_ref, run_id, expected_run_version, prior_plan_id,
           prior_plan_version, prior_plan_digest, source_kind, source_digest,
           requested_base_sha, observed_at, created_at
         )
         SELECT context.context_ref, current.run_id, current.version,
                current.active_plan_id, current.active_plan_version,
                current.active_plan_digest, 'supplemental_context',
                context.context_digest, current.base_sha, context.created_at, ?
         FROM supplemental_context_revisions AS context
         JOIN tasks AS prior ON prior.task_id = context.prior_task_id
         JOIN runs AS current ON current.run_id = context.applied_run_id
         JOIN execution_plans AS active ON active.plan_id = current.active_plan_id
         WHERE context.context_id = ? AND context.prior_task_id = ?
           AND context.new_task_id = ? AND context.new_run_id = ?
           AND context.context_ref = ? AND context.context_digest = ?
           AND context.apply_to_current_run = 1
           AND context.expected_run_version = ?
           AND context.prior_plan_version = ?
           AND context.prior_plan_digest = ? AND context.base_sha = ?
           AND ${currentGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        nowIso,
        contextId,
        input.priorTaskId,
        ids.taskId,
        ids.runId,
        input.contextRef,
        contextDigest,
        currentRun.expectedRunVersion,
        currentRun.planVersion,
        currentRun.planDigest,
        currentRun.baseSha,
        currentRun.runId,
        currentRun.expectedRunVersion,
        currentRun.taskRevision,
        currentRun.baseSha,
        currentRun.planVersion,
        currentRun.planDigest,
      ),
    ];
    return await this.beginPrepared({
      runId: currentRun.runId,
      expectedRunVersion: currentRun.expectedRunVersion,
      activePlanVersion: currentRun.planVersion,
      activePlanDigest: currentRun.planDigest,
      sourceKind: 'supplemental_context',
      sourceRef: input.contextRef,
      sourceDigest: contextDigest,
      requestedBaseSha: currentRun.baseSha,
    }, now, sourceStatements);
  }

  async beginFromBaseObservation(
    rawInput: unknown,
    now = new Date(),
  ): Promise<BeginPlanRevisionResult> {
    const parsed = BeginBaseObservationRevisionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PlanRevisionError('invalid_request');
    const input = parsed.data;
    const sourceDigest = await canonicalSha256(input.fact);
    const identity = await canonicalSha256({
      schemaVersion: '1',
      runId: input.runId,
      expectedRunVersion: input.expectedRunVersion,
      sourceDigest,
    });
    const observationId = `github_base_${stableSuffix(identity)}`;
    const sourceRef = `d1://github-base-observations/${observationId}`;
    const existing = await this.baseObservation(observationId);
    if (existing !== null) {
      if (
        existing.run_id !== input.runId ||
        existing.expected_run_version !== input.expectedRunVersion ||
        existing.repository !== input.fact.repository ||
        existing.base_branch !== input.fact.baseBranch ||
        existing.before_sha !== input.fact.beforeSha ||
        existing.after_sha !== input.fact.afterSha ||
        existing.relationship !== input.fact.relationship ||
        existing.ahead_by !== input.fact.aheadBy ||
        existing.reference_digest !== input.fact.referenceDigest ||
        existing.comparison_digest !== input.fact.comparisonDigest ||
        existing.source_digest !== sourceDigest
      ) throw new PlanRevisionError('state_conflict');
      return await this.begin({
        runId: existing.run_id,
        expectedRunVersion: existing.expected_run_version,
        activePlanVersion: existing.prior_plan_version,
        activePlanDigest: existing.prior_plan_digest,
        sourceKind: 'base_update',
        sourceRef,
        sourceDigest,
        requestedBaseSha: existing.after_sha,
      }, now);
    }

    const candidate = await this.beginCandidate(input.runId);
    if (candidate === null) {
      const run = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(input.runId).first<{ run_id: string }>();
      throw new PlanRevisionError(run === null ? 'not_found' : 'state_conflict');
    }
    if (
      !REPLAN_RUN_STATES.has(candidate.run_state) ||
      candidate.run_version !== input.expectedRunVersion ||
      candidate.run_base_sha !== input.fact.beforeSha ||
      candidate.repository !== input.fact.repository ||
      candidate.base_branch !== input.fact.baseBranch ||
      candidate.active_plan_id.length === 0 ||
      candidate.active_plan_version <= 0 ||
      candidate.active_plan_digest.length === 0 ||
      candidate.plan_status !== 'active' ||
      candidate.plan_base_sha !== candidate.run_base_sha
    ) throw new PlanRevisionError('state_conflict');

    const observedAt = new Date(input.observedAt).toISOString();
    const nowIso = now.toISOString();
    const observationInsert = this.db.prepare(
      `INSERT INTO github_base_observations (
         observation_id, run_id, expected_run_version, prior_plan_id,
         prior_plan_version, prior_plan_digest, repository, base_branch,
         before_sha, after_sha, relationship, ahead_by, reference_digest,
         comparison_digest, source_digest, observed_at, created_at
       )
       SELECT ?, runs.run_id, runs.version, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              tasks.target_repository, tasks.target_base_branch,
              runs.base_sha, ?, 'ahead', ?, ?, ?, ?, ?, ?
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ? AND runs.state = ? AND runs.version = ?
         AND runs.base_sha = ?
         AND runs.active_plan_id = ? AND runs.active_plan_version = ?
         AND runs.active_plan_digest = ?
         AND tasks.target_repository = ? AND tasks.target_base_branch = ?
         AND plans.status = 'active' AND plans.base_sha = runs.base_sha
       ON CONFLICT DO NOTHING`,
    ).bind(
      observationId,
      input.fact.afterSha,
      input.fact.aheadBy,
      input.fact.referenceDigest,
      input.fact.comparisonDigest,
      sourceDigest,
      observedAt,
      nowIso,
      input.runId,
      candidate.run_state,
      input.expectedRunVersion,
      input.fact.beforeSha,
      candidate.active_plan_id,
      candidate.active_plan_version,
      candidate.active_plan_digest,
      input.fact.repository,
      input.fact.baseBranch,
    );
    const sourceInsert = this.db.prepare(
      `INSERT INTO plan_revision_source_facts (
         source_ref, run_id, expected_run_version, prior_plan_id,
         prior_plan_version, prior_plan_digest, source_kind, source_digest,
         requested_base_sha, observed_at, created_at
       )
       SELECT ?, observation.run_id, observation.expected_run_version,
              observation.prior_plan_id, observation.prior_plan_version,
              observation.prior_plan_digest, 'base_update',
              observation.source_digest, observation.after_sha,
              observation.observed_at, ?
       FROM github_base_observations AS observation
       JOIN runs ON runs.run_id = observation.run_id
       JOIN execution_plans AS plans ON plans.plan_id = observation.prior_plan_id
       WHERE observation.observation_id = ?
         AND observation.run_id = ?
         AND observation.expected_run_version = ?
         AND observation.repository = ? AND observation.base_branch = ?
         AND observation.before_sha = ? AND observation.after_sha = ?
         AND observation.source_digest = ?
         AND runs.state = ? AND runs.version = observation.expected_run_version
         AND runs.base_sha = observation.before_sha
         AND runs.active_plan_id = observation.prior_plan_id
         AND runs.active_plan_version = observation.prior_plan_version
         AND runs.active_plan_digest = observation.prior_plan_digest
         AND plans.status = 'active' AND plans.base_sha = runs.base_sha
       ON CONFLICT DO NOTHING`,
    ).bind(
      sourceRef,
      nowIso,
      observationId,
      input.runId,
      input.expectedRunVersion,
      input.fact.repository,
      input.fact.baseBranch,
      input.fact.beforeSha,
      input.fact.afterSha,
      sourceDigest,
      candidate.run_state,
    );
    const beginInput = BeginPlanRevisionInputSchema.parse({
      runId: input.runId,
      expectedRunVersion: input.expectedRunVersion,
      activePlanVersion: candidate.active_plan_version,
      activePlanDigest: candidate.active_plan_digest,
      sourceKind: 'base_update',
      sourceRef,
      sourceDigest,
      requestedBaseSha: input.fact.afterSha,
    });
    return await this.beginPrepared(beginInput, now, [observationInsert, sourceInsert]);
  }

  private async beginPrepared(
    input: BeginPlanRevisionInput,
    now: Date,
    sourceStatements: readonly D1PreparedStatement[] = [],
  ): Promise<BeginPlanRevisionResult> {
    const identity = await canonicalSha256({
      schemaVersion: '1',
      runId: input.runId,
      expectedRunVersion: input.expectedRunVersion,
      activePlanVersion: input.activePlanVersion,
      activePlanDigest: input.activePlanDigest,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      sourceDigest: input.sourceDigest,
      requestedBaseSha: input.requestedBaseSha,
    });
    const suffix = stableSuffix(identity);
    const revisionId = `plan_revision_${suffix}`;
    const analysisAttemptId = `attempt_replan_${suffix}`;
    const outboxId = `dispatch_replan_${suffix}`;
    const existing = await this.beginProjection(revisionId);
    if (existing !== null) return this.beginResult(existing, false, input);

    const candidate = await this.beginCandidate(input.runId);
    if (candidate === null) {
      const run = await this.db.prepare('SELECT run_id FROM runs WHERE run_id = ?')
        .bind(input.runId).first<{ run_id: string }>();
      throw new PlanRevisionError(run === null ? 'not_found' : 'state_conflict');
    }
    if (
      !REPLAN_RUN_STATES.has(candidate.run_state) ||
      candidate.run_version !== input.expectedRunVersion ||
      candidate.active_plan_version !== input.activePlanVersion ||
      candidate.active_plan_digest !== input.activePlanDigest ||
      candidate.active_plan_id.length === 0 ||
      candidate.plan_status !== 'active' ||
      candidate.plan_base_sha !== candidate.run_base_sha
    ) throw new PlanRevisionError('state_conflict');
    if (sourceStatements.length === 0) {
      const sourceFact = await this.sourceFact(input.sourceRef);
      if (
        sourceFact === null ||
        sourceFact.run_id !== input.runId ||
        sourceFact.expected_run_version !== input.expectedRunVersion ||
        sourceFact.prior_plan_id !== candidate.active_plan_id ||
        sourceFact.prior_plan_version !== input.activePlanVersion ||
        sourceFact.prior_plan_digest !== input.activePlanDigest ||
        sourceFact.source_kind !== input.sourceKind ||
        sourceFact.source_digest !== input.sourceDigest ||
        sourceFact.requested_base_sha !== input.requestedBaseSha
      ) throw new PlanRevisionError('state_conflict');
    }

    const nowIso = now.toISOString();
    const workflowRef =
      `${candidate.repository}/${DELIVERY_AGENT_WORKFLOW_FILE}@refs/heads/${candidate.base_branch}`;
    const results = await this.db.batch([
      ...sourceStatements,
      this.db.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         )
         SELECT ?, runs.run_id,
                (SELECT COALESCE(MAX(existing.ordinal), 0) + 1
                 FROM attempts AS existing WHERE existing.run_id = runs.run_id),
                'analysis', 'pending', ?, tasks.target_repository, ?, 0, 0, ?, ?
         FROM runs
         JOIN tasks ON tasks.task_id = runs.task_id
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         WHERE runs.run_id = ? AND runs.state = ? AND runs.version = ?
           AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
           AND execution_plans.status = 'active'
           AND execution_plans.base_sha = runs.base_sha
           AND EXISTS (
             SELECT 1 FROM plan_revision_source_facts
             WHERE source_ref = ? AND run_id = runs.run_id
               AND prior_plan_id = runs.active_plan_id
               AND prior_plan_version = runs.active_plan_version
               AND prior_plan_digest = runs.active_plan_digest
               AND source_kind = ? AND source_digest = ?
               AND requested_base_sha = ?
           )
         ON CONFLICT DO NOTHING`,
      ).bind(
        analysisAttemptId,
        input.requestedBaseSha,
        workflowRef,
        nowIso,
        nowIso,
        input.runId,
        candidate.run_state,
        input.expectedRunVersion,
        input.activePlanVersion,
        input.activePlanDigest,
        input.sourceRef,
        input.sourceKind,
        input.sourceDigest,
        input.requestedBaseSha,
      ),
      this.db.prepare(
        `INSERT INTO plan_revisions (
           revision_id, run_id, expected_run_version, prior_plan_id,
           prior_plan_version, prior_plan_digest, prior_base_sha,
           source_kind, source_ref, source_digest, requested_base_sha,
           analysis_attempt_id, status, created_at, updated_at
         )
         SELECT ?, runs.run_id, runs.version, runs.active_plan_id,
                runs.active_plan_version, runs.active_plan_digest, runs.base_sha,
                ?, ?, ?, ?, attempts.attempt_id, 'analyzing', ?, ?
         FROM runs
         JOIN attempts ON attempts.attempt_id = ? AND attempts.run_id = runs.run_id
         JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
         JOIN plan_revision_source_facts AS source
           ON source.source_ref = ? AND source.run_id = runs.run_id
         WHERE runs.run_id = ? AND runs.state = ? AND runs.version = ?
           AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
           AND execution_plans.status = 'active'
           AND attempts.mode = 'analysis' AND attempts.status = 'pending'
           AND attempts.base_sha = ?
           AND source.prior_plan_id = runs.active_plan_id
           AND source.prior_plan_version = runs.active_plan_version
           AND source.prior_plan_digest = runs.active_plan_digest
           AND source.source_kind = ? AND source.source_digest = ?
           AND source.requested_base_sha = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        revisionId,
        input.sourceKind,
        input.sourceRef,
        input.sourceDigest,
        input.requestedBaseSha,
        nowIso,
        nowIso,
        analysisAttemptId,
        input.sourceRef,
        input.runId,
        candidate.run_state,
        input.expectedRunVersion,
        input.activePlanVersion,
        input.activePlanDigest,
        input.requestedBaseSha,
        input.sourceKind,
        input.sourceDigest,
        input.requestedBaseSha,
      ),
      this.db.prepare(
        `INSERT INTO approval_invalidations (
           approval_id, revision_id, reason, invalidated_at
         )
         SELECT approvals.approval_id, ?, 'plan_revision_started', ?
         FROM approvals
         JOIN plan_revisions ON plan_revisions.revision_id = ?
         WHERE approvals.run_id = plan_revisions.run_id
           AND approvals.plan_id = plan_revisions.prior_plan_id
           AND approvals.plan_version = plan_revisions.prior_plan_version
           AND approvals.plan_digest = plan_revisions.prior_plan_digest
         ON CONFLICT DO NOTHING`,
      ).bind(revisionId, nowIso, revisionId),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'cancelled', version = version + 1,
             lease_generation = lease_generation + 1,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE run_id = ? AND attempt_id <> ?
           AND plan_id = ?
           AND status IN ('pending', 'starting', 'running', 'cancel_requested')
           AND EXISTS (
             SELECT 1 FROM plan_revisions
             WHERE revision_id = ? AND status = 'analyzing'
               AND prior_plan_id = attempts.plan_id
           )`,
      ).bind(nowIso, input.runId, analysisAttemptId, candidate.active_plan_id, revisionId),
      this.db.prepare(
        `UPDATE attempt_tokens SET revoked_at = ?
         WHERE revoked_at IS NULL AND attempt_id IN (
           SELECT attempt_id FROM attempts
           WHERE run_id = ? AND status = 'cancelled' AND updated_at = ?
         )`,
      ).bind(nowIso, input.runId, nowIso),
      this.db.prepare(
        `UPDATE github_write_credentials
         SET status = 'revocation_pending', updated_at = ?
         WHERE run_id = ? AND plan_id = ? AND status IN ('issuing', 'active')
           AND EXISTS (
             SELECT 1 FROM plan_revisions
             WHERE revision_id = ? AND status = 'analyzing'
           )`,
      ).bind(nowIso, input.runId, candidate.active_plan_id, revisionId),
      this.db.prepare(
        `UPDATE protected_path_change_gates
         SET status = 'superseded', updated_at = ?
         WHERE run_id = ? AND plan_id = ?
           AND status IN ('awaiting_approval', 'approved')
           AND EXISTS (
             SELECT 1 FROM plan_revisions
             WHERE revision_id = ? AND status = 'analyzing'
           )`,
      ).bind(nowIso, input.runId, candidate.active_plan_id, revisionId),
      this.db.prepare(
        `UPDATE outbox
         SET delivery_state = 'settled', lease_token = NULL,
             lease_expires_at = NULL, last_error_code = 'plan_revision_started',
             updated_at = ?
         WHERE run_id = ? AND kind IN ('execution_dispatch', 'pull_request')
           AND delivery_state IN ('pending', 'delivering')
           AND EXISTS (
             SELECT 1 FROM plan_revisions
             WHERE revision_id = ? AND status = 'analyzing'
           )`,
      ).bind(nowIso, input.runId, revisionId),
      this.db.prepare(
        `UPDATE runs
         SET state = 'planning', base_sha = ?, version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = ? AND version = ?
           AND active_plan_id = ? AND active_plan_version = ?
           AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM plan_revisions
             WHERE revision_id = ? AND analysis_attempt_id = ?
               AND status = 'analyzing'
           )`,
      ).bind(
        input.requestedBaseSha,
        nowIso,
        input.runId,
        candidate.run_state,
        input.expectedRunVersion,
        candidate.active_plan_id,
        input.activePlanVersion,
        input.activePlanDigest,
        revisionId,
        analysisAttemptId,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, runs.run_id, 'analysis_dispatch', 'github_actions', ?, ?,
                'pending', ?, ?
         FROM runs
         JOIN plan_revisions ON plan_revisions.run_id = runs.run_id
         WHERE plan_revisions.revision_id = ?
           AND plan_revisions.analysis_attempt_id = ?
           AND runs.state = 'planning' AND runs.version = ?
           AND runs.base_sha = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        outboxId,
        `d1://attempts/${analysisAttemptId}`,
        `analysis-replan:${revisionId}`,
        nowIso,
        nowIso,
        revisionId,
        analysisAttemptId,
        input.expectedRunVersion + 1,
        input.requestedBaseSha,
      ),
    ]);
    const projection = await this.beginProjection(revisionId);
    if (projection === null) throw new PlanRevisionError('state_conflict');
    const revisionStatementIndex = sourceStatements.length + 1;
    return this.beginResult(
      projection,
      results[revisionStatementIndex]?.meta.changes === 1,
      input,
    );
  }

  async activate(
    rawInput: unknown,
    now = new Date(),
  ): Promise<ActivatePlanRevisionResult> {
    const parsed = ActivatePlanRevisionInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new PlanRevisionError('invalid_request');
    const input = parsed.data;
    const existing = await this.activatedProjection(input.revisionId);
    if (existing !== null) return this.activateResult(existing, false, input);
    if (await this.isRejectedNoChange(input)) throw new PlanRevisionError('no_change');
    const candidate = await this.activationCandidate(input);
    if (candidate === null) {
      const revision = await this.db.prepare(
        'SELECT revision_id FROM plan_revisions WHERE revision_id = ?',
      ).bind(input.revisionId).first<{ revision_id: string }>();
      throw new PlanRevisionError(revision === null ? 'not_found' : 'state_conflict');
    }
    if (
      candidate.revision_status !== 'analyzing' ||
      candidate.run_state !== 'planning' ||
      candidate.run_version !== input.expectedRunVersion ||
      candidate.run_base_sha !== candidate.requested_base_sha ||
      candidate.active_plan_id !== candidate.prior_plan_id ||
      candidate.active_plan_version !== candidate.prior_plan_version ||
      candidate.active_plan_digest !== candidate.prior_plan_digest ||
      candidate.prior_plan_status !== 'active' ||
      candidate.new_plan_id !== input.planId ||
      candidate.new_plan_version !== input.planVersion ||
      candidate.new_plan_version !== candidate.prior_plan_version + 1 ||
      candidate.new_plan_digest !== input.planDigest ||
      candidate.new_plan_base_sha !== candidate.requested_base_sha ||
      candidate.new_plan_status !== 'validated' ||
      candidate.new_plan_created_by_attempt_id !== candidate.analysis_attempt_id ||
      (candidate.analysis_attempt_status !== 'pending' &&
        candidate.analysis_attempt_status !== 'running')
    ) throw new PlanRevisionError('state_conflict');

    const [priorBodyDigest, nextBodyDigest, priorEffectsDigest, nextEffectsDigest] =
      await Promise.all([
        this.semanticDigest(candidate.prior_plan_id),
        this.semanticDigest(candidate.new_plan_id),
        this.effectsDigest(candidate.prior_plan_id),
        this.effectsDigest(candidate.new_plan_id),
      ]);
    const bodyChanged = priorBodyDigest !== nextBodyDigest;
    const baseChanged = candidate.prior_base_sha !== candidate.new_plan_base_sha;
    const effectsChanged = priorEffectsDigest !== nextEffectsDigest;
    if (!bodyChanged && !baseChanged && !effectsChanged) {
      await this.rejectNoChange(candidate, input, now);
      throw new PlanRevisionError('no_change');
    }

    const nowIso = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE execution_plans SET status = 'superseded', updated_at = ?
         WHERE plan_id = ? AND run_id = ? AND plan_version = ?
           AND digest = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM plan_revisions
             WHERE revision_id = ? AND status = 'analyzing'
               AND prior_plan_id = execution_plans.plan_id
           )
           AND EXISTS (
             SELECT 1 FROM execution_plans AS replacement
             WHERE replacement.plan_id = ? AND replacement.run_id = execution_plans.run_id
               AND replacement.plan_version = ? AND replacement.digest = ?
               AND replacement.status = 'validated'
           )`,
      ).bind(
        nowIso,
        candidate.prior_plan_id,
        candidate.run_id,
        candidate.prior_plan_version,
        candidate.prior_plan_digest,
        candidate.revision_id,
        candidate.new_plan_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
      ),
      this.db.prepare(
        `UPDATE execution_plans SET status = 'active', updated_at = ?
         WHERE plan_id = ? AND run_id = ? AND plan_version = ?
           AND digest = ? AND status = 'validated'
           AND EXISTS (
             SELECT 1 FROM execution_plans AS prior
             WHERE prior.plan_id = ? AND prior.status = 'superseded'
           )`,
      ).bind(
        nowIso,
        candidate.new_plan_id,
        candidate.run_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
        candidate.prior_plan_id,
      ),
      this.db.prepare(
        `UPDATE runs
         SET state = 'awaiting_approval', active_plan_id = ?,
             active_plan_version = ?, active_plan_digest = ?,
             version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'planning' AND version = ?
           AND base_sha = ? AND active_plan_id = ?
           AND active_plan_version = ? AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM execution_plans
             WHERE plan_id = ? AND status = 'active' AND digest = ?
           )`,
      ).bind(
        candidate.new_plan_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
        nowIso,
        candidate.run_id,
        input.expectedRunVersion,
        candidate.new_plan_base_sha,
        candidate.prior_plan_id,
        candidate.prior_plan_version,
        candidate.prior_plan_digest,
        candidate.new_plan_id,
        candidate.new_plan_digest,
      ),
      this.db.prepare(
        `UPDATE attempts SET status = 'completed', version = version + 1,
                            lease_generation = lease_generation + 1,
                            lease_token_digest = NULL, lease_expires_at = NULL,
                            updated_at = ?
         WHERE attempt_id = ? AND run_id = ?
           AND status IN ('pending', 'running')
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE run_id = ? AND state = 'awaiting_approval'
               AND active_plan_id = ? AND active_plan_version = ?
               AND active_plan_digest = ?
           )`,
      ).bind(
        nowIso,
        candidate.analysis_attempt_id,
        candidate.run_id,
        candidate.run_id,
        candidate.new_plan_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
      ),
      this.db.prepare(
        `UPDATE plan_revisions
         SET new_plan_id = ?, new_plan_version = ?, new_plan_digest = ?,
             body_changed = ?, base_changed = ?, effects_changed = ?,
             status = 'activated', activated_at = ?, updated_at = ?
         WHERE revision_id = ? AND status = 'analyzing'
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE run_id = plan_revisions.run_id
               AND state = 'awaiting_approval' AND version = ?
               AND active_plan_id = ? AND active_plan_version = ?
               AND active_plan_digest = ?
           )`,
      ).bind(
        candidate.new_plan_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
        bodyChanged ? 1 : 0,
        baseChanged ? 1 : 0,
        effectsChanged ? 1 : 0,
        nowIso,
        nowIso,
        candidate.revision_id,
        input.expectedRunVersion + 1,
        candidate.new_plan_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
      ),
    ]);
    const projection = await this.activatedProjection(input.revisionId);
    if (projection === null) throw new PlanRevisionError('state_conflict');
    return this.activateResult(projection, results[4]?.meta.changes === 1, input);
  }

  private async beginCandidate(runId: string): Promise<BeginCandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.task_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha AS run_base_sha, runs.task_revision,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              execution_plans.status AS plan_status,
              execution_plans.base_sha AS plan_base_sha,
              tasks.target_repository AS repository,
              tasks.target_base_branch AS base_branch
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ?`,
    ).bind(runId).first<BeginCandidateRow>();
  }

  private async reviewRevisionCandidate(
    attemptId: string,
  ): Promise<ReviewRevisionCandidateRow | null> {
    return await this.db.prepare(
      `SELECT feedback.feedback_id, feedback.expected_run_version,
              feedback.github_review_id,
              feedback.body_digest, feedback.source_head_sha, feedback.branch,
              feedback.review_url, feedback.submitted_at,
              lineage.review_attempt_id,
              attempts.run_id AS attempt_run_id, attempts.mode AS attempt_mode,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation AS attempt_lease_generation,
              attempts.lease_expires_at AS attempt_lease_expires_at,
              attempts.plan_id AS attempt_plan_id,
              attempts.plan_version AS attempt_plan_version,
              attempts.plan_item_id AS attempt_plan_item_id,
              attempts.head_sha AS attempt_head_sha,
              attempts.head_branch AS attempt_head_branch,
              runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha AS run_base_sha, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              plans.status AS plan_status,
              progress.status AS progress_status,
              progress.active_attempt_id AS progress_active_attempt_id,
              publication.status AS publication_status,
              publication.head_sha AS publication_head_sha,
              publication.head_branch AS publication_head_branch,
              (SELECT candidate_updates.head_sha
               FROM attempt_head_updates AS candidate_updates
               JOIN attempts AS candidate_attempt
                 ON candidate_attempt.attempt_id = candidate_updates.attempt_id
               WHERE candidate_updates.run_id = runs.run_id
                 AND candidate_updates.plan_id = feedback.plan_id
                 AND candidate_updates.branch = feedback.branch
               ORDER BY candidate_attempt.ordinal DESC, candidate_updates.created_at DESC
               LIMIT 1) AS current_branch_head_sha,
              (SELECT COUNT(*) FROM review_feedback_attempts AS exact_lineage
               WHERE exact_lineage.review_attempt_id = attempts.attempt_id) AS lineage_count,
              (SELECT COUNT(*) FROM attempt_repairs
               WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id) AS repair_count
       FROM attempts
       JOIN review_feedback_attempts AS lineage
         ON lineage.review_attempt_id = attempts.attempt_id
       JOIN github_review_feedbacks AS feedback
         ON feedback.feedback_id = lineage.feedback_id
       JOIN runs ON runs.run_id = feedback.run_id
       JOIN execution_plans AS plans ON plans.plan_id = feedback.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = feedback.plan_id
        AND progress.item_id = feedback.plan_item_id
       JOIN pull_request_publications AS publication
         ON publication.publication_id = feedback.publication_id
       WHERE attempts.attempt_id = ?`,
    ).bind(attemptId).first<ReviewRevisionCandidateRow>();
  }

  private async beginProjection(revisionId: string): Promise<BeginProjectionRow | null> {
    return await this.db.prepare(
      `SELECT plan_revisions.revision_id, plan_revisions.analysis_attempt_id,
              plan_revisions.status, runs.state AS run_state,
              runs.version AS run_version, runs.base_sha AS run_base_sha,
              outbox.outbox_id
       FROM plan_revisions
       JOIN runs ON runs.run_id = plan_revisions.run_id
       JOIN outbox ON outbox.run_id = plan_revisions.run_id
        AND outbox.kind = 'analysis_dispatch'
        AND outbox.dedupe_key = 'analysis-replan:' || plan_revisions.revision_id
       WHERE plan_revisions.revision_id = ?`,
    ).bind(revisionId).first<BeginProjectionRow>();
  }

  private async sourceFact(sourceRef: string): Promise<SourceFactRow | null> {
    return await this.db.prepare(
      `SELECT run_id, expected_run_version, prior_plan_id, prior_plan_version,
              prior_plan_digest, source_kind, source_digest, requested_base_sha
       FROM plan_revision_source_facts WHERE source_ref = ?`,
    ).bind(sourceRef).first<SourceFactRow>();
  }

  private async baseObservation(observationId: string): Promise<BaseObservationRow | null> {
    return await this.db.prepare(
      `SELECT observation_id, run_id, expected_run_version, prior_plan_id,
              prior_plan_version, prior_plan_digest, repository, base_branch,
              before_sha, after_sha, relationship, ahead_by,
              reference_digest, comparison_digest, source_digest
       FROM github_base_observations WHERE observation_id = ?`,
    ).bind(observationId).first<BaseObservationRow>();
  }

  private beginResult(
    row: BeginProjectionRow,
    created: boolean,
    input: BeginPlanRevisionInput,
  ): BeginPlanRevisionResult {
    if (
      row.status !== 'analyzing' ||
      row.run_state !== 'planning' ||
      row.run_version !== input.expectedRunVersion + 1 ||
      row.run_base_sha !== input.requestedBaseSha
    ) throw new PlanRevisionError('state_conflict');
    return {
      revisionId: row.revision_id,
      analysisAttemptId: row.analysis_attempt_id,
      dispatchOutboxId: row.outbox_id,
      created,
      runVersion: row.run_version,
    };
  }

  private async activationCandidate(
    input: ActivatePlanRevisionInput,
  ): Promise<ActivationCandidateRow | null> {
    return await this.db.prepare(
      `SELECT plan_revisions.revision_id,
              plan_revisions.status AS revision_status,
              plan_revisions.prior_plan_id, plan_revisions.prior_plan_version,
              plan_revisions.prior_plan_digest, plan_revisions.prior_base_sha,
              plan_revisions.requested_base_sha,
              analysis.attempt_id AS analysis_attempt_id,
              runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha AS run_base_sha, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              prior.status AS prior_plan_status,
              replacement.plan_id AS new_plan_id,
              replacement.plan_version AS new_plan_version,
              replacement.digest AS new_plan_digest,
              replacement.base_sha AS new_plan_base_sha,
              replacement.status AS new_plan_status,
              replacement.created_by_attempt_id AS new_plan_created_by_attempt_id,
              analysis.status AS analysis_attempt_status
       FROM plan_revisions
       JOIN runs ON runs.run_id = plan_revisions.run_id
       JOIN execution_plans AS prior ON prior.plan_id = plan_revisions.prior_plan_id
       JOIN attempts AS analysis
         ON analysis.attempt_id = COALESCE(
           (SELECT retry.retry_attempt_id
            FROM plan_revision_analysis_retries AS retry
            WHERE retry.revision_id = plan_revisions.revision_id
            ORDER BY retry.retry_sequence DESC LIMIT 1),
           plan_revisions.analysis_attempt_id
         )
       JOIN execution_plans AS replacement
         ON replacement.plan_id = ? AND replacement.run_id = plan_revisions.run_id
       WHERE plan_revisions.revision_id = ?`,
    ).bind(input.planId, input.revisionId).first<ActivationCandidateRow>();
  }

  private async activatedProjection(revisionId: string): Promise<ActivatedProjectionRow | null> {
    return await this.db.prepare(
      `SELECT plan_revisions.revision_id, plan_revisions.new_plan_id,
              plan_revisions.new_plan_version, plan_revisions.new_plan_digest,
              plan_revisions.body_changed, plan_revisions.base_changed,
              plan_revisions.effects_changed,
              runs.state AS run_state, runs.version AS run_version,
              runs.active_plan_id, runs.active_plan_version,
              runs.active_plan_digest
       FROM plan_revisions
       JOIN runs ON runs.run_id = plan_revisions.run_id
       WHERE plan_revisions.revision_id = ?
         AND plan_revisions.status = 'activated'`,
    ).bind(revisionId).first<ActivatedProjectionRow>();
  }

  private async isRejectedNoChange(input: ActivatePlanRevisionInput): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT new_plan_id, new_plan_version, new_plan_digest,
              body_changed, base_changed, effects_changed
       FROM plan_revisions
       WHERE revision_id = ? AND status = 'rejected'`,
    ).bind(input.revisionId).first<{
      new_plan_id: string | null;
      new_plan_version: number | null;
      new_plan_digest: string | null;
      body_changed: number | null;
      base_changed: number | null;
      effects_changed: number | null;
    }>();
    if (row === null) return false;
    if (
      row.new_plan_id !== input.planId ||
      row.new_plan_version !== input.planVersion ||
      row.new_plan_digest !== input.planDigest ||
      row.body_changed !== 0 ||
      row.base_changed !== 0 ||
      row.effects_changed !== 0
    ) throw new PlanRevisionError('state_conflict');
    return true;
  }

  private activateResult(
    row: ActivatedProjectionRow,
    created: boolean,
    input: ActivatePlanRevisionInput,
  ): ActivatePlanRevisionResult {
    if (
      row.new_plan_id !== input.planId ||
      row.new_plan_version !== input.planVersion ||
      row.new_plan_digest !== input.planDigest ||
      row.run_state !== 'awaiting_approval' ||
      row.active_plan_id !== input.planId ||
      row.active_plan_version !== input.planVersion ||
      row.active_plan_digest !== input.planDigest
    ) throw new PlanRevisionError('state_conflict');
    return {
      revisionId: row.revision_id,
      planId: row.new_plan_id,
      planVersion: row.new_plan_version,
      planDigest: row.new_plan_digest,
      created,
      runVersion: row.run_version,
      changes: {
        body: row.body_changed === 1,
        base: row.base_changed === 1,
        effects: row.effects_changed === 1,
      },
    };
  }

  private async semanticDigest(planId: string): Promise<string> {
    const plan = await this.db.prepare(
      'SELECT objective FROM execution_plans WHERE plan_id = ?',
    ).bind(planId).first<{ objective: string }>();
    if (plan === null) throw new PlanRevisionError('state_conflict');
    const queries = await Promise.all([
      this.rows('SELECT position, assumption FROM execution_plan_assumptions WHERE plan_id = ? ORDER BY position', planId),
      this.rows('SELECT position, evidence_ref FROM execution_plan_evidence_refs WHERE plan_id = ? ORDER BY position', planId),
      this.rows('SELECT item_id, kind, title, objective, required, position FROM plan_items WHERE plan_id = ? ORDER BY position', planId),
      this.rows('SELECT item_id, acceptance_criterion_index FROM plan_item_acceptance_criteria WHERE plan_id = ? ORDER BY item_id, acceptance_criterion_index', planId),
      this.rows('SELECT item_id, position, condition FROM plan_item_done_when WHERE plan_id = ? ORDER BY item_id, position', planId),
      this.rows('SELECT item_id, depends_on_item_id FROM plan_item_dependencies WHERE plan_id = ? ORDER BY item_id, depends_on_item_id', planId),
      this.rows('SELECT item_id, effect FROM plan_item_effects WHERE plan_id = ? ORDER BY item_id, effect', planId),
      this.rows('SELECT item_id, command_ref FROM plan_item_command_refs WHERE plan_id = ? ORDER BY item_id, command_ref', planId),
      this.rows('SELECT item_id, evidence_kind FROM plan_item_evidence_kinds WHERE plan_id = ? ORDER BY item_id, evidence_kind', planId),
      this.rows('SELECT item_id, external_fact FROM plan_item_external_facts WHERE plan_id = ? ORDER BY item_id, external_fact', planId),
    ]);
    return await canonicalSha256({ objective: plan.objective, normalized: queries });
  }

  private async effectsDigest(planId: string): Promise<string> {
    return await canonicalSha256(await this.rows(
      'SELECT item_id, effect FROM plan_item_effects WHERE plan_id = ? ORDER BY item_id, effect',
      planId,
    ));
  }

  private async rows(sql: string, planId: string): Promise<Record<string, unknown>[]> {
    const result = await this.db.prepare(sql).bind(planId).all<Record<string, unknown>>();
    if (!result.success) throw new PlanRevisionError('state_conflict');
    return result.results;
  }

  private async rejectNoChange(
    candidate: ActivationCandidateRow,
    input: ActivatePlanRevisionInput,
    now: Date,
  ): Promise<void> {
    const nowIso = now.toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE execution_plans SET status = 'superseded', updated_at = ?
         WHERE plan_id = ? AND run_id = ? AND plan_version = ?
           AND digest = ? AND status = 'validated'
           AND EXISTS (
             SELECT 1 FROM plan_revisions
             WHERE revision_id = ? AND status = 'analyzing'
           )`,
      ).bind(
        nowIso,
        candidate.new_plan_id,
        candidate.run_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
        candidate.revision_id,
      ),
      this.db.prepare(
        `UPDATE runs SET state = 'awaiting_approval', base_sha = ?,
                         version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'planning' AND version = ?
           AND active_plan_id = ? AND active_plan_version = ?
           AND active_plan_digest = ?
           AND EXISTS (
             SELECT 1 FROM execution_plans
             WHERE plan_id = ? AND status = 'superseded'
           )`,
      ).bind(
        candidate.prior_base_sha,
        nowIso,
        candidate.run_id,
        input.expectedRunVersion,
        candidate.prior_plan_id,
        candidate.prior_plan_version,
        candidate.prior_plan_digest,
        candidate.new_plan_id,
      ),
      this.db.prepare(
        `UPDATE attempts SET status = 'completed', version = version + 1,
                            lease_generation = lease_generation + 1,
                            lease_token_digest = NULL, lease_expires_at = NULL,
                            updated_at = ?
         WHERE attempt_id = ? AND run_id = ?
           AND status IN ('pending', 'running')
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE run_id = ? AND state = 'awaiting_approval'
               AND active_plan_id = ? AND active_plan_version = ?
               AND active_plan_digest = ?
           )`,
      ).bind(
        nowIso,
        candidate.analysis_attempt_id,
        candidate.run_id,
        candidate.run_id,
        candidate.prior_plan_id,
        candidate.prior_plan_version,
        candidate.prior_plan_digest,
      ),
      this.db.prepare(
        `UPDATE plan_revisions
         SET new_plan_id = ?, new_plan_version = ?, new_plan_digest = ?,
             body_changed = 0, base_changed = 0, effects_changed = 0,
             status = 'rejected', updated_at = ?
         WHERE revision_id = ? AND status = 'analyzing'
           AND EXISTS (
             SELECT 1 FROM runs
             WHERE run_id = plan_revisions.run_id
               AND state = 'awaiting_approval' AND version = ?
               AND active_plan_id = ? AND active_plan_version = ?
               AND active_plan_digest = ?
           )`,
      ).bind(
        candidate.new_plan_id,
        candidate.new_plan_version,
        candidate.new_plan_digest,
        nowIso,
        candidate.revision_id,
        input.expectedRunVersion + 1,
        candidate.prior_plan_id,
        candidate.prior_plan_version,
        candidate.prior_plan_digest,
      ),
    ]);
    const rejected = await this.db.prepare(
      `SELECT status FROM plan_revisions WHERE revision_id = ?`,
    ).bind(candidate.revision_id).first<{ status: string }>();
    if (rejected?.status !== 'rejected') throw new PlanRevisionError('state_conflict');
  }
}
