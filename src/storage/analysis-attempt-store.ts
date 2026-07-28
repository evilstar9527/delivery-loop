import {
  AnalysisPlanContentV1Schema,
  deriveAnalysisPlanId,
  type AnalysisPlanContentV1,
} from '../domain/analysis-plan.js';
import {
  computeExecutionPlanDigest,
  ExecutionPlanValidationError,
  type ExecutionPlanBodyV1,
  type ExecutionPlanV1,
  type PlanEffect,
} from '../domain/plan.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  type TaskEnvelope,
} from '../domain/task.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  BaseUpdateRevisionDataSchema,
  ReviewFeedbackRevisionDataSchema,
  SupplementalContextDataSchema,
  type AnalysisRevisionSource,
} from '../domain/revision-source.js';
import type { RunnerAuthorization } from './runner-attempt-store.js';
import { ExecutionPlanStore } from './execution-plan-store.js';
import { SecretScanner } from '../security/redaction.js';

export const ANALYSIS_ALLOWED_EFFECTS = [
  'repo_read',
  'logs_read',
  'database_diagnostic',
] as const satisfies readonly PlanEffect[];
export const ANALYSIS_ALLOWED_COMMAND_REFS = ['policy:inspect', 'policy:diagnose'] as const;

type AnalysisAttemptErrorCode =
  | 'attempt_context_mismatch'
  | 'task_payload_unavailable'
  | 'task_payload_conflict'
  | 'revision_source_unavailable'
  | 'revision_source_conflict'
  | 'plan_policy_denied'
  | 'plan_secret_detected'
  | 'plan_evidence_conflict';

export class AnalysisAttemptError extends Error {
  constructor(readonly code: AnalysisAttemptErrorCode) {
    super(`Analysis Attempt operation failed: ${code}`);
    this.name = 'AnalysisAttemptError';
  }
}

interface AttemptContextRow {
  attempt_id: string;
  run_id: string;
  mode: string;
  status: string;
  version: number;
  lease_generation: number;
  base_sha: string;
  repository: string | null;
  task_id: string;
  task_revision: string;
  task_digest: string;
  run_state: string;
  payload_ref: string;
  target_repository: string;
  target_base_branch: string;
  acceptance_criteria_count: number;
  intent_kind: string;
}

export interface AnalysisAttemptContext {
  schemaVersion: '1';
  attempt: {
    id: string;
    runId: string;
    mode: 'analysis';
    version: number;
    leaseGeneration: number;
    baseSha: string;
  };
  task: TaskEnvelope;
  revisionSource?: AnalysisRevisionSource;
  planPolicy: {
    version: number;
    allowedEffects: readonly PlanEffect[];
    allowedCommandRefs: readonly string[];
  };
}

export interface AnalysisPlanSaveResult {
  created: boolean;
  plan: ExecutionPlanV1;
}

