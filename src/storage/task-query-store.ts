import {
  ATTEMPTED_PATH_LABELS,
  HUMAN_INPUT_PROMPTS,
  type AttemptedPath,
  type HumanInputCode,
} from '../domain/attempt-failure.js';
import { canonicalSha256 } from '../domain/digest.js';

interface TaskRunRow {
  task_id: string;
  source_system: string;
  tenant_key: string;
  source_task_key: string;
  task_revision: string;
  source_url: string | null;
  task_digest: string;
  target_repository: string;
  target_base_branch: string;
  target_environment: string;
  intent_kind: string;
  title: string;
  priority: string;
  acceptance_criteria_count: number;
  allow_repository_write: number;
  allow_test_deploy: number;
  allow_production_deploy: number;
  require_human_approval: number;
  task_created_at: string;
  task_updated_at: string;
  run_id: string;
  base_sha: string | null;
  workflow_instance_id: string;
  run_state: string;
  run_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  run_created_at: string;
  run_updated_at: string;
}

interface RunRow {
  run_id: string;
  task_id: string;
  task_revision: string;
  task_digest: string;
  base_sha: string | null;
  state: string;
  version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  plan_id: string;
  plan_version: number;
  task_revision: string;
  base_sha: string;
  digest: string;
  status: string;
  created_by_attempt_id: string;
  objective: string;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  item_id: string;
  kind: string;
  title: string;
  objective: string;
  required: number;
  position: number;
  status: string;
  progress_version: number;
}

interface ItemValueRow {
  item_id: string;
  value: string;
  position?: number;
}

interface ItemIndexRow {
  item_id: string;
  value: number;
}

interface PlanValueRow {
  position: number;
  value: string;
}

interface PlanItemVerificationRow {
  verification_id: string;
  plan_item_id: string;
  head_sha: string;
  evidence_set_digest: string;
  created_at: string;
}

interface PlanItemVerificationMappingRow {
  verification_id: string;
  done_when_position: number;
  evidence_position: number;
  evidence_id: string;
}

interface AttemptRow {
  attempt_id: string;
  ordinal: number;
  mode: string;
  status: string;
  base_sha: string;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  head_branch: string | null;
  head_sha: string | null;
  recovered_from_attempt_id: string | null;
  recovery_checkpoint_id: string | null;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  result_event_id: string | null;
  result_sequence: number | null;
  result_payload_ref: string | null;
  result_digest: string | null;
  result_reported_at: string | null;
  github_run_id: string | null;
  github_status: string | null;
  github_conclusion: string | null;
  github_observed_at: string | null;
  github_external_updated_at: string | null;
  github_observation_version: number;
  created_at: string;
  updated_at: string;
  repair_id: string | null;
  repair_failure_id: string | null;
  failed_attempt_id: string | null;
  source_suite_id: string | null;
  source_evidence_id: string | null;
  base_rebase_id: string | null;
  base_rebase_source_attempt_id: string | null;
  base_rebase_source_head_sha: string | null;
  base_rebase_old_base_sha: string | null;
  base_rebase_new_base_sha: string | null;
  base_rebase_target_branch: string | null;
  base_rebase_status: string | null;
}

interface HeartbeatReceiptRow {
  heartbeat_id: string;
  attempt_id: string;
  lease_generation: number;
  previous_attempt_version: number;
  attempt_version: number;
  previous_heartbeat_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
}

interface CheckpointRow {
  checkpoint_id: string;
  attempt_id: string;
  sequence: number;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  head_sha: string | null;
  payload_digest: string;
  created_at: string;
}

interface EvidenceRow {
  evidence_id: string;
  attempt_id: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  kind: string;
  status: string;
  command_ref: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  sha: string | null;
  external_url: string | null;
  artifact_digest: string | null;
  verification_status: string;
  observed_at: string;
}

interface BlockerPathRow {
  blocker_id: string;
  reason: string;
  fingerprint_digest: string;
  attempt_count: number;
  consecutive_fingerprint_count: number;
  needed_human_input: string;
  blocker_created_at: string;
  failure_id: string;
  attempt_id: string;
  attempt_ordinal: number;
  failure_class: string;
  failure_code: string;
  failure_site: string;
  occurred_at: string;
  position: number;
  path_code: string;
  source_suite_id: string | null;
  source_evidence_id: string | null;
  source_head_sha: string | null;
  failure_fact_digest: string | null;
}

interface BaseConflictBlockerRow {
  conflict_id: string;
  repository: string;
  base_branch: string;
  before_sha: string;
  after_sha: string;
  relationship: string;
  ahead_by: number;
  behind_by: number;
  merge_base_sha: string;
  blocker_reason: string;
  needed_human_input: string;
  created_at: string;
}

interface BaseRebaseBlockerRow {
  rebase_id: string;
  source_attempt_id: string;
  rebase_attempt_id: string;
  source_branch: string;
  source_head_sha: string;
  target_branch: string;
  old_base_sha: string;
  new_base_sha: string;
  blocker_reason: string;
  completed_at: string;
}

