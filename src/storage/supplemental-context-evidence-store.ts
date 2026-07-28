import { canonicalSha256 } from '../domain/digest.js';
import { SupplementalContextDataSchema } from '../domain/revision-source.js';
import { TaskEnvelopeSchema, taskRevisionDigest } from '../domain/task.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_OBJECT_BYTES = 1024 * 1024;

interface ContextRow {
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
  prior_plan_id: string | null;
  prior_plan_version: number | null;
  prior_plan_digest: string | null;
  base_sha: string | null;
  created_at: string;
  source_system: string;
  tenant_key: string;
  source_task_key: string;
  task_revision: string;
  task_digest: string;
  payload_ref: string;
  actor_type: string;
  actor_id: string;
  target_repository: string;
  target_base_branch: string;
  target_environment: string;
  intent_kind: string;
}

interface RunRow {
  run_id: string;
  state: string;
  version: number;
  base_sha: string | null;
  workflow_instance_id: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  updated_at: string;
}

interface OutboxRow {
  outbox_id: string;
  delivery_state: string;
  last_error_code: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

interface FeishuRow {
  action_receipt_id: string;
  delivery_id: string;
  tenant_key: string;
  event_id: string;
  event_digest: string;
  operator_open_id: string;
  message_id: string;
  card_id: string;
  presentation_id: string;
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  base_sha: string;
  context_mode: 'new_run' | 'apply_current';
  received_at: string;
  outcome_id: string;
  result_id: string;
  completed_at: string;
}

interface MeegleRow {
  ingress_outbox_id: string;
  event_id: string;
  tenant_key: string;
  project_key: string;
  work_item_type_key: string;
  work_item_id: string;
  external_revision: string | null;
  exact_snapshot_digest: string;
  mapping_snapshot_digest: string;
  mapping_profile_version: number;
  mapping_profile_digest: string;
  task_id: string;
  run_id: string;
  created_at: string;
}

interface AttemptRow {
  attempt_id: string;
  mode: string;
  status: string;
  plan_id: string | null;
  plan_version: number | null;
  version: number;
  lease_generation: number;
  updated_at: string;
  token_count: number;
  revoked_token_count: number;
}

interface RevisionRow {
  revision_id: string;
  expected_run_version: number;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  source_digest: string;
  requested_base_sha: string;
  analysis_attempt_id: string;
  status: string;
  created_at: string;
  attempt_status: string;
  attempt_version: number;
  attempt_lease_generation: number;
  outbox_id: string;
  outbox_delivery_state: string;
  outbox_attempt_count: number;
}

export interface SupplementalContextEvidenceProjection {
  schemaVersion: '1';
  contextId: string;
  lineage: {
    eventDigest: string;
    priorTaskId: string;
    priorTaskRevisionDigest: string;
    newTaskId: string;
    newTaskRevisionDigest: string;
    newTaskDigest: string;
    newRunId: string;
    contextDigest: string;
    mode: 'new_run' | 'apply_current';
    createdAt: string;
  };
  source: {
    system: string;
    tenantKey: string;
    taskKey: string;
    revision: string;
    repository: string;
    baseBranch: string;
    environment: string;
    intentKind: string;
  };
  objects: { contextVerified: boolean; newTaskVerified: boolean };
  newRun: {
    runId: string;
    state: string;
    version: number;
    workflowInstanceId: string;
    updatedAt: string;
  };
  workflowCreate: {
    outboxId: string;
    deliveryState: string;
    lastErrorCode: string | null;
    attemptCount: number;
    createdAt: string;
    updatedAt: string;
  };
  feishuActions: Array<{
    actionReceiptId: string;
    deliveryId: string;
    tenantKey: string;
    eventId: string;
    eventDigest: string;
    operatorDigest: string;
    messageId: string;
    cardId: string;
    presentationId: string;
    sourceRunId: string;
    sourceRunVersion: number;
    planId: string;
    planVersion: number;
    planDigest: string;
    baseSha: string;
    contextMode: 'new_run' | 'apply_current';
    outcomeId: string;
    resultId: string;
    receivedAt: string;
    completedAt: string;
    currentSourceRun: SupplementalContextEvidenceProjection['currentRunSnapshot'];
    priorPlanAttempts: SupplementalContextEvidenceProjection['attempts'];
    priorApprovalCount: number;
    approvalInvalidationCount: number;
    planRevisionCount: number;
  }>;
  meegleMappings: Array<{
    ingressOutboxId: string;
    eventId: string;
    tenantKey: string;
    projectKey: string;
    workItemTypeKey: string;
    workItemId: string;
    externalRevision: string | null;
    exactSnapshotDigest: string;
    mappingSnapshotDigest: string;
    mappingProfileVersion: number;
    mappingProfileDigest: string;
    taskId: string;
    runId: string;
    createdAt: string;
  }>;
  currentRunSnapshot: {
    runId: string;
    state: string;
    version: number;
    baseSha: string | null;
    activePlanId: string | null;
    activePlanVersion: number | null;
    activePlanDigest: string | null;
    updatedAt: string;
  } | null;
  planRevision: {
    revisionId: string;
    expectedRunVersion: number;
    priorPlanId: string;
    priorPlanVersion: number;
    priorPlanDigest: string;
    sourceDigest: string;
    requestedBaseSha: string;
    analysisAttemptId: string;
    status: string;
    createdAt: string;
    analysisAttemptStatus: string;
    analysisAttemptVersion: number;
    analysisAttemptLeaseGeneration: number;
    analysisOutboxId: string;
    analysisOutboxDeliveryState: string;
    analysisOutboxAttemptCount: number;
    priorApprovalCount: number;
    approvalInvalidationCount: number;
  } | null;
  attempts: Array<{
    attemptId: string;
    mode: string;
    status: string;
    planId: string | null;
    planVersion: number | null;
    version: number;
    leaseGeneration: number;
    updatedAt: string;
    tokenCount: number;
    revokedTokenCount: number;
  }>;
  counts: {
    contextRevisions: number;
    newTasks: number;
    newRuns: number;
    workflowCreates: number;
    planRevisions: number;
    feishuActions: number;
    meegleMappings: number;
  };
}

export class SupplementalContextEvidenceStoreError extends Error {
  constructor(readonly code: 'invalid_query' | 'not_found' | 'projection_conflict') {
    super(`Supplemental context evidence projection failed: ${code}`);
    this.name = 'SupplementalContextEvidenceStoreError';
  }
}

export class SupplementalContextEvidenceStore {
  constructor(private readonly db: D1Database, private readonly objects: R2Bucket) {}

