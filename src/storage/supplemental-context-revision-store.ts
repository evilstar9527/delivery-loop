import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  SupplementalContextDataSchema,
  type SupplementalContextData,
} from '../domain/revision-source.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
  type TaskEnvelope,
} from '../domain/task.js';
import { SecretScanner } from '../security/redaction.js';
import {
  ImmutableR2ObjectConflictError,
  putImmutableJsonObject,
} from './immutable-r2-object.js';
import {
  PlanRevisionError,
  PlanRevisionStore,
  type BeginPlanRevisionResult,
} from './plan-revision-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

const SupplementalBaseSchema = z.object({
  schemaVersion: z.literal('1'),
  priorTaskId: z.string().regex(ID_PATTERN),
  task: TaskEnvelopeSchema,
  context: z.string().min(1).max(65_536).refine((value) => /\S/.test(value)),
});
const CurrentRunBindingSchema = z.object({
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  taskRevision: z.string().min(1).max(500),
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(DIGEST_PATTERN),
  baseSha: z.string().regex(SHA_PATTERN),
}).strict();
export const SupplementalContextRevisionInputSchema = z.discriminatedUnion(
  'applyToCurrentRun',
  [
    SupplementalBaseSchema.extend({
      applyToCurrentRun: z.literal(false),
    }).strict(),
    SupplementalBaseSchema.extend({
      applyToCurrentRun: z.literal(true),
      currentRun: CurrentRunBindingSchema,
    }).strict(),
  ],
);

type SupplementalContextRevisionInput = z.infer<
  typeof SupplementalContextRevisionInputSchema
>;

export type SupplementalContextRevisionErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'revision_conflict'
  | 'state_conflict'
  | 'secret_detected'
  | 'storage_unavailable';

export class SupplementalContextRevisionError extends Error {
  constructor(readonly code: SupplementalContextRevisionErrorCode) {
    super(`Supplemental context revision operation failed: ${code}`);
    this.name = 'SupplementalContextRevisionError';
  }
}

export interface SupplementalContextRevisionResult {
  contextId: string;
  taskId: string;
  runId: string;
  workflowOutboxId: string;
  disposition: 'queued' | 'applied_to_current';
  created: boolean;
  planRevision?: BeginPlanRevisionResult;
}

interface StoreOptions {
  secrets?: readonly string[];
}

interface PriorTaskRow {
  task_id: string;
  source_system: string;
  tenant_key: string;
  source_task_key: string;
  task_revision: string;
  target_repository: string;
  target_base_branch: string;
  target_environment: string;
  intent_kind: string;
  allow_repository_write: number;
  allow_test_deploy: number;
  allow_production_deploy: number;
  require_human_approval: number;
}

interface ExistingContextRow {
  context_id: string;
  event_digest: string;
  prior_task_id: string;
  prior_task_revision: string;
  new_task_id: string;
  new_task_revision: string;
  new_task_digest: string;
  new_run_id: string;
  context_ref: string;
  context_digest: string;
  apply_to_current_run: number;
  applied_run_id: string | null;
  expected_run_version: number | null;
  prior_plan_version: number | null;
  prior_plan_digest: string | null;
  base_sha: string | null;
}

interface PreparedSupplementalContext {
  input: SupplementalContextRevisionInput;
  task: TaskEnvelope;
  taskId: string;
  runId: string;
  workflowOutboxId: string;
  taskDigest: string;
  taskPayloadRef: string;
  contextId: string;
  contextDigest: string;
  contextRef: string;
  contextData: SupplementalContextData;
  eventDigest: string;
}

