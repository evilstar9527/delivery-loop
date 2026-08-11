import { canonicalSha256 } from '../domain/digest.js';
import {
  EXECUTION_TOOL_ACTIONS,
  trustedToolSpec,
} from '../domain/tool-bridge.js';
import { GitHubMergeGateFactSchema } from '../domain/github-merge-gate.js';
import { CorrelationQueryStore } from './correlation-query-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const REVIEW_ID_PATTERN = /^[0-9]{1,32}$/;
const AUTOMATED_REVIEW_ID_PATTERN = /^automated_review_[a-f0-9]{52}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const IGNORE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const FIVE_MINUTES_MS = 300_000;
const MAX_ROWS_PER_SECTION = 500;

export type Case8AuditReportErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'projection_conflict'
  | 'time_budget_exceeded';

export class Case8AuditReportError extends Error {
  constructor(readonly code: Case8AuditReportErrorCode) {
    super(`Case 8 audit report failed: ${code}`);
    this.name = 'Case8AuditReportError';
  }
}

interface TaskRunRow {
  task_id: string;
  source_system: string;
  tenant_key: string;
  source_task_key: string;
  task_revision: string;
  source_url: string | null;
  task_digest: string;
  actor_type: string;
  actor_id: string;
  target_repository: string;
  target_base_branch: string;
  target_environment: string;
  allow_repository_write: number;
  allow_test_deploy: number;
  allow_production_deploy: number;
  require_human_approval: number;
  run_id: string;
  run_state: string;
  run_version: number;
  base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  plan_id: string;
  plan_version: number;
  digest: string;
  status: string;
  base_sha: string;
  created_by_attempt_id: string;
  created_at: string;
}

interface AttemptRow {
  attempt_id: string;
  ordinal: number;
  mode: string;
  status: string;
  repository: string | null;
  workflow_ref: string | null;
  github_run_id: string | null;
  github_status: string | null;
  github_conclusion: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  claimed_progress_version: number | null;
  base_sha: string;
  head_sha: string | null;
  created_at: string;
  updated_at: string;
}

interface RevisionSourceRow {
  source_kind: string;
  source_ref: string;
  source_digest: string;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  requested_base_sha: string;
  observed_at: string;
}

interface EffectRow {
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  item_id: string;
  effect: string;
}

interface GrantRow {
  token_id: string;
  attempt_id: string;
  lease_generation: number;
  scopes_json: string;
  expires_at: string;
  revoked_at: string | null;
}

interface GitHubWebhookRunObservationRow {
  source_id: string;
  source_digest: string;
  repository: string;
  github_run_id: string;
  attempt_id: string;
  processing_state: string;
  ignore_reason: string | null;
  external_updated_at: string;
  observed_at: string;
  processed_at: string | null;
}

type GitHubApiRunObservationRow = GitHubWebhookRunObservationRow;