  async get(contextId: string): Promise<SupplementalContextEvidenceProjection> {
    if (!ID_PATTERN.test(contextId)) {
      throw new SupplementalContextEvidenceStoreError('invalid_query');
    }
    const context = await this.context(contextId);
    if (context === null) throw new SupplementalContextEvidenceStoreError('not_found');
    const [newRun, workflowCreate, feishuRows, meegleRows, counts, objects] = await Promise.all([
      this.run(context.new_run_id),
      this.workflowCreate(context.new_run_id),
      this.feishuRows(context.new_task_id),
      this.meegleRows(context.new_task_id, context.new_run_id),
      this.counts(context),
      this.verifyObjects(context),
    ]);
    if (
      newRun === null || workflowCreate === null || counts.contextRevisions !== 1 ||
      counts.newTasks !== 1 || counts.newRuns !== 1 || counts.workflowCreates !== 1 ||
      counts.feishuActions !== feishuRows.length || counts.meegleMappings !== meegleRows.length
    ) throw new SupplementalContextEvidenceStoreError('projection_conflict');

    const feishuActions = await Promise.all(feishuRows.map(async (row) => {
      const [sourceRun, attempts, approvalCounts, planRevisionCount] = await Promise.all([
        this.run(row.run_id),
        this.attemptRows(row.run_id, row.plan_id),
        this.approvalCounts(row.run_id, row.plan_id),
        this.count('plan_revisions', 'run_id = ?', [row.run_id]),
      ]);
      if (sourceRun === null) throw new SupplementalContextEvidenceStoreError('projection_conflict');
      return {
        actionReceiptId: row.action_receipt_id,
        deliveryId: row.delivery_id,
        tenantKey: row.tenant_key,
        eventId: row.event_id,
        eventDigest: row.event_digest,
        operatorDigest: await canonicalSha256(row.operator_open_id),
        messageId: row.message_id,
        cardId: row.card_id,
        presentationId: row.presentation_id,
        sourceRunId: row.run_id,
        sourceRunVersion: row.run_version,
        planId: row.plan_id,
        planVersion: row.plan_version,
        planDigest: row.plan_digest,
        baseSha: row.base_sha,
        contextMode: row.context_mode,
        outcomeId: row.outcome_id,
        resultId: row.result_id,
        receivedAt: row.received_at,
        completedAt: row.completed_at,
        currentSourceRun: this.safeRun(sourceRun),
        priorPlanAttempts: attempts.map((attempt) => this.safeAttempt(attempt)),
        priorApprovalCount: approvalCounts.approvals,
        approvalInvalidationCount: approvalCounts.invalidations,
        planRevisionCount,
      };
    }));

    let currentRunSnapshot: SupplementalContextEvidenceProjection['currentRunSnapshot'] = null;
    let planRevision: SupplementalContextEvidenceProjection['planRevision'] = null;
    let attempts: AttemptRow[] = [];
    if (context.apply_to_current_run === 1) {
      if (context.applied_run_id === null || context.prior_plan_id === null) {
        throw new SupplementalContextEvidenceStoreError('projection_conflict');
      }
      const [current, revision, currentAttempts] = await Promise.all([
        this.run(context.applied_run_id),
        this.revision(context),
        this.attemptRows(context.applied_run_id, context.prior_plan_id),
      ]);
      if (current === null || revision === null) {
        throw new SupplementalContextEvidenceStoreError('projection_conflict');
      }
      currentRunSnapshot = this.safeRun(current);
      const approvals = await this.approvalCounts(context.applied_run_id, context.prior_plan_id);
      planRevision = {
        revisionId: revision.revision_id,
        expectedRunVersion: revision.expected_run_version,
        priorPlanId: revision.prior_plan_id,
        priorPlanVersion: revision.prior_plan_version,
        priorPlanDigest: revision.prior_plan_digest,
        sourceDigest: revision.source_digest,
        requestedBaseSha: revision.requested_base_sha,
        analysisAttemptId: revision.analysis_attempt_id,
        status: revision.status,
        createdAt: revision.created_at,
        analysisAttemptStatus: revision.attempt_status,
        analysisAttemptVersion: revision.attempt_version,
        analysisAttemptLeaseGeneration: revision.attempt_lease_generation,
        analysisOutboxId: revision.outbox_id,
        analysisOutboxDeliveryState: revision.outbox_delivery_state,
        analysisOutboxAttemptCount: revision.outbox_attempt_count,
        priorApprovalCount: approvals.approvals,
        approvalInvalidationCount: approvals.invalidations,
      };
      attempts = currentAttempts;
    }

    return {
      schemaVersion: '1',
      contextId,
      lineage: {
        eventDigest: context.event_digest,
        priorTaskId: context.prior_task_id,
        priorTaskRevisionDigest: await canonicalSha256({
          kind: 'task_revision', value: context.prior_task_revision,
        }),
        newTaskId: context.new_task_id,
        newTaskRevisionDigest: await canonicalSha256({
          kind: 'task_revision', value: context.new_task_revision,
        }),
        newTaskDigest: context.new_task_digest,
        newRunId: context.new_run_id,
        contextDigest: context.context_digest,
        mode: context.apply_to_current_run === 1 ? 'apply_current' : 'new_run',
        createdAt: context.created_at,
      },
      source: {
        system: context.source_system,
        tenantKey: context.tenant_key,
        taskKey: context.source_task_key,
        revision: context.task_revision,
        repository: context.target_repository,
        baseBranch: context.target_base_branch,
        environment: context.target_environment,
        intentKind: context.intent_kind,
      },
      objects,
      newRun: {
        runId: newRun.run_id,
        state: newRun.state,
        version: newRun.version,
        workflowInstanceId: newRun.workflow_instance_id,
        updatedAt: newRun.updated_at,
      },
      workflowCreate: {
        outboxId: workflowCreate.outbox_id,
        deliveryState: workflowCreate.delivery_state,
        lastErrorCode: workflowCreate.last_error_code,
        attemptCount: workflowCreate.attempt_count,
        createdAt: workflowCreate.created_at,
        updatedAt: workflowCreate.updated_at,
      },
      feishuActions,
      meegleMappings: meegleRows.map((row) => ({
        ingressOutboxId: row.ingress_outbox_id,
        eventId: row.event_id,
        tenantKey: row.tenant_key,
        projectKey: row.project_key,
        workItemTypeKey: row.work_item_type_key,
        workItemId: row.work_item_id,
        externalRevision: row.external_revision,
        exactSnapshotDigest: row.exact_snapshot_digest,
        mappingSnapshotDigest: row.mapping_snapshot_digest,
        mappingProfileVersion: row.mapping_profile_version,
        mappingProfileDigest: row.mapping_profile_digest,
        taskId: row.task_id,
        runId: row.run_id,
        createdAt: row.created_at,
      })),
      currentRunSnapshot,
      planRevision,
      attempts: attempts.map((attempt) => this.safeAttempt(attempt)),
      counts,
    };
  }