interface ProtectedPathGateRow {
  gate_id: string;
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  base_sha: string;
  staged_tree_sha: string;
  delivery_policy_digest: string;
  diff_digest: string;
  total_changed_files: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ProtectedPathEntryRow {
  path: string;
  previous_path: string | null;
  change_type: string;
  additions: number | null;
  deletions: number | null;
}

interface PlanRevisionRow {
  revision_id: string;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  prior_base_sha: string;
  source_kind: string;
  source_digest: string;
  requested_base_sha: string;
  analysis_attempt_id: string;
  new_plan_id: string | null;
  new_plan_version: number | null;
  new_plan_digest: string | null;
  body_changed: number | null;
  base_changed: number | null;
  effects_changed: number | null;
  status: string;
  created_at: string;
  activated_at: string | null;
  updated_at: string;
}

interface MergeGateProjectionRow {
  evaluation_id: string;
  evaluation_status: string;
  rejection_reason: string | null;
  decision_id: string | null;
  observation_id: string;
  github_pr_number: number;
  head_sha: string;
  base_sha: string;
  mergeability: string;
  merge_state: string;
  review_decision: string;
  required_approval_count: number;
  approved_review_count: number;
  required_check_count: number;
  passed_check_count: number;
  pending_check_count: number;
  failed_check_count: number;
  missing_check_count: number;
  policy_digest: string;
  checks_digest: string;
  reviews_digest: string;
  external_updated_at: string;
  evaluated_at: string;
}

interface TestDeploymentProjectionRow {
  deployment_id: string;
  plan_item_id: string;
  attempt_id: string;
  status: string;
  environment: string;
  ref_sha: string;
  role_ref: string;
  github_deployment_id: string | null;
  external_url: string | null;
  evidence_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TestAcceptanceProjectionRow {
  acceptance_id: string;
  deployment_id: string;
  plan_item_id: string;
  attempt_id: string;
  status: string;
  ref_sha: string;
  command_ref: string;
  github_run_id: string | null;
  external_state: string | null;
  external_conclusion: string | null;
  evidence_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TestRollbackProjectionRow {
  rollback_id: string;
  source_kind: string;
  source_id: string;
  source_evidence_id: string;
  deployment_id: string;
  attempt_id: string;
  status: string;
  ref_sha: string;
  role_ref: string;
  policy_digest: string;
  contract_digest: string;
  github_run_id: string | null;
  external_state: string | null;
  external_conclusion: string | null;
  evidence_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProductionDeploymentProjectionRow {
  deployment_id: string;
  attempt_id: string;
  approval_id: string;
  approver_principal: string;
  task_revision: string;
  merge_id: string;
  merge_sha: string;
  status: string;
  environment: string;
  role_ref: string;
  external_state: string | null;
  external_updated_at: string | null;
  github_deployment_id: string | null;
  external_url: string | null;
  evidence_id: string | null;
  created_at: string;
  updated_at: string;
}

interface GitHubMergeProjectionRow {
  merge_id: string;
  decision_id: string;
  publication_id: string;
  github_pr_number: number;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  base_sha: string;
  merge_sha: string;
  merged_by_login: string;
  merged_at: string;
  deployment_disposition: string;
  evidence_id: string;
  external_url: string | null;
  created_at: string;
}

interface RunStuckIncidentProjectionRow {
  incident_id: string;
  state_kind: string;
  observed_run_state: string;
  run_version: number;
  attempt_id: string | null;
  threshold_seconds: number;
  action: string;
  status: string;
  detected_at: string;
  resolved_at: string | null;
  resolution_code: string | null;
}

interface WorkflowInstanceReconciliationStateRow {
  run_version: number;
  d1_state: string;
  platform_status: string;
  fact_digest: string;
  checked_at: string;
}

interface WorkflowInstanceReconciliationObservationRow {
  observation_id: string;
  run_version: number;
  d1_state: string;
  platform_status: string;
  fact_digest: string;
  action: string;
  status: string;
  repair_outbox_id: string | null;
  observed_at: string;
  repair_observed_at: string | null;
  resolved_at: string | null;
  resolution_code: string | null;
}

interface QuotaLimitProjectionRow {
  scope_type: string;
  resource_type: string;
  window_kind: string;
  limit_value: number;
  effective_limit: number;
  used_units: number;
  override_id: string | null;
}

interface QuotaOverrideProjectionRow {
  override_id: string;
  expected_run_version: number;
  resources_json: string;
  reason_digest: string;
  approver_principal: string | null;
  multiplier: number;
  decision: string;
  status: string;
  rejection_reason: string | null;
  expires_at: string;
  created_at: string;
}

interface QuotaDenialProjectionRow {
  denial_id: string;
  attempt_id: string | null;
  resource_type: string;
  scope_type: string;
  limit_value: number;
  requested_units: number;
  reason_digest: string;
  occurred_at: string;
}

interface ModelUsageProjectionRow {
  usage_id: string;
  attempt_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cost_microusd: number;
  source_digest: string;
  at: string;
}

interface AutomatedReviewProjectionRow {
  iteration: number;
  head_sha: string;
  status: string;
  blocking_finding_count: number | null;
  minor_finding_count: number | null;
}

export interface TaskStatusView {
  task: Record<string, unknown>;
  run: Record<string, unknown>;
}

export interface RunPlanStatusView {
  run: Record<string, unknown>;
  plan: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  heartbeats: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
}

function optional(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== null && value !== undefined) target[key] = value;
}

function safeExternalUrl(value: string | null): string | undefined {
  if (value === null) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function runSummary(row: RunRow): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: row.run_id,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    taskDigest: row.task_digest,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  optional(summary, 'baseSha', row.base_sha);
  if (
    row.active_plan_id !== null &&
    row.active_plan_version !== null &&
    row.active_plan_digest !== null
  ) {
    summary.activePlan = {
      id: row.active_plan_id,
      version: row.active_plan_version,
      digest: row.active_plan_digest,
    };
  }
  return summary;
}

function appendValues(
  rows: readonly ItemValueRow[],
  valuesByItem: Map<string, string[]>,
): void {
  for (const row of rows) {
    const values = valuesByItem.get(row.item_id);
    if (values === undefined) valuesByItem.set(row.item_id, [row.value]);
    else values.push(row.value);
  }
}

/** Read-only D1 query projection. It deliberately has no Workflow binding or R2 body reads. */
export class TaskQueryStore {
  constructor(private readonly db: D1Database) {}

  async getTaskStatus(taskId: string): Promise<TaskStatusView | null> {
    const row = await this.db
      .prepare(
        `SELECT
           tasks.task_id, tasks.source_system, tasks.tenant_key, tasks.source_task_key,
           tasks.task_revision, tasks.source_url, tasks.task_digest,
           tasks.target_repository, tasks.target_base_branch, tasks.target_environment,
           tasks.intent_kind, tasks.title, tasks.priority, tasks.acceptance_criteria_count,
           tasks.allow_repository_write, tasks.allow_test_deploy,
           tasks.allow_production_deploy, tasks.require_human_approval,
           tasks.created_at AS task_created_at, tasks.updated_at AS task_updated_at,
           runs.run_id, runs.base_sha, runs.workflow_instance_id, runs.state AS run_state,
           runs.version AS run_version, runs.active_plan_id, runs.active_plan_version,
           runs.active_plan_digest, runs.created_at AS run_created_at,
           runs.updated_at AS run_updated_at
         FROM tasks
         JOIN runs ON runs.task_id = tasks.task_id
         WHERE tasks.task_id = ?`,
      )
      .bind(taskId)
      .first<TaskRunRow>();
    if (row === null) return null;

    const source: Record<string, unknown> = {
      system: row.source_system,
      tenantKey: row.tenant_key,
      taskKey: row.source_task_key,
      revision: row.task_revision,
    };
    optional(source, 'url', row.source_url);
    const run: Record<string, unknown> = {
      id: row.run_id,
      state: row.run_state,
      version: row.run_version,
      createdAt: row.run_created_at,
      updatedAt: row.run_updated_at,
    };
    optional(run, 'baseSha', row.base_sha);
    if (
      row.active_plan_id !== null &&
      row.active_plan_version !== null &&
      row.active_plan_digest !== null
    ) {
      run.activePlan = {
        id: row.active_plan_id,
        version: row.active_plan_version,
        digest: row.active_plan_digest,
      };
    }
    const blocker = await this.blockerSummary(row.run_id);
    if (row.run_state === 'blocked' && blocker !== null) run.blocker = blocker;
    const stuckIncidents = await this.stuckIncidentSummaries(row.run_id);
    if (stuckIncidents.length > 0) run.stuckIncidents = stuckIncidents;
    const workflowInstance = await this.workflowInstanceSummary(row.run_id);
    if (workflowInstance !== null) run.workflowInstance = workflowInstance;
    run.quota = await this.quotaSummary(row.run_id);
    const approvalRequest = await this.protectedPathApprovalSummary(row.run_id);
    if (row.run_state === 'awaiting_approval' && approvalRequest !== null) {
      run.approvalRequest = approvalRequest;
    }
    const mergeGate = await this.mergeGateSummary(row.run_id);
    if (mergeGate !== null) run.mergeGate = mergeGate;
    const testDeployments = await this.testDeploymentSummaries(row.run_id);
    if (testDeployments.length > 0) run.testDeployments = testDeployments;
    const testAcceptances = await this.testAcceptanceSummaries(row.run_id);
    if (testAcceptances.length > 0) run.testAcceptances = testAcceptances;
    const testRollbacks = await this.testRollbackSummaries(row.run_id);
    if (testRollbacks.length > 0) run.testRollbacks = testRollbacks;
    const productionDeployments = await this.productionDeploymentSummaries(row.run_id);
    if (productionDeployments.length > 0) {
      run.productionDeployments = productionDeployments;
    }
    const merge = await this.githubMergeSummary(row.run_id);
    if (merge !== null) run.merge = merge;
    return {
      task: {
        id: row.task_id,
        source,
        digest: row.task_digest,
        target: {
          repository: row.target_repository,
          baseBranch: row.target_base_branch,
          environment: row.target_environment,
        },
        intent: {
          kind: row.intent_kind,
          title: row.title,
          priority: row.priority,
          acceptanceCriteriaCount: row.acceptance_criteria_count,
        },
        policy: {
          allowRepositoryWrite: row.allow_repository_write === 1,
          allowTestDeploy: row.allow_test_deploy === 1,
          allowProductionDeploy: row.allow_production_deploy === 1,
          requireHumanApproval: row.require_human_approval === 1,
        },
        createdAt: row.task_created_at,
        updatedAt: row.task_updated_at,
      },
      run,
    };
  }

  async getRunPlanStatus(runId: string): Promise<RunPlanStatusView | null> {
    const run = await this.db
      .prepare(
        `SELECT run_id, task_id, task_revision, task_digest, base_sha, state, version,
                active_plan_id, active_plan_version, active_plan_digest, created_at, updated_at
         FROM runs WHERE run_id = ?`,
      )
      .bind(runId)
      .first<RunRow>();
    if (run === null) return null;
    const blocker = await this.blockerSummary(runId);
    const runView = runSummary(run);
    if (run.state === 'blocked' && blocker !== null) runView.blocker = blocker;
    const stuckIncidents = await this.stuckIncidentSummaries(runId);
    if (stuckIncidents.length > 0) runView.stuckIncidents = stuckIncidents;
    const workflowInstance = await this.workflowInstanceSummary(runId);
    if (workflowInstance !== null) runView.workflowInstance = workflowInstance;
    runView.quota = await this.quotaSummary(runId);
    const approvalRequest = await this.protectedPathApprovalSummary(runId);
    if (run.state === 'awaiting_approval' && approvalRequest !== null) {
      runView.approvalRequest = approvalRequest;
    }
    const planRevision = await this.planRevisionSummary(runId);
    if (planRevision !== null) runView.planRevision = planRevision;
    const mergeGate = await this.mergeGateSummary(runId);
    if (mergeGate !== null) runView.mergeGate = mergeGate;
    const automatedReview = await this.automatedReviewSummary(runId);
    if (automatedReview !== null) runView.automatedReview = automatedReview;
    const testDeployments = await this.testDeploymentSummaries(runId);
    if (testDeployments.length > 0) runView.testDeployments = testDeployments;
    const testAcceptances = await this.testAcceptanceSummaries(runId);
    if (testAcceptances.length > 0) runView.testAcceptances = testAcceptances;
    const testRollbacks = await this.testRollbackSummaries(runId);
    if (testRollbacks.length > 0) runView.testRollbacks = testRollbacks;
    const productionDeployments = await this.productionDeploymentSummaries(runId);
    if (productionDeployments.length > 0) {
      runView.productionDeployments = productionDeployments;
    }
    const githubMerge = await this.githubMergeSummary(runId);
    if (githubMerge !== null) runView.merge = githubMerge;

    const [attemptResult, heartbeatResult, checkpointResult, evidenceResult] = await Promise.all([
      this.db
        .prepare(
          `SELECT attempts.attempt_id, attempts.ordinal, attempts.mode, attempts.status,
                  attempts.base_sha, attempts.plan_id, attempts.plan_version,
                  attempts.plan_item_id, attempts.head_branch, attempts.head_sha,
                  attempts.recovered_from_attempt_id, attempts.recovery_checkpoint_id,
                  attempts.version, attempts.lease_generation,
                  attempts.lease_expires_at, attempts.heartbeat_at,
                  attempts.result_event_id, attempts.result_sequence,
                  attempts.result_payload_ref, attempts.result_digest,
                  attempts.result_reported_at, attempts.github_run_id,
                  attempts.github_status, attempts.github_conclusion,
                  attempts.github_observed_at, attempts.github_external_updated_at,
                  attempts.github_observation_version,
                  attempts.created_at, attempts.updated_at,
                  attempt_repairs.repair_id,
                  attempt_repairs.failure_id AS repair_failure_id,
                  attempt_repairs.failed_attempt_id,
                  attempt_repairs.source_suite_id,
                  attempt_repairs.source_evidence_id,
                  base_rebase_attempts.rebase_id AS base_rebase_id,
                  base_rebase_attempts.source_attempt_id AS base_rebase_source_attempt_id,
                  base_rebase_attempts.source_head_sha AS base_rebase_source_head_sha,
                  base_rebase_attempts.old_base_sha AS base_rebase_old_base_sha,
                  base_rebase_attempts.new_base_sha AS base_rebase_new_base_sha,
                  base_rebase_attempts.target_branch AS base_rebase_target_branch,
                  base_rebase_attempts.status AS base_rebase_status
           FROM attempts
           LEFT JOIN attempt_repairs
             ON attempt_repairs.repair_attempt_id = attempts.attempt_id
           LEFT JOIN base_rebase_attempts
             ON base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
           WHERE attempts.run_id = ? ORDER BY attempts.ordinal, attempts.attempt_id`,
        )
        .bind(runId)
        .all<AttemptRow>(),
      this.db
        .prepare(
          `SELECT receipts.heartbeat_id, receipts.attempt_id,
                  receipts.lease_generation, receipts.previous_attempt_version,
                  receipts.attempt_version, receipts.previous_heartbeat_at,
                  receipts.heartbeat_at, receipts.lease_expires_at
           FROM attempt_heartbeat_receipts AS receipts
           JOIN attempts ON attempts.attempt_id = receipts.attempt_id
           WHERE attempts.run_id = ?
           ORDER BY attempts.ordinal, receipts.attempt_version
           LIMIT 1001`,
        )
        .bind(runId)
        .all<HeartbeatReceiptRow>(),
      this.db
        .prepare(
          `SELECT checkpoints.checkpoint_id, checkpoints.attempt_id, checkpoints.sequence,
                  checkpoints.plan_id, checkpoints.plan_version, checkpoints.plan_item_id,
                  checkpoints.head_sha, checkpoints.payload_digest, checkpoints.created_at
           FROM checkpoints
           JOIN attempts ON attempts.attempt_id = checkpoints.attempt_id
           WHERE attempts.run_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM checkpoints AS newer
               WHERE newer.attempt_id = checkpoints.attempt_id
                 AND newer.sequence > checkpoints.sequence
             )
           ORDER BY attempts.ordinal, checkpoints.sequence DESC`,
        )
        .bind(runId)
        .all<CheckpointRow>(),
      this.db
        .prepare(
          `SELECT evidence_id, attempt_id, plan_id, plan_version, plan_item_id, kind,
                  status, command_ref, exit_code, duration_ms, sha, external_url, artifact_digest,
                  verification_status, observed_at
           FROM evidence WHERE run_id = ? ORDER BY observed_at, evidence_id`,
        )
        .bind(runId)
        .all<EvidenceRow>(),
    ]);
    if (heartbeatResult.results.length > 1_000) {
      throw new Error('heartbeat projection is too large');
    }

    const attempts = attemptResult.results.map((row) => {
      const summary: Record<string, unknown> = {
        id: row.attempt_id,
        ordinal: row.ordinal,
        mode: row.mode,
        status: row.status,
        baseSha: row.base_sha,
        version: row.version,
        leaseGeneration: row.lease_generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(summary, 'planId', row.plan_id);
      optional(summary, 'planVersion', row.plan_version);
      optional(summary, 'planItemId', row.plan_item_id);
      optional(summary, 'headBranch', row.head_branch);
      optional(summary, 'headSha', row.head_sha);
      optional(summary, 'leaseExpiresAt', row.lease_expires_at);
      optional(summary, 'heartbeatAt', row.heartbeat_at);
      optional(summary, 'githubRunId', row.github_run_id);
      optional(summary, 'githubStatus', row.github_status);
      optional(summary, 'githubConclusion', row.github_conclusion);
      optional(summary, 'githubObservedAt', row.github_observed_at);
      optional(summary, 'githubExternalUpdatedAt', row.github_external_updated_at);
      if (row.github_observation_version > 0) {
        summary.githubObservationVersion = row.github_observation_version;
      }
      if (
        row.result_event_id !== null && row.result_sequence !== null &&
        row.result_payload_ref !== null && row.result_digest !== null &&
        row.result_reported_at !== null
      ) {
        summary.result = {
          eventId: row.result_event_id,
          sequence: row.result_sequence,
          payloadRef: row.result_payload_ref,
          digest: row.result_digest,
          reportedAt: row.result_reported_at,
        };
      }
      if (
        row.recovered_from_attempt_id !== null &&
        row.recovery_checkpoint_id !== null
      ) {
        summary.recovery = {
          recoveredFromAttemptId: row.recovered_from_attempt_id,
          checkpointId: row.recovery_checkpoint_id,
        };
      }
      if (
        row.repair_id !== null &&
        row.repair_failure_id !== null &&
        row.failed_attempt_id !== null &&
        row.source_suite_id !== null &&
        row.source_evidence_id !== null
      ) {
        summary.repair = {
          id: row.repair_id,
          failureId: row.repair_failure_id,
          failedAttemptId: row.failed_attempt_id,
          sourceSuiteId: row.source_suite_id,
          sourceEvidenceId: row.source_evidence_id,
        };
      }
      if (
        row.base_rebase_id !== null &&
        row.base_rebase_source_attempt_id !== null &&
        row.base_rebase_source_head_sha !== null &&
        row.base_rebase_old_base_sha !== null &&
        row.base_rebase_new_base_sha !== null &&
        row.base_rebase_target_branch !== null &&
        row.base_rebase_status !== null
      ) {
        summary.baseRebase = {
          id: row.base_rebase_id,
          sourceAttemptId: row.base_rebase_source_attempt_id,
          sourceHeadSha: row.base_rebase_source_head_sha,
          oldBaseSha: row.base_rebase_old_base_sha,
          newBaseSha: row.base_rebase_new_base_sha,
          targetBranch: row.base_rebase_target_branch,
          status: row.base_rebase_status,
        };
      }
      return summary;
    });
    const heartbeats = heartbeatResult.results.map((row) => ({
      id: row.heartbeat_id,
      attemptId: row.attempt_id,
      leaseGeneration: row.lease_generation,
      previousVersion: row.previous_attempt_version,
      version: row.attempt_version,
      previousHeartbeatAt: row.previous_heartbeat_at,
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
    }));
    const checkpoints = checkpointResult.results.map((row) => {
      const summary: Record<string, unknown> = {
        id: row.checkpoint_id,
        attemptId: row.attempt_id,
        sequence: row.sequence,
        payloadDigest: row.payload_digest,
        createdAt: row.created_at,
      };
      optional(summary, 'planId', row.plan_id);
      optional(summary, 'planVersion', row.plan_version);
      optional(summary, 'planItemId', row.plan_item_id);
      optional(summary, 'headSha', row.head_sha);
      return summary;
    });
    const evidence = evidenceResult.results.map((row) => {
      const summary: Record<string, unknown> = {
        id: row.evidence_id,
        kind: row.kind,
        status: row.status,
        verificationStatus: row.verification_status,
        observedAt: row.observed_at,
      };
      optional(summary, 'attemptId', row.attempt_id);
      optional(summary, 'planId', row.plan_id);
      optional(summary, 'planVersion', row.plan_version);
      optional(summary, 'planItemId', row.plan_item_id);
      optional(summary, 'commandRef', row.command_ref);
      optional(summary, 'exitCode', row.exit_code);
      optional(summary, 'durationMs', row.duration_ms);
      optional(summary, 'sha', row.sha);
      optional(summary, 'url', safeExternalUrl(row.external_url));
      optional(summary, 'artifactDigest', row.artifact_digest);
      return summary;
    });

    if (run.active_plan_id === null) {
      return {
        run: runView,
        plan: null,
        items: [],
        attempts,
        heartbeats,
        checkpoints,
        evidence,
      };
    }

    const plan = await this.db
      .prepare(
        `SELECT plan_id, plan_version, task_revision, base_sha, digest, status,
                created_by_attempt_id, objective, created_at, updated_at
         FROM execution_plans WHERE plan_id = ? AND run_id = ?`,
      )
      .bind(run.active_plan_id, runId)
      .first<PlanRow>();
    if (plan === null) throw new Error('active plan projection is incomplete');

    const [
      assumptionResult,
      planEvidenceRefResult,
      itemResult,
      acceptanceCriteriaResult,
      doneWhenResult,
      dependencyResult,
      effectResult,
      commandResult,
      evidenceKindResult,
      externalFactResult,
      verificationResult,
      verificationMappingResult,
    ] = await Promise.all([
      this.db
        .prepare(
          `SELECT position, assumption AS value
           FROM execution_plan_assumptions WHERE plan_id = ? ORDER BY position`,
        )
        .bind(plan.plan_id)
        .all<PlanValueRow>(),
      this.db
        .prepare(
          `SELECT position, evidence_ref AS value
           FROM execution_plan_evidence_refs WHERE plan_id = ? ORDER BY position`,
        )
        .bind(plan.plan_id)
        .all<PlanValueRow>(),
      this.db
        .prepare(
          `SELECT plan_items.item_id, plan_items.kind, plan_items.title,
                  plan_items.objective, plan_items.required, plan_items.position,
                  plan_item_progress.status, plan_item_progress.version AS progress_version
           FROM plan_items
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_items.plan_id
            AND plan_item_progress.item_id = plan_items.item_id
           WHERE plan_items.plan_id = ? ORDER BY plan_items.position`,
        )
        .bind(plan.plan_id)
        .all<ItemRow>(),
      this.db
        .prepare(
          `SELECT item_id, acceptance_criterion_index AS value
           FROM plan_item_acceptance_criteria
           WHERE plan_id = ? ORDER BY item_id, acceptance_criterion_index`,
        )
        .bind(plan.plan_id)
        .all<ItemIndexRow>(),
      this.itemValues(
        `SELECT item_id, condition AS value, position
         FROM plan_item_done_when WHERE plan_id = ? ORDER BY item_id, position`,
        plan.plan_id,
      ),
      this.itemValues(
        `SELECT item_id, depends_on_item_id AS value
         FROM plan_item_dependencies WHERE plan_id = ? ORDER BY item_id, depends_on_item_id`,
        plan.plan_id,
      ),
      this.itemValues(
        `SELECT item_id, effect AS value
         FROM plan_item_effects WHERE plan_id = ? ORDER BY item_id, effect`,
        plan.plan_id,
      ),
      this.itemValues(
        `SELECT item_id, command_ref AS value
         FROM plan_item_command_refs WHERE plan_id = ? ORDER BY item_id, command_ref`,
        plan.plan_id,
      ),
      this.itemValues(
        `SELECT item_id, evidence_kind AS value
         FROM plan_item_evidence_kinds WHERE plan_id = ? ORDER BY item_id, evidence_kind`,
        plan.plan_id,
      ),
      this.itemValues(
        `SELECT item_id, external_fact AS value
         FROM plan_item_external_facts WHERE plan_id = ? ORDER BY item_id, external_fact`,
        plan.plan_id,
      ),
      this.db
        .prepare(
          `SELECT plan_item_verifications.verification_id,
                  plan_item_verifications.plan_item_id,
                  plan_item_verifications.head_sha,
                  plan_item_verifications.evidence_set_digest,
                  plan_item_verifications.created_at
           FROM plan_item_verifications
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_item_verifications.plan_id
            AND plan_item_progress.item_id = plan_item_verifications.plan_item_id
           WHERE plan_item_verifications.plan_id = ?
             AND plan_item_verifications.status = 'passed'
             AND plan_item_progress.status = 'passed'
             AND plan_item_progress.version = plan_item_verifications.progress_version + 1
           ORDER BY plan_item_verifications.created_at, plan_item_verifications.verification_id`,
        )
        .bind(plan.plan_id)
        .all<PlanItemVerificationRow>(),
      this.db
        .prepare(
          `SELECT plan_item_done_when_evidence.verification_id,
                  plan_item_done_when_evidence.done_when_position,
                  plan_item_done_when_evidence.evidence_position,
                  plan_item_done_when_evidence.evidence_id
           FROM plan_item_done_when_evidence
           JOIN plan_item_verifications
             ON plan_item_verifications.verification_id = plan_item_done_when_evidence.verification_id
           JOIN plan_item_progress
             ON plan_item_progress.plan_id = plan_item_verifications.plan_id
            AND plan_item_progress.item_id = plan_item_verifications.plan_item_id
           WHERE plan_item_verifications.plan_id = ?
             AND plan_item_verifications.status = 'passed'
             AND plan_item_progress.status = 'passed'
             AND plan_item_progress.version = plan_item_verifications.progress_version + 1
           ORDER BY plan_item_done_when_evidence.verification_id,
                    plan_item_done_when_evidence.done_when_position,
                    plan_item_done_when_evidence.evidence_position`,
        )
        .bind(plan.plan_id)
        .all<PlanItemVerificationMappingRow>(),
    ]);

    const assumptions = assumptionResult.results.map((row, index) => {
      if (row.position !== index) throw new Error('active plan projection is incomplete');
      return row.value;
    });
    const planEvidenceRefs = planEvidenceRefResult.results.map((row, index) => {
      if (row.position !== index) throw new Error('active plan projection is incomplete');
      return row.value;
    });

    const valueMaps = Array.from({ length: 6 }, () => new Map<string, string[]>());
    const valueResults = [
      doneWhenResult,
      dependencyResult,
      effectResult,
      commandResult,
      evidenceKindResult,
      externalFactResult,
    ];
    valueResults.forEach((rows, index) => appendValues(rows, valueMaps[index]!));
    const [doneWhen, dependencies, effects, commands, evidenceKinds, externalFacts] = valueMaps;
    const acceptanceCriteriaIndexes = new Map<string, number[]>();
    for (const row of acceptanceCriteriaResult.results) {
      const indexes = acceptanceCriteriaIndexes.get(row.item_id);
      if (indexes === undefined) acceptanceCriteriaIndexes.set(row.item_id, [row.value]);
      else indexes.push(row.value);
    }
    const mappingsByVerification = new Map<string, PlanItemVerificationMappingRow[]>();
    for (const mapping of verificationMappingResult.results) {
      const mappings = mappingsByVerification.get(mapping.verification_id);
      if (mappings === undefined) {
        mappingsByVerification.set(mapping.verification_id, [mapping]);
      } else {
        mappings.push(mapping);
      }
    }
    const verificationByItem = new Map<string, Record<string, unknown>>();
    for (const verification of verificationResult.results) {
      const mappings = mappingsByVerification.get(verification.verification_id) ?? [];
      const evidenceIds: string[] = [];
      const seenEvidence = new Set<string>();
      const doneWhenEvidence: Array<{ position: number; evidenceIds: string[] }> = [];
      for (const mapping of mappings) {
        if (!seenEvidence.has(mapping.evidence_id)) {
          seenEvidence.add(mapping.evidence_id);
          evidenceIds.push(mapping.evidence_id);
        }
        const current = doneWhenEvidence.at(-1);
        if (current?.position === mapping.done_when_position) {
          current.evidenceIds.push(mapping.evidence_id);
        } else {
          doneWhenEvidence.push({
            position: mapping.done_when_position,
            evidenceIds: [mapping.evidence_id],
          });
        }
      }
      verificationByItem.set(verification.plan_item_id, {
        id: verification.verification_id,
        headSha: verification.head_sha,
        evidenceSetDigest: verification.evidence_set_digest,
        evidenceIds,
        doneWhenEvidence,
        verifiedAt: verification.created_at,
      });
    }

    return {
      run: runView,
      plan: {
        id: plan.plan_id,
        version: plan.plan_version,
        taskRevision: plan.task_revision,
        baseSha: plan.base_sha,
        digest: plan.digest,
        status: plan.status,
        createdByAttemptId: plan.created_by_attempt_id,
        objective: plan.objective,
        assumptionCount: assumptions.length,
        evidenceRefCount: planEvidenceRefs.length,
        evidenceRefsDigest: await canonicalSha256(planEvidenceRefs),
        createdAt: plan.created_at,
        updatedAt: plan.updated_at,
      },
      items: itemResult.results.map((item) => {
        const summary: Record<string, unknown> = {
          id: item.item_id,
          kind: item.kind,
          title: item.title,
          objective: item.objective,
          required: item.required === 1,
          status: item.status,
          progressVersion: item.progress_version,
          acceptanceCriteriaIndexes: acceptanceCriteriaIndexes.get(item.item_id) ?? [],
          doneWhen: doneWhen?.get(item.item_id) ?? [],
          dependsOn: dependencies?.get(item.item_id) ?? [],
          effects: effects?.get(item.item_id) ?? [],
          commandRefs: commands?.get(item.item_id) ?? [],
          evidenceKinds: evidenceKinds?.get(item.item_id) ?? [],
          externalFacts: externalFacts?.get(item.item_id) ?? [],
        };
        optional(summary, 'verificationDecision', verificationByItem.get(item.item_id));
        return summary;
      }),
      attempts,
      heartbeats,
      checkpoints,
      evidence,
    };
  }

  private async testDeploymentSummaries(
    runId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare(
      `SELECT deployment_id, plan_item_id, attempt_id, status, environment,
              ref_sha, role_ref, github_deployment_id, external_url,
              evidence_id, created_at, updated_at
       FROM test_deployments WHERE run_id = ?
       ORDER BY created_at, deployment_id`,
    ).bind(runId).all<TestDeploymentProjectionRow>();
    return rows.results.map((row) => {
      const summary: Record<string, unknown> = {
        id: row.deployment_id,
        planItemId: row.plan_item_id,
        attemptId: row.attempt_id,
        status: row.status,
        environment: row.environment,
        refSha: row.ref_sha,
        roleRef: row.role_ref,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(summary, 'githubDeploymentId', row.github_deployment_id);
      optional(summary, 'url', safeExternalUrl(row.external_url));
      optional(summary, 'evidenceId', row.evidence_id);
      return summary;
    });
  }

  private async testAcceptanceSummaries(
    runId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare(
      `SELECT acceptance_id, deployment_id, plan_item_id, attempt_id, status,
              ref_sha, command_ref, github_run_id, external_state,
              external_conclusion, evidence_id, created_at, updated_at
       FROM test_acceptances WHERE run_id = ?
       ORDER BY created_at, acceptance_id`,
    ).bind(runId).all<TestAcceptanceProjectionRow>();
    return rows.results.map((row) => {
      const summary: Record<string, unknown> = {
        id: row.acceptance_id,
        deploymentId: row.deployment_id,
        planItemId: row.plan_item_id,
        attemptId: row.attempt_id,
        status: row.status,
        refSha: row.ref_sha,
        commandRef: row.command_ref,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(summary, 'githubRunId', row.github_run_id);
      optional(summary, 'externalState', row.external_state);
      optional(summary, 'externalConclusion', row.external_conclusion);
      optional(summary, 'evidenceId', row.evidence_id);
      return summary;
    });
  }

  private async productionDeploymentSummaries(
    runId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare(
      `SELECT deployments.deployment_id, deployments.attempt_id,
              deployments.approval_id, identities.approver_principal,
              deployments.task_revision, deployments.merge_id, deployments.merge_sha,
              deployments.status, deployments.environment, deployments.role_ref,
              deployments.external_state, deployments.external_updated_at,
              deployments.github_deployment_id, deployments.external_url,
              deployments.evidence_id, deployments.created_at, deployments.updated_at
       FROM production_deployments AS deployments
       JOIN identity_bound_approvals AS identities
         ON identities.approval_id = deployments.approval_id
       WHERE deployments.run_id = ?
       ORDER BY deployments.created_at, deployments.deployment_id`,
    ).bind(runId).all<ProductionDeploymentProjectionRow>();
    return rows.results.map((row) => {
      const summary: Record<string, unknown> = {
        id: row.deployment_id,
        attemptId: row.attempt_id,
        approvalId: row.approval_id,
        approverPrincipal: row.approver_principal,
        taskRevision: row.task_revision,
        mergeId: row.merge_id,
        mergeSha: row.merge_sha,
        status: row.status,
        environment: row.environment,
        roleRef: row.role_ref,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(summary, 'githubDeploymentId', row.github_deployment_id);
      optional(summary, 'externalState', row.external_state);
      optional(summary, 'externalUpdatedAt', row.external_updated_at);
      optional(summary, 'url', safeExternalUrl(row.external_url));
      optional(summary, 'evidenceId', row.evidence_id);
      return summary;
    });
  }

  private async testRollbackSummaries(
    runId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare(
      `SELECT rollback_id, source_kind, source_id, source_evidence_id,
              deployment_id, attempt_id, status, ref_sha, role_ref,
              policy_digest, contract_digest, github_run_id, external_state,
              external_conclusion, evidence_id, created_at, updated_at
       FROM test_rollbacks WHERE run_id = ? ORDER BY created_at, rollback_id`,
    ).bind(runId).all<TestRollbackProjectionRow>();
    return rows.results.map((row) => {
      const summary: Record<string, unknown> = {
        id: row.rollback_id,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        sourceEvidenceId: row.source_evidence_id,
        deploymentId: row.deployment_id,
        attemptId: row.attempt_id,
        status: row.status,
        refSha: row.ref_sha,
        roleRef: row.role_ref,
        policyDigest: row.policy_digest,
        contractDigest: row.contract_digest,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      optional(summary, 'githubRunId', row.github_run_id);
      optional(summary, 'externalState', row.external_state);
      optional(summary, 'externalConclusion', row.external_conclusion);
      optional(summary, 'evidenceId', row.evidence_id);
      return summary;
    });
  }

  private async automatedReviewSummary(runId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare(
      `WITH current_head AS (
         SELECT observations.head_sha
         FROM github_merge_gate_observations AS observations
         JOIN merge_gate_evaluations AS evaluations
           ON evaluations.observation_id = observations.observation_id
         WHERE evaluations.run_id = ?
         ORDER BY observations.external_updated_at DESC,
                  evaluations.created_at DESC, observations.observation_id DESC
         LIMIT 1
       )
       SELECT lineage.iteration, lineage.head_sha, lineage.status,
              lineage.blocking_finding_count, lineage.minor_finding_count
       FROM automated_review_lineage AS lineage
       WHERE lineage.run_id = ?
         AND lineage.head_sha = (SELECT head_sha FROM current_head)
       ORDER BY lineage.iteration DESC, lineage.updated_at DESC
       LIMIT 1`,
    ).bind(runId, runId).first<AutomatedReviewProjectionRow>();
    if (row === null) return null;
    const projection: Record<string, unknown> = {
      iteration: row.iteration,
      headSha: row.head_sha,
      status: row.status,
    };
    optional(projection, 'blockingFindingCount', row.blocking_finding_count);
    optional(projection, 'minorFindingCount', row.minor_finding_count);
    return projection;
  }

  private async githubMergeSummary(runId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare(
      `SELECT merges.merge_id, merges.decision_id, merges.publication_id,
              merges.github_pr_number, merges.head_branch, merges.head_sha,
              merges.base_branch, merges.base_sha, merges.merge_sha,
              merges.merged_by_login, merges.merged_at,
              merges.deployment_disposition, merges.evidence_id,
              evidence.external_url, merges.created_at
       FROM github_merges AS merges
       JOIN evidence ON evidence.evidence_id = merges.evidence_id
       WHERE merges.run_id = ?`,
    ).bind(runId).first<GitHubMergeProjectionRow>();
    if (row === null) return null;
    const summary: Record<string, unknown> = {
      id: row.merge_id,
      decisionId: row.decision_id,
      publicationId: row.publication_id,
      pullRequestNumber: row.github_pr_number,
      headBranch: row.head_branch,
      headSha: row.head_sha,
      baseBranch: row.base_branch,
      baseSha: row.base_sha,
      mergeSha: row.merge_sha,
      mergedByLogin: row.merged_by_login,
      mergedAt: row.merged_at,
      deploymentDisposition: row.deployment_disposition,
      evidenceId: row.evidence_id,
      observedAt: row.created_at,
    };
    optional(summary, 'url', safeExternalUrl(row.external_url));
    return summary;
  }

  private async itemValues(sql: string, planId: string): Promise<ItemValueRow[]> {
    const { results } = await this.db.prepare(sql).bind(planId).all<ItemValueRow>();
    return results;
  }

  private async mergeGateSummary(runId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare(
      `SELECT evaluations.evaluation_id,
              evaluations.status AS evaluation_status,
              evaluations.rejection_reason,
              decisions.decision_id,
              observations.observation_id,
              observations.github_pr_number,
              observations.head_sha, observations.base_sha,
              observations.mergeability, observations.merge_state,
              observations.review_decision,
              observations.required_approval_count,
              observations.approved_review_count,
              observations.required_check_count,
              observations.passed_check_count,
              observations.pending_check_count,
              observations.failed_check_count,
              observations.missing_check_count,
              observations.policy_digest, observations.checks_digest,
              observations.reviews_digest, observations.external_updated_at,
              evaluations.created_at AS evaluated_at
       FROM merge_gate_evaluations AS evaluations
       JOIN github_merge_gate_observations AS observations
         ON observations.observation_id = evaluations.observation_id
       LEFT JOIN merge_gate_decisions AS decisions
         ON decisions.evaluation_id = evaluations.evaluation_id
       WHERE evaluations.run_id = ?
       ORDER BY observations.external_updated_at DESC,
                evaluations.created_at DESC, evaluations.evaluation_id DESC LIMIT 1`,
    ).bind(runId).first<MergeGateProjectionRow>();
    if (row === null) return null;
    if (
      (row.evaluation_status === 'passed' &&
        (row.rejection_reason !== null || row.decision_id === null)) ||
      (row.evaluation_status === 'rejected' && row.rejection_reason === null) ||
      (row.evaluation_status !== 'passed' && row.evaluation_status !== 'rejected')
    ) throw new Error('merge gate projection is invalid');
    const projection: Record<string, unknown> = {
      id: row.evaluation_id,
      status: row.evaluation_status,
      observationId: row.observation_id,
      pullRequestNumber: row.github_pr_number,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      mergeability: row.mergeability,
      mergeState: row.merge_state,
      reviewDecision: row.review_decision,
      requiredApprovals: row.required_approval_count,
      approvedReviewCount: row.approved_review_count,
      requiredCheckCount: row.required_check_count,
      passedCheckCount: row.passed_check_count,
      pendingCheckCount: row.pending_check_count,
      failedCheckCount: row.failed_check_count,
      missingCheckCount: row.missing_check_count,
      policyDigest: row.policy_digest,
      checksDigest: row.checks_digest,
      reviewsDigest: row.reviews_digest,
      externalUpdatedAt: row.external_updated_at,
      evaluatedAt: row.evaluated_at,
    };
    optional(projection, 'decisionId', row.decision_id);
    optional(projection, 'reason', row.rejection_reason);
    return projection;
  }

  private async blockerSummary(runId: string): Promise<Record<string, unknown> | null> {
    const baseRebase = await this.db.prepare(
      `SELECT rebase_id, source_attempt_id, rebase_attempt_id,
              source_branch, source_head_sha, target_branch,
              old_base_sha, new_base_sha, blocker_reason, completed_at
       FROM base_rebase_attempts
       WHERE run_id = ? AND status = 'blocked'
       ORDER BY completed_at DESC, rebase_id DESC LIMIT 1`,
    ).bind(runId).first<BaseRebaseBlockerRow>();
    if (baseRebase !== null) {
      if (
        baseRebase.blocker_reason !== 'base_rebase_content_conflict' ||
        baseRebase.completed_at === null
      ) throw new Error('base rebase blocker projection is invalid');
      return {
        id: baseRebase.rebase_id,
        kind: 'base_rebase_conflict',
        reason: baseRebase.blocker_reason,
        sourceAttemptId: baseRebase.source_attempt_id,
        rebaseAttemptId: baseRebase.rebase_attempt_id,
        sourceBranch: baseRebase.source_branch,
        sourceHeadSha: baseRebase.source_head_sha,
        targetBranch: baseRebase.target_branch,
        oldBaseSha: baseRebase.old_base_sha,
        newBaseSha: baseRebase.new_base_sha,
        neededHumanInput: {
          code: 'manual_rebase',
          prompt: 'Resolve the base rebase conflict on a new branch, rerun trusted verification, and request fresh approval.',
        },
        createdAt: baseRebase.completed_at,
      };
    }
    const baseConflict = await this.db.prepare(
      `SELECT conflict_id, repository, base_branch, before_sha, after_sha,
              relationship, ahead_by, behind_by, merge_base_sha,
              blocker_reason, needed_human_input, created_at
       FROM github_base_conflicts
       WHERE run_id = ? ORDER BY created_at DESC, conflict_id DESC LIMIT 1`,
    ).bind(runId).first<BaseConflictBlockerRow>();
    if (baseConflict !== null) {
      if (
        baseConflict.blocker_reason !== 'base_history_diverged' ||
        baseConflict.needed_human_input !== 'manual_rebase'
      ) throw new Error('base conflict blocker projection is invalid');
      return {
        id: baseConflict.conflict_id,
        kind: 'base_history_conflict',
        reason: baseConflict.blocker_reason,
        repository: baseConflict.repository,
        baseBranch: baseConflict.base_branch,
        beforeSha: baseConflict.before_sha,
        afterSha: baseConflict.after_sha,
        relationship: baseConflict.relationship,
        aheadBy: baseConflict.ahead_by,
        behindBy: baseConflict.behind_by,
        mergeBaseSha: baseConflict.merge_base_sha,
        neededHumanInput: {
          code: baseConflict.needed_human_input,
          prompt: 'Manually rebase the unpublished change onto the reviewed base, resolve conflicts, and request a fresh verified run.',
        },
        createdAt: baseConflict.created_at,
      };
    }
    const result = await this.db
      .prepare(
        `SELECT run_blockers.blocker_id, run_blockers.reason,
                run_blockers.fingerprint_digest, run_blockers.attempt_count,
                run_blockers.consecutive_fingerprint_count,
                run_blockers.needed_human_input,
                run_blockers.created_at AS blocker_created_at,
                attempt_failures.failure_id, attempt_failures.attempt_id,
                attempt_failures.attempt_ordinal, attempt_failures.failure_class,
                attempt_failures.failure_code, attempt_failures.failure_site,
                attempt_failures.occurred_at,
                attempt_failure_paths.position, attempt_failure_paths.path_code,
                attempt_failure_verification_facts.source_suite_id,
                attempt_failure_verification_facts.source_evidence_id,
                attempt_failure_verification_facts.source_head_sha,
                attempt_failure_verification_facts.failure_fact_digest
         FROM run_blockers
         JOIN attempt_failures
           ON attempt_failures.run_id = run_blockers.run_id
          AND attempt_failures.retry_scope_digest = run_blockers.retry_scope_digest
          AND attempt_failures.created_at <= run_blockers.created_at
         JOIN attempt_failure_paths
           ON attempt_failure_paths.failure_id = attempt_failures.failure_id
         LEFT JOIN attempt_failure_verification_facts
           ON attempt_failure_verification_facts.failure_id = attempt_failures.failure_id
         WHERE run_blockers.run_id = ? AND run_blockers.resolved_at IS NULL
         ORDER BY attempt_failures.attempt_ordinal, attempt_failure_paths.position`,
      )
      .bind(runId)
      .all<BlockerPathRow>();
    const first = result.results[0];
    if (first === undefined) return null;
    const inputCode = first.needed_human_input as HumanInputCode;
    const prompt = HUMAN_INPUT_PROMPTS[inputCode];
    if (prompt === undefined) throw new Error('blocker human input projection is invalid');

    const attempts = new Map<string, Record<string, unknown>>();
    for (const row of result.results) {
      const pathCode = row.path_code as AttemptedPath;
      const label = ATTEMPTED_PATH_LABELS[pathCode];
      if (label === undefined) throw new Error('blocker attempted path projection is invalid');
      let attempt = attempts.get(row.failure_id);
      if (attempt === undefined) {
        attempt = {
          attemptId: row.attempt_id,
          ordinal: row.attempt_ordinal,
          failureClass: row.failure_class,
          failureCode: row.failure_code,
          failureSite: row.failure_site,
          occurredAt: row.occurred_at,
          paths: [],
        };
        if (
          row.source_suite_id !== null &&
          row.source_evidence_id !== null &&
          row.source_head_sha !== null &&
          row.failure_fact_digest !== null
        ) {
          attempt.verificationFailure = {
            sourceSuiteId: row.source_suite_id,
            sourceEvidenceId: row.source_evidence_id,
            headSha: row.source_head_sha,
            factDigest: row.failure_fact_digest,
          };
        }
        attempts.set(row.failure_id, attempt);
      }
      (attempt.paths as Array<Record<string, string>>).push({ code: pathCode, label });
    }
    return {
      id: first.blocker_id,
      reason: first.reason,
      fingerprintDigest: first.fingerprint_digest,
      attemptCount: first.attempt_count,
      consecutiveFingerprintCount: first.consecutive_fingerprint_count,
      attemptedPaths: [...attempts.values()],
      neededHumanInput: { code: inputCode, prompt },
      createdAt: first.blocker_created_at,
    };
  }

  private async protectedPathApprovalSummary(
    runId: string,
  ): Promise<Record<string, unknown> | null> {
    const gate = await this.db
      .prepare(
        `SELECT gate_id, attempt_id, plan_id, plan_version, plan_item_id, base_sha,
                staged_tree_sha, delivery_policy_digest, diff_digest,
                total_changed_files, status, created_at, updated_at
         FROM protected_path_change_gates
         WHERE run_id = ? AND status = 'awaiting_approval'
         ORDER BY created_at DESC, gate_id DESC LIMIT 1`,
      )
      .bind(runId)
      .first<ProtectedPathGateRow>();
    if (gate === null) return null;
    const entries = await this.db
      .prepare(
        `SELECT path, previous_path, change_type, additions, deletions
         FROM protected_path_change_entries
         WHERE gate_id = ? ORDER BY position`,
      )
      .bind(gate.gate_id)
      .all<ProtectedPathEntryRow>();
    return {
      id: gate.gate_id,
      kind: 'protected_path_change',
      status: gate.status,
      attemptId: gate.attempt_id,
      planId: gate.plan_id,
      planVersion: gate.plan_version,
      planItemId: gate.plan_item_id,
      baseSha: gate.base_sha,
      stagedTreeSha: gate.staged_tree_sha,
      policyDigest: gate.delivery_policy_digest,
      diffDigest: gate.diff_digest,
      totalChangedFiles: gate.total_changed_files,
      changes: entries.results.map((entry) => ({
        path: entry.path,
        ...(entry.previous_path === null ? {} : { previousPath: entry.previous_path }),
        changeType: entry.change_type,
        additions: entry.additions,
        deletions: entry.deletions,
      })),
      createdAt: gate.created_at,
      updatedAt: gate.updated_at,
    };
  }

  private async stuckIncidentSummaries(runId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare(
      `SELECT incident_id, state_kind, observed_run_state, run_version, attempt_id,
              threshold_seconds, action, status, detected_at, resolved_at, resolution_code
       FROM run_stuck_incidents WHERE run_id = ?
       ORDER BY detected_at DESC, incident_id DESC LIMIT 20`,
    ).bind(runId).all<RunStuckIncidentProjectionRow>();
    return rows.results.map((row) => ({
      id: row.incident_id,
      stateKind: row.state_kind,
      observedRunState: row.observed_run_state,
      runVersion: row.run_version,
      thresholdSeconds: row.threshold_seconds,
      action: row.action,
      status: row.status,
      detectedAt: row.detected_at,
      ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
      ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
      ...(row.resolution_code === null ? {} : { resolutionCode: row.resolution_code }),
    }));
  }

  private async workflowInstanceSummary(runId: string): Promise<Record<string, unknown> | null> {
    const state = await this.db.prepare(
      `SELECT run_version, d1_state, platform_status, fact_digest, checked_at
       FROM workflow_instance_reconciliation_state WHERE run_id = ?`,
    ).bind(runId).first<WorkflowInstanceReconciliationStateRow>();
    if (state === null) return null;
    const observations = await this.db.prepare(
      `SELECT observation_id, run_version, d1_state, platform_status,
              fact_digest, action, status, repair_outbox_id, observed_at,
              repair_observed_at, resolved_at, resolution_code
       FROM workflow_instance_reconciliation_observations WHERE run_id = ?
       ORDER BY observed_at DESC, observation_id DESC LIMIT 20`,
    ).bind(runId).all<WorkflowInstanceReconciliationObservationRow>();
    return {
      id: runId,
      runVersion: state.run_version,
      d1State: state.d1_state,
      platformStatus: state.platform_status,
      factDigest: state.fact_digest,
      checkedAt: state.checked_at,
      reconciliations: observations.results.map((row) => ({
        id: row.observation_id,
        runVersion: row.run_version,
        d1State: row.d1_state,
        platformStatus: row.platform_status,
        factDigest: row.fact_digest,
        action: row.action,
        status: row.status,
        observedAt: row.observed_at,
        ...(row.repair_outbox_id === null ? {} : { repairOutboxId: row.repair_outbox_id }),
        ...(row.repair_observed_at === null
          ? {}
          : { repairObservedAt: row.repair_observed_at }),
        ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
        ...(row.resolution_code === null ? {} : { resolutionCode: row.resolution_code }),
      })),
    };
  }

  private async quotaSummary(runId: string): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const [limits, overrides, denials, usage] = await Promise.all([
      this.db.prepare(
        `WITH query(now, run_id) AS (VALUES (?, ?)), computed AS (
           SELECT policy.scope_type, policy.resource_type, policy.window_kind,
                  policy.limit_value,
                  (
                    SELECT active.override_id FROM quota_overrides AS active
                    WHERE active.run_id = policy.run_id AND active.status = 'approved'
                      AND active.expires_at > query.now
                      AND EXISTS (
                        SELECT 1 FROM json_each(active.resources_json)
                        WHERE value = policy.resource_type
                      )
                    ORDER BY active.created_at DESC, active.override_id DESC LIMIT 1
                  ) AS override_id,
                  CASE policy.resource_type
                    WHEN 'concurrency' THEN (
                      SELECT COUNT(*) FROM quota_concurrency_reservations AS reservations
                      JOIN quota_run_scopes AS scope
                        ON scope.run_id = reservations.run_id
                       AND scope.scope_type = policy.scope_type
                       AND scope.scope_key = policy.scope_key
                      JOIN attempts ON attempts.attempt_id = reservations.attempt_id
                      WHERE reservations.released_at IS NULL AND (
                        (attempts.status = 'pending' AND reservations.expires_at > query.now) OR
                        (attempts.status IN ('starting', 'running') AND (
                          reservations.expires_at > query.now OR
                          attempts.lease_expires_at > query.now
                        ))
                      )
                    )
                    WHEN 'attempt' THEN (
                      SELECT COUNT(*) FROM attempts AS attempt_usage
                      JOIN quota_run_scopes AS scope
                        ON scope.run_id = attempt_usage.run_id
                       AND scope.scope_type = policy.scope_type
                       AND scope.scope_key = policy.scope_key
                      WHERE policy.window_kind = 'run_lifetime'
                         OR substr(attempt_usage.created_at, 1, 10) = substr(query.now, 1, 10)
                    )
                    WHEN 'tool_call' THEN (
                      SELECT COUNT(*) FROM quota_tool_call_admissions AS tool_usage
                      JOIN quota_run_scopes AS scope
                        ON scope.run_id = tool_usage.run_id
                       AND scope.scope_type = policy.scope_type
                       AND scope.scope_key = policy.scope_key
                      WHERE policy.window_kind = 'run_lifetime'
                         OR substr(tool_usage.occurred_at, 1, 10) = substr(query.now, 1, 10)
                    )
                    WHEN 'model_tokens' THEN COALESCE((
                      SELECT SUM(model_usage.input_tokens + model_usage.output_tokens)
                      FROM model_usage
                      JOIN quota_run_scopes AS scope
                        ON scope.run_id = model_usage.run_id
                       AND scope.scope_type = policy.scope_type
                       AND scope.scope_key = policy.scope_key
                      WHERE policy.window_kind = 'run_lifetime'
                         OR substr(model_usage.at, 1, 10) = substr(query.now, 1, 10)
                    ), 0) + COALESCE((
                      SELECT SUM(reservations.reserved_tokens)
                      FROM quota_model_reservations AS reservations
                      JOIN quota_run_scopes AS scope
                        ON scope.run_id = reservations.run_id
                       AND scope.scope_type = policy.scope_type
                       AND scope.scope_key = policy.scope_key
                      WHERE reservations.status = 'reserved' AND reservations.expires_at > query.now
                        AND (policy.window_kind = 'run_lifetime'
                          OR substr(reservations.created_at, 1, 10) = substr(query.now, 1, 10))
                    ), 0)
                    WHEN 'model_cost_microusd' THEN COALESCE((
                      SELECT SUM(model_usage.cost_microusd) FROM model_usage
                      JOIN quota_run_scopes AS scope
                        ON scope.run_id = model_usage.run_id
                       AND scope.scope_type = policy.scope_type
                       AND scope.scope_key = policy.scope_key
                      WHERE policy.window_kind = 'run_lifetime'
                         OR substr(model_usage.at, 1, 10) = substr(query.now, 1, 10)
                    ), 0) + COALESCE((
                      SELECT SUM(reservations.reserved_cost_microusd)
                      FROM quota_model_reservations AS reservations
                      JOIN quota_run_scopes AS scope
                        ON scope.run_id = reservations.run_id
                       AND scope.scope_type = policy.scope_type
                       AND scope.scope_key = policy.scope_key
                      WHERE reservations.status = 'reserved' AND reservations.expires_at > query.now
                        AND (policy.window_kind = 'run_lifetime'
                          OR substr(reservations.created_at, 1, 10) = substr(query.now, 1, 10))
                    ), 0)
                  END AS used_units
           FROM quota_effective_policies AS policy CROSS JOIN query
           WHERE policy.run_id = query.run_id
         )
         SELECT scope_type, resource_type, window_kind, limit_value,
                used_units, override_id,
                limit_value * CASE WHEN override_id IS NULL THEN 1 ELSE 2 END AS effective_limit
         FROM computed
         ORDER BY CASE scope_type WHEN 'tenant' THEN 0 WHEN 'repository' THEN 1
           WHEN 'user' THEN 2 ELSE 3 END,
           CASE resource_type WHEN 'concurrency' THEN 0 WHEN 'attempt' THEN 1
             WHEN 'model_tokens' THEN 2 WHEN 'model_cost_microusd' THEN 3 ELSE 4 END`,
      ).bind(now, runId).all<QuotaLimitProjectionRow>(),
      this.db.prepare(
        `SELECT override_id, expected_run_version, resources_json, reason_digest,
                approver_principal, multiplier, decision, status, rejection_reason,
                expires_at, created_at
         FROM quota_overrides WHERE run_id = ?
         ORDER BY created_at DESC, override_id DESC LIMIT 20`,
      ).bind(runId).all<QuotaOverrideProjectionRow>(),
      this.db.prepare(
        `SELECT denial_id, attempt_id, resource_type, scope_type, limit_value,
                requested_units, reason_digest, occurred_at
         FROM quota_denials WHERE run_id = ?
         ORDER BY occurred_at DESC, denial_id DESC LIMIT 20`,
      ).bind(runId).all<QuotaDenialProjectionRow>(),
      this.db.prepare(
        `SELECT usage_id, attempt_id, provider, model, input_tokens,
                cached_input_tokens, output_tokens, reasoning_output_tokens,
                cost_microusd, source_digest, at
         FROM model_usage WHERE run_id = ?
         ORDER BY at DESC, usage_id DESC LIMIT 20`,
      ).bind(runId).all<ModelUsageProjectionRow>(),
    ]);
    return {
      checkedAt: now,
      limits: limits.results.map((row) => ({
        scopeType: row.scope_type,
        resource: row.resource_type,
        window: row.window_kind,
        used: row.used_units,
        limit: row.limit_value,
        effectiveLimit: row.effective_limit,
        state: row.used_units > row.effective_limit ? 'exceeded' : 'available',
        ...(row.override_id === null ? {} : { overrideId: row.override_id }),
      })),
      overrides: overrides.results.map((row) => ({
        id: row.override_id,
        expectedRunVersion: row.expected_run_version,
        resources: JSON.parse(row.resources_json) as unknown,
        reasonDigest: row.reason_digest,
        multiplier: row.multiplier,
        decision: row.decision,
        status: row.status,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        ...(row.approver_principal === null ? {} : { approverPrincipal: row.approver_principal }),
        ...(row.rejection_reason === null ? {} : { rejectionReason: row.rejection_reason }),
      })),
      denials: denials.results.map((row) => ({
        id: row.denial_id,
        resource: row.resource_type,
        scopeType: row.scope_type,
        limit: row.limit_value,
        requestedUnits: row.requested_units,
        reasonDigest: row.reason_digest,
        occurredAt: row.occurred_at,
        ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
      })),
      modelCalls: usage.results.map((row) => ({
        id: row.usage_id,
        attemptId: row.attempt_id,
        provider: row.provider,
        model: row.model,
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        outputTokens: row.output_tokens,
        reasoningOutputTokens: row.reasoning_output_tokens,
        costMicrousd: row.cost_microusd,
        sourceDigest: row.source_digest,
        occurredAt: row.at,
      })),
    };
  }

  private async planRevisionSummary(runId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare(
      `SELECT revision_id, prior_plan_id, prior_plan_version, prior_plan_digest,
              prior_base_sha, source_kind, source_digest, requested_base_sha,
              COALESCE(
                (SELECT retry_attempt_id FROM plan_revision_analysis_retries
                 WHERE revision_id = plan_revisions.revision_id
                 ORDER BY retry_sequence DESC LIMIT 1),
                analysis_attempt_id
              ) AS analysis_attempt_id,
              new_plan_id, new_plan_version, new_plan_digest,
              body_changed, base_changed, effects_changed, status,
              created_at, activated_at, updated_at
       FROM plan_revisions
       WHERE run_id = ?
       ORDER BY created_at DESC, revision_id DESC LIMIT 1`,
    ).bind(runId).first<PlanRevisionRow>();
    if (row === null) return null;
    const summary: Record<string, unknown> = {
      id: row.revision_id,
      status: row.status,
      sourceKind: row.source_kind,
      sourceDigest: row.source_digest,
      priorPlan: {
        id: row.prior_plan_id,
        version: row.prior_plan_version,
        digest: row.prior_plan_digest,
        baseSha: row.prior_base_sha,
      },
      requestedBaseSha: row.requested_base_sha,
      analysisAttemptId: row.analysis_attempt_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (
      row.new_plan_id !== null &&
      row.new_plan_version !== null &&
      row.new_plan_digest !== null
    ) {
      summary.newPlan = {
        id: row.new_plan_id,
        version: row.new_plan_version,
        digest: row.new_plan_digest,
      };
    }
    if (
      row.body_changed !== null &&
      row.base_changed !== null &&
      row.effects_changed !== null
    ) {
      summary.changes = {
        body: row.body_changed === 1,
        base: row.base_changed === 1,
        effects: row.effects_changed === 1,
      };
    }
    optional(summary, 'activatedAt', row.activated_at);
    return summary;
  }
}