async function attemptContextRow(
  db: D1Database,
  authorization: RunnerAuthorization,
): Promise<AttemptContextRow> {
  const row = await db
    .prepare(
      `SELECT attempts.attempt_id, attempts.run_id, attempts.mode, attempts.status,
              attempts.version, attempts.lease_generation, attempts.base_sha,
              attempts.repository, runs.task_id, runs.task_revision, runs.task_digest,
              runs.state AS run_state, tasks.payload_ref, tasks.target_repository,
              tasks.target_base_branch, tasks.acceptance_criteria_count,
              tasks.intent_kind
       FROM attempts
       JOIN runs ON runs.run_id = attempts.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
    )
    .bind(authorization.attemptId, authorization.runId)
    .first<AttemptContextRow>();
  if (
    row === null ||
    row.mode !== 'analysis' ||
    row.status !== 'running' ||
    row.version !== authorization.version ||
    row.lease_generation !== authorization.leaseGeneration ||
    row.repository !== row.target_repository ||
    !authorization.scopes.includes('repo:read')
  ) {
    throw new AnalysisAttemptError('attempt_context_mismatch');
  }
  return row;
}

export class AnalysisAttemptContextStore {
  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
  ) {}

  async get(authorization: RunnerAuthorization): Promise<AnalysisAttemptContext> {
    const row = await attemptContextRow(this.db, authorization);
    const prefix = 'r2://';
    if (!row.payload_ref.startsWith(prefix)) {
      throw new AnalysisAttemptError('task_payload_conflict');
    }
    const key = row.payload_ref.slice(prefix.length);
    if (key.length === 0 || key.includes('..')) {
      throw new AnalysisAttemptError('task_payload_conflict');
    }
    const object = await this.objects.get(key);
    if (object === null) throw new AnalysisAttemptError('task_payload_unavailable');

    let task: TaskEnvelope;
    try {
      task = TaskEnvelopeSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new AnalysisAttemptError('task_payload_conflict');
    }
    const digest = await taskRevisionDigest(task);
    if (
      digest !== row.task_digest ||
      object.customMetadata?.taskDigest !== row.task_digest ||
      task.source.revision !== row.task_revision ||
      `${task.target.owner}/${task.target.repo}` !== row.target_repository ||
      task.target.baseBranch !== row.target_base_branch
    ) {
      throw new AnalysisAttemptError('task_payload_conflict');
    }
    const version = await nextPlanVersion(this.db, row.run_id);
    const revisionSource = await this.revisionSource(row);
    return {
      schemaVersion: '1',
      attempt: {
        id: row.attempt_id,
        runId: row.run_id,
        mode: 'analysis',
        version: row.version,
        leaseGeneration: row.lease_generation,
        baseSha: row.base_sha,
      },
      task,
      ...(revisionSource === undefined ? {} : { revisionSource }),
      planPolicy: {
        version,
        allowedEffects: ANALYSIS_ALLOWED_EFFECTS,
        allowedCommandRefs: ANALYSIS_ALLOWED_COMMAND_REFS,
      },
    };
  }

  private async revisionSource(
    row: AttemptContextRow,
  ): Promise<AnalysisRevisionSource | undefined> {
    const facts = await this.db.prepare(
      `SELECT source.source_ref, source.source_kind, source.source_digest
       FROM plan_revisions AS revision
       JOIN plan_revision_source_facts AS source
         ON source.source_ref = revision.source_ref
        AND source.run_id = revision.run_id
        AND source.source_kind = revision.source_kind
        AND source.source_digest = revision.source_digest
       WHERE revision.analysis_attempt_id = ? AND revision.run_id = ?
         AND revision.status = 'analyzing'
       UNION ALL
       SELECT context_ref AS source_ref, 'supplemental_context' AS source_kind,
              context_digest AS source_digest
       FROM supplemental_context_revisions
       WHERE new_run_id = ? AND apply_to_current_run = 0`,
    ).bind(row.attempt_id, row.run_id, row.run_id).all<RevisionSourceFactRow>();
    if (!facts.success || facts.results.length > 1) {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    const fact = facts.results[0];
    if (fact === undefined) return undefined;
    switch (fact.source_kind) {
      case 'review_feedback':
        return await this.reviewRevisionSource(row, fact);
      case 'supplemental_context':
        return await this.supplementalRevisionSource(row, fact);
      case 'base_update':
        return await this.baseRevisionSource(row, fact);
      default:
        throw new AnalysisAttemptError('revision_source_conflict');
    }
  }

  private async reviewRevisionSource(
    row: AttemptContextRow,
    fact: RevisionSourceFactRow,
  ): Promise<AnalysisRevisionSource> {
    const feedback = await this.db.prepare(
      `SELECT feedback_id, github_review_id, body_ref, body_digest,
              source_head_sha, branch, review_url, submitted_at
       FROM github_review_feedbacks
       WHERE run_id = ? AND ? = 'd1://github-review-feedbacks/' || feedback_id`,
    ).bind(row.run_id, fact.source_ref).first<ReviewRevisionSourceRow>();
    if (feedback === null || !feedback.body_ref.startsWith('r2://')) {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    const expectedDigest = await canonicalSha256({
      schemaVersion: '1',
      sourceKind: 'review_feedback',
      feedbackId: feedback.feedback_id,
      githubReviewId: feedback.github_review_id,
      bodyDigest: feedback.body_digest,
      sourceHeadSha: feedback.source_head_sha,
      branch: feedback.branch,
      reviewUrl: feedback.review_url,
      submittedAt: feedback.submitted_at,
    });
    if (expectedDigest !== fact.source_digest) {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    const object = await this.revisionObject(feedback.body_ref);
    let data: ReturnType<typeof ReviewFeedbackRevisionDataSchema.parse>;
    try {
      data = ReviewFeedbackRevisionDataSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    if (
      data.reviewId !== feedback.github_review_id ||
      data.bodyDigest !== feedback.body_digest ||
      await canonicalSha256(data.body) !== feedback.body_digest ||
      data.sourceHeadSha !== feedback.source_head_sha ||
      data.branch !== feedback.branch ||
      data.url !== feedback.review_url ||
      data.submittedAt !== feedback.submitted_at ||
      object.customMetadata?.schemaVersion !== '1' ||
      object.customMetadata?.feedbackId !== feedback.feedback_id ||
      object.customMetadata?.bodyDigest !== feedback.body_digest ||
      object.customMetadata?.sourceHeadSha !== feedback.source_head_sha
    ) throw new AnalysisAttemptError('revision_source_conflict');
    return { schemaVersion: '1', kind: 'review_feedback', digest: fact.source_digest, data };
  }

  private async supplementalRevisionSource(
    row: AttemptContextRow,
    fact: RevisionSourceFactRow,
  ): Promise<AnalysisRevisionSource> {
    const context = await this.db.prepare(
      `SELECT context.context_id, context.prior_task_id, context.new_task_id,
              context.new_task_revision, context.new_task_digest,
              context.context_ref, context.context_digest,
              next.payload_ref AS task_payload_ref,
              next.target_repository, next.target_base_branch
       FROM supplemental_context_revisions AS context
       JOIN tasks AS next ON next.task_id = context.new_task_id
       WHERE context.context_ref = ? AND context.context_digest = ?
         AND (
           (context.apply_to_current_run = 0 AND context.new_run_id = ?) OR
           (context.apply_to_current_run = 1 AND context.applied_run_id = ?)
         )`,
    ).bind(
      fact.source_ref,
      fact.source_digest,
      row.run_id,
      row.run_id,
    ).first<SupplementalRevisionSourceRow>();
    if (context === null || !context.context_ref.startsWith('r2://')) {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    const object = await this.revisionObject(context.context_ref);
    let data: ReturnType<typeof SupplementalContextDataSchema.parse>;
    try {
      data = SupplementalContextDataSchema.parse(JSON.parse(await object.text()) as unknown);
    } catch {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    if (
      await canonicalSha256(data) !== context.context_digest ||
      context.context_digest !== fact.source_digest ||
      object.customMetadata?.schemaVersion !== '1' ||
      object.customMetadata?.contextId !== context.context_id ||
      object.customMetadata?.contextDigest !== context.context_digest ||
      object.customMetadata?.priorTaskId !== context.prior_task_id ||
      object.customMetadata?.newTaskId !== context.new_task_id
    ) throw new AnalysisAttemptError('revision_source_conflict');
    const taskObject = await this.revisionObject(context.task_payload_ref);
    let task: TaskEnvelope;
    try {
      task = TaskEnvelopeSchema.parse(JSON.parse(await taskObject.text()) as unknown);
    } catch {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    if (
      await taskRevisionDigest(task) !== context.new_task_digest ||
      taskObject.customMetadata?.taskDigest !== context.new_task_digest ||
      task.source.revision !== context.new_task_revision ||
      `${task.target.owner}/${task.target.repo}` !== context.target_repository ||
      task.target.baseBranch !== context.target_base_branch ||
      task.source.system !== data.source.system ||
      task.source.tenantKey !== data.source.tenantKey ||
      task.source.taskKey !== data.source.taskKey ||
      task.source.revision !== data.source.revision
    ) throw new AnalysisAttemptError('revision_source_conflict');
    return {
      schemaVersion: '1',
      kind: 'supplemental_context',
      digest: fact.source_digest,
      data: {
        ...data,
        taskRevision: { digest: context.new_task_digest, task },
      },
    };
  }

  private async baseRevisionSource(
    row: AttemptContextRow,
    fact: RevisionSourceFactRow,
  ): Promise<AnalysisRevisionSource> {
    const observation = await this.db.prepare(
      `SELECT repository, base_branch, before_sha, after_sha, relationship,
              ahead_by, reference_digest, comparison_digest, source_digest
       FROM github_base_observations
       WHERE run_id = ? AND ? = 'd1://github-base-observations/' || observation_id`,
    ).bind(row.run_id, fact.source_ref).first<BaseRevisionSourceRow>();
    if (observation === null || observation.relationship !== 'ahead') {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    let data: ReturnType<typeof BaseUpdateRevisionDataSchema.parse>;
    try {
      data = BaseUpdateRevisionDataSchema.parse({
        schemaVersion: '1',
        repository: observation.repository,
        baseBranch: observation.base_branch,
        beforeSha: observation.before_sha,
        afterSha: observation.after_sha,
        relationship: observation.relationship,
        aheadBy: observation.ahead_by,
        referenceDigest: observation.reference_digest,
        comparisonDigest: observation.comparison_digest,
      });
    } catch {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    if (
      await canonicalSha256(data) !== fact.source_digest ||
      observation.source_digest !== fact.source_digest
    ) throw new AnalysisAttemptError('revision_source_conflict');
    return { schemaVersion: '1', kind: 'base_update', digest: fact.source_digest, data };
  }

  private async revisionObject(ref: string): Promise<R2ObjectBody> {
    if (!ref.startsWith('r2://')) throw new AnalysisAttemptError('revision_source_conflict');
    const key = ref.slice('r2://'.length);
    if (key.length === 0 || key.includes('..')) {
      throw new AnalysisAttemptError('revision_source_conflict');
    }
    const object = await this.objects.get(key);
    if (object === null) throw new AnalysisAttemptError('revision_source_unavailable');
    return object;
  }
}

interface RevisionSourceFactRow {
  source_ref: string;
  source_kind: string;
  source_digest: string;
}

interface ReviewRevisionSourceRow {
  feedback_id: string;
  github_review_id: string;
  body_ref: string;
  body_digest: string;
  source_head_sha: string;
  branch: string;
  review_url: string;
  submitted_at: string;
}

interface SupplementalRevisionSourceRow {
  context_id: string;
  prior_task_id: string;
  new_task_id: string;
  new_task_revision: string;
  new_task_digest: string;
  context_ref: string;
  context_digest: string;
  task_payload_ref: string;
  target_repository: string;
  target_base_branch: string;
}

interface BaseRevisionSourceRow {
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

async function nextPlanVersion(db: D1Database, runId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(plan_version), 0) + 1 AS next_version
       FROM execution_plans WHERE run_id = ?`,
    )
    .bind(runId)
    .first<{ next_version: number }>();
  if (row === null) throw new AnalysisAttemptError('attempt_context_mismatch');
  return row.next_version;
}