  private async context(contextId: string): Promise<ContextRow | null> {
    return await this.db.prepare(
      `SELECT context.*, task.source_system, task.tenant_key, task.source_task_key,
              task.task_revision, task.task_digest, task.payload_ref, task.actor_type,
              task.actor_id, task.target_repository, task.target_base_branch,
              task.target_environment, task.intent_kind
       FROM supplemental_context_revisions AS context
       JOIN tasks AS task ON task.task_id = context.new_task_id
       WHERE context.context_id = ?`,
    ).bind(contextId).first<ContextRow>();
  }

  private async run(runId: string): Promise<RunRow | null> {
    return await this.db.prepare(
      `SELECT run_id, state, version, base_sha, workflow_instance_id,
              active_plan_id, active_plan_version, active_plan_digest, updated_at
       FROM runs WHERE run_id = ?`,
    ).bind(runId).first<RunRow>();
  }

  private async workflowCreate(runId: string): Promise<OutboxRow | null> {
    return await this.db.prepare(
      `SELECT outbox_id, delivery_state, last_error_code, attempt_count, created_at, updated_at
       FROM outbox WHERE run_id = ? AND kind = 'workflow_create'`,
    ).bind(runId).first<OutboxRow>();
  }

  private async feishuRows(taskId: string): Promise<FeishuRow[]> {
    const result = await this.db.prepare(
      `SELECT receipt.action_receipt_id, receipt.delivery_id, receipt.tenant_key,
              receipt.event_id, delivery.event_digest, receipt.operator_open_id,
              receipt.message_id, receipt.card_id, receipt.presentation_id,
              receipt.run_id, receipt.run_version, receipt.plan_id, receipt.plan_version,
              receipt.plan_digest, receipt.base_sha, receipt.context_mode,
              receipt.received_at, outcome.outcome_id, outcome.result_id, outcome.completed_at
       FROM feishu_card_action_receipts AS receipt
       JOIN feishu_card_action_outcomes AS outcome
         ON outcome.action_receipt_id = receipt.action_receipt_id
       JOIN feishu_webhook_deliveries AS delivery ON delivery.delivery_id = receipt.delivery_id
       WHERE receipt.command = 'add_context' AND receipt.effect = 'add_context'
         AND outcome.disposition = 'applied' AND outcome.result_kind = 'task_revision'
         AND outcome.result_id = ?
       ORDER BY receipt.received_at, receipt.action_receipt_id LIMIT 20`,
    ).bind(taskId).all<FeishuRow>();
    return result.results;
  }