interface CredentialRow {
  credential_id: string;
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  approval_id: string;
  repository: string;
  lease_generation: number;
  status: string;
  authorization_expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface HeadUpdateRow {
  update_id: string;
  evidence_id: string;
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  parent_sha: string;
  head_sha: string;
  branch: string;
  created_at: string;
}

interface ProtectedDiffRow {
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
  protected_change_count: number;
  status: string;
  created_at: string;
}

interface PullRequestRow {
  publication_id: string;
  approval_id: string;
  repository: string;
  base_branch: string;
  head_branch: string;
  head_sha: string;
  body_digest: string;
  status: string;
  github_pr_number: number | null;
  github_pr_url: string | null;
  evidence_id: string | null;
  created_at: string;
}

interface MergeRow {
  merge_id: string;
  publication_id: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  repository: string;
  github_pr_number: number;
  head_sha: string;
  base_sha: string;
  merge_sha: string;
  merged_by_login: string;
  merged_at: string;
  deployment_disposition: string;
  evidence_id: string;
}

interface MergeObservationRow {
  observation_id: string;
  source_kind: 'webhook' | 'api';
  fact_digest: string;
  repository: string;
  github_pr_number: number;
  merge_id: string | null;
  processing_state: 'received' | 'applied' | 'ignored';
  ignore_reason: string | null;
  external_updated_at: string;
  observed_at: string;
  processed_at: string | null;
}

interface CommandRow {
  suite_id: string;
  attempt_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  head_sha: string;
  delivery_policy_digest: string;
  suite_status: string;
  position: number;
  phase: string;
  command_ref: string;
  result_status: string;
  evidence_id: string | null;
  updated_at: string;
}

interface ItemVerificationRow {
  verification_id: string;
  plan_id: string;
  plan_version: number;
  plan_item_id: string;
  attempt_id: string;
  head_sha: string;
  evidence_set_digest: string;
  status: string;
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

interface GitHubCheckRow {
  observation_id: string;
  fact_digest: string;
  policy_digest: string;
  checks_digest: string;
  reviews_digest: string;
  context: string;
  integration_id: number | null;
  state: string;
  observed_at: string;
}

interface MergeGateAuditRow {
  observation_id: string;
  run_version: number;
  publication_id: string;
  fact_digest: string;
  repository: string;
  github_pr_number: number;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  base_sha: string;
  pull_request_base_sha: string;
  pull_request_author_login: string | null;
  pull_request_state: string;
  is_draft: number;
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
  observed_at: string;
  evaluation_id: string;
  evaluation_status: string;
  rejection_reason: string | null;
  evaluation_approval_id: string | null;
  evaluation_created_at: string;
  decision_id: string | null;
  decision_status: string | null;
  decision_approval_id: string | null;
  decision_head_sha: string | null;
  decision_base_sha: string | null;
}

interface ApprovalRow {
  approval_id: string;
  task_id: string;
  task_revision: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  base_sha: string;
  effect: string;
  actor_id: string;
  decision: string;
  expires_at: string;
  created_at: string;
  approver_principal: string | null;
  roles_digest: string | null;
  separation_verified: number | null;
  provider: string | null;
  external_event_id: string | null;
  event_digest: string | null;
  occurred_at: string | null;
  lineage_id: string | null;
  source_id: string | null;
  card_action_receipt_id: string | null;
  decision_recorded_at: string | null;
  invalidated_approval_id: string | null;
}

interface IdentityApprovalAuditRow {
  source_id: string;
  provider: string;
  tenant_key: string;
  external_event_id: string;
  event_digest: string;
  channel: string;
  channel_user_id: string;
  source_occurred_at: string;
  outcome: 'accepted' | 'rejected';
  approval_id: string | null;
  lineage_id: string | null;
  rejection_id: string | null;
  reason: string | null;
  run_id: string;
  task_revision: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  base_sha: string;
  effect: string;
  decision: string;
  approver_principal: string | null;
  approver_channel: string | null;
  approver_channel_user_id: string | null;
  author_principal: string | null;
  author_channel: string | null;
  author_login: string | null;
  roles_digest: string | null;
  separation_verified: number | null;
  expires_at: string | null;
  decision_recorded_at: string;
}

interface DeploymentRow {
  deployment_id: string;
  run_version: number | null;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_item_id: string | null;
  attempt_id: string;
  approval_id: string;
  repository: string;
  environment: string;
  role_ref: string;
  status: string;
  sha: string;
  github_deployment_id: string | null;
  external_state: string | null;
  external_updated_at: string | null;
  external_url: string | null;
  evidence_id: string | null;
  workflow_path: string | null;
  oidc_audience: string | null;
  oidc_attestation_id: string | null;
  oidc_github_run_id: string | null;
  oidc_subject: string | null;
  created_at: string;
  kind: 'test' | 'production';
}

interface ProductionApprovalAuditRow {
  approval_id: string;
  run_id: string;
  task_revision: string;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  base_sha: string;
  merge_id: string;
  merge_sha: string;
  environment: 'production';
  binding_created_at: string;
  decision: string;
  expires_at: string;
  approval_created_at: string;
  source_id: string | null;
  provider: string | null;
  tenant_key: string | null;
  external_event_id: string | null;
  event_digest: string | null;
  channel: string | null;
  channel_user_id: string | null;
  approver_principal: string | null;
  roles_digest: string | null;
  separation_verified: number | null;
  source_occurred_at: string | null;
  decision_recorded_at: string | null;
}

interface TestDeploymentObservationRow {
  observation_id: string;
  source_kind: 'webhook' | 'api';
  fact_digest: string;
  deployment_id: string;
  processing_state: 'received' | 'applied' | 'ignored';
  ignore_reason: string | null;
  external_updated_at: string;
  observed_at: string;
  processed_at: string | null;
}

interface TestAcceptanceRow {
  acceptance_id: string;
  deployment_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_item_id: string;
  attempt_id: string;
  approval_id: string | null;
  repository: string;
  environment: string;
  workflow_path: string;
  oidc_audience: string;
  command_ref: string;
  environment_url: string;
  status: string;
  ref_sha: string;
  github_run_id: string | null;
  runner_result_digest: string | null;
  runner_status: string | null;
  runner_exit_code: number | null;
  runner_duration_ms: number | null;
  external_state: string | null;
  external_conclusion: string | null;
  external_updated_at: string | null;
  evidence_id: string | null;
  oidc_attestation_id: string | null;
  oidc_github_run_id: string | null;
  oidc_subject: string | null;
  created_at: string;
}

interface TestAcceptanceObservationRow {
  observation_id: string;
  source_kind: 'webhook' | 'api';
  fact_digest: string;
  acceptance_id: string;
  github_run_id: string;
  processing_state: 'received' | 'applied' | 'ignored';
  ignore_reason: string | null;
  external_updated_at: string;
  observed_at: string;
  processed_at: string | null;
}

interface TestRollbackContractObservationRow {
  observation_id: string;
  source_kind: 'deployment_failure' | 'acceptance_failure';
  source_id: string;
  source_evidence_id: string;
  repository: string;
  ref_sha: string;
  disposition: 'declared' | 'not_declared' | 'policy_missing' | 'policy_invalid';
  policy_digest: string | null;
  contract_digest: string | null;
  workflow_path: string | null;
  environment: string | null;
  oidc_audience: string | null;
  role_ref: string | null;
  observed_at: string;
}

interface TestRollbackAuditRow {
  rollback_id: string;
  source_kind: 'deployment_failure' | 'acceptance_failure';
  source_id: string;
  source_evidence_id: string;
  failed_attempt_id: string;
  deployment_id: string;
  approval_id: string;
  contract_observation_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_item_id: string;
  attempt_id: string;
  repository: string;
  base_branch: string;
  base_sha: string;
  ref_sha: string;
  policy_digest: string;
  contract_digest: string;
  workflow_path: string;
  environment: string;
  oidc_audience: string;
  role_ref: string;
  status: string;
  github_run_id: string | null;
  runner_result_digest: string | null;
  runner_status: string | null;
  runner_exit_code: number | null;
  runner_duration_ms: number | null;
  external_state: string | null;
  external_conclusion: string | null;
  external_updated_at: string | null;
  evidence_id: string | null;
  oidc_attestation_id: string | null;
  oidc_github_run_id: string | null;
  oidc_workflow_ref: string | null;
  oidc_subject: string | null;
  created_at: string;
}

interface TestRollbackObservationRow {
  observation_id: string;
  source_kind: 'webhook' | 'api';
  fact_digest: string;
  rollback_id: string | null;
  github_run_id: string;
  processing_state: 'received' | 'applied' | 'ignored';
  ignore_reason: string | null;
  external_updated_at: string;
  observed_at: string;
  processed_at: string | null;
}

interface ReplayRow {
  replay_id: string;
  expected_run_version: number;
  plan_id: string;
  plan_version: number;
  plan_item_id: string | null;
  target_kind: 'system_step' | 'plan_item';
  target_step_name: string;
  target_step_type: 'do';
  target_step_count: number;
  reason_digest: string;
  effect_snapshot_digest: string;
  restart_observed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReplayEffectRow {
  replay_id: string;
  effect: string;
  approval_id: string | null;
}

interface ReplayReconciliationRow {
  replay_id: string;
  source_kind: 'outbox' | 'evidence';
  source_ref: string;
  source_digest: string;
  outbox_id: string | null;
  outbox_kind: string | null;
  outbox_dedupe_key: string | null;
  outbox_delivery_state: string | null;
  evidence_id: string | null;
  evidence_kind: string | null;
  evidence_status: string | null;
  evidence_verification_status: string | null;
  evidence_sha: string | null;
  evidence_artifact_digest: string | null;
  evidence_external_url: string | null;
}

interface ReplayOutboxRow {
  outbox_id: string;
  payload_ref: string;
  delivery_state: string;
  attempt_count: number;
  last_error_code: string | null;
}

interface EffectOutboxRow {
  outbox_id: string;
  kind: string;
  delivery_state: string;
  last_error_code: string | null;
  created_at: string;
}

interface SecretArtifactRow {
  object_id: string;
  attempt_id: string;
  category: string;
  ciphertext_digest: string;
  size_bytes: number;
  policy_version: string;
  created_at: string;
  expires_at: string;
  deletion_state: string;
}

interface PullRequestObservationRow {
  source_kind: 'webhook' | 'api';
  source_id: string;
  publication_id: string | null;
  repository: string;
  github_pr_number: number;
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
  ignore_reason: string | null;
  external_updated_at: string;
  observed_at: string;
  processed_at: string | null;
}

interface ReviewObservationRow {
  source_kind: 'webhook';
  source_id: string;
  publication_id: string;
  repository: string;
  github_pr_number: number;
  github_review_id: string;
  reviewed_head_sha: string;
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
  ignore_reason: string | null;
  observed_at: string;
  processed_at: string | null;
  feedback_id: string | null;
  prior_attempt_id: string | null;
  review_attempt_id: string | null;
  source_head_sha: string | null;
  branch: string | null;
  review_url: string | null;
  submitted_at: string | null;
  body_digest: string | null;
}

interface PlanRevisionAuditRow {
  revision_id: string;
  expected_run_version: number;
  revision_status: 'analyzing' | 'activated' | 'rejected';
  source_kind: 'review_feedback' | 'supplemental_context' | 'base_update';
  source_digest: string;
  source_observed_at: string;
  requested_base_sha: string;
  analysis_attempt_id: string;
  prior_plan_id: string;
  prior_plan_version: number;
  prior_plan_digest: string;
  prior_plan_base_sha: string;
  prior_plan_status: string;
  new_plan_id: string | null;
  new_plan_version: number | null;
  new_plan_digest: string | null;
  new_plan_base_sha: string | null;
  new_plan_status: string | null;
  body_changed: number | null;
  base_changed: number | null;
  effects_changed: number | null;
  activated_at: string | null;
  created_at: string;
  source_record_id: string | null;
  base_repository: string | null;
  base_branch: string | null;
  base_before_sha: string | null;
  base_after_sha: string | null;
  base_ahead_by: number | null;
  base_reference_digest: string | null;
  base_comparison_digest: string | null;
  review_delivery_id: string | null;
  review_source_type: 'github' | 'automated' | null;
  review_repository: string | null;
  review_pr_number: number | null;
  review_id: string | null;
  review_body_digest: string | null;
  review_result_digest: string | null;
  review_head_sha: string | null;
  review_branch: string | null;
  review_url: string | null;
  review_submitted_at: string | null;
  context_event_digest: string | null;
  context_digest: string | null;
  context_source_system: string | null;
  context_tenant_key: string | null;
  context_source_task_key: string | null;
  context_prior_task_id: string | null;
  context_prior_task_revision: string | null;
  context_new_task_id: string | null;
  context_new_task_revision: string | null;
  context_new_task_digest: string | null;
  context_new_run_id: string | null;
  context_applied_run_id: string | null;
}

interface BaseRebaseAuditRow {
  rebase_id: string;
  revision_id: string;
  source_plan_id: string;
  source_plan_version: number;
  target_plan_id: string;
  target_plan_version: number;
  plan_item_id: string;
  source_attempt_id: string;
  rebase_attempt_id: string;
  old_base_sha: string;
  new_base_sha: string;
  source_branch: string;
  source_head_sha: string;
  target_branch: string;
  status: string;
  result_head_sha: string | null;
  verification_suite_id: string | null;
  blocker_reason: string | null;
  attempt_status: string;
  attempt_mode: string;
  attempt_github_run_id: string | null;
  attempt_github_status: string | null;
  attempt_github_conclusion: string | null;
  attempt_head_branch: string | null;
  attempt_head_sha: string | null;
  progress_status: string;
  dispatch_outbox_id: string | null;
  dispatch_outbox_state: string | null;
  created_at: string;
  completed_at: string | null;
}

interface BaseConflictAuditRow {
  conflict_id: string;
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
  behind_by: number;
  merge_base_sha: string;
  reference_digest: string;
  comparison_digest: string;
  source_digest: string;
  blocker_reason: string;
  needed_human_input: string;
  run_state: string;
  run_version: number;
  plan_status: string;
  cancel_outbox_id: string | null;
  cancel_outbox_state: string | null;
  created_at: string;
  observed_at: string;
}

export interface Case8AuditReport {
  schemaVersion: '1';
  runId: string;
  generatedAt: string;
  queryDurationMs: number;
  reportDigest: string;
  run: Record<string, unknown>;
  task: Record<string, unknown>;
  answers: {
    who: Record<string, unknown>;
    sourceEvents: Array<Record<string, unknown>>;
    permissions: Record<string, unknown>;
    contextReads: Array<Record<string, unknown>>;
    changes: Array<Record<string, unknown>>;
    checks: Record<string, unknown>;
    approvals: Array<Record<string, unknown>>;
    deployments: Array<Record<string, unknown>>;
  };
  digests: Record<string, unknown>;
  links: Array<{ kind: string; url: string }>;
}

export interface Case8AuditReportStoreOptions {
  now?: () => Date;
  monotonicNow?: () => number;
  generateAccessId?: () => string;
}

function safeUrl(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function optional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) target[key] = value;
}

function rows<T>(result: D1Result<T>): T[] {
  if (result.results.length > MAX_ROWS_PER_SECTION) {
    throw new Case8AuditReportError('projection_conflict');
  }
  return result.results;
}

function scopes(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Case8AuditReportError('projection_conflict');
  }
  if (
    !Array.isArray(parsed) || parsed.length < 1 ||
    parsed.some((scope) => typeof scope !== 'string') ||
    new Set(parsed).size !== parsed.length ||
    parsed.some((scope) => !EXECUTION_TOOL_ACTIONS.includes(scope)) ||
    parsed.some((scope, index) => {
      if (index === 0) return false;
      return EXECUTION_TOOL_ACTIONS.indexOf(scope) <=
        EXECUTION_TOOL_ACTIONS.indexOf(parsed[index - 1] as string);
    })
  ) {
    throw new Case8AuditReportError('projection_conflict');
  }
  return [...parsed] as string[];
}

function category(path: string): string | null {
  if (path === 'repo/read') return 'repository';
  if (path === 'logs/search') return 'logs';
  if (path === 'traces/get') return 'traces';
  if (path === 'k8s/diagnose') return 'k8s';
  if (path === 'database/diagnose') return 'database';
  if (trustedToolSpec(path) !== null) return 'denied_mutation';
  return null;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * A normalized, D1-only answer to Vision Case 8. The List/filter/prepare+bind
 * shape is adapted from Watt@476e3cd AuditStore; delivery-loop joins its
 * domain ledgers instead of copying Watt's generic CallContext JSON model.
 */
export class Case8AuditReportStore {
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly generateAccessId: () => string;

  constructor(
    private readonly db: D1Database,
    options: Case8AuditReportStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.generateAccessId = options.generateAccessId ?? (() => crypto.randomUUID());
  }

  async generate(rawRunId: string): Promise<Case8AuditReport> {
    if (!ID_PATTERN.test(rawRunId)) throw new Case8AuditReportError('invalid_request');
    const requestedAt = this.now();
    if (!Number.isFinite(requestedAt.getTime())) {
      throw new Case8AuditReportError('invalid_request');
    }
    const started = this.monotonicNow();
    const subject = await this.db.prepare(
      `SELECT tasks.task_id, tasks.source_system, tasks.tenant_key,
              tasks.source_task_key, tasks.task_revision, tasks.source_url,
              tasks.task_digest, tasks.actor_type, tasks.actor_id,
              tasks.target_repository, tasks.target_base_branch,
              tasks.target_environment, tasks.allow_repository_write,
              tasks.allow_test_deploy, tasks.allow_production_deploy,
              tasks.require_human_approval, runs.run_id, runs.state AS run_state,
              runs.version AS run_version, runs.base_sha, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              runs.created_at, runs.updated_at
       FROM runs JOIN tasks ON tasks.task_id = runs.task_id
       WHERE runs.run_id = ?`,
    ).bind(rawRunId).first<TaskRunRow>();
    if (subject === null) throw new Case8AuditReportError('not_found');

    const correlationPromise = new CorrelationQueryStore(this.db).resolve({
      kind: 'run',
      id: rawRunId,
    });
    const queryLimit = MAX_ROWS_PER_SECTION + 1;
    const [plansResult, attemptsResult, revisionSourcesResult, effectsResult,
      grantsResult, credentialsResult, headsResult, protectedDiffsResult,
      pullRequestsResult, mergesResult, mergeObservationsResult, commandsResult, itemVerificationsResult,
      evidenceResult, secretArtifactsResult, githubChecksResult, approvalsResult, testDeploymentsResult,
      testDeploymentWebhookResult, testDeploymentApiObservationResult,
      testAcceptancesResult, testAcceptanceObservationResult,
      testRollbackContractResult, testRollbackResult, testRollbackObservationResult,
      productionApprovalsResult, productionDeploymentsResult, productionDeploymentObservationResult,
      replayResult, replayEffectResult,
      replayReconciliationResult, replayOutboxResult, effectOutboxResult,
      baseRebasesResult, baseConflictsResult,
      correlation] = await Promise.all([
      this.db.prepare(
        `SELECT plan_id, plan_version, digest, status, base_sha,
                created_by_attempt_id, created_at
         FROM execution_plans WHERE run_id = ?
         ORDER BY plan_version, plan_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<PlanRow>(),
      this.db.prepare(
        `SELECT attempt_id, ordinal, mode, status, repository, workflow_ref,
                github_run_id, github_status, github_conclusion, plan_id,
                plan_version, plan_item_id, claimed_progress_version,
                base_sha, head_sha, created_at, updated_at
         FROM attempts WHERE run_id = ? ORDER BY ordinal, attempt_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<AttemptRow>(),
      this.db.prepare(
        `SELECT source_kind, source_ref, source_digest, prior_plan_id,
                prior_plan_version, prior_plan_digest, requested_base_sha, observed_at
         FROM plan_revision_source_facts WHERE run_id = ?
         ORDER BY observed_at, source_ref LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<RevisionSourceRow>(),
      this.db.prepare(
        `SELECT plans.plan_id, plans.plan_version, plans.digest AS plan_digest,
                effects.item_id, effects.effect
         FROM execution_plans AS plans
         JOIN plan_item_effects AS effects ON effects.plan_id = plans.plan_id
         WHERE plans.run_id = ?
         ORDER BY plans.plan_version, effects.item_id, effects.effect LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<EffectRow>(),
      this.db.prepare(
        `SELECT tokens.token_id, tokens.attempt_id, tokens.lease_generation,
                tokens.scopes_json, tokens.expires_at, tokens.revoked_at
         FROM attempt_tokens AS tokens
         JOIN attempts ON attempts.attempt_id = tokens.attempt_id
         WHERE attempts.run_id = ?
         ORDER BY attempts.ordinal, tokens.lease_generation LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<GrantRow>(),
      this.db.prepare(
        `SELECT credential_id, attempt_id, plan_id, plan_version, plan_item_id,
                approval_id, repository, lease_generation, status,
                authorization_expires_at, revoked_at, created_at
         FROM github_write_credentials WHERE run_id = ?
         ORDER BY created_at, credential_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<CredentialRow>(),
      this.db.prepare(
        `SELECT update_id, evidence_id, attempt_id, plan_id, plan_version,
                plan_item_id, parent_sha, head_sha, branch, created_at
         FROM attempt_head_updates WHERE run_id = ?
         ORDER BY created_at, update_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<HeadUpdateRow>(),
      this.db.prepare(
        `SELECT gate_id, attempt_id, plan_id, plan_version, plan_item_id, base_sha,
                staged_tree_sha, delivery_policy_digest, diff_digest,
                total_changed_files, protected_change_count, status, created_at
         FROM protected_path_change_gates WHERE run_id = ?
         ORDER BY created_at, gate_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ProtectedDiffRow>(),
      this.db.prepare(
        `SELECT publication_id, approval_id, repository, base_branch, head_branch,
                head_sha, body_digest, status, github_pr_number, github_pr_url,
                evidence_id, created_at
         FROM pull_request_publications WHERE run_id = ?
         ORDER BY created_at, publication_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<PullRequestRow>(),
      this.db.prepare(
        `SELECT merge_id, publication_id, plan_id, plan_version, plan_digest,
                repository, github_pr_number, head_sha, base_sha, merge_sha,
                merged_by_login, merged_at, deployment_disposition, evidence_id
         FROM github_merges WHERE run_id = ? ORDER BY created_at, merge_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<MergeRow>(),
      this.db.prepare(
        `SELECT observation_id, source_kind, fact_digest, repository,
                github_pr_number, merge_id, processing_state, ignore_reason,
                external_updated_at, observed_at, processed_at
         FROM github_merge_observations WHERE repository = ?
           AND github_pr_number IN (
             SELECT github_pr_number FROM github_merges WHERE run_id = ?
             UNION
             SELECT github_pr_number FROM pull_request_publications WHERE run_id = ?
           )
         ORDER BY observed_at, observation_id LIMIT ?`,
      ).bind(subject.target_repository, rawRunId, rawRunId, queryLimit)
        .all<MergeObservationRow>(),
      this.db.prepare(
        `SELECT suites.suite_id, suites.attempt_id, suites.plan_id,
                suites.plan_version, suites.plan_item_id, suites.head_sha,
                suites.delivery_policy_digest, suites.status AS suite_status,
                commands.position, commands.phase, commands.command_ref,
                commands.result_status, commands.evidence_id, commands.updated_at
         FROM verification_suites AS suites
         JOIN verification_suite_commands AS commands ON commands.suite_id = suites.suite_id
         WHERE suites.run_id = ?
         ORDER BY suites.created_at, suites.suite_id, commands.position LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<CommandRow>(),
      this.db.prepare(
        `SELECT verification_id, plan_id, plan_version, plan_item_id, attempt_id,
                head_sha, evidence_set_digest, status, created_at
         FROM plan_item_verifications WHERE run_id = ?
         ORDER BY created_at, verification_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ItemVerificationRow>(),
      this.db.prepare(
        `SELECT evidence_id, attempt_id, plan_id, plan_version, plan_item_id,
                kind, status, command_ref, exit_code, duration_ms, sha,
                external_url, artifact_digest, verification_status, observed_at
         FROM evidence WHERE run_id = ?
         ORDER BY observed_at, evidence_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<EvidenceRow>(),
      this.db.prepare(
        `SELECT artifacts.object_id, uploads.attempt_id, artifacts.category,
                artifacts.ciphertext_digest, artifacts.size_bytes,
                artifacts.policy_version, artifacts.created_at,
                artifacts.expires_at, artifacts.deletion_state
         FROM raw_agent_artifacts AS artifacts
         JOIN raw_agent_artifact_uploads AS uploads
           ON uploads.upload_id = artifacts.object_id
         JOIN attempts ON attempts.attempt_id = uploads.attempt_id
         WHERE attempts.run_id = ?
         ORDER BY artifacts.created_at, artifacts.object_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<SecretArtifactRow>(),
      this.db.prepare(
        `SELECT observations.observation_id, observations.fact_digest,
                observations.policy_digest, observations.checks_digest,
                observations.reviews_digest, checks.context, checks.integration_id,
                checks.state, observations.observed_at
         FROM github_merge_gate_observations AS observations
         JOIN github_merge_gate_required_checks AS checks
           ON checks.observation_id = observations.observation_id
         WHERE observations.run_id = ?
         ORDER BY observations.observed_at, observations.observation_id,
                  checks.position LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<GitHubCheckRow>(),
      this.db.prepare(
        `SELECT approvals.approval_id, runs.task_id, approvals.task_revision,
                approvals.plan_id, approvals.plan_version,
                approvals.plan_digest, approvals.base_sha, approvals.effect,
                approvals.actor_id, approvals.decision, approvals.expires_at,
                approvals.created_at,
                COALESCE(lineages.approver_principal, bindings.approver_principal)
                  AS approver_principal,
                COALESCE(lineages.roles_digest, bindings.roles_digest) AS roles_digest,
                COALESCE(lineages.separation_verified, bindings.separation_verified)
                  AS separation_verified,
                lineages.provider, lineages.external_event_id,
                lineages.external_event_digest AS event_digest,
                lineages.source_occurred_at AS occurred_at,
                lineages.lineage_id, lineages.source_id,
                lineages.card_action_receipt_id, lineages.decision_recorded_at,
                invalidated.approval_id AS invalidated_approval_id
         FROM approvals
         JOIN runs ON runs.run_id = approvals.run_id
         LEFT JOIN approval_lineages AS lineages
           ON lineages.approval_id = approvals.approval_id
         LEFT JOIN identity_bound_approvals AS bindings
           ON bindings.approval_id = approvals.approval_id
         LEFT JOIN invalidated_approvals AS invalidated
           ON invalidated.approval_id = approvals.approval_id
         WHERE approvals.run_id = ?
         ORDER BY approvals.created_at, approvals.approval_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ApprovalRow>(),
      this.db.prepare(
        `SELECT test_deployments.deployment_id, test_deployments.run_version,
                test_deployments.plan_id,
                test_deployments.plan_version, test_deployments.plan_digest,
                test_deployments.plan_item_id, test_deployments.attempt_id,
                test_deployments.approval_id, test_deployments.repository,
                test_deployments.environment, test_deployments.role_ref,
                test_deployments.status, test_deployments.ref_sha AS sha,
                test_deployments.github_deployment_id, test_deployments.external_url,
                test_deployments.evidence_id, test_deployments.workflow_path,
                test_deployments.oidc_audience,
                attestations.attestation_id AS oidc_attestation_id,
                attestations.github_run_id AS oidc_github_run_id,
                attestations.subject AS oidc_subject,
                test_deployments.created_at, 'test' AS kind
         FROM test_deployments
         LEFT JOIN test_deployment_oidc_attestations AS attestations
           ON attestations.deployment_id = test_deployments.deployment_id
         WHERE test_deployments.run_id = ?
         ORDER BY test_deployments.created_at, test_deployments.deployment_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<DeploymentRow>(),
      this.db.prepare(
        `SELECT delivery_id AS observation_id, 'webhook' AS source_kind,
                payload_digest AS fact_digest, deployment_id, processing_state,
                ignore_reason, external_updated_at, received_at AS observed_at,
                processed_at
         FROM github_test_deployment_webhook_deliveries
         WHERE deployment_id IN (SELECT deployment_id FROM test_deployments WHERE run_id = ?)
         ORDER BY received_at, delivery_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestDeploymentObservationRow>(),
      this.db.prepare(
        `SELECT observations.observation_id, 'api' AS source_kind,
                observations.fact_digest, observations.deployment_id,
                observations.processing_state, observations.ignore_reason,
                observations.external_updated_at, observations.observed_at,
                observations.processed_at
         FROM github_test_deployment_status_observations AS observations
         JOIN test_deployments AS deployments
           ON deployments.deployment_id = observations.deployment_id
         WHERE deployments.run_id = ?
         ORDER BY observations.observed_at, observations.observation_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestDeploymentObservationRow>(),
      this.db.prepare(
        `SELECT acceptances.acceptance_id, acceptances.deployment_id,
                acceptances.run_version, acceptances.plan_id,
                acceptances.plan_version, acceptances.plan_digest,
                acceptances.plan_item_id, acceptances.attempt_id,
                deployments.approval_id, acceptances.repository,
                acceptances.environment, acceptances.workflow_path,
                acceptances.oidc_audience, acceptances.command_ref,
                acceptances.environment_url, acceptances.status,
                acceptances.ref_sha, acceptances.github_run_id,
                acceptances.runner_result_digest, acceptances.runner_status,
                acceptances.runner_exit_code, acceptances.runner_duration_ms,
                acceptances.external_state, acceptances.external_conclusion,
                acceptances.external_updated_at, acceptances.evidence_id,
                attestations.attestation_id AS oidc_attestation_id,
                attestations.github_run_id AS oidc_github_run_id,
                attestations.subject AS oidc_subject,
                acceptances.created_at
         FROM test_acceptances AS acceptances
         JOIN test_deployments AS deployments
           ON deployments.deployment_id = acceptances.deployment_id
         LEFT JOIN test_acceptance_oidc_attestations AS attestations
           ON attestations.acceptance_id = acceptances.acceptance_id
         WHERE acceptances.run_id = ?
         ORDER BY acceptances.created_at, acceptances.acceptance_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestAcceptanceRow>(),
      this.db.prepare(
        `SELECT observation_id, source_kind, fact_digest, acceptance_id,
                github_run_id, processing_state, ignore_reason,
                external_updated_at, observed_at, processed_at
         FROM github_test_acceptance_observations
         WHERE acceptance_id IN (SELECT acceptance_id FROM test_acceptances WHERE run_id = ?)
         ORDER BY observed_at, observation_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestAcceptanceObservationRow>(),
      this.db.prepare(
        `SELECT observation_id, source_kind, source_id, source_evidence_id,
                repository, ref_sha, disposition, policy_digest, contract_digest,
                workflow_path, environment, oidc_audience, role_ref, observed_at
         FROM test_rollback_contract_observations
         WHERE source_evidence_id IN (SELECT evidence_id FROM evidence WHERE run_id = ?)
         ORDER BY observed_at, observation_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestRollbackContractObservationRow>(),
      this.db.prepare(
        `SELECT rollbacks.rollback_id, rollbacks.source_kind, rollbacks.source_id,
                rollbacks.source_evidence_id, rollbacks.failed_attempt_id,
                rollbacks.deployment_id, rollbacks.approval_id,
                rollbacks.contract_observation_id, rollbacks.run_version,
                rollbacks.plan_id, rollbacks.plan_version, rollbacks.plan_digest,
                rollbacks.plan_item_id, rollbacks.attempt_id, rollbacks.repository,
                rollbacks.base_branch, rollbacks.base_sha, rollbacks.ref_sha,
                rollbacks.policy_digest, rollbacks.contract_digest,
                rollbacks.workflow_path, rollbacks.environment,
                rollbacks.oidc_audience, rollbacks.role_ref, rollbacks.status,
                rollbacks.github_run_id, rollbacks.runner_result_digest,
                rollbacks.runner_status, rollbacks.runner_exit_code,
                rollbacks.runner_duration_ms, rollbacks.external_state,
                rollbacks.external_conclusion, rollbacks.external_updated_at,
                rollbacks.evidence_id,
                attestations.attestation_id AS oidc_attestation_id,
                attestations.github_run_id AS oidc_github_run_id,
                attestations.workflow_ref AS oidc_workflow_ref,
                attestations.subject AS oidc_subject,
                rollbacks.created_at
         FROM test_rollbacks AS rollbacks
         LEFT JOIN test_rollback_oidc_attestations AS attestations
           ON attestations.rollback_id = rollbacks.rollback_id
         WHERE rollbacks.run_id = ?
         ORDER BY rollbacks.created_at, rollbacks.rollback_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestRollbackAuditRow>(),
      this.db.prepare(
        `SELECT observations.observation_id, observations.source_kind,
                observations.fact_digest, observations.rollback_id,
                observations.github_run_id, observations.processing_state,
                observations.ignore_reason, observations.external_updated_at,
                observations.observed_at, observations.processed_at
         FROM github_test_rollback_observations AS observations
         JOIN test_rollbacks AS rollbacks
           ON rollbacks.rollback_id = observations.rollback_id
         WHERE rollbacks.run_id = ?
         ORDER BY observations.observed_at, observations.observation_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestRollbackObservationRow>(),
      this.db.prepare(
        `SELECT releases.approval_id, releases.run_id, releases.task_revision,
                releases.plan_id, releases.plan_version, releases.plan_digest,
                approvals.base_sha, releases.merge_id, releases.merge_sha,
                releases.environment, releases.created_at AS binding_created_at,
                approvals.decision, approvals.expires_at,
                approvals.created_at AS approval_created_at,
                lineages.source_id, lineages.provider, lineages.tenant_key,
                lineages.external_event_id, lineages.external_event_digest AS event_digest,
                lineages.approver_principal, lineages.roles_digest,
                lineages.separation_verified, lineages.source_occurred_at,
                lineages.decision_recorded_at,
                source_events.channel, source_events.channel_user_id
         FROM production_release_approval_bindings AS releases
         JOIN approvals ON approvals.approval_id = releases.approval_id
         LEFT JOIN approval_lineages AS lineages
           ON lineages.approval_id = releases.approval_id
         LEFT JOIN approval_source_events AS source_events
           ON source_events.source_id = COALESCE(lineages.source_id, '')
         WHERE releases.run_id = ?
         ORDER BY releases.created_at, releases.approval_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ProductionApprovalAuditRow>(),
      this.db.prepare(
        `SELECT production_deployments.deployment_id, production_deployments.run_version,
                production_deployments.plan_id, production_deployments.plan_version,
                production_deployments.plan_digest, NULL AS plan_item_id,
                production_deployments.attempt_id, production_deployments.approval_id,
                production_deployments.repository, production_deployments.environment,
                production_deployments.role_ref, production_deployments.status,
                production_deployments.merge_sha AS sha,
                production_deployments.github_deployment_id,
                production_deployments.external_state, production_deployments.external_updated_at,
                production_deployments.external_url, production_deployments.evidence_id,
                production_deployments.created_at, production_deployments.workflow_path,
                production_deployments.oidc_audience,
                attestations.attestation_id AS oidc_attestation_id,
                attestations.github_run_id AS oidc_github_run_id,
                attestations.subject AS oidc_subject,
                'production' AS kind
         FROM production_deployments
         LEFT JOIN production_deployment_oidc_attestations AS attestations
           ON attestations.deployment_id = production_deployments.deployment_id
         WHERE production_deployments.run_id = ?
         ORDER BY production_deployments.created_at, production_deployments.deployment_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<DeploymentRow>(),
      this.db.prepare(
        `SELECT observations.observation_id, observations.source_kind,
                observations.fact_digest, observations.deployment_id,
                observations.processing_state, observations.ignore_reason,
                observations.external_updated_at, observations.observed_at,
                observations.processed_at
         FROM production_deployment_status_observations AS observations
         JOIN production_deployments AS deployments
           ON deployments.deployment_id = observations.deployment_id
         WHERE deployments.run_id = ?
         ORDER BY observations.observed_at, observations.observation_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<TestDeploymentObservationRow>(),
      this.db.prepare(
        `SELECT replay_id, expected_run_version, plan_id, plan_version,
                plan_item_id, target_kind, target_step_name, target_step_type,
                target_step_count, reason_digest, effect_snapshot_digest,
                restart_observed_at, created_at, updated_at
         FROM workflow_replays WHERE run_id = ?
         ORDER BY created_at, replay_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ReplayRow>(),
      this.db.prepare(
        `SELECT effects.replay_id, effects.effect, effects.approval_id
         FROM workflow_replay_effects AS effects
         JOIN workflow_replays AS replays ON replays.replay_id = effects.replay_id
         WHERE replays.run_id = ?
         ORDER BY effects.replay_id, effects.effect LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ReplayEffectRow>(),
      this.db.prepare(
        `SELECT reconciliations.replay_id, reconciliations.source_kind,
                reconciliations.source_ref, reconciliations.source_digest,
                outboxes.outbox_id, outboxes.kind AS outbox_kind,
                outboxes.dedupe_key AS outbox_dedupe_key,
                outboxes.delivery_state AS outbox_delivery_state,
                evidence.evidence_id, evidence.kind AS evidence_kind,
                evidence.status AS evidence_status,
                evidence.verification_status AS evidence_verification_status,
                evidence.sha AS evidence_sha,
                evidence.artifact_digest AS evidence_artifact_digest,
                evidence.external_url AS evidence_external_url
         FROM workflow_replay_reconciliations AS reconciliations
         JOIN workflow_replays AS replays
           ON replays.replay_id = reconciliations.replay_id
         LEFT JOIN outbox AS outboxes
           ON reconciliations.source_kind = 'outbox'
          AND reconciliations.source_ref = 'd1://outbox/' || outboxes.outbox_id
         LEFT JOIN evidence
           ON reconciliations.source_kind = 'evidence'
          AND reconciliations.source_ref = 'd1://evidence/' || evidence.evidence_id
         WHERE replays.run_id = ?
         ORDER BY reconciliations.replay_id, reconciliations.source_kind,
                  reconciliations.source_ref LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ReplayReconciliationRow>(),
      this.db.prepare(
        `SELECT outbox_id, payload_ref, delivery_state, attempt_count, last_error_code
         FROM outbox WHERE run_id = ? AND kind = 'workflow_replay'
         ORDER BY created_at, outbox_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<ReplayOutboxRow>(),
      this.db.prepare(
        `SELECT outbox_id, kind, delivery_state, last_error_code, created_at
         FROM outbox WHERE run_id = ?
           AND (kind LIKE '%dispatch%' OR kind IN (
             'workflow_cancel', 'pull_request', 'test_deploy', 'merge', 'production_deploy'
           ))
         ORDER BY outbox_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<EffectOutboxRow>(),
      this.db.prepare(
        `SELECT rebase.rebase_id, rebase.revision_id,
                rebase.source_plan_id, rebase.source_plan_version,
                rebase.target_plan_id, rebase.target_plan_version,
                rebase.plan_item_id, rebase.source_attempt_id,
                rebase.rebase_attempt_id, rebase.old_base_sha,
                rebase.new_base_sha, rebase.source_branch,
                rebase.source_head_sha, rebase.target_branch,
                rebase.status, rebase.result_head_sha,
                rebase.verification_suite_id, rebase.blocker_reason,
                attempts.status AS attempt_status, attempts.mode AS attempt_mode,
                attempts.github_run_id AS attempt_github_run_id,
                attempts.github_status AS attempt_github_status,
                attempts.github_conclusion AS attempt_github_conclusion,
                attempts.head_branch AS attempt_head_branch,
                attempts.head_sha AS attempt_head_sha,
                progress.status AS progress_status,
                dispatch.outbox_id AS dispatch_outbox_id,
                dispatch.delivery_state AS dispatch_outbox_state,
                rebase.created_at, rebase.completed_at
         FROM base_rebase_attempts AS rebase
         JOIN attempts ON attempts.attempt_id = rebase.rebase_attempt_id
         JOIN plan_item_progress AS progress
           ON progress.plan_id = rebase.target_plan_id
          AND progress.item_id = rebase.plan_item_id
         LEFT JOIN outbox AS dispatch
           ON dispatch.run_id = rebase.run_id
          AND dispatch.kind = 'execution_dispatch'
          AND dispatch.payload_ref = 'd1://attempts/' || rebase.rebase_attempt_id
         WHERE rebase.run_id = ?
         ORDER BY rebase.created_at, rebase.rebase_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<BaseRebaseAuditRow>(),
      this.db.prepare(
        `SELECT conflicts.conflict_id, conflicts.expected_run_version,
                conflicts.prior_plan_id, conflicts.prior_plan_version,
                conflicts.prior_plan_digest, conflicts.repository,
                conflicts.base_branch, conflicts.before_sha, conflicts.after_sha,
                conflicts.relationship, conflicts.ahead_by, conflicts.behind_by,
                conflicts.merge_base_sha, conflicts.reference_digest,
                conflicts.comparison_digest, conflicts.source_digest,
                conflicts.blocker_reason, conflicts.needed_human_input,
                runs.state AS run_state, runs.version AS run_version,
                plans.status AS plan_status,
                cancel.outbox_id AS cancel_outbox_id,
                cancel.delivery_state AS cancel_outbox_state,
                conflicts.created_at, conflicts.observed_at
         FROM github_base_conflicts AS conflicts
         JOIN runs ON runs.run_id = conflicts.run_id
         JOIN execution_plans AS plans ON plans.plan_id = conflicts.prior_plan_id
         LEFT JOIN outbox AS cancel
           ON cancel.run_id = conflicts.run_id
          AND cancel.kind = 'workflow_cancel'
          AND cancel.dedupe_key = 'workflow-cancel:' || conflicts.run_id
         WHERE conflicts.run_id = ?
         ORDER BY conflicts.created_at, conflicts.conflict_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<BaseConflictAuditRow>(),
      correlationPromise,
    ]);
    const [githubWebhookRunResult, githubApiRunResult] = await Promise.all([
      this.db.prepare(
        `SELECT deliveries.delivery_id AS source_id,
                deliveries.payload_digest AS source_digest,
                deliveries.repository, deliveries.github_run_id,
                deliveries.attempt_id, deliveries.processing_state,
                deliveries.ignore_reason, deliveries.external_updated_at,
                deliveries.received_at AS observed_at, deliveries.processed_at
         FROM github_webhook_deliveries AS deliveries
         JOIN attempts ON attempts.attempt_id = deliveries.attempt_id
         WHERE attempts.run_id = ?
         ORDER BY deliveries.received_at, deliveries.delivery_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<GitHubWebhookRunObservationRow>(),
      this.db.prepare(
        `SELECT observations.observation_id AS source_id,
                observations.fact_digest AS source_digest,
                observations.repository, observations.github_run_id,
                observations.attempt_id, observations.processing_state,
                observations.ignore_reason, observations.external_updated_at,
                observations.observed_at, observations.processed_at
         FROM github_api_observations AS observations
         JOIN attempts ON attempts.attempt_id = observations.attempt_id
         WHERE attempts.run_id = ?
         ORDER BY observations.observed_at, observations.observation_id LIMIT ?`,
      ).bind(rawRunId, queryLimit).all<GitHubApiRunObservationRow>(),
    ]);
    const identityApprovalsResult = await this.db.prepare(
      `SELECT sources.source_id, sources.provider, sources.tenant_key,
              sources.external_event_id, sources.event_digest, sources.channel,
              sources.channel_user_id, sources.occurred_at AS source_occurred_at,
              'accepted' AS outcome, approvals.approval_id,
              lineages.lineage_id, NULL AS rejection_id, NULL AS reason,
              approvals.run_id, approvals.task_revision, approvals.plan_id,
              approvals.plan_version, approvals.plan_digest, approvals.base_sha,
              approvals.effect, approvals.decision,
              bindings.approver_principal,
              bindings.approver_channel,
              bindings.approver_channel_user_id,
              bindings.pull_request_author_principal AS author_principal,
              bindings.pull_request_author_channel AS author_channel,
              bindings.pull_request_author_login AS author_login,
              bindings.roles_digest, bindings.separation_verified,
              approvals.expires_at,
              approvals.created_at AS decision_recorded_at
       FROM approval_source_events AS sources
       JOIN identity_bound_approvals AS bindings
         ON bindings.source_id = sources.source_id
       JOIN approvals ON approvals.approval_id = bindings.approval_id
       LEFT JOIN approval_lineages AS lineages
         ON lineages.approval_id = approvals.approval_id
       WHERE approvals.run_id = ?
       UNION ALL
       SELECT sources.source_id, sources.provider, sources.tenant_key,
              sources.external_event_id, sources.event_digest, sources.channel,
              sources.channel_user_id, sources.occurred_at AS source_occurred_at,
              'rejected' AS outcome, NULL AS approval_id,
              NULL AS lineage_id, rejections.rejection_id, rejections.reason,
              rejections.run_id, tasks.task_revision,
              rejections.plan_id, rejections.plan_version, plans.digest,
              runs.base_sha, rejections.effect, rejections.decision,
              rejections.approver_principal,
              rejections.approver_channel,
              rejections.approver_channel_user_id,
              rejections.author_principal,
              rejections.author_channel,
              rejections.author_login,
              rejections.roles_digest,
              rejections.separation_verified,
              NULL AS expires_at,
              rejections.rejected_at
       FROM approval_identity_rejections AS rejections
       JOIN approval_source_events AS sources
         ON sources.source_id = rejections.source_id
       JOIN runs ON runs.run_id = rejections.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = rejections.plan_id
       WHERE rejections.run_id = ?
       ORDER BY source_occurred_at LIMIT ?`,
    ).bind(rawRunId, rawRunId, queryLimit).all<IdentityApprovalAuditRow>();
    const pullRequestObservationsResult = await this.db.prepare(
      `SELECT 'webhook' AS source_kind, deliveries.delivery_id AS source_id,
              deliveries.publication_id, deliveries.repository,
              deliveries.github_pr_number, deliveries.payload_digest AS fact_digest,
              deliveries.processing_state, deliveries.ignore_reason,
              deliveries.external_updated_at, deliveries.received_at AS observed_at,
              deliveries.processed_at
       FROM github_pull_request_webhook_deliveries AS deliveries
       JOIN pull_request_publications AS publications
         ON publications.publication_id = deliveries.publication_id
       WHERE publications.run_id = ?
       UNION ALL
       SELECT 'api' AS source_kind, observations.observation_id AS source_id,
              observations.publication_id, observations.repository,
              observations.github_pr_number, observations.fact_digest,
              observations.processing_state, observations.ignore_reason,
              observations.external_updated_at, observations.observed_at,
              observations.processed_at
       FROM github_pull_request_api_observations AS observations
       JOIN pull_request_publications AS publications
         ON publications.publication_id = observations.publication_id
       WHERE publications.run_id = ?
       ORDER BY observed_at, source_id LIMIT ?`,
    ).bind(rawRunId, rawRunId, queryLimit).all<PullRequestObservationRow>();
    const reviewObservationsResult = await this.db.prepare(
      `SELECT 'webhook' AS source_kind, deliveries.delivery_id AS source_id,
              deliveries.publication_id, deliveries.repository,
              deliveries.github_pr_number, deliveries.github_review_id,
              deliveries.reviewed_head_sha,
              deliveries.payload_digest AS fact_digest,
              deliveries.processing_state, deliveries.ignore_reason,
              deliveries.received_at AS observed_at, deliveries.processed_at,
              feedback.feedback_id, feedback.prior_attempt_id,
              lineage.review_attempt_id, feedback.source_head_sha,
              feedback.branch, feedback.review_url, feedback.submitted_at,
              feedback.body_digest
       FROM github_review_webhook_deliveries AS deliveries
       JOIN pull_request_publications AS publications
         ON publications.publication_id = deliveries.publication_id
       LEFT JOIN github_review_feedbacks AS feedback
         ON feedback.source_delivery_id = deliveries.delivery_id
       LEFT JOIN review_feedback_attempts AS lineage
         ON lineage.feedback_id = feedback.feedback_id
       WHERE publications.run_id = ?
       ORDER BY observed_at, source_id LIMIT ?`,
    ).bind(rawRunId, queryLimit).all<ReviewObservationRow>();
    const planRevisionsResult = await this.db.prepare(
      `SELECT revisions.revision_id, revisions.expected_run_version,
              revisions.status AS revision_status,
              revisions.source_kind, revisions.source_digest,
              source.observed_at AS source_observed_at,
              revisions.requested_base_sha,
              COALESCE(
                (SELECT retry.retry_attempt_id
                 FROM plan_revision_analysis_retries AS retry
                 WHERE retry.revision_id = revisions.revision_id
                 ORDER BY retry.retry_sequence DESC LIMIT 1),
                revisions.analysis_attempt_id
              ) AS analysis_attempt_id,
              revisions.prior_plan_id, revisions.prior_plan_version,
              revisions.prior_plan_digest,
              prior.base_sha AS prior_plan_base_sha,
              prior.status AS prior_plan_status,
              revisions.new_plan_id, revisions.new_plan_version,
              revisions.new_plan_digest,
              replacement.base_sha AS new_plan_base_sha,
              replacement.status AS new_plan_status,
              revisions.body_changed, revisions.base_changed,
              revisions.effects_changed, revisions.activated_at,
              revisions.created_at,
              COALESCE(base.observation_id, feedback.feedback_id, automated.review_id,
                       supplemental.context_id) AS source_record_id,
              base.repository AS base_repository,
              base.base_branch, base.before_sha AS base_before_sha,
              base.after_sha AS base_after_sha, base.ahead_by AS base_ahead_by,
              base.reference_digest AS base_reference_digest,
              base.comparison_digest AS base_comparison_digest,
              CASE WHEN feedback.feedback_id IS NOT NULL THEN 'github'
                   WHEN automated.review_id IS NOT NULL THEN 'automated'
                   ELSE NULL END AS review_source_type,
              COALESCE(feedback.source_delivery_id,
                       automated.review_attempt_id) AS review_delivery_id,
              COALESCE(feedback.repository,
                       automated.repository) AS review_repository,
              COALESCE(feedback.github_pr_number,
                       automated.github_pr_number) AS review_pr_number,
              COALESCE(feedback.github_review_id,
                       automated.review_id) AS review_id,
              COALESCE(feedback.body_digest,
                       automated.feedback_body_digest) AS review_body_digest,
              automated.result_digest AS review_result_digest,
              COALESCE(feedback.source_head_sha,
                       automated.source_head_sha) AS review_head_sha,
              COALESCE(feedback.branch, automated.branch) AS review_branch,
              COALESCE(feedback.review_url,
                       automated_publication.github_pr_url) AS review_url,
              COALESCE(feedback.submitted_at,
                       automated.completed_at) AS review_submitted_at,
              supplemental.event_digest AS context_event_digest,
              supplemental.context_digest,
              next_task.source_system AS context_source_system,
              next_task.tenant_key AS context_tenant_key,
              next_task.source_task_key AS context_source_task_key,
              supplemental.prior_task_id AS context_prior_task_id,
              supplemental.prior_task_revision AS context_prior_task_revision,
              supplemental.new_task_id AS context_new_task_id,
              supplemental.new_task_revision AS context_new_task_revision,
              supplemental.new_task_digest AS context_new_task_digest,
              supplemental.new_run_id AS context_new_run_id,
              supplemental.applied_run_id AS context_applied_run_id
       FROM plan_revisions AS revisions
       JOIN plan_revision_source_facts AS source
         ON source.source_ref = revisions.source_ref
        AND source.run_id = revisions.run_id
        AND source.source_kind = revisions.source_kind
        AND source.source_digest = revisions.source_digest
       JOIN execution_plans AS prior
         ON prior.plan_id = revisions.prior_plan_id
       LEFT JOIN execution_plans AS replacement
         ON replacement.plan_id = revisions.new_plan_id
       LEFT JOIN github_base_observations AS base
         ON revisions.source_kind = 'base_update'
        AND source.source_ref = 'd1://github-base-observations/' || base.observation_id
       LEFT JOIN github_review_feedbacks AS feedback
         ON revisions.source_kind = 'review_feedback'
        AND source.source_ref = 'd1://github-review-feedbacks/' || feedback.feedback_id
       LEFT JOIN automated_reviews AS automated
         ON revisions.source_kind = 'review_feedback'
        AND source.source_ref = 'd1://automated-reviews/' || automated.review_id
       LEFT JOIN pull_request_publications AS automated_publication
         ON automated_publication.publication_id = automated.publication_id
       LEFT JOIN supplemental_context_revisions AS supplemental
         ON revisions.source_kind = 'supplemental_context'
        AND source.source_ref = supplemental.context_ref
       LEFT JOIN tasks AS next_task
         ON next_task.task_id = supplemental.new_task_id
       WHERE revisions.run_id = ?
       ORDER BY revisions.created_at, revisions.revision_id LIMIT ?`,
    ).bind(rawRunId, queryLimit).all<PlanRevisionAuditRow>();
    const mergeGatesResult = await this.db.prepare(
      `SELECT observations.observation_id, observations.run_version,
              observations.publication_id, observations.fact_digest,
              observations.repository, observations.github_pr_number,
              observations.head_branch, observations.head_sha,
              observations.base_branch, observations.base_sha,
              observations.pull_request_base_sha,
              observations.pull_request_author_login,
              observations.pull_request_state, observations.is_draft,
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
              observations.observed_at,
              evaluations.evaluation_id, evaluations.status AS evaluation_status,
              evaluations.rejection_reason, evaluations.approval_id AS evaluation_approval_id,
              evaluations.created_at AS evaluation_created_at,
              decisions.decision_id, decisions.status AS decision_status,
              decisions.approval_id AS decision_approval_id,
              decisions.head_sha AS decision_head_sha,
              decisions.base_sha AS decision_base_sha
       FROM github_merge_gate_observations AS observations
       JOIN merge_gate_evaluations AS evaluations
         ON evaluations.observation_id = observations.observation_id
        AND evaluations.run_id = observations.run_id
       LEFT JOIN merge_gate_decisions AS decisions
         ON decisions.evaluation_id = evaluations.evaluation_id
       WHERE observations.run_id = ?
       ORDER BY evaluations.created_at, evaluations.evaluation_id LIMIT ?`,
    ).bind(rawRunId, queryLimit).all<MergeGateAuditRow>();
    if (correlation === null) throw new Case8AuditReportError('projection_conflict');

    const plans = rows(plansResult);
    const attempts = rows(attemptsResult);
    const revisionSources = rows(revisionSourcesResult);
    const effects = rows(effectsResult);
    const grants = rows(grantsResult);
    const credentials = rows(credentialsResult);
    const githubWebhookRunObservations = rows(githubWebhookRunResult);
    const githubApiRunObservations = rows(githubApiRunResult);
    const githubRunObservationIdentities = new Set<string>();
    for (const [sourceKind, observations] of [
      ['webhook', githubWebhookRunObservations],
      ['api', githubApiRunObservations],
    ] as const) {
      for (const observation of observations) {
        const identity = `${sourceKind}:${observation.source_id}`;
        const externalUpdatedAt = Date.parse(observation.external_updated_at);
        const observedAt = Date.parse(observation.observed_at);
        const processedAt = observation.processed_at === null
          ? null : Date.parse(observation.processed_at);
        if (
          !ID_PATTERN.test(observation.source_id) ||
          !DIGEST_PATTERN.test(observation.source_digest) ||
          !REPOSITORY_PATTERN.test(observation.repository) ||
          !/^[0-9]{1,32}$/.test(observation.github_run_id) ||
          !ID_PATTERN.test(observation.attempt_id) ||
          !['received', 'applied', 'ignored'].includes(observation.processing_state) ||
          (observation.processing_state === 'applied' && observation.ignore_reason !== null) ||
          (observation.processing_state === 'ignored' &&
            (observation.ignore_reason === null ||
              !IGNORE_REASON_PATTERN.test(observation.ignore_reason))) ||
          !Number.isFinite(externalUpdatedAt) || !Number.isFinite(observedAt) ||
          externalUpdatedAt > observedAt ||
          (observation.processing_state === 'received' && processedAt !== null) ||
          (observation.processing_state !== 'received' &&
            (processedAt === null || !Number.isFinite(processedAt) || observedAt > processedAt)) ||
          githubRunObservationIdentities.has(identity)
        ) throw new Case8AuditReportError('projection_conflict');
        githubRunObservationIdentities.add(identity);
      }
    }
    const heads = rows(headsResult);
    const protectedDiffs = rows(protectedDiffsResult);
    const pullRequests = rows(pullRequestsResult);
    const merges = rows(mergesResult);
    const mergeObservations = rows(mergeObservationsResult);
    const commands = rows(commandsResult);
    const itemVerifications = rows(itemVerificationsResult);
    const evidence = rows(evidenceResult);
    const githubChecks = rows(githubChecksResult);
    const mergeGateRows = rows(mergeGatesResult);
    const checksByObservation = new Map<string, Array<{
      context: string;
      integrationId: number | null;
      state: 'missing' | 'pending' | 'passed' | 'failed';
    }>>();
    for (const check of githubChecks) {
      if (
        !ID_PATTERN.test(check.observation_id) || !DIGEST_PATTERN.test(check.fact_digest) ||
        !DIGEST_PATTERN.test(check.policy_digest) || !DIGEST_PATTERN.test(check.checks_digest) ||
        !DIGEST_PATTERN.test(check.reviews_digest) || typeof check.context !== 'string' ||
        check.context.length < 1 || check.context.length > 255 || /[\0\r\n]/.test(check.context) ||
        (check.integration_id !== null && (!Number.isSafeInteger(check.integration_id) || check.integration_id <= 0)) ||
        !['missing', 'pending', 'passed', 'failed'].includes(check.state) ||
        !Number.isFinite(Date.parse(check.observed_at))
      ) throw new Case8AuditReportError('projection_conflict');
      const list = checksByObservation.get(check.observation_id) ?? [];
      list.push({
        context: check.context,
        integrationId: check.integration_id,
        state: check.state as 'missing' | 'pending' | 'passed' | 'failed',
      });
      checksByObservation.set(check.observation_id, list);
    }
    const mergeGates: Array<Record<string, unknown>> = [];
    const mergeGateIds = new Set<string>();
    for (const row of mergeGateRows) {
      if (
        !ID_PATTERN.test(row.observation_id) || !ID_PATTERN.test(row.publication_id) ||
        !DIGEST_PATTERN.test(row.fact_digest) || !REPOSITORY_PATTERN.test(row.repository) ||
        !Number.isSafeInteger(row.run_version) || row.run_version < 0 ||
        !Number.isSafeInteger(row.github_pr_number) || row.github_pr_number <= 0 ||
        !BRANCH_PATTERN.test(row.head_branch) || !BRANCH_PATTERN.test(row.base_branch) ||
        row.head_branch.includes('..') || row.head_branch.includes('//') ||
        row.base_branch.includes('..') || row.base_branch.includes('//') ||
        !SHA_PATTERN.test(row.head_sha) || !SHA_PATTERN.test(row.base_sha) ||
        !SHA_PATTERN.test(row.pull_request_base_sha) ||
        (row.pull_request_author_login !== null &&
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(row.pull_request_author_login)) ||
        !['open', 'closed'].includes(row.pull_request_state) || ![0, 1].includes(row.is_draft) ||
        !['mergeable', 'conflicting', 'unknown'].includes(row.mergeability) ||
        !['clean', 'blocked', 'behind', 'dirty', 'draft', 'has_hooks', 'unstable', 'unknown']
          .includes(row.merge_state) ||
        !['approved', 'review_required', 'changes_requested'].includes(row.review_decision) ||
        ![row.required_approval_count, row.approved_review_count, row.required_check_count,
          row.passed_check_count, row.pending_check_count, row.failed_check_count,
          row.missing_check_count].every((count) => Number.isSafeInteger(count) && count >= 0) ||
        row.required_check_count !== row.passed_check_count + row.pending_check_count +
          row.failed_check_count + row.missing_check_count ||
        !DIGEST_PATTERN.test(row.policy_digest) || !DIGEST_PATTERN.test(row.checks_digest) ||
        !DIGEST_PATTERN.test(row.reviews_digest) ||
        !Number.isFinite(Date.parse(row.external_updated_at)) ||
        !Number.isFinite(Date.parse(row.observed_at)) || !ID_PATTERN.test(row.evaluation_id) ||
        !['passed', 'rejected'].includes(row.evaluation_status) ||
        (row.rejection_reason !== null && !/^[a-z][a-z0-9_]{0,99}$/.test(row.rejection_reason)) ||
        (row.evaluation_approval_id !== null && !ID_PATTERN.test(row.evaluation_approval_id)) ||
        !Number.isFinite(Date.parse(row.evaluation_created_at)) ||
        (row.decision_id !== null && !ID_PATTERN.test(row.decision_id)) ||
        (row.decision_status !== null && row.decision_status !== 'passed') ||
        (row.decision_approval_id !== null && !ID_PATTERN.test(row.decision_approval_id)) ||
        (row.decision_head_sha !== null && !SHA_PATTERN.test(row.decision_head_sha)) ||
        (row.decision_base_sha !== null && !SHA_PATTERN.test(row.decision_base_sha)) ||
        mergeGateIds.has(row.evaluation_id)
      ) throw new Case8AuditReportError('projection_conflict');
      const requiredChecks = [...(checksByObservation.get(row.observation_id) ?? [])]
        .sort((left, right) => `${left.context}\0${left.integrationId ?? ''}`.localeCompare(
          `${right.context}\0${right.integrationId ?? ''}`,
        ));
      if (requiredChecks.length !== row.required_check_count) {
        throw new Case8AuditReportError('projection_conflict');
      }
      const factResult = GitHubMergeGateFactSchema.safeParse({
        schemaVersion: '1', repository: row.repository, number: row.github_pr_number,
        pullRequestAuthorLogin: row.pull_request_author_login,
        headBranch: row.head_branch, headSha: row.head_sha, baseBranch: row.base_branch,
        baseSha: row.base_sha, pullRequestBaseSha: row.pull_request_base_sha,
        state: row.pull_request_state, draft: row.is_draft === 1,
        mergeability: row.mergeability, mergeState: row.merge_state,
        reviewDecision: row.review_decision,
        requiredApprovals: row.required_approval_count,
        approvedReviewCount: row.approved_review_count,
        requiredChecks, policyDigest: row.policy_digest,
        checksDigest: row.checks_digest, reviewsDigest: row.reviews_digest,
        externalUpdatedAt: row.external_updated_at,
      });
      if (!factResult.success || await canonicalSha256(factResult.data) !== row.fact_digest) {
        throw new Case8AuditReportError('projection_conflict');
      }
      if (
        (row.evaluation_status === 'passed' &&
          (row.rejection_reason !== null || row.decision_id === null)) ||
        (row.evaluation_status === 'rejected' && row.rejection_reason === null) ||
        (row.decision_id !== null &&
          (row.decision_status !== 'passed' || row.decision_approval_id !== row.evaluation_approval_id ||
            row.decision_head_sha !== row.head_sha || row.decision_base_sha !== row.base_sha))
      ) throw new Case8AuditReportError('projection_conflict');
      mergeGateIds.add(row.evaluation_id);
      mergeGates.push({
        observationId: row.observation_id,
        runVersion: row.run_version,
        publicationId: row.publication_id,
        factDigest: row.fact_digest,
        fact: factResult.data,
        evaluation: {
          evaluationId: row.evaluation_id,
          status: row.evaluation_status,
          rejectionReason: row.rejection_reason,
          approvalId: row.evaluation_approval_id,
          createdAt: row.evaluation_created_at,
        },
        decisionId: row.decision_id,
      });
    }
    const mergeGateObservationIds = new Set(mergeGateRows.map((row) => row.observation_id));
    if (githubChecks.some((check) => !mergeGateObservationIds.has(check.observation_id))) {
      throw new Case8AuditReportError('projection_conflict');
    }
    const mergeObservationIds = new Set<string>();
    const mergeObservationAnswers: Array<Record<string, unknown>> = [];
    for (const observation of mergeObservations) {
      if (
        !ID_PATTERN.test(observation.observation_id) ||
        !['webhook', 'api'].includes(observation.source_kind) ||
        !DIGEST_PATTERN.test(observation.fact_digest) ||
        !REPOSITORY_PATTERN.test(observation.repository) ||
        !Number.isSafeInteger(observation.github_pr_number) || observation.github_pr_number <= 0 ||
        !['received', 'applied', 'ignored'].includes(observation.processing_state) ||
        (observation.ignore_reason !== null && !IGNORE_REASON_PATTERN.test(observation.ignore_reason)) ||
        !Number.isFinite(Date.parse(observation.external_updated_at)) ||
        !Number.isFinite(Date.parse(observation.observed_at)) ||
        (observation.processed_at !== null && !Number.isFinite(Date.parse(observation.processed_at))) ||
        (observation.processing_state === 'received' && observation.processed_at !== null) ||
        (observation.processing_state !== 'received' && observation.processed_at === null) ||
        (observation.processing_state === 'applied' && observation.merge_id === null) ||
        (observation.merge_id !== null && !ID_PATTERN.test(observation.merge_id)) ||
        mergeObservationIds.has(observation.observation_id)
      ) throw new Case8AuditReportError('projection_conflict');
      if (observation.merge_id !== null && !merges.some((merge) => merge.merge_id === observation.merge_id)) {
        throw new Case8AuditReportError('projection_conflict');
      }
      mergeObservationIds.add(observation.observation_id);
      const value: Record<string, unknown> = {
        observationId: observation.observation_id,
        sourceKind: observation.source_kind,
        factDigest: observation.fact_digest,
        repository: observation.repository,
        githubPrNumber: observation.github_pr_number,
        processingState: observation.processing_state,
        externalUpdatedAt: observation.external_updated_at,
        observedAt: observation.observed_at,
      };
      optional(value, 'mergeId', observation.merge_id);
      optional(value, 'ignoreReason', observation.ignore_reason);
      optional(value, 'processedAt', observation.processed_at);
      mergeObservationAnswers.push(value);
    }
    const identityApprovals: Array<Record<string, unknown>> = [];
    const identityApprovalSources = new Set<string>();
    for (const row of rows(identityApprovalsResult)) {
      const safeText = (value: string | null, maximum = 255): boolean =>
        value !== null && value.length > 0 && value.length <= maximum && !/[\0\r\n]/.test(value);
      if (
        !ID_PATTERN.test(row.source_id) || !['github', 'feishu'].includes(row.provider) ||
        !safeText(row.tenant_key, 128) || !safeText(row.external_event_id, 200) ||
        !DIGEST_PATTERN.test(row.event_digest) ||
        !safeText(row.channel, 200) || !safeText(row.channel_user_id, 200) ||
        !Number.isFinite(Date.parse(row.source_occurred_at)) ||
        !['accepted', 'rejected'].includes(row.outcome) ||
        !ID_PATTERN.test(row.run_id) || !safeText(row.task_revision, 255) ||
        !ID_PATTERN.test(row.plan_id) || !Number.isSafeInteger(row.plan_version) ||
        row.plan_version <= 0 || !DIGEST_PATTERN.test(row.plan_digest) ||
        !SHA_PATTERN.test(row.base_sha) ||
        !['repo_write', 'test_deploy', 'merge', 'production_deploy'].includes(row.effect) ||
        !['approve', 'reject'].includes(row.decision) ||
        !Number.isFinite(Date.parse(row.decision_recorded_at)) ||
        identityApprovalSources.has(row.source_id)
      ) throw new Case8AuditReportError('projection_conflict');
      if (row.outcome === 'accepted') {
        if (
          row.approval_id === null || !ID_PATTERN.test(row.approval_id) ||
          row.lineage_id === null || !ID_PATTERN.test(row.lineage_id) ||
          row.rejection_id !== null || row.reason !== null ||
          !safeText(row.approver_principal) || !safeText(row.approver_channel) ||
          !safeText(row.approver_channel_user_id) || !safeText(row.author_principal) ||
          !safeText(row.author_channel) || !safeText(row.author_login, 100) ||
          !DIGEST_PATTERN.test(row.roles_digest ?? '') ||
          (row.effect === 'repo_write'
            ? row.separation_verified !== 0
            : row.separation_verified !== 1) ||
          !Number.isFinite(Date.parse(row.expires_at ?? '')) ||
          row.channel !== row.approver_channel ||
          row.channel_user_id !== row.approver_channel_user_id ||
          row.channel !== `${row.provider}:${row.tenant_key}`
        ) throw new Case8AuditReportError('projection_conflict');
      } else if (
        row.approval_id !== null || row.lineage_id !== null ||
        row.rejection_id === null || !ID_PATTERN.test(row.rejection_id) ||
        !['identity_unresolved', 'actor_not_human', 'actor_not_authorized',
          'self_approval_denied', 'task_actor_self_approval'].includes(row.reason ?? '') ||
        row.expires_at !== null || row.separation_verified !== 0 ||
        !safeText(row.approver_channel) || !safeText(row.approver_channel_user_id) ||
        !safeText(row.author_channel) || !safeText(row.author_login, 100) ||
        !DIGEST_PATTERN.test(row.roles_digest ?? '') ||
        row.channel !== row.approver_channel ||
        row.channel_user_id !== row.approver_channel_user_id ||
        row.channel !== `${row.provider}:${row.tenant_key}` ||
        (row.approver_principal !== null && !safeText(row.approver_principal)) ||
        (row.author_principal !== null && !safeText(row.author_principal))
      ) throw new Case8AuditReportError('projection_conflict');
      identityApprovalSources.add(row.source_id);
      const value: Record<string, unknown> = {
        sourceId: row.source_id,
        provider: row.provider,
        tenantKey: row.tenant_key,
        externalEventId: row.external_event_id,
        eventDigest: row.event_digest,
        channel: row.channel,
        channelUserId: row.channel_user_id,
        sourceOccurredAt: row.source_occurred_at,
        outcome: row.outcome,
        runId: row.run_id,
        taskRevision: row.task_revision,
        planId: row.plan_id,
        planVersion: row.plan_version,
        planDigest: row.plan_digest,
        baseSha: row.base_sha,
        effect: row.effect,
        decision: row.decision,
        decisionRecordedAt: row.decision_recorded_at,
      };
      optional(value, 'approvalId', row.approval_id);
      optional(value, 'lineageId', row.lineage_id);
      optional(value, 'rejectionId', row.rejection_id);
      optional(value, 'reason', row.reason);
      optional(value, 'approverPrincipal', row.approver_principal);
      optional(value, 'approverChannel', row.approver_channel);
      optional(value, 'approverChannelUserId', row.approver_channel_user_id);
      optional(value, 'authorPrincipal', row.author_principal);
      optional(value, 'authorChannel', row.author_channel);
      optional(value, 'authorLogin', row.author_login);
      optional(value, 'rolesDigest', row.roles_digest);
      value.separationVerified = row.separation_verified === 1;
      optional(value, 'expiresAt', row.expires_at);
      identityApprovals.push(value);
    }
    const approvals = rows(approvalsResult);
    const productionApprovals = rows(productionApprovalsResult);
    const productionApprovalIds = new Set<string>();
    const productionApprovalAnswers: Array<Record<string, unknown>> = [];
    for (const row of productionApprovals) {
      const sourceFields = [row.source_id, row.provider, row.tenant_key, row.external_event_id,
        row.event_digest, row.channel, row.channel_user_id, row.approver_principal,
        row.roles_digest, row.source_occurred_at, row.decision_recorded_at];
      if (
        !ID_PATTERN.test(row.approval_id) || !ID_PATTERN.test(row.run_id) ||
        row.run_id !== rawRunId || !ID_PATTERN.test(row.plan_id) ||
        !Number.isSafeInteger(row.plan_version) || row.plan_version <= 0 ||
        !DIGEST_PATTERN.test(row.plan_digest) || !SHA_PATTERN.test(row.base_sha) ||
        !ID_PATTERN.test(row.merge_id) || !SHA_PATTERN.test(row.merge_sha) ||
        row.environment !== 'production' || row.decision !== 'approve' ||
        !Number.isFinite(Date.parse(row.binding_created_at)) ||
        !Number.isFinite(Date.parse(row.approval_created_at)) ||
        !Number.isFinite(Date.parse(row.expires_at)) ||
        Date.parse(row.expires_at) <= Date.parse(row.approval_created_at) ||
        sourceFields.some((value) => value === null || value === undefined) ||
        !['github', 'feishu'].includes(row.provider ?? '') ||
        !ID_PATTERN.test(row.source_id ?? '') || !DIGEST_PATTERN.test(row.event_digest ?? '') ||
        !DIGEST_PATTERN.test(row.roles_digest ?? '') ||
        !Number.isFinite(Date.parse(row.source_occurred_at ?? '')) ||
        !Number.isFinite(Date.parse(row.decision_recorded_at ?? '')) ||
        row.separation_verified !== 1 || productionApprovalIds.has(row.approval_id) ||
        !approvals.some((approval) => approval.approval_id === row.approval_id)
      ) throw new Case8AuditReportError('projection_conflict');
      productionApprovalIds.add(row.approval_id);
      productionApprovalAnswers.push({
        approvalId: row.approval_id,
        runId: row.run_id,
        taskRevision: row.task_revision,
        planId: row.plan_id,
        planVersion: row.plan_version,
        planDigest: row.plan_digest,
        baseSha: row.base_sha,
        mergeId: row.merge_id,
        mergeSha: row.merge_sha,
        environment: row.environment,
        decision: row.decision,
        expiresAt: row.expires_at,
        bindingCreatedAt: row.binding_created_at,
        approvalCreatedAt: row.approval_created_at,
        sourceId: row.source_id,
        provider: row.provider,
        tenantKey: row.tenant_key,
        externalEventId: row.external_event_id,
        eventDigest: row.event_digest,
        channel: row.channel,
        channelUserId: row.channel_user_id,
        approverPrincipal: row.approver_principal,
        rolesDigest: row.roles_digest,
        separationVerified: true,
        sourceOccurredAt: row.source_occurred_at,
        decisionRecordedAt: row.decision_recorded_at,
      });
    }
    const deployments = [...rows(testDeploymentsResult), ...rows(productionDeploymentsResult)]
      .sort((left, right) => left.created_at.localeCompare(right.created_at) ||
        left.deployment_id.localeCompare(right.deployment_id));
    const testDeploymentObservations = [
      ...rows(testDeploymentWebhookResult), ...rows(testDeploymentApiObservationResult),
    ].sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at)) ||
      String(left.observation_id).localeCompare(String(right.observation_id)));
    const productionDeploymentObservations = rows(productionDeploymentObservationResult)
      .sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at)) ||
        String(left.observation_id).localeCompare(String(right.observation_id)));
    const productionObservationIds = new Set<string>();
    for (const observation of productionDeploymentObservations) {
      if (
        !ID_PATTERN.test(observation.observation_id) ||
        !['webhook', 'api'].includes(observation.source_kind) ||
        !DIGEST_PATTERN.test(observation.fact_digest) ||
        !ID_PATTERN.test(observation.deployment_id) ||
        !['received', 'applied', 'ignored'].includes(observation.processing_state) ||
        !Number.isFinite(Date.parse(observation.external_updated_at)) ||
        !Number.isFinite(Date.parse(observation.observed_at)) ||
        (observation.processed_at !== null &&
          !Number.isFinite(Date.parse(observation.processed_at))) ||
        (observation.ignore_reason !== null &&
          !IGNORE_REASON_PATTERN.test(observation.ignore_reason)) ||
        productionObservationIds.has(observation.observation_id)
      ) throw new Case8AuditReportError('projection_conflict');
      productionObservationIds.add(observation.observation_id);
    }
    const testAcceptances = rows(testAcceptancesResult);
    const testAcceptanceObservations = rows(testAcceptanceObservationResult);
    const testRollbackContracts = rows(testRollbackContractResult).map((contract) => {
      const declared = contract.disposition === 'declared';
      if (
        !ID_PATTERN.test(contract.observation_id) ||
        !['deployment_failure', 'acceptance_failure'].includes(contract.source_kind) ||
        !ID_PATTERN.test(contract.source_id) || !ID_PATTERN.test(contract.source_evidence_id) ||
        !REPOSITORY_PATTERN.test(contract.repository) || !SHA_PATTERN.test(contract.ref_sha) ||
        !['declared', 'not_declared', 'policy_missing', 'policy_invalid']
          .includes(contract.disposition) ||
        (contract.policy_digest !== null && !DIGEST_PATTERN.test(contract.policy_digest)) ||
        !Number.isFinite(Date.parse(contract.observed_at)) ||
        (declared && (
          contract.contract_digest === null || !DIGEST_PATTERN.test(contract.contract_digest) ||
          contract.workflow_path !== '.github/workflows/delivery-test-rollback.yml' ||
          contract.environment !== 'test' ||
          contract.oidc_audience !== 'delivery-loop-test-rollback' ||
          contract.role_ref === null || !/^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
            .test(contract.role_ref)
        )) ||
        (!declared && (
          contract.contract_digest !== null || contract.workflow_path !== null ||
          contract.environment !== null || contract.oidc_audience !== null ||
          contract.role_ref !== null
        ))
      ) throw new Case8AuditReportError('projection_conflict');
      const value: Record<string, unknown> = {
        observationId: contract.observation_id,
        sourceKind: contract.source_kind,
        sourceId: contract.source_id,
        sourceEvidenceId: contract.source_evidence_id,
        repository: contract.repository,
        refSha: contract.ref_sha,
        disposition: contract.disposition,
        observedAt: contract.observed_at,
      };
      optional(value, 'policyDigest', contract.policy_digest);
      optional(value, 'contractDigest', contract.contract_digest);
      optional(value, 'workflowPath', contract.workflow_path);
      optional(value, 'environment', contract.environment);
      optional(value, 'oidcAudience', contract.oidc_audience);
      optional(value, 'roleRef', contract.role_ref);
      return value;
    });
    const testRollbacks = rows(testRollbackResult).map((rollback) => {
      const runnerFields = [
        rollback.runner_result_digest, rollback.runner_status,
        rollback.runner_exit_code, rollback.runner_duration_ms,
      ];
      const runnerPresent = runnerFields.every((value) => value !== null);
      const runnerAbsent = runnerFields.every((value) => value === null);
      const oidcFields = [
        rollback.oidc_attestation_id, rollback.oidc_github_run_id,
        rollback.oidc_workflow_ref, rollback.oidc_subject,
      ];
      const oidcPresent = oidcFields.every((value) => value !== null);
      const oidcAbsent = oidcFields.every((value) => value === null);
      if (
        !ID_PATTERN.test(rollback.rollback_id) ||
        !['deployment_failure', 'acceptance_failure'].includes(rollback.source_kind) ||
        !ID_PATTERN.test(rollback.source_id) || !ID_PATTERN.test(rollback.source_evidence_id) ||
        !ID_PATTERN.test(rollback.failed_attempt_id) || !ID_PATTERN.test(rollback.deployment_id) ||
        !ID_PATTERN.test(rollback.approval_id) ||
        !ID_PATTERN.test(rollback.contract_observation_id) ||
        !Number.isSafeInteger(rollback.run_version) || rollback.run_version < 0 ||
        !ID_PATTERN.test(rollback.plan_id) || !Number.isSafeInteger(rollback.plan_version) ||
        rollback.plan_version <= 0 || !DIGEST_PATTERN.test(rollback.plan_digest) ||
        !ID_PATTERN.test(rollback.plan_item_id) || !ID_PATTERN.test(rollback.attempt_id) ||
        !REPOSITORY_PATTERN.test(rollback.repository) || !BRANCH_PATTERN.test(rollback.base_branch) ||
        !SHA_PATTERN.test(rollback.base_sha) || !SHA_PATTERN.test(rollback.ref_sha) ||
        !DIGEST_PATTERN.test(rollback.policy_digest) || !DIGEST_PATTERN.test(rollback.contract_digest) ||
        rollback.workflow_path !== '.github/workflows/delivery-test-rollback.yml' ||
        rollback.environment !== 'test' ||
        rollback.oidc_audience !== 'delivery-loop-test-rollback' ||
        !/^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(rollback.role_ref) ||
        !['scheduled', 'dispatched', 'running', 'succeeded', 'failed'].includes(rollback.status) ||
        (rollback.github_run_id !== null && !/^[1-9][0-9]{0,31}$/.test(rollback.github_run_id)) ||
        (!runnerPresent && !runnerAbsent) ||
        (runnerPresent && (
          !DIGEST_PATTERN.test(rollback.runner_result_digest ?? '') ||
          !['passed', 'failed'].includes(rollback.runner_status ?? '') ||
          !Number.isSafeInteger(rollback.runner_exit_code) ||
          Number(rollback.runner_exit_code) < 0 || Number(rollback.runner_exit_code) > 255 ||
          !Number.isSafeInteger(rollback.runner_duration_ms) ||
          Number(rollback.runner_duration_ms) < 0 || Number(rollback.runner_duration_ms) > 3_600_000
        )) ||
        (!oidcPresent && !oidcAbsent) ||
        (oidcPresent && (
          !ID_PATTERN.test(rollback.oidc_attestation_id ?? '') ||
          rollback.oidc_github_run_id !== rollback.github_run_id ||
          rollback.oidc_workflow_ref !==
            `${rollback.repository}/${rollback.workflow_path}@refs/heads/${rollback.base_branch}` ||
          rollback.oidc_subject !== `repo:${rollback.repository}:environment:test`
        )) ||
        (rollback.external_updated_at !== null &&
          !Number.isFinite(Date.parse(rollback.external_updated_at))) ||
        (rollback.evidence_id !== null && !ID_PATTERN.test(rollback.evidence_id)) ||
        !Number.isFinite(Date.parse(rollback.created_at))
      ) throw new Case8AuditReportError('projection_conflict');
      const value: Record<string, unknown> = {
        rollbackId: rollback.rollback_id,
        sourceKind: rollback.source_kind,
        sourceId: rollback.source_id,
        sourceEvidenceId: rollback.source_evidence_id,
        failedAttemptId: rollback.failed_attempt_id,
        deploymentId: rollback.deployment_id,
        approvalId: rollback.approval_id,
        contractObservationId: rollback.contract_observation_id,
        runVersion: rollback.run_version,
        planId: rollback.plan_id,
        planVersion: rollback.plan_version,
        planDigest: rollback.plan_digest,
        itemId: rollback.plan_item_id,
        attemptId: rollback.attempt_id,
        repository: rollback.repository,
        baseBranch: rollback.base_branch,
        baseSha: rollback.base_sha,
        refSha: rollback.ref_sha,
        policyDigest: rollback.policy_digest,
        contractDigest: rollback.contract_digest,
        workflowPath: rollback.workflow_path,
        environment: rollback.environment,
        oidcAudience: rollback.oidc_audience,
        roleRef: rollback.role_ref,
        status: rollback.status,
        createdAt: rollback.created_at,
      };
      optional(value, 'githubRunId', rollback.github_run_id);
      optional(value, 'runnerResultDigest', rollback.runner_result_digest);
      optional(value, 'runnerStatus', rollback.runner_status);
      optional(value, 'runnerExitCode', rollback.runner_exit_code);
      optional(value, 'runnerDurationMs', rollback.runner_duration_ms);
      optional(value, 'externalState', rollback.external_state);
      optional(value, 'externalConclusion', rollback.external_conclusion);
      optional(value, 'externalUpdatedAt', rollback.external_updated_at);
      optional(value, 'evidenceId', rollback.evidence_id);
      optional(value, 'oidcAttestationId', rollback.oidc_attestation_id);
      optional(value, 'oidcGithubRunId', rollback.oidc_github_run_id);
      optional(value, 'oidcWorkflowRef', rollback.oidc_workflow_ref);
      optional(value, 'oidcSubject', rollback.oidc_subject);
      return value;
    });
    const testRollbackObservations = rows(testRollbackObservationResult).map((observation) => {
      if (
        !ID_PATTERN.test(observation.observation_id) ||
        !['webhook', 'api'].includes(observation.source_kind) ||
        !DIGEST_PATTERN.test(observation.fact_digest) ||
        (observation.rollback_id !== null && !ID_PATTERN.test(observation.rollback_id)) ||
        !/^[1-9][0-9]{0,31}$/.test(observation.github_run_id) ||
        !['received', 'applied', 'ignored'].includes(observation.processing_state) ||
        (observation.ignore_reason !== null &&
          !IGNORE_REASON_PATTERN.test(observation.ignore_reason)) ||
        !Number.isFinite(Date.parse(observation.external_updated_at)) ||
        !Number.isFinite(Date.parse(observation.observed_at)) ||
        (observation.processed_at !== null &&
          !Number.isFinite(Date.parse(observation.processed_at)))
      ) throw new Case8AuditReportError('projection_conflict');
      const value: Record<string, unknown> = {
        observationId: observation.observation_id,
        sourceKind: observation.source_kind,
        factDigest: observation.fact_digest,
        githubRunId: observation.github_run_id,
        processingState: observation.processing_state,
        externalUpdatedAt: observation.external_updated_at,
        observedAt: observation.observed_at,
      };
      optional(value, 'rollbackId', observation.rollback_id);
      optional(value, 'ignoreReason', observation.ignore_reason);
      optional(value, 'processedAt', observation.processed_at);
      return value;
    });
    const replayRows = rows(replayResult);
    const replayEffects = rows(replayEffectResult);
    const replayReconciliations = rows(replayReconciliationResult);
    const replayOutboxes = rows(replayOutboxResult);
    const effectOutboxes = rows(effectOutboxResult).map((outbox) => ({
      id: outbox.outbox_id,
      kind: outbox.kind,
      state: outbox.delivery_state,
      createdAt: outbox.created_at,
      ...(outbox.last_error_code === null ? {} : { lastErrorCode: outbox.last_error_code }),
    }));
    const secretArtifacts = rows(secretArtifactsResult).map((artifact) => {
      if (
        !ID_PATTERN.test(artifact.object_id) || !ID_PATTERN.test(artifact.attempt_id) ||
        artifact.category !== 'raw_transcript' || !DIGEST_PATTERN.test(artifact.ciphertext_digest) ||
        !Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0 ||
        artifact.policy_version !== 'security-v1-raw-30d' ||
        !['active', 'deleting', 'retry', 'deleted'].includes(artifact.deletion_state) ||
        !Number.isFinite(Date.parse(artifact.created_at)) ||
        !Number.isFinite(Date.parse(artifact.expires_at)) ||
        Date.parse(artifact.expires_at) <= Date.parse(artifact.created_at)
      ) throw new Case8AuditReportError('projection_conflict');
      return {
        objectId: artifact.object_id,
        attemptId: artifact.attempt_id,
        category: artifact.category,
        ciphertextDigest: artifact.ciphertext_digest,
        sizeBytes: artifact.size_bytes,
        policyVersion: artifact.policy_version,
        createdAt: artifact.created_at,
        expiresAt: artifact.expires_at,
        deletionState: artifact.deletion_state,
      };
    });
    const baseRebases = rows(baseRebasesResult).map((rebase) => {
      if (
        !ID_PATTERN.test(rebase.rebase_id) || !ID_PATTERN.test(rebase.revision_id) ||
        !ID_PATTERN.test(rebase.source_plan_id) || !ID_PATTERN.test(rebase.target_plan_id) ||
        !ID_PATTERN.test(rebase.plan_item_id) || !ID_PATTERN.test(rebase.source_attempt_id) ||
        !ID_PATTERN.test(rebase.rebase_attempt_id) ||
        !BRANCH_PATTERN.test(rebase.source_branch) || !BRANCH_PATTERN.test(rebase.target_branch) ||
        rebase.source_branch.includes('..') || rebase.source_branch.includes('//') ||
        rebase.target_branch.includes('..') || rebase.target_branch.includes('//') ||
        !SHA_PATTERN.test(rebase.old_base_sha) || !SHA_PATTERN.test(rebase.new_base_sha) ||
        !SHA_PATTERN.test(rebase.source_head_sha) ||
        (rebase.result_head_sha !== null && !SHA_PATTERN.test(rebase.result_head_sha)) ||
        !['scheduled', 'passed', 'blocked'].includes(rebase.status) ||
        !['review_fix'].includes(rebase.attempt_mode) ||
        !['pending', 'starting', 'running', 'completed', 'cancelled'].includes(rebase.attempt_status) ||
        !['ready', 'in_progress', 'passed', 'blocked'].includes(rebase.progress_status) ||
        (rebase.status === 'passed' && (
          rebase.result_head_sha === null || rebase.verification_suite_id === null ||
          rebase.blocker_reason !== null || rebase.completed_at === null
        )) ||
        (rebase.status === 'blocked' && (
          rebase.result_head_sha !== null || rebase.verification_suite_id !== null ||
          rebase.blocker_reason !== 'base_rebase_content_conflict' ||
          rebase.completed_at === null
        )) ||
        (rebase.status === 'scheduled' && (
          rebase.result_head_sha !== null || rebase.verification_suite_id !== null ||
          rebase.blocker_reason !== null || rebase.completed_at !== null
        )) ||
        !Number.isSafeInteger(rebase.source_plan_version) || rebase.source_plan_version <= 0 ||
        !Number.isSafeInteger(rebase.target_plan_version) || rebase.target_plan_version <= 0 ||
        (rebase.attempt_github_run_id !== null && !/^\d{1,32}$/.test(rebase.attempt_github_run_id)) ||
        (rebase.dispatch_outbox_id !== null && !ID_PATTERN.test(rebase.dispatch_outbox_id)) ||
        (rebase.dispatch_outbox_state !== null &&
          !['pending', 'delivering', 'settled'].includes(rebase.dispatch_outbox_state)) ||
        !Number.isFinite(Date.parse(rebase.created_at)) ||
        (rebase.completed_at !== null && !Number.isFinite(Date.parse(rebase.completed_at)))
      ) throw new Case8AuditReportError('projection_conflict');
      const value: Record<string, unknown> = {
        rebaseId: rebase.rebase_id,
        revisionId: rebase.revision_id,
        sourcePlan: {
          id: rebase.source_plan_id,
          version: rebase.source_plan_version,
        },
        targetPlan: {
          id: rebase.target_plan_id,
          version: rebase.target_plan_version,
        },
        itemId: rebase.plan_item_id,
        sourceAttemptId: rebase.source_attempt_id,
        attemptId: rebase.rebase_attempt_id,
        oldBaseSha: rebase.old_base_sha,
        newBaseSha: rebase.new_base_sha,
        sourceBranch: rebase.source_branch,
        sourceHeadSha: rebase.source_head_sha,
        targetBranch: rebase.target_branch,
        status: rebase.status,
        attemptStatus: rebase.attempt_status,
        progressStatus: rebase.progress_status,
        createdAt: rebase.created_at,
      };
      optional(value, 'resultHeadSha', rebase.result_head_sha);
      optional(value, 'verificationSuiteId', rebase.verification_suite_id);
      optional(value, 'blockerReason', rebase.blocker_reason);
      optional(value, 'githubRunId', rebase.attempt_github_run_id);
      optional(value, 'githubStatus', rebase.attempt_github_status);
      optional(value, 'githubConclusion', rebase.attempt_github_conclusion);
      optional(value, 'attemptHeadBranch', rebase.attempt_head_branch);
      optional(value, 'attemptHeadSha', rebase.attempt_head_sha);
      optional(value, 'dispatchOutboxId', rebase.dispatch_outbox_id);
      optional(value, 'dispatchOutboxState', rebase.dispatch_outbox_state);
      optional(value, 'completedAt', rebase.completed_at);
      return value;
    });
    const baseConflicts = rows(baseConflictsResult).map((conflict) => {
      if (
        !ID_PATTERN.test(conflict.conflict_id) ||
        !ID_PATTERN.test(conflict.prior_plan_id) ||
        !REPOSITORY_PATTERN.test(conflict.repository) || !BRANCH_PATTERN.test(conflict.base_branch) ||
        conflict.base_branch.includes('..') || conflict.base_branch.includes('//') ||
        !SHA_PATTERN.test(conflict.before_sha) || !SHA_PATTERN.test(conflict.after_sha) ||
        !SHA_PATTERN.test(conflict.merge_base_sha) ||
        !DIGEST_PATTERN.test(conflict.prior_plan_digest) ||
        !DIGEST_PATTERN.test(conflict.reference_digest) ||
        !DIGEST_PATTERN.test(conflict.comparison_digest) ||
        !DIGEST_PATTERN.test(conflict.source_digest) ||
        !['behind', 'diverged', 'identical'].includes(conflict.relationship) ||
        conflict.blocker_reason !== 'base_history_diverged' ||
        conflict.needed_human_input !== 'manual_rebase' ||
        conflict.run_state !== 'blocked' || conflict.plan_status !== 'blocked' ||
        conflict.run_version !== conflict.expected_run_version + 1 ||
        conflict.before_sha === conflict.after_sha ||
        !Number.isSafeInteger(conflict.expected_run_version) || conflict.expected_run_version < 0 ||
        !Number.isSafeInteger(conflict.ahead_by) || conflict.ahead_by < 0 ||
        !Number.isSafeInteger(conflict.behind_by) || conflict.behind_by < 0 ||
        (conflict.cancel_outbox_id !== null && !ID_PATTERN.test(conflict.cancel_outbox_id)) ||
        (conflict.cancel_outbox_state !== null &&
          !['pending', 'delivering', 'settled'].includes(conflict.cancel_outbox_state)) ||
        !Number.isFinite(Date.parse(conflict.created_at)) ||
        !Number.isFinite(Date.parse(conflict.observed_at))
      ) throw new Case8AuditReportError('projection_conflict');
      const value: Record<string, unknown> = {
        conflictId: conflict.conflict_id,
        expectedRunVersion: conflict.expected_run_version,
        priorPlan: {
          id: conflict.prior_plan_id,
          version: conflict.prior_plan_version,
          digest: conflict.prior_plan_digest,
        },
        repository: conflict.repository,
        baseBranch: conflict.base_branch,
        beforeSha: conflict.before_sha,
        afterSha: conflict.after_sha,
        relationship: conflict.relationship,
        aheadBy: conflict.ahead_by,
        behindBy: conflict.behind_by,
        mergeBaseSha: conflict.merge_base_sha,
        referenceDigest: conflict.reference_digest,
        comparisonDigest: conflict.comparison_digest,
        sourceDigest: conflict.source_digest,
        blockerReason: conflict.blocker_reason,
        neededHumanInput: conflict.needed_human_input,
        runState: conflict.run_state,
        runVersion: conflict.run_version,
        planStatus: conflict.plan_status,
        createdAt: conflict.created_at,
        observedAt: conflict.observed_at,
      };
      optional(value, 'cancelOutboxId', conflict.cancel_outbox_id);
      optional(value, 'cancelOutboxState', conflict.cancel_outbox_state);
      return value;
    });
    const reviewObservations = rows(reviewObservationsResult);
    const reviewSourceIds = new Set<string>();
    for (const observation of reviewObservations) {
      if (
        observation.source_kind !== 'webhook' ||
        !ID_PATTERN.test(observation.source_id) ||
        !ID_PATTERN.test(observation.publication_id) ||
        !REVIEW_ID_PATTERN.test(observation.github_review_id) ||
        !SHA_PATTERN.test(observation.reviewed_head_sha) ||
        !DIGEST_PATTERN.test(observation.fact_digest) ||
        !['received', 'applied', 'ignored'].includes(observation.processing_state) ||
        !Number.isFinite(Date.parse(observation.observed_at)) ||
        (observation.processed_at !== null &&
          !Number.isFinite(Date.parse(observation.processed_at))) ||
        reviewSourceIds.has(observation.source_id)
      ) throw new Case8AuditReportError('projection_conflict');
      reviewSourceIds.add(observation.source_id);
      const feedbackFields = [
        observation.feedback_id, observation.prior_attempt_id,
        observation.review_attempt_id, observation.source_head_sha,
        observation.branch, observation.review_url, observation.submitted_at,
        observation.body_digest,
      ];
      const hasFeedback = feedbackFields.some((value) => value !== null);
      const completeFeedback = feedbackFields.every((value) => value !== null);
      if (
        observation.processing_state === 'received' ||
        (observation.processing_state === 'applied' &&
          (!completeFeedback || observation.processed_at === null)) ||
        (observation.processing_state === 'ignored' && hasFeedback) ||
        (observation.processing_state === 'applied' && observation.ignore_reason !== null) ||
        (observation.processing_state === 'ignored' && observation.ignore_reason !== null &&
          !IGNORE_REASON_PATTERN.test(observation.ignore_reason)) ||
        (observation.review_url !== null &&
          safeUrl(observation.review_url) !== observation.review_url) ||
        (observation.source_head_sha !== null && !SHA_PATTERN.test(observation.source_head_sha)) ||
        (observation.body_digest !== null && !DIGEST_PATTERN.test(observation.body_digest)) ||
        (observation.submitted_at !== null &&
          !Number.isFinite(Date.parse(observation.submitted_at)))
      ) throw new Case8AuditReportError('projection_conflict');
    }
    const planRevisionRows = rows(planRevisionsResult);
    const planRevisionAnswers: Array<Record<string, unknown>> = [];
    for (const revision of planRevisionRows) {
      if (
        !ID_PATTERN.test(revision.revision_id) ||
        !Number.isSafeInteger(revision.expected_run_version) ||
        revision.expected_run_version < 0 ||
        !['analyzing', 'activated', 'rejected'].includes(revision.revision_status) ||
        !['review_feedback', 'supplemental_context', 'base_update']
          .includes(revision.source_kind) ||
        !DIGEST_PATTERN.test(revision.source_digest) ||
        !Number.isFinite(Date.parse(revision.source_observed_at)) ||
        !SHA_PATTERN.test(revision.requested_base_sha) ||
        !ID_PATTERN.test(revision.analysis_attempt_id) ||
        !ID_PATTERN.test(revision.prior_plan_id) ||
        !Number.isSafeInteger(revision.prior_plan_version) ||
        revision.prior_plan_version <= 0 ||
        !DIGEST_PATTERN.test(revision.prior_plan_digest) ||
        !SHA_PATTERN.test(revision.prior_plan_base_sha) ||
        !Number.isFinite(Date.parse(revision.created_at)) ||
        revision.source_record_id === null || !ID_PATTERN.test(revision.source_record_id)
      ) throw new Case8AuditReportError('projection_conflict');
      const activated = revision.revision_status === 'activated';
      const rejected = revision.revision_status === 'rejected';
      const completeNewPlan =
        revision.new_plan_id !== null && revision.new_plan_version !== null &&
        revision.new_plan_digest !== null && revision.new_plan_base_sha !== null &&
        revision.new_plan_status !== null && revision.body_changed !== null &&
        revision.base_changed !== null && revision.effects_changed !== null;
      const anyNewPlan = [
        revision.new_plan_id, revision.new_plan_version, revision.new_plan_digest,
        revision.new_plan_base_sha, revision.new_plan_status, revision.body_changed,
        revision.base_changed, revision.effects_changed,
      ].some((value) => value !== null);
      if (
        (activated && (!completeNewPlan || revision.activated_at === null)) ||
        (rejected && (!completeNewPlan || revision.activated_at !== null)) ||
        (!activated && !rejected && (anyNewPlan || revision.activated_at !== null)) ||
        (activated && (
          !ID_PATTERN.test(revision.new_plan_id!) ||
          !Number.isSafeInteger(revision.new_plan_version) ||
          revision.new_plan_version !== revision.prior_plan_version + 1 ||
          !DIGEST_PATTERN.test(revision.new_plan_digest!) ||
          !SHA_PATTERN.test(revision.new_plan_base_sha!) ||
          revision.prior_plan_status !== 'superseded' ||
          revision.new_plan_status !== 'active' ||
          ![0, 1].includes(revision.body_changed!) ||
          ![0, 1].includes(revision.base_changed!) ||
          ![0, 1].includes(revision.effects_changed!) ||
          revision.body_changed! + revision.base_changed! + revision.effects_changed! < 1 ||
          !Number.isFinite(Date.parse(revision.activated_at!))
        )) ||
        (rejected && (
          revision.body_changed !== 0 || revision.base_changed !== 0 ||
          revision.effects_changed !== 0
        ))
      ) throw new Case8AuditReportError('projection_conflict');
      let source: Record<string, unknown>;
      if (revision.source_kind === 'base_update') {
        if (
          revision.base_repository === null || revision.base_branch === null ||
          revision.base_before_sha === null || revision.base_after_sha === null ||
          revision.base_ahead_by === null || revision.base_reference_digest === null ||
          revision.base_comparison_digest === null ||
          !SHA_PATTERN.test(revision.base_before_sha) ||
          !SHA_PATTERN.test(revision.base_after_sha) ||
          !Number.isSafeInteger(revision.base_ahead_by) || revision.base_ahead_by <= 0 ||
          !DIGEST_PATTERN.test(revision.base_reference_digest) ||
          !DIGEST_PATTERN.test(revision.base_comparison_digest)
        ) throw new Case8AuditReportError('projection_conflict');
        const digest = await canonicalSha256({
          schemaVersion: '1', repository: revision.base_repository,
          baseBranch: revision.base_branch, beforeSha: revision.base_before_sha,
          afterSha: revision.base_after_sha, relationship: 'ahead',
          aheadBy: revision.base_ahead_by,
          referenceDigest: revision.base_reference_digest,
          comparisonDigest: revision.base_comparison_digest,
        });
        if (digest !== revision.source_digest) {
          throw new Case8AuditReportError('projection_conflict');
        }
        source = {
          kind: 'base_update', recordId: revision.source_record_id,
          digest: revision.source_digest, observedAt: revision.source_observed_at,
          repository: revision.base_repository, baseBranch: revision.base_branch,
          beforeSha: revision.base_before_sha, afterSha: revision.base_after_sha,
          aheadBy: revision.base_ahead_by,
          referenceDigest: revision.base_reference_digest,
          comparisonDigest: revision.base_comparison_digest,
        };
      } else if (revision.source_kind === 'review_feedback') {
        if (
          revision.review_source_type === null ||
          revision.review_delivery_id === null || revision.review_id === null ||
          revision.review_repository === null || revision.review_pr_number === null ||
          revision.review_body_digest === null || revision.review_head_sha === null ||
          revision.review_branch === null || revision.review_url === null ||
          revision.review_submitted_at === null ||
          !ID_PATTERN.test(revision.review_delivery_id) ||
          !Number.isSafeInteger(revision.review_pr_number) || revision.review_pr_number <= 0 ||
          !DIGEST_PATTERN.test(revision.review_body_digest) ||
          !SHA_PATTERN.test(revision.review_head_sha) ||
          safeUrl(revision.review_url) !== revision.review_url ||
          !Number.isFinite(Date.parse(revision.review_submitted_at))
        ) throw new Case8AuditReportError('projection_conflict');
        const automated = revision.review_source_type === 'automated';
        if (
          automated
            ? !AUTOMATED_REVIEW_ID_PATTERN.test(revision.review_id) ||
              revision.review_result_digest === null ||
              !DIGEST_PATTERN.test(revision.review_result_digest)
            : !REVIEW_ID_PATTERN.test(revision.review_id) ||
              revision.review_result_digest !== null
        ) throw new Case8AuditReportError('projection_conflict');
        const digest = await canonicalSha256(automated ? {
          schemaVersion: '1', sourceKind: 'review_feedback',
          sourceType: 'automated_review', reviewId: revision.review_id,
          resultDigest: revision.review_result_digest,
          bodyDigest: revision.review_body_digest,
          sourceHeadSha: revision.review_head_sha, branch: revision.review_branch,
          reviewUrl: revision.review_url, submittedAt: revision.review_submitted_at,
        } : {
          schemaVersion: '1', sourceKind: 'review_feedback',
          feedbackId: revision.source_record_id, githubReviewId: revision.review_id,
          bodyDigest: revision.review_body_digest,
          sourceHeadSha: revision.review_head_sha, branch: revision.review_branch,
          reviewUrl: revision.review_url, submittedAt: revision.review_submitted_at,
        });
        if (digest !== revision.source_digest) {
          throw new Case8AuditReportError('projection_conflict');
        }
        source = automated ? {
          kind: 'review_feedback', sourceType: 'automated_review',
          recordId: revision.source_record_id,
          digest: revision.source_digest, observedAt: revision.source_observed_at,
          reviewAttemptId: revision.review_delivery_id,
          repository: revision.review_repository,
          pullRequestNumber: revision.review_pr_number,
          reviewId: revision.review_id,
          resultDigest: revision.review_result_digest,
          bodyDigest: revision.review_body_digest,
          reviewedHeadSha: revision.review_head_sha, branch: revision.review_branch,
          reviewUrl: revision.review_url,
        } : {
          kind: 'review_feedback', recordId: revision.source_record_id,
          digest: revision.source_digest, observedAt: revision.source_observed_at,
          deliveryId: revision.review_delivery_id,
          repository: revision.review_repository,
          pullRequestNumber: revision.review_pr_number,
          reviewId: revision.review_id,
          bodyDigest: revision.review_body_digest,
          reviewedHeadSha: revision.review_head_sha, branch: revision.review_branch,
          reviewUrl: revision.review_url,
        };
      } else {
        if (
          revision.context_event_digest === null || revision.context_digest === null ||
          revision.context_source_system === null || revision.context_tenant_key === null ||
          revision.context_source_task_key === null ||
          revision.context_prior_task_id === null ||
          revision.context_prior_task_revision === null ||
          revision.context_new_task_id === null ||
          revision.context_new_task_revision === null ||
          revision.context_new_task_digest === null || revision.context_new_run_id === null ||
          revision.context_applied_run_id === null ||
          revision.context_digest !== revision.source_digest ||
          !DIGEST_PATTERN.test(revision.context_event_digest) ||
          !DIGEST_PATTERN.test(revision.context_new_task_digest) ||
          !ID_PATTERN.test(revision.context_prior_task_id) ||
          !ID_PATTERN.test(revision.context_new_task_id) ||
          !ID_PATTERN.test(revision.context_new_run_id) ||
          !ID_PATTERN.test(revision.context_applied_run_id)
        ) throw new Case8AuditReportError('projection_conflict');
        source = {
          kind: 'supplemental_context', recordId: revision.source_record_id,
          digest: revision.source_digest, observedAt: revision.source_observed_at,
          eventDigest: revision.context_event_digest,
          sourceSystem: revision.context_source_system,
          tenantKey: revision.context_tenant_key,
          sourceTaskKey: revision.context_source_task_key,
          priorTaskId: revision.context_prior_task_id,
          priorTaskRevision: revision.context_prior_task_revision,
          newTaskId: revision.context_new_task_id,
          newTaskRevision: revision.context_new_task_revision,
          newTaskDigest: revision.context_new_task_digest,
          newRunId: revision.context_new_run_id,
          appliedRunId: revision.context_applied_run_id,
        };
      }
      const answer: Record<string, unknown> = {
        revisionId: revision.revision_id,
        expectedRunVersion: revision.expected_run_version,
        status: revision.revision_status,
        sourceKind: revision.source_kind,
        sourceRecordId: revision.source_record_id,
        sourceDigest: revision.source_digest,
        requestedBaseSha: revision.requested_base_sha,
        analysisAttemptId: revision.analysis_attempt_id,
        priorPlan: {
          id: revision.prior_plan_id, version: revision.prior_plan_version,
          digest: revision.prior_plan_digest, baseSha: revision.prior_plan_base_sha,
          status: revision.prior_plan_status,
        },
        source,
        createdAt: revision.created_at,
      };
      if (activated) {
        answer.newPlan = {
          id: revision.new_plan_id, version: revision.new_plan_version,
          digest: revision.new_plan_digest, baseSha: revision.new_plan_base_sha,
          status: revision.new_plan_status,
        };
        answer.changes = {
          body: revision.body_changed === 1,
          base: revision.base_changed === 1,
          effects: revision.effects_changed === 1,
        };
        answer.activatedAt = revision.activated_at;
      }
      planRevisionAnswers.push(answer);
    }
    const replayIds = new Set(replayRows.map((replay) => replay.replay_id));
    const effectsByReplay = new Map<string, Array<Record<string, unknown>>>();
    for (const effect of replayEffects) {
      if (!replayIds.has(effect.replay_id)) {
        throw new Case8AuditReportError('projection_conflict');
      }
      const values = effectsByReplay.get(effect.replay_id) ?? [];
      values.push({
        effect: effect.effect,
        ...(effect.approval_id === null ? {} : { approvalId: effect.approval_id }),
      });
      effectsByReplay.set(effect.replay_id, values);
    }
    const reconciliationsByReplay = new Map<string, Array<Record<string, unknown>>>();
    for (const reconciliation of replayReconciliations) {
      if (!replayIds.has(reconciliation.replay_id)) {
        throw new Case8AuditReportError('projection_conflict');
      }
      let source: Record<string, unknown>;
      if (reconciliation.source_kind === 'outbox') {
        if (
          reconciliation.outbox_id === null || reconciliation.outbox_kind === null ||
          reconciliation.outbox_dedupe_key === null ||
          reconciliation.outbox_delivery_state === null ||
          reconciliation.evidence_id !== null
        ) throw new Case8AuditReportError('projection_conflict');
        const digest = await canonicalSha256({
          outboxId: reconciliation.outbox_id,
          kind: reconciliation.outbox_kind,
          dedupeKey: reconciliation.outbox_dedupe_key,
          deliveryState: reconciliation.outbox_delivery_state,
        });
        if (digest !== reconciliation.source_digest) {
          throw new Case8AuditReportError('projection_conflict');
        }
        source = {
          outboxId: reconciliation.outbox_id,
          outboxKind: reconciliation.outbox_kind,
          deliveryState: reconciliation.outbox_delivery_state,
        };
      } else {
        if (
          reconciliation.evidence_id === null || reconciliation.evidence_kind === null ||
          reconciliation.evidence_status === null ||
          reconciliation.evidence_verification_status === null ||
          reconciliation.outbox_id !== null
        ) throw new Case8AuditReportError('projection_conflict');
        const digest = await canonicalSha256({
          evidenceId: reconciliation.evidence_id,
          kind: reconciliation.evidence_kind,
          status: reconciliation.evidence_status,
          verificationStatus: reconciliation.evidence_verification_status,
          sha: reconciliation.evidence_sha,
          artifactDigest: reconciliation.evidence_artifact_digest,
          externalUrl: reconciliation.evidence_external_url,
        });
        if (digest !== reconciliation.source_digest) {
          throw new Case8AuditReportError('projection_conflict');
        }
        source = {
          evidenceId: reconciliation.evidence_id,
          evidenceKind: reconciliation.evidence_kind,
          status: reconciliation.evidence_status,
          verificationStatus: reconciliation.evidence_verification_status,
          ...(reconciliation.evidence_sha === null
            ? {}
            : { sha: reconciliation.evidence_sha }),
        };
      }
      const values = reconciliationsByReplay.get(reconciliation.replay_id) ?? [];
      values.push({
        sourceKind: reconciliation.source_kind,
        sourceRef: reconciliation.source_ref,
        sourceDigest: reconciliation.source_digest,
        ...source,
      });
      reconciliationsByReplay.set(reconciliation.replay_id, values);
    }
    const outboxByReplay = new Map<string, Record<string, unknown>>();
    const replayRefPrefix = 'd1://workflow-replays/';
    for (const outbox of replayOutboxes) {
      const replayId = outbox.payload_ref.startsWith(replayRefPrefix)
        ? outbox.payload_ref.slice(replayRefPrefix.length)
        : '';
      if (
        !replayIds.has(replayId) || outboxByReplay.has(replayId) ||
        !Number.isSafeInteger(outbox.attempt_count) || outbox.attempt_count < 0 ||
        (outbox.last_error_code !== null &&
          !/^[a-z][a-z0-9_]{0,99}$/.test(outbox.last_error_code))
      ) throw new Case8AuditReportError('projection_conflict');
      outboxByReplay.set(replayId, {
        id: outbox.outbox_id,
        state: outbox.delivery_state,
        attemptCount: outbox.attempt_count,
        ...(outbox.last_error_code === null ? {} : { lastErrorCode: outbox.last_error_code }),
      });
    }
    const replays = replayRows.map((replay) => {
      const outbox = outboxByReplay.get(replay.replay_id);
      if (outbox === undefined) throw new Case8AuditReportError('projection_conflict');
      const value: Record<string, unknown> = {
        replayId: replay.replay_id,
        expectedRunVersion: replay.expected_run_version,
        planId: replay.plan_id,
        planVersion: replay.plan_version,
        target: {
          kind: replay.target_kind,
          name: replay.target_step_name,
          type: replay.target_step_type,
          count: replay.target_step_count,
        },
        reasonDigest: replay.reason_digest,
        effectSnapshotDigest: replay.effect_snapshot_digest,
        createdAt: replay.created_at,
        updatedAt: replay.updated_at,
        outbox,
        effects: effectsByReplay.get(replay.replay_id) ?? [],
        reconciliations: reconciliationsByReplay.get(replay.replay_id) ?? [],
      };
      optional(value, 'itemId', replay.plan_item_id);
      optional(value, 'restartObservedAt', replay.restart_observed_at);
      return value;
    });

    const links: Array<{ kind: string; url: string }> = [];
    const addLink = (kind: string, raw: string | null): string | undefined => {
      const url = safeUrl(raw);
      if (url !== undefined) links.push({ kind, url });
      return url;
    };
    const sourceUrl = addLink('source', subject.source_url);

    const sourceEvents: Array<Record<string, unknown>> = [{
      kind: 'task_revision',
      provider: subject.source_system,
      tenantKey: subject.tenant_key,
      externalId: subject.source_task_key,
      revision: subject.task_revision,
      digest: subject.task_digest,
      actor: { type: subject.actor_type, id: subject.actor_id },
      ...(sourceUrl === undefined ? {} : { url: sourceUrl }),
    }];
    sourceEvents.push(...revisionSources.map((source) => ({
      kind: 'plan_revision',
      sourceKind: source.source_kind,
      sourceRef: source.source_ref,
      digest: source.source_digest,
      priorPlanId: source.prior_plan_id,
      priorPlanVersion: source.prior_plan_version,
      priorPlanDigest: source.prior_plan_digest,
      requestedBaseSha: source.requested_base_sha,
      observedAt: source.observed_at,
    })));
    sourceEvents.push(...approvals.flatMap((approval) =>
      approval.external_event_id === null ? [] : [{
        kind: 'approval_decision',
        provider: approval.provider,
        externalId: approval.external_event_id,
        digest: approval.event_digest,
        approvalId: approval.approval_id,
        occurredAt: approval.occurred_at,
      }],
    ));

    const contextReads = this.contextReads(attempts, correlation.traces);
    const changes: Array<Record<string, unknown>> = heads.map((head) => ({
      kind: 'commit',
      updateId: head.update_id,
      attemptId: head.attempt_id,
      planId: head.plan_id,
      planVersion: head.plan_version,
      itemId: head.plan_item_id,
      parentSha: head.parent_sha,
      headSha: head.head_sha,
      branch: head.branch,
      evidenceId: head.evidence_id,
      createdAt: head.created_at,
    }));
    changes.push(...protectedDiffs.map((diff) => ({
      kind: 'protected_diff',
      gateId: diff.gate_id,
      attemptId: diff.attempt_id,
      planId: diff.plan_id,
      planVersion: diff.plan_version,
      itemId: diff.plan_item_id,
      baseSha: diff.base_sha,
      stagedTreeSha: diff.staged_tree_sha,
      deliveryPolicyDigest: diff.delivery_policy_digest,
      diffDigest: diff.diff_digest,
      totalChangedFiles: diff.total_changed_files,
      protectedChangeCount: diff.protected_change_count,
      status: diff.status,
      createdAt: diff.created_at,
    })));
    changes.push(...pullRequests.map((pullRequest) => {
      const value: Record<string, unknown> = {
        kind: 'pull_request',
        publicationId: pullRequest.publication_id,
        approvalId: pullRequest.approval_id,
        repository: pullRequest.repository,
        baseBranch: pullRequest.base_branch,
        headBranch: pullRequest.head_branch,
        headSha: pullRequest.head_sha,
        bodyDigest: pullRequest.body_digest,
        status: pullRequest.status,
        createdAt: pullRequest.created_at,
      };
      optional(value, 'number', pullRequest.github_pr_number);
      optional(value, 'evidenceId', pullRequest.evidence_id);
      optional(value, 'url', addLink('pull_request', pullRequest.github_pr_url));
      return value;
    }));
    changes.push(...merges.map((merge) => ({
      kind: 'merge',
      mergeId: merge.merge_id,
      publicationId: merge.publication_id,
      planId: merge.plan_id,
      planVersion: merge.plan_version,
      planDigest: merge.plan_digest,
      repository: merge.repository,
      pullRequestNumber: merge.github_pr_number,
      headSha: merge.head_sha,
      baseSha: merge.base_sha,
      mergeSha: merge.merge_sha,
      mergedBy: merge.merged_by_login,
      mergedAt: merge.merged_at,
      deploymentDisposition: merge.deployment_disposition,
      evidenceId: merge.evidence_id,
    })));

    const evidenceAnswers = evidence.map((item) => {
      const value: Record<string, unknown> = {
        evidenceId: item.evidence_id,
        kind: item.kind,
        status: item.status,
        verificationStatus: item.verification_status,
        observedAt: item.observed_at,
      };
      optional(value, 'attemptId', item.attempt_id);
      optional(value, 'planId', item.plan_id);
      optional(value, 'planVersion', item.plan_version);
      optional(value, 'itemId', item.plan_item_id);
      optional(value, 'commandRef', item.command_ref);
      optional(value, 'exitCode', item.exit_code);
      optional(value, 'durationMs', item.duration_ms);
      optional(value, 'sha', item.sha);
      optional(value, 'artifactDigest', item.artifact_digest);
      const linkKind = item.kind === 'deployment' ? 'deployment' : 'check';
      optional(value, 'url', addLink(linkKind, item.external_url));
      return value;
    });

    const deploymentAnswers = deployments.map((deployment) => {
      const value: Record<string, unknown> = {
        kind: deployment.kind,
        deploymentId: deployment.deployment_id,
        runVersion: deployment.run_version,
        planId: deployment.plan_id,
        planVersion: deployment.plan_version,
        planDigest: deployment.plan_digest,
        attemptId: deployment.attempt_id,
        approvalId: deployment.approval_id,
        repository: deployment.repository,
        environment: deployment.environment,
        roleRef: deployment.role_ref,
        status: deployment.status,
        sha: deployment.sha,
        externalState: deployment.external_state,
        externalUpdatedAt: deployment.external_updated_at,
        createdAt: deployment.created_at,
      };
      optional(value, 'itemId', deployment.plan_item_id);
      optional(value, 'githubDeploymentId', deployment.github_deployment_id);
      optional(value, 'evidenceId', deployment.evidence_id);
      optional(value, 'workflowPath', deployment.workflow_path);
      optional(value, 'oidcAudience', deployment.oidc_audience);
      optional(value, 'oidcAttestationId', deployment.oidc_attestation_id);
      optional(value, 'oidcGithubRunId', deployment.oidc_github_run_id);
      optional(value, 'oidcSubject', deployment.oidc_subject);
      optional(value, 'url', addLink('deployment', deployment.external_url));
      return value;
    });
    const testAcceptanceAnswers = testAcceptances.map((acceptance) => {
      const value: Record<string, unknown> = {
        acceptanceId: acceptance.acceptance_id,
        deploymentId: acceptance.deployment_id,
        runVersion: acceptance.run_version,
        planId: acceptance.plan_id,
        planVersion: acceptance.plan_version,
        planDigest: acceptance.plan_digest,
        itemId: acceptance.plan_item_id,
        attemptId: acceptance.attempt_id,
        approvalId: acceptance.approval_id,
        repository: acceptance.repository,
        environment: acceptance.environment,
        workflowPath: acceptance.workflow_path,
        oidcAudience: acceptance.oidc_audience,
        commandRef: acceptance.command_ref,
        environmentUrl: acceptance.environment_url,
        status: acceptance.status,
        refSha: acceptance.ref_sha,
        githubRunId: acceptance.github_run_id,
        runnerResultDigest: acceptance.runner_result_digest,
        runnerStatus: acceptance.runner_status,
        runnerExitCode: acceptance.runner_exit_code,
        runnerDurationMs: acceptance.runner_duration_ms,
        externalState: acceptance.external_state,
        externalConclusion: acceptance.external_conclusion,
        externalUpdatedAt: acceptance.external_updated_at,
        evidenceId: acceptance.evidence_id,
        oidcAttestationId: acceptance.oidc_attestation_id,
        oidcGithubRunId: acceptance.oidc_github_run_id,
        oidcSubject: acceptance.oidc_subject,
        createdAt: acceptance.created_at,
      };
      return value;
    });

    const answers: Case8AuditReport['answers'] = {
      who: {
        taskActor: { type: subject.actor_type, id: subject.actor_id },
        attempts: attempts.map((attempt) => {
          const value: Record<string, unknown> = {
            attemptId: attempt.attempt_id,
            ordinal: attempt.ordinal,
            mode: attempt.mode,
            status: attempt.status,
            baseSha: attempt.base_sha,
            createdAt: attempt.created_at,
            updatedAt: attempt.updated_at,
          };
          optional(value, 'repository', attempt.repository);
          optional(value, 'workflowRef', attempt.workflow_ref);
          optional(value, 'githubRunId', attempt.github_run_id);
          optional(value, 'githubStatus', attempt.github_status);
          optional(value, 'githubConclusion', attempt.github_conclusion);
          optional(value, 'planId', attempt.plan_id);
          optional(value, 'planVersion', attempt.plan_version);
          optional(value, 'itemId', attempt.plan_item_id);
          optional(value, 'claimedProgressVersion', attempt.claimed_progress_version);
          optional(value, 'headSha', attempt.head_sha);
          return value;
        }),
        mergeActors: merges.map((merge) => ({
          mergeId: merge.merge_id,
          login: merge.merged_by_login,
          mergedAt: merge.merged_at,
        })),
      },
      sourceEvents,
      permissions: {
        taskPolicy: {
          repositoryWrite: subject.allow_repository_write === 1,
          testDeploy: subject.allow_test_deploy === 1,
          productionDeploy: subject.allow_production_deploy === 1,
          humanApprovalRequired: subject.require_human_approval === 1,
        },
        planEffects: effects.map((effect) => ({
          planId: effect.plan_id,
          planVersion: effect.plan_version,
          planDigest: effect.plan_digest,
          itemId: effect.item_id,
          effect: effect.effect,
        })),
        grants: grants.map((grant) => ({
          tokenId: grant.token_id,
          attemptId: grant.attempt_id,
          leaseGeneration: grant.lease_generation,
          scopes: scopes(grant.scopes_json),
          expiresAt: grant.expires_at,
          revokedAt: grant.revoked_at,
        })),
        repositoryWriteCredentials: credentials.map((credential) => ({
          credentialId: credential.credential_id,
          attemptId: credential.attempt_id,
          planId: credential.plan_id,
          planVersion: credential.plan_version,
          itemId: credential.plan_item_id,
          approvalId: credential.approval_id,
          repository: credential.repository,
          leaseGeneration: credential.lease_generation,
          status: credential.status,
          authorizationExpiresAt: credential.authorization_expires_at,
          revokedAt: credential.revoked_at,
          createdAt: credential.created_at,
        })),
      },
      contextReads,
      changes,
      checks: {
        githubRunObservations: [
          ...githubWebhookRunObservations.map((observation) => ({
            sourceKind: 'webhook',
            sourceId: observation.source_id,
            sourceDigest: observation.source_digest,
            repository: observation.repository,
            githubRunId: observation.github_run_id,
            attemptId: observation.attempt_id,
            processingState: observation.processing_state,
            ignoreReason: observation.ignore_reason,
            externalUpdatedAt: observation.external_updated_at,
            observedAt: observation.observed_at,
            processedAt: observation.processed_at,
          })),
          ...githubApiRunObservations.map((observation) => ({
            sourceKind: 'api',
            sourceId: observation.source_id,
            sourceDigest: observation.source_digest,
            repository: observation.repository,
            githubRunId: observation.github_run_id,
            attemptId: observation.attempt_id,
            processingState: observation.processing_state,
            ignoreReason: observation.ignore_reason,
            externalUpdatedAt: observation.external_updated_at,
            observedAt: observation.observed_at,
            processedAt: observation.processed_at,
          })),
        ].sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
          left.sourceKind.localeCompare(right.sourceKind) ||
          left.sourceId.localeCompare(right.sourceId)),
        commands: commands.map((command) => ({
          suiteId: command.suite_id,
          attemptId: command.attempt_id,
          planId: command.plan_id,
          planVersion: command.plan_version,
          itemId: command.plan_item_id,
          headSha: command.head_sha,
          deliveryPolicyDigest: command.delivery_policy_digest,
          suiteStatus: command.suite_status,
          position: command.position,
          phase: command.phase,
          commandRef: command.command_ref,
          status: command.result_status,
          evidenceId: command.evidence_id,
          observedAt: command.updated_at,
        })),
        itemVerifications: itemVerifications.map((verification) => ({
          verificationId: verification.verification_id,
          planId: verification.plan_id,
          planVersion: verification.plan_version,
          itemId: verification.plan_item_id,
          attemptId: verification.attempt_id,
          headSha: verification.head_sha,
          evidenceSetDigest: verification.evidence_set_digest,
          status: verification.status,
          verifiedAt: verification.created_at,
        })),
        githubRequiredChecks: githubChecks.map((check) => ({
          observationId: check.observation_id,
          factDigest: check.fact_digest,
          policyDigest: check.policy_digest,
          checksDigest: check.checks_digest,
          reviewsDigest: check.reviews_digest,
          context: check.context,
          integrationId: check.integration_id,
          status: check.state,
          observedAt: check.observed_at,
        })),
        mergeGates,
        mergeObservations: mergeObservationAnswers,
        productionApprovals: productionApprovalAnswers,
        identityApprovals,
        testDeploymentObservations: testDeploymentObservations.map((observation) => ({
          observationId: observation.observation_id,
          sourceKind: observation.source_kind,
          factDigest: observation.fact_digest,
          deploymentId: observation.deployment_id,
          processingState: observation.processing_state,
          ignoreReason: observation.ignore_reason,
          externalUpdatedAt: observation.external_updated_at,
          observedAt: observation.observed_at,
          processedAt: observation.processed_at,
        })),
        productionDeploymentObservations: productionDeploymentObservations.map((observation) => ({
          observationId: observation.observation_id,
          sourceKind: observation.source_kind,
          factDigest: observation.fact_digest,
          deploymentId: observation.deployment_id,
          processingState: observation.processing_state,
          ignoreReason: observation.ignore_reason,
          externalUpdatedAt: observation.external_updated_at,
          observedAt: observation.observed_at,
          processedAt: observation.processed_at,
        })),
        testAcceptances: testAcceptanceAnswers,
        testAcceptanceObservations: testAcceptanceObservations.map((observation) => ({
          observationId: observation.observation_id,
          sourceKind: observation.source_kind,
          factDigest: observation.fact_digest,
          acceptanceId: observation.acceptance_id,
          githubRunId: observation.github_run_id,
          processingState: observation.processing_state,
          ignoreReason: observation.ignore_reason,
          externalUpdatedAt: observation.external_updated_at,
          observedAt: observation.observed_at,
          processedAt: observation.processed_at,
        })),
        testRollbackContracts,
        testRollbacks,
        testRollbackObservations,
        pullRequestObservations: pullRequestObservationsResult.results.map((observation) => ({
          sourceKind: observation.source_kind,
          sourceId: observation.source_id,
          publicationId: observation.publication_id,
          repository: observation.repository,
          githubPrNumber: observation.github_pr_number,
          factDigest: observation.fact_digest,
          processingState: observation.processing_state,
          ignoreReason: observation.ignore_reason,
          externalUpdatedAt: observation.external_updated_at,
          observedAt: observation.observed_at,
          processedAt: observation.processed_at,
        })),
        reviewObservations: reviewObservations.map((observation) => ({
          sourceKind: observation.source_kind,
          sourceId: observation.source_id,
          publicationId: observation.publication_id,
          repository: observation.repository,
          githubPrNumber: observation.github_pr_number,
          githubReviewId: observation.github_review_id,
          reviewedHeadSha: observation.reviewed_head_sha,
          factDigest: observation.fact_digest,
          processingState: observation.processing_state,
          ignoreReason: observation.ignore_reason,
          observedAt: observation.observed_at,
          processedAt: observation.processed_at,
          feedbackId: observation.feedback_id,
          priorAttemptId: observation.prior_attempt_id,
          reviewAttemptId: observation.review_attempt_id,
          sourceHeadSha: observation.source_head_sha,
          branch: observation.branch,
          reviewUrl: observation.review_url,
          submittedAt: observation.submitted_at,
          bodyDigest: observation.body_digest,
        })),
        planRevisions: planRevisionAnswers,
        baseRebases,
        baseConflicts,
        evidence: evidenceAnswers,
        secretArtifacts,
        replays,
        effectOutboxes,
      },
      approvals: approvals.map((approval) => ({
        approvalId: approval.approval_id,
        taskId: approval.task_id,
        taskRevision: approval.task_revision,
        approver: approval.approver_principal ?? approval.actor_id,
        effect: approval.effect,
        decision: approval.decision,
        planId: approval.plan_id,
        planVersion: approval.plan_version,
        planDigest: approval.plan_digest,
        baseSha: approval.base_sha,
        expiresAt: approval.expires_at,
        createdAt: approval.created_at,
        rolesDigest: approval.roles_digest,
        separationVerified: approval.separation_verified === 1,
        provider: approval.provider,
        lineageId: approval.lineage_id,
        sourceRecordId: approval.source_id ?? approval.card_action_receipt_id,
        externalEventId: approval.external_event_id,
        eventDigest: approval.event_digest,
        sourceOccurredAt: approval.occurred_at,
        decisionRecordedAt: approval.decision_recorded_at ?? approval.created_at,
        invalidated: approval.invalidated_approval_id !== null,
      })),
      deployments: deploymentAnswers,
    };

    const uniqueLinks = [...new Map(
      links.map((link) => [`${link.kind}\0${link.url}`, link]),
    ).values()].sort((left, right) => left.kind.localeCompare(right.kind) ||
      left.url.localeCompare(right.url));
    const body = {
      schemaVersion: '1' as const,
      runId: rawRunId,
      run: {
        state: subject.run_state,
        version: subject.run_version,
        baseSha: subject.base_sha,
        activePlanId: subject.active_plan_id,
        activePlanVersion: subject.active_plan_version,
        activePlanDigest: subject.active_plan_digest,
        createdAt: subject.created_at,
        updatedAt: subject.updated_at,
      },
      task: {
        id: subject.task_id,
        revision: subject.task_revision,
        digest: subject.task_digest,
        repository: subject.target_repository,
        baseBranch: subject.target_base_branch,
        targetEnvironment: subject.target_environment,
      },
      answers,
      digests: {
        task: subject.task_digest,
        plans: plans.map((plan) => ({
          planId: plan.plan_id,
          version: plan.plan_version,
          digest: plan.digest,
          status: plan.status,
          baseSha: plan.base_sha,
          createdByAttemptId: plan.created_by_attempt_id,
          createdAt: plan.created_at,
        })),
        evidenceArtifacts: evidence.flatMap((item) => item.artifact_digest === null
          ? []
          : [{ evidenceId: item.evidence_id, digest: item.artifact_digest }]),
      },
      links: uniqueLinks,
    };
    const reportDigest = await canonicalSha256(body);
    const completedAt = this.now();
    const durationMs = Math.ceil(this.monotonicNow() - started);
    if (
      !Number.isFinite(completedAt.getTime()) ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 0 ||
      durationMs >= FIVE_MINUTES_MS
    ) throw new Case8AuditReportError('time_budget_exceeded');

    // Directly adapted from Watt AuditStore.write: one UUID/timestamped row per
    // real read. Delivery-loop stores only safe identity/digest/timing fields.
    await this.db.prepare(
      `INSERT INTO case8_audit_report_accesses (
         access_id, run_id, principal, report_digest, answer_count,
         duration_ms, requested_at, completed_at
       ) VALUES (?, ?, 'service:operations', ?, 8, ?, ?, ?)`,
    ).bind(
      this.generateAccessId(),
      rawRunId,
      reportDigest,
      durationMs,
      requestedAt.toISOString(),
      completedAt.toISOString(),
    ).run();
    return {
      ...body,
      generatedAt: completedAt.toISOString(),
      queryDurationMs: durationMs,
      reportDigest,
    };
  }

  private contextReads(
    attempts: AttemptRow[],
    traces: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    interface Aggregate {
      category: string;
      action: string;
      effect: string;
      totalCalls: number;
      successfulCalls: number;
      deniedCalls: number;
      attemptIds: string[];
      firstObservedAt: string;
      lastObservedAt: string;
    }
    const aggregates = new Map<string, Aggregate>();
    const repositoryAttempts = attempts.filter((attempt) =>
      attempt.repository !== null && ['analysis', 'implement', 'review_fix'].includes(attempt.mode));
    if (repositoryAttempts.length > 0) {
      aggregates.set('repository\0runner_checkout', {
        category: 'repository',
        action: 'repo:read',
        effect: 'read',
        totalCalls: repositoryAttempts.length,
        successfulCalls: repositoryAttempts.length,
        deniedCalls: 0,
        attemptIds: repositoryAttempts.map((attempt) => attempt.attempt_id),
        firstObservedAt: repositoryAttempts[0]!.created_at,
        lastObservedAt: repositoryAttempts.at(-1)!.updated_at,
      });
    }
    for (const trace of traces) {
      const path = trace.toolPath;
      const attemptId = trace.attemptId;
      const resultCategory = trace.resultCategory;
      const occurredAt = trace.occurredAt;
      if (
        typeof path !== 'string' || typeof attemptId !== 'string' ||
        typeof resultCategory !== 'string' || typeof occurredAt !== 'string'
      ) throw new Case8AuditReportError('projection_conflict');
      const spec = trustedToolSpec(path);
      const contextCategory = category(path);
      if (spec === null || contextCategory === null) {
        throw new Case8AuditReportError('projection_conflict');
      }
      const key = `${contextCategory}\0${spec.scope}`;
      const existing = aggregates.get(key) ?? {
        category: contextCategory,
        action: spec.scope,
        effect: spec.effect,
        totalCalls: 0,
        successfulCalls: 0,
        deniedCalls: 0,
        attemptIds: [],
        firstObservedAt: occurredAt,
        lastObservedAt: occurredAt,
      };
      existing.totalCalls += 1;
      if (resultCategory === 'success') existing.successfulCalls += 1;
      if (resultCategory === 'policy_denied') existing.deniedCalls += 1;
      existing.attemptIds.push(attemptId);
      if (occurredAt < existing.firstObservedAt) existing.firstObservedAt = occurredAt;
      if (occurredAt > existing.lastObservedAt) existing.lastObservedAt = occurredAt;
      aggregates.set(key, existing);
    }
    return [...aggregates.values()]
      .map((aggregate) => ({
        ...aggregate,
        attemptIds: sortedUnique(aggregate.attemptIds),
      }))
      .sort((left, right) => String(left.category).localeCompare(String(right.category)) ||
        String(left.action).localeCompare(String(right.action)));
  }
}