export class AnalysisPlanProposalStore {
  constructor(private readonly db: D1Database) {}

  async save(
    authorization: RunnerAuthorization,
    input: unknown,
    now: string,
    secrets: readonly string[] = [],
  ): Promise<AnalysisPlanSaveResult> {
    const content = AnalysisPlanContentV1Schema.parse(input);
    if (new SecretScanner({ secrets }).scan(content).length > 0) {
      throw new AnalysisAttemptError('plan_secret_detected');
    }
    const row = await attemptContextRow(this.db, authorization);
    if (row.run_state !== 'planning') {
      throw new AnalysisAttemptError('attempt_context_mismatch');
    }
    await this.assertDiagnosticEvidenceBindings(row, content);
    const existing = await this.db
      .prepare(
        `SELECT plan_version FROM execution_plans
         WHERE run_id = ? AND created_by_attempt_id = ?
         ORDER BY plan_version DESC LIMIT 1`,
      )
      .bind(row.run_id, row.attempt_id)
      .first<{ plan_version: number }>();
    const version = existing?.plan_version ?? (await nextPlanVersion(this.db, row.run_id));
    const body = await planBody(row, content, version);
    const proposal: ExecutionPlanV1 = {
      ...body,
      digest: await computeExecutionPlanDigest(body),
      status: 'proposed',
    };
    const context = {
      runId: row.run_id,
      taskRevision: row.task_revision,
      baseSha: row.base_sha,
      expectedVersion: version,
      acceptanceCriteriaCount: row.acceptance_criteria_count,
      allowedCommandRefs: ANALYSIS_ALLOWED_COMMAND_REFS,
      allowedEffects: ANALYSIS_ALLOWED_EFFECTS,
    };
    const store = new ExecutionPlanStore(this.db);
    try {
      const plan = await store.saveValidatedProposal(proposal, context, now);
      return { created: existing === null, plan };
    } catch (error) {
      if (error instanceof ExecutionPlanValidationError) {
        if (error.issues.some((issue) => issue.code === 'effect_not_allowed')) {
          throw new AnalysisAttemptError('plan_policy_denied');
        }
        throw error;
      }
      // Concurrent identical requests may race after the initial existence check.
      const plan = await store.saveValidatedProposal(proposal, context, now);
      return { created: false, plan };
    }
  }