  private async meegleRows(taskId: string, runId: string): Promise<MeegleRow[]> {
    const result = await this.db.prepare(
      `SELECT ingress_outbox_id, event_id, tenant_key, project_key, work_item_type_key,
              work_item_id, external_revision, exact_snapshot_digest,
              mapping_snapshot_digest, mapping_profile_version, mapping_profile_digest,
              task_id, run_id, created_at
       FROM meegle_mapping_lineage
       WHERE outcome = 'mapped' AND task_id = ? AND run_id = ?
       ORDER BY created_at, event_id LIMIT 20`,
    ).bind(taskId, runId).all<MeegleRow>();
    return result.results;
  }

  private async attemptRows(runId: string, planId: string): Promise<AttemptRow[]> {
    const result = await this.db.prepare(
      `SELECT attempt.attempt_id, attempt.mode, attempt.status, attempt.plan_id,
              attempt.plan_version, attempt.version, attempt.lease_generation,
              attempt.updated_at,
              (SELECT COUNT(*) FROM attempt_tokens AS token
               WHERE token.attempt_id = attempt.attempt_id) AS token_count,
              (SELECT COUNT(*) FROM attempt_tokens AS token
               WHERE token.attempt_id = attempt.attempt_id AND token.revoked_at IS NOT NULL)
                AS revoked_token_count
       FROM attempts AS attempt
       WHERE attempt.run_id = ? AND attempt.plan_id = ?
       ORDER BY attempt.ordinal, attempt.attempt_id LIMIT 100`,
    ).bind(runId, planId).all<AttemptRow>();
    return result.results;
  }