/** R2-first producer for immutable Task revisions and optional current-Run re-analysis. */
export class SupplementalContextRevisionStore {
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    options: StoreOptions = {},
  ) {
    this.secrets = [...(options.secrets ?? [])];
  }

  async accept(rawInput: unknown, now = new Date()): Promise<SupplementalContextRevisionResult> {
    const parsed = SupplementalContextRevisionInputSchema.safeParse(rawInput);
    if (!parsed.success || !Number.isFinite(now.getTime())) {
      throw new SupplementalContextRevisionError('invalid_request');
    }
    const input = parsed.data;
    if (new SecretScanner({ secrets: this.secrets }).scan(input).length > 0) {
      throw new SupplementalContextRevisionError('secret_detected');
    }
    const prior = await this.priorTask(input.priorTaskId);
    if (prior === null) throw new SupplementalContextRevisionError('not_found');
    this.assertRevisionBoundary(prior, input.task);

    let prepared: PreparedSupplementalContext;
    try {
      prepared = await this.prepare(input, prior);
    } catch {
      throw new SupplementalContextRevisionError('invalid_request');
    }
    const existing = await this.existingByPrior(input.priorTaskId);
    if (existing !== null) this.assertExisting(existing, prepared);
    if (existing === null && input.applyToCurrentRun) await this.assertCurrentRun(input);
    await this.persistObjects(prepared);

    if (input.applyToCurrentRun) {
      let planRevision: BeginPlanRevisionResult;
      try {
        planRevision = await new PlanRevisionStore(this.db).beginFromSupplementalContext({
          priorTaskId: input.priorTaskId,
          task: input.task,
          payloadRef: prepared.taskPayloadRef,
          contextRef: prepared.contextRef,
          context: prepared.contextData,
          currentRun: input.currentRun,
        }, now);
      } catch (error) {
        if (error instanceof PlanRevisionError) {
          throw new SupplementalContextRevisionError(
            error.code === 'invalid_request' ? 'invalid_request' : 'state_conflict',
          );
        }
        throw new SupplementalContextRevisionError('state_conflict');
      }
      const persisted = await this.existingByPrior(input.priorTaskId);
      if (persisted === null) throw new SupplementalContextRevisionError('state_conflict');
      this.assertExisting(persisted, prepared);
      return {
        contextId: prepared.contextId,
        taskId: prepared.taskId,
        runId: prepared.runId,
        workflowOutboxId: prepared.workflowOutboxId,
        disposition: 'applied_to_current',
        created: planRevision.created,
        planRevision,
      };
    }

    let results: D1Result<unknown>[];
    try {
      results = await this.persistQueued(prepared, prior, now.toISOString());
    } catch {
      throw new SupplementalContextRevisionError('state_conflict');
    }
    const persisted = await this.existingByPrior(input.priorTaskId);
    if (persisted === null) throw new SupplementalContextRevisionError('state_conflict');
    this.assertExisting(persisted, prepared);
    return {
      contextId: prepared.contextId,
      taskId: prepared.taskId,
      runId: prepared.runId,
      workflowOutboxId: prepared.workflowOutboxId,
      disposition: 'queued',
      created: results[3]?.meta.changes === 1,
    };
  }

  private async prepare(
    input: SupplementalContextRevisionInput,
    prior: PriorTaskRow,
  ): Promise<PreparedSupplementalContext> {
    const task = input.task;
    const [ids, taskDigest, eventDigest] = await Promise.all([
      taskRevisionIds(task),
      taskRevisionDigest(task),
      canonicalSha256({
        schemaVersion: '1',
        sourceSystem: task.source.system,
        tenantKey: task.source.tenantKey,
        eventId: task.eventId,
      }),
    ]);
    const contextData = SupplementalContextDataSchema.parse({
      schemaVersion: '1',
      source: {
        system: task.source.system,
        tenantKey: task.source.tenantKey,
        taskKey: task.source.taskKey,
        priorRevision: prior.task_revision,
        revision: task.source.revision,
      },
      actor: { type: task.actor.type, id: task.actor.id },
      body: input.context,
    });
    const contextDigest = await canonicalSha256(contextData);
    const contextIdentity = await canonicalSha256({
      schemaVersion: '1',
      priorTaskId: input.priorTaskId,
      newTaskId: ids.taskId,
      contextDigest,
    });
    const contextId = `supplemental_context_${stableSuffix(contextIdentity)}`;
    return {
      input,
      task,
      taskId: ids.taskId,
      runId: ids.runId,
      workflowOutboxId: ids.workflowCreateOutboxId,
      taskDigest,
      taskPayloadRef:
        `r2://tasks/${ids.taskId}/${taskDigest.slice('sha256:'.length)}.json`,
      contextId,
      contextDigest,
      contextRef:
        `r2://supplemental-context/${contextId}/` +
        `${contextDigest.slice('sha256:'.length)}.json`,
      contextData,
      eventDigest,
    };
  }

  private async persistObjects(prepared: PreparedSupplementalContext): Promise<void> {
    try {
      await Promise.all([
        putImmutableJsonObject(this.objects, {
          key: prepared.taskPayloadRef.slice('r2://'.length),
          body: JSON.stringify(prepared.task),
          metadata: { taskDigest: prepared.taskDigest },
        }),
        putImmutableJsonObject(this.objects, {
          key: prepared.contextRef.slice('r2://'.length),
          body: JSON.stringify(prepared.contextData),
          metadata: {
            schemaVersion: '1',
            contextId: prepared.contextId,
            contextDigest: prepared.contextDigest,
            priorTaskId: prepared.input.priorTaskId,
            newTaskId: prepared.taskId,
          },
        }),
      ]);
    } catch (error) {
      if (error instanceof ImmutableR2ObjectConflictError) {
        throw new SupplementalContextRevisionError('revision_conflict');
      }
      throw new SupplementalContextRevisionError('storage_unavailable');
    }
  }

  private async persistQueued(
    prepared: PreparedSupplementalContext,
    prior: PriorTaskRow,
    nowIso: string,
  ): Promise<D1Result<unknown>[]> {
    const task = prepared.task;
    const repository = `${task.target.owner}/${task.target.repo}`;
    const lineageGuard =
      `NOT EXISTS (
         SELECT 1 FROM supplemental_context_revisions AS conflicting
         WHERE conflicting.prior_task_id = prior.task_id
           AND (
             conflicting.new_task_id <> ? OR
             conflicting.context_ref <> ? OR
             conflicting.context_digest <> ? OR
             conflicting.apply_to_current_run <> 0
           )
       )`;
    const eventGuard =
      `NOT EXISTS (
         SELECT 1 FROM supplemental_context_revisions AS conflicting_event
         WHERE conflicting_event.event_digest = ?
           AND conflicting_event.context_id <> ?
       )`;
    return await this.db.batch([
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
         WHERE prior.task_id = ? AND prior.task_revision = ?
           AND prior.source_system = ? AND prior.tenant_key = ?
           AND prior.source_task_key = ?
           AND prior.target_repository = ? AND prior.target_base_branch = ?
           AND prior.target_environment = ? AND prior.intent_kind = ?
           AND prior.allow_repository_write = ? AND prior.allow_test_deploy = ?
           AND prior.allow_production_deploy = ? AND prior.require_human_approval = ?
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        prepared.taskId,
        task.source.system,
        task.source.tenantKey,
        task.source.taskKey,
        task.source.revision,
        task.source.url ?? null,
        prepared.taskDigest,
        prepared.taskPayloadRef,
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
        prior.task_id,
        prior.task_revision,
        prior.source_system,
        prior.tenant_key,
        prior.source_task_key,
        prior.target_repository,
        prior.target_base_branch,
        prior.target_environment,
        prior.intent_kind,
        prior.allow_repository_write,
        prior.allow_test_deploy,
        prior.allow_production_deploy,
        prior.require_human_approval,
        prepared.taskId,
        prepared.contextRef,
        prepared.contextDigest,
        prepared.eventDigest,
        prepared.contextId,
      ),
      this.db.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha, workflow_instance_id,
           state, version, created_at, updated_at
         )
         SELECT ?, next.task_id, next.task_revision, next.task_digest,
                prior_run.base_sha, ?, 'queued', 0, ?, ?
         FROM tasks AS next
         JOIN tasks AS prior ON prior.task_id = ?
         JOIN runs AS prior_run ON prior_run.task_id = prior.task_id
         WHERE next.task_id = ? AND next.task_digest = ? AND next.payload_ref = ?
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        prepared.runId,
        prepared.runId,
        nowIso,
        nowIso,
        prior.task_id,
        prepared.taskId,
        prepared.taskDigest,
        prepared.taskPayloadRef,
        prepared.taskId,
        prepared.contextRef,
        prepared.contextDigest,
        prepared.eventDigest,
        prepared.contextId,
      ),
      this.db.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         )
         SELECT ?, queued.run_id, 'workflow_create', 'cloudflare_workflows', ?, ?,
                'pending', ?, ?
         FROM runs AS queued
         JOIN tasks AS next ON next.task_id = queued.task_id
         JOIN tasks AS prior ON prior.task_id = ?
         WHERE queued.run_id = ? AND queued.state = 'queued' AND queued.version = 0
           AND next.task_id = ? AND next.task_digest = ? AND next.payload_ref = ?
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        prepared.workflowOutboxId,
        `d1://runs/${prepared.runId}`,
        `workflow-create:${prepared.runId}`,
        nowIso,
        nowIso,
        prior.task_id,
        prepared.runId,
        prepared.taskId,
        prepared.taskDigest,
        prepared.taskPayloadRef,
        prepared.taskId,
        prepared.contextRef,
        prepared.contextDigest,
        prepared.eventDigest,
        prepared.contextId,
      ),
      this.db.prepare(
        `INSERT INTO supplemental_context_revisions (
           context_id, event_digest, prior_task_id, prior_task_revision,
           new_task_id, new_task_revision, new_task_digest, new_run_id,
           context_ref, context_digest, apply_to_current_run, created_at
         )
         SELECT ?, ?, prior.task_id, prior.task_revision,
                next.task_id, next.task_revision, next.task_digest, queued.run_id,
                ?, ?, 0, ?
         FROM tasks AS prior
         JOIN tasks AS next ON next.task_id = ?
         JOIN runs AS queued ON queued.run_id = ? AND queued.task_id = next.task_id
         JOIN outbox AS intent ON intent.outbox_id = ? AND intent.run_id = queued.run_id
         WHERE prior.task_id = ? AND prior.task_revision = ?
           AND next.task_digest = ? AND next.payload_ref = ?
           AND queued.state = 'queued' AND queued.version = 0
           AND intent.kind = 'workflow_create' AND intent.delivery_state = 'pending'
           AND ${lineageGuard}
           AND ${eventGuard}
         ON CONFLICT DO NOTHING`,
      ).bind(
        prepared.contextId,
        prepared.eventDigest,
        prepared.contextRef,
        prepared.contextDigest,
        nowIso,
        prepared.taskId,
        prepared.runId,
        prepared.workflowOutboxId,
        prior.task_id,
        prior.task_revision,
        prepared.taskDigest,
        prepared.taskPayloadRef,
        prepared.taskId,
        prepared.contextRef,
        prepared.contextDigest,
        prepared.eventDigest,
        prepared.contextId,
      ),
    ]);
  }

  private async priorTask(taskId: string): Promise<PriorTaskRow | null> {
    return await this.db.prepare(
      `SELECT task_id, source_system, tenant_key, source_task_key, task_revision,
              target_repository, target_base_branch, target_environment, intent_kind,
              allow_repository_write, allow_test_deploy, allow_production_deploy,
              require_human_approval
       FROM tasks WHERE task_id = ?`,
    ).bind(taskId).first<PriorTaskRow>();
  }

  private assertRevisionBoundary(prior: PriorTaskRow, task: TaskEnvelope): void {
    if (
      task.source.system !== prior.source_system ||
      task.source.tenantKey !== prior.tenant_key ||
      task.source.taskKey !== prior.source_task_key ||
      task.source.revision === prior.task_revision ||
      `${task.target.owner}/${task.target.repo}` !== prior.target_repository ||
      task.target.baseBranch !== prior.target_base_branch ||
      task.target.environment !== prior.target_environment ||
      task.intent.kind !== prior.intent_kind ||
      Number(task.policy.allowRepositoryWrite) !== prior.allow_repository_write ||
      Number(task.policy.allowTestDeploy) !== prior.allow_test_deploy ||
      Number(task.policy.allowProductionDeploy) !== prior.allow_production_deploy ||
      Number(task.policy.requireHumanApproval) !== prior.require_human_approval
    ) throw new SupplementalContextRevisionError('revision_conflict');
  }

  private async assertCurrentRun(
    input: Extract<SupplementalContextRevisionInput, { applyToCurrentRun: true }>,
  ): Promise<void> {
    const row = await this.db.prepare(
      `SELECT runs.run_id
       FROM runs
       JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ? AND runs.task_id = ? AND runs.task_revision = ?
         AND runs.version = ? AND runs.base_sha = ?
         AND runs.active_plan_version = ? AND runs.active_plan_digest = ?
         AND runs.state IN (
           'awaiting_approval', 'executing', 'verifying', 'pull_request_open',
           'awaiting_review', 'ready_to_merge', 'blocked'
         )
         AND execution_plans.status = 'active'
         AND execution_plans.base_sha = runs.base_sha`,
    ).bind(
      input.currentRun.runId,
      input.priorTaskId,
      input.currentRun.taskRevision,
      input.currentRun.expectedRunVersion,
      input.currentRun.baseSha,
      input.currentRun.planVersion,
      input.currentRun.planDigest,
    ).first<{ run_id: string }>();
    if (row === null) throw new SupplementalContextRevisionError('state_conflict');
  }

  private async existingByPrior(priorTaskId: string): Promise<ExistingContextRow | null> {
    return await this.db.prepare(
      `SELECT context_id, event_digest, prior_task_id, prior_task_revision,
              new_task_id, new_task_revision, new_task_digest, new_run_id,
              context_ref, context_digest, apply_to_current_run, applied_run_id,
              expected_run_version, prior_plan_version, prior_plan_digest, base_sha
       FROM supplemental_context_revisions WHERE prior_task_id = ?`,
    ).bind(priorTaskId).first<ExistingContextRow>();
  }

  private assertExisting(
    row: ExistingContextRow,
    prepared: PreparedSupplementalContext,
  ): void {
    const input = prepared.input;
    if (
      row.context_id !== prepared.contextId ||
      row.prior_task_id !== input.priorTaskId ||
      row.new_task_id !== prepared.taskId ||
      row.new_task_revision !== prepared.task.source.revision ||
      row.new_task_digest !== prepared.taskDigest ||
      row.new_run_id !== prepared.runId ||
      row.context_ref !== prepared.contextRef ||
      row.context_digest !== prepared.contextDigest ||
      row.apply_to_current_run !== Number(input.applyToCurrentRun)
    ) throw new SupplementalContextRevisionError('state_conflict');
    if (
      input.applyToCurrentRun && (
        row.applied_run_id !== input.currentRun.runId ||
        row.expected_run_version !== input.currentRun.expectedRunVersion ||
        row.prior_plan_version !== input.currentRun.planVersion ||
        row.prior_plan_digest !== input.currentRun.planDigest ||
        row.base_sha !== input.currentRun.baseSha
      )
    ) throw new SupplementalContextRevisionError('state_conflict');
    if (
      !input.applyToCurrentRun && (
        row.applied_run_id !== null ||
        row.expected_run_version !== null ||
        row.prior_plan_version !== null ||
        row.prior_plan_digest !== null ||
        row.base_sha !== null
      )
    ) throw new SupplementalContextRevisionError('state_conflict');
  }
}

function stableSuffix(digest: string): string {
  return digest.slice('sha256:'.length, 'sha256:'.length + 52);
}