  private async assertDiagnosticEvidenceBindings(
    row: AttemptContextRow,
    content: AnalysisPlanContentV1,
  ): Promise<void> {
    const needsDiagnosticEvidence = row.intent_kind === 'bug' && content.items.some(
      (item) => item.effects.includes('logs_read'),
    );
    if (!needsDiagnosticEvidence) return;
    const prefix = 'd1://evidence/';
    const evidenceIds = content.evidenceRefs.flatMap((reference) => {
      if (!reference.startsWith(`${prefix}diagnostic_`)) return [];
      const evidenceId = reference.slice(prefix.length);
      return /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(evidenceId) ? [evidenceId] : [];
    });
    if (evidenceIds.length === 0) throw new AnalysisAttemptError('plan_evidence_conflict');
    const placeholders = evidenceIds.map(() => '?').join(', ');
    const result = await this.db.prepare(
      `SELECT binding.evidence_id,
              SUM(CASE WHEN traces.tool_path = 'logs/search' THEN 1 ELSE 0 END) AS logs_count,
              SUM(CASE WHEN traces.tool_path = 'traces/get' THEN 1 ELSE 0 END) AS traces_count
       FROM diagnostic_evidence_bindings AS binding
       JOIN evidence ON evidence.evidence_id = binding.evidence_id
       JOIN diagnostic_evidence_trace_sources AS sources
         ON sources.evidence_id = binding.evidence_id
       JOIN tool_call_traces AS traces ON traces.trace_id = sources.trace_id
       WHERE binding.evidence_id IN (${placeholders})
         AND binding.run_id = ? AND binding.attempt_id = ?
         AND evidence.run_id = binding.run_id AND evidence.attempt_id = binding.attempt_id
         AND evidence.kind = 'diagnostic' AND evidence.status = 'passed'
         AND evidence.verification_status = 'verified'
         AND traces.run_id = binding.run_id AND traces.attempt_id = binding.attempt_id
         AND traces.effect = 'read' AND traces.result_category = 'success'
       GROUP BY binding.evidence_id ORDER BY binding.evidence_id`,
    ).bind(...evidenceIds, row.run_id, row.attempt_id).all<{
      evidence_id: string;
      logs_count: number;
      traces_count: number;
    }>();
    if (
      result.results.length !== evidenceIds.length ||
      result.results.some((evidence) => evidence.logs_count < 1 || evidence.traces_count < 1)
    ) throw new AnalysisAttemptError('plan_evidence_conflict');
  }
}

async function planBody(
  row: AttemptContextRow,
  content: AnalysisPlanContentV1,
  version: number,
): Promise<ExecutionPlanBodyV1> {
  return {
    schemaVersion: '1',
    id: await deriveAnalysisPlanId(row.run_id, row.attempt_id, version),
    runId: row.run_id,
    version,
    taskRevision: row.task_revision,
    baseSha: row.base_sha,
    createdByAttemptId: row.attempt_id,
    ...content,
  };
}