  private async approvalCounts(
    runId: string,
    planId: string,
  ): Promise<{ approvals: number; invalidations: number }> {
    const row = await this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM approvals WHERE run_id = ? AND plan_id = ?) AS approvals,
         (SELECT COUNT(*) FROM approval_invalidations AS invalidation
          JOIN approvals AS approval ON approval.approval_id = invalidation.approval_id
          WHERE approval.run_id = ? AND approval.plan_id = ?) AS invalidations`,
    ).bind(runId, planId, runId, planId).first<{ approvals: number; invalidations: number }>();
    if (row === null) throw new SupplementalContextEvidenceStoreError('projection_conflict');
    return row;
  }

  private async revision(context: ContextRow): Promise<RevisionRow | null> {
    return await this.db.prepare(
      `SELECT revision.revision_id, revision.expected_run_version,
              revision.prior_plan_id, revision.prior_plan_version,
              revision.prior_plan_digest, revision.source_digest,
              revision.requested_base_sha, revision.analysis_attempt_id,
              revision.status, revision.created_at, attempt.status AS attempt_status,
              attempt.version AS attempt_version,
              attempt.lease_generation AS attempt_lease_generation,
              outbox.outbox_id, outbox.delivery_state AS outbox_delivery_state,
              outbox.attempt_count AS outbox_attempt_count
       FROM plan_revisions AS revision
       JOIN attempts AS attempt ON attempt.attempt_id = revision.analysis_attempt_id
       JOIN outbox ON outbox.run_id = revision.run_id
         AND outbox.kind = 'analysis_dispatch'
         AND outbox.dedupe_key = 'analysis-replan:' || revision.revision_id
       WHERE revision.run_id = ? AND revision.source_kind = 'supplemental_context'
         AND revision.prior_plan_id = ? AND revision.source_digest = ?`,
    ).bind(
      context.applied_run_id,
      context.prior_plan_id,
      context.context_digest,
    ).first<RevisionRow>();
  }

  private async counts(context: ContextRow): Promise<{
    contextRevisions: number;
    newTasks: number;
    newRuns: number;
    workflowCreates: number;
    planRevisions: number;
    feishuActions: number;
    meegleMappings: number;
  }> {
    const row = await this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM supplemental_context_revisions WHERE context_id = ?)
           AS context_revisions,
         (SELECT COUNT(*) FROM tasks WHERE task_id = ?) AS new_tasks,
         (SELECT COUNT(*) FROM runs WHERE run_id = ?) AS new_runs,
         (SELECT COUNT(*) FROM outbox WHERE run_id = ? AND kind = 'workflow_create')
           AS workflow_creates,
         (SELECT COUNT(*) FROM plan_revisions WHERE source_kind = 'supplemental_context'
           AND source_digest = ?) AS plan_revisions,
         (SELECT COUNT(*) FROM feishu_card_action_receipts AS receipt
          JOIN feishu_card_action_outcomes AS outcome
            ON outcome.action_receipt_id = receipt.action_receipt_id
          WHERE receipt.command = 'add_context' AND receipt.effect = 'add_context'
            AND outcome.disposition = 'applied' AND outcome.result_kind = 'task_revision'
            AND outcome.result_id = ?) AS feishu_actions,
         (SELECT COUNT(*) FROM meegle_mapping_lineage
          WHERE outcome = 'mapped' AND task_id = ? AND run_id = ?) AS meegle_mappings`,
    ).bind(
      context.context_id,
      context.new_task_id,
      context.new_run_id,
      context.new_run_id,
      context.context_digest,
      context.new_task_id,
      context.new_task_id,
      context.new_run_id,
    ).first<Record<string, number>>();
    if (row === null) throw new SupplementalContextEvidenceStoreError('projection_conflict');
    return {
      contextRevisions: row.context_revisions ?? -1,
      newTasks: row.new_tasks ?? -1,
      newRuns: row.new_runs ?? -1,
      workflowCreates: row.workflow_creates ?? -1,
      planRevisions: row.plan_revisions ?? -1,
      feishuActions: row.feishu_actions ?? -1,
      meegleMappings: row.meegle_mappings ?? -1,
    };
  }

  private async count(table: 'plan_revisions', where: string, values: string[]): Promise<number> {
    const value = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    ).bind(...values).first<number>('count');
    if (value === null) throw new SupplementalContextEvidenceStoreError('projection_conflict');
    return value;
  }

  private async verifyObjects(
    context: ContextRow,
  ): Promise<{ contextVerified: boolean; newTaskVerified: boolean }> {
    const [contextObject, taskObject] = await Promise.all([
      this.readObject(context.context_ref),
      this.readObject(context.payload_ref),
    ]);
    let contextVerified = false;
    let newTaskVerified = false;
    if (contextObject !== null) {
      const parsed = SupplementalContextDataSchema.safeParse(contextObject.value);
      const metadata = contextObject.metadata;
      contextVerified = parsed.success &&
        await canonicalSha256(parsed.data) === context.context_digest &&
        metadata.schemaVersion === '1' && metadata.contextId === context.context_id &&
        metadata.contextDigest === context.context_digest &&
        metadata.priorTaskId === context.prior_task_id &&
        metadata.newTaskId === context.new_task_id &&
        parsed.data.source.system === context.source_system &&
        parsed.data.source.tenantKey === context.tenant_key &&
        parsed.data.source.taskKey === context.source_task_key &&
        parsed.data.source.priorRevision === context.prior_task_revision &&
        parsed.data.source.revision === context.new_task_revision &&
        parsed.data.actor.type === context.actor_type &&
        parsed.data.actor.id === context.actor_id;
    }
    if (taskObject !== null) {
      const parsed = TaskEnvelopeSchema.safeParse(taskObject.value);
      newTaskVerified = parsed.success &&
        await taskRevisionDigest(parsed.data) === context.new_task_digest &&
        taskObject.metadata.taskDigest === context.new_task_digest &&
        parsed.data.source.system === context.source_system &&
        parsed.data.source.tenantKey === context.tenant_key &&
        parsed.data.source.taskKey === context.source_task_key &&
        parsed.data.source.revision === context.new_task_revision &&
        parsed.data.actor.type === context.actor_type && parsed.data.actor.id === context.actor_id &&
        `${parsed.data.target.owner}/${parsed.data.target.repo}` === context.target_repository &&
        parsed.data.target.baseBranch === context.target_base_branch &&
        parsed.data.target.environment === context.target_environment &&
        parsed.data.intent.kind === context.intent_kind;
    }
    return { contextVerified, newTaskVerified };
  }

  private async readObject(
    ref: string,
  ): Promise<{ value: unknown; metadata: Record<string, string> } | null> {
    if (!ref.startsWith('r2://') || ref.includes('..')) return null;
    let object: R2ObjectBody | null;
    try { object = await this.objects.get(ref.slice('r2://'.length)); }
    catch { return null; }
    if (object === null) return null;
    if (object.size > MAX_OBJECT_BYTES) {
      await object.body.cancel();
      return null;
    }
    try {
      return {
        value: JSON.parse(await object.text()) as unknown,
        metadata: object.customMetadata ?? {},
      };
    } catch {
      return null;
    }
  }

  private safeRun(run: RunRow): NonNullable<SupplementalContextEvidenceProjection['currentRunSnapshot']> {
    return {
      runId: run.run_id,
      state: run.state,
      version: run.version,
      baseSha: run.base_sha,
      activePlanId: run.active_plan_id,
      activePlanVersion: run.active_plan_version,
      activePlanDigest: run.active_plan_digest,
      updatedAt: run.updated_at,
    };
  }

  private safeAttempt(attempt: AttemptRow): SupplementalContextEvidenceProjection['attempts'][number] {
    return {
      attemptId: attempt.attempt_id,
      mode: attempt.mode,
      status: attempt.status,
      planId: attempt.plan_id,
      planVersion: attempt.plan_version,
      version: attempt.version,
      leaseGeneration: attempt.lease_generation,
      updatedAt: attempt.updated_at,
      tokenCount: attempt.token_count,
      revokedTokenCount: attempt.revoked_token_count,
    };
  }
}
