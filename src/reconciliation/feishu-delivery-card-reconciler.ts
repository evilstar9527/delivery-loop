import {
  ATTEMPTED_PATHS,
  type AttemptedPath,
  type HumanInputCode,
} from '../domain/attempt-failure.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  FeishuCardActionCommandSchema,
  type FeishuCardActionCommand,
  type FeishuCardApprovalEffect,
} from '../domain/feishu-card-action.js';
import {
  FeishuDeliveryCardPresentationV2Schema,
  renderFeishuDeliveryCard,
  safeFeishuDeliveryUrl,
  type DeploymentCardStatus,
  type FeishuDeliveryCardPresentationV2,
  type MergeCardStatus,
  type PullRequestCardStatus,
} from '../domain/feishu-delivery-card.js';
import type { RunState } from '../domain/run.js';
import { SecretScanner } from '../security/redaction.js';
import {
  feishuDeliveryCardPresentationFromRow,
  type StoredFeishuDeliveryCardPresentationRow,
} from '../storage/feishu-delivery-card-presentation.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const HIDDEN_SUMMARY = '摘要已隐藏（检测到敏感内容）';
const CARD_ACTION_CONTRACT_VERSION = '1';
const MUTATING_CARD_EFFECTS = new Set<FeishuCardApprovalEffect>([
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
]);
const CARD_CANCELLABLE_STATES = new Set<RunState>([
  'received',
  'triaging',
  'awaiting_approval',
  'queued',
  'planning',
  'executing',
  'verifying',
  'pull_request_open',
  'awaiting_review',
  'ready_to_merge',
  'blocked',
  'failed',
]);

export interface FeishuDeliveryCardTarget {
  tenantKey: string;
  chatId: string;
}

export interface FeishuDeliveryCardReconcileResult {
  runId: string;
  presentationId: string;
  outboxId: string;
  disposition: 'created' | 'unchanged';
}

export type FeishuDeliveryCardBatchResult = FeishuDeliveryCardReconcileResult;

export interface FeishuDeliveryCardRefreshInput {
  runId: string;
  expectedPresentationId: string;
  expectedRevision: number;
  expectedDigest: string;
}

export interface FeishuDeliveryCardRefreshResult extends FeishuDeliveryCardReconcileResult {
  requestId: string;
  requestDisposition: 'created' | 'unchanged';
}

export interface FeishuDeliveryCardOperationsView {
  runId: string;
  cardId: string;
  latest: {
    presentationId: string;
    revision: number;
    digest: string;
    renderedDigest: string;
    outboxId: string;
    deliveryState: 'pending' | 'delivering' | 'settled';
    attemptCount: number;
    lastErrorCode: string | null;
  };
  delivered: {
    presentationId: string;
    revision: number;
    digest: string;
    messageId: string;
  } | null;
  retryHistory: Array<{
    outboxId: string;
    presentationId: string;
    attemptCount: number;
    errorCode: string;
    observedAt: string;
  }>;
  refresh: {
    requestId: string;
    expectedPresentationId: string;
    expectedRevision: number;
    expectedDigest: string;
    nextPresentationId: string;
    nextRevision: number;
    nextDigest: string;
    nextOutboxId: string;
    nextDeliveryState: 'pending' | 'delivering' | 'settled';
  } | null;
}

export interface FeishuCardPresentationEvidenceView {
  taskId: string;
  runId: string;
  repository: string;
  tenantKey: string;
  chatId: string;
  cardId: string;
  presentations: Array<{
    presentationId: string;
    revision: number;
    digest: string;
    renderedDigest: string;
    createdAt: string;
    lineage: {
      trigger: 'initial' | 'source_change' | 'approval_expiry' | 'manual_refresh';
      priorPresentationId: string | null;
      priorSourceObservedAt: string | null;
      sourceObservedAt: string;
      triggerRefreshAt: string | null;
      nextRefreshAt: string | null;
      projectedAt: string;
    };
    snapshot: Omit<
      FeishuDeliveryCardPresentationV2,
      | 'schemaVersion' | 'cardId' | 'presentationId' | 'refreshRequestId'
      | 'runId' | 'actions'
    >;
    outbox: {
      outboxId: string;
      deliveryState: 'pending' | 'delivering' | 'settled';
      attemptCount: number;
      lastErrorCode: string | null;
      payloadKind: 'presentation_ref';
    };
    delivery: {
      disposition: 'created' | 'updated';
      messageId: string;
      deliveredAt: string;
    } | null;
  }>;
}

export type FeishuDeliveryCardRefreshErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'stale_snapshot';

export class FeishuDeliveryCardRefreshError extends Error {
  constructor(readonly code: FeishuDeliveryCardRefreshErrorCode) {
    super(`Feishu delivery card refresh failed: ${code}`);
    this.name = 'FeishuDeliveryCardRefreshError';
  }
}

export interface FeishuDeliveryCardReconcilerOptions {
  now?: () => Date;
  secrets?: readonly string[];
}

interface RunRow {
  run_id: string;
  run_version: number;
  run_state: RunState;
  run_updated_at: string;
  task_id: string;
  tenant_key: string;
  task_revision: string;
  task_digest: string;
  target_repository: string;
  base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
}

interface CardRow {
  card_id: string;
  tenant_key: string;
  chat_id: string;
  latest_revision: number;
  latest_presentation_id: string | null;
  source_observed_at: string;
  refresh_after: string | null;
}

interface ExistingPresentationRow {
  presentation_id: string;
  outbox_id: string;
}

interface RefreshRequestRow {
  refresh_request_id: string;
  card_id: string;
  run_id: string;
  expected_presentation_id: string;
  expected_revision: number;
  expected_digest: string;
}

interface OperationsViewRow extends StoredFeishuDeliveryCardPresentationRow {
  latest_presentation_id: string;
  latest_revision: number;
  latest_digest: string;
  delivered_presentation_id: string | null;
  delivered_revision: number;
  delivered_digest: string | null;
  active_message_id: string | null;
  outbox_id: string;
  delivery_state: 'pending' | 'delivering' | 'settled';
  attempt_count: number;
  last_error_code: string | null;
}

interface PresentationEvidenceRow extends StoredFeishuDeliveryCardPresentationRow {
  task_id: string;
  target_repository: string;
  tenant_key: string;
  chat_id: string;
  revision: number;
  digest: string;
  created_at: string;
  lineage_id: string;
  prior_presentation_id: string | null;
  trigger_reason: 'initial' | 'source_change' | 'approval_expiry' | 'manual_refresh';
  prior_source_observed_at: string | null;
  source_observed_at: string;
  trigger_refresh_at: string | null;
  next_refresh_at: string | null;
  projected_at: string;
  outbox_id: string;
  payload_ref: string;
  delivery_state: 'pending' | 'delivering' | 'settled';
  attempt_count: number;
  last_error_code: string | null;
  delivery_disposition: 'created' | 'updated' | 'rejected' | null;
  delivery_message_id: string | null;
  delivered_at: string | null;
}

interface RetryObservationRow {
  outbox_id: string;
  presentation_id: string;
  attempt_count: number;
  error_code: string;
  observed_at: string;
}

interface RefreshProjectionRow {
  refresh_request_id: string;
  expected_presentation_id: string;
  expected_revision: number;
  expected_digest: string;
  next_presentation_id: string;
  next_revision: number;
  next_digest: string;
  next_outbox_id: string;
  next_delivery_state: 'pending' | 'delivering' | 'settled';
}

interface PullRequestRow {
  status: 'pending' | 'created_unverified' | 'verified';
  github_pr_url: string | null;
  updated_at: string;
}

interface MergeDecisionRow {
  created_at: string;
}

interface MergeRow {
  created_at: string;
}

interface DeploymentRow {
  status: 'scheduled' | 'created_unverified' | 'in_progress' | 'succeeded' | 'failed';
  external_url: string | null;
  observation_version: number;
  updated_at: string;
}

interface PlanRow {
  plan_id: string;
  plan_version: number;
  digest: string;
  base_sha: string;
  updated_at: string;
}

interface ProgressRow {
  total: number;
  passed: number;
  required_total: number;
  required_passed: number;
  in_progress: number;
  failed: number;
  blocked: number;
  updated_at: string | null;
}

interface GoalRow {
  title: string;
  updated_at: string;
}

interface ActionRow {
  github_run_id: string;
  github_external_updated_at: string;
}

interface SummaryRow {
  summary: string;
  external_url?: string | null;
  observed_at?: string;
  created_at?: string;
}

interface BlockerRow {
  reason: 'repeated_fingerprint' | 'attempt_limit';
  retry_scope_digest: string;
  attempt_count: number;
  needed_human_input: HumanInputCode;
  created_at: string;
  resolved_at: string | null;
}

interface ApprovalRow {
  effect: 'repo_write' | 'test_deploy' | 'merge' | 'production_deploy';
  expires_at: string;
  created_at: string;
}

interface TimestampRow {
  observed_at: string | null;
}

export interface FeishuDeliveryProjectionFacts {
  pr: {
    status: 'pending' | 'created_unverified' | 'verified';
    url: string | null;
  } | null;
  mergeDecisionObserved: boolean;
  mergeObserved: boolean;
  testDeploy: {
    status: DeploymentRow['status'];
    url: string | null;
    observationVersion: number;
  } | null;
  productionDeploy: {
    status: DeploymentRow['status'];
    url: string | null;
    observationVersion: number;
  } | null;
}

export interface FeishuDeliveryProjectedSections {
  pr: { status: PullRequestCardStatus; url: string | null };
  merge: { status: MergeCardStatus; url: string | null };
  testDeploy: { status: DeploymentCardStatus; url: string | null };
  productionDeploy: { status: DeploymentCardStatus; url: string | null };
}

type PresentationCore = Omit<FeishuDeliveryCardPresentationV2, 'cardId' | 'presentationId'>;

interface ProjectionSnapshot {
  run: RunRow;
  sourceObservedAt: string;
  refreshAfter: string | null;
  actionEpoch: string | null;
  presentation: PresentationCore;
}

function assertTarget(target: FeishuDeliveryCardTarget): void {
  if (
    target.tenantKey.length < 1 || target.tenantKey.length > 200 ||
    /[\0\r\n]/.test(target.tenantKey) || !TARGET_ID_PATTERN.test(target.chatId)
  ) throw new Error('Feishu delivery card target is invalid');
}

function deploymentStatus(status: DeploymentRow['status'] | undefined): DeploymentCardStatus {
  if (status === undefined) return 'not_started';
  return status === 'created_unverified' ? 'verifying' : status;
}

/** Pure safety boundary used after the D1 external-fact queries. */
export function projectFeishuDeliveryFacts(
  facts: FeishuDeliveryProjectionFacts,
): FeishuDeliveryProjectedSections {
  const prUrl = facts.pr?.status === 'verified'
    ? safeFeishuDeliveryUrl(facts.pr.url)
    : null;
  return {
    pr: {
      status: facts.pr === null
        ? 'not_started'
        : facts.pr.status === 'verified' ? 'open' : 'publishing',
      url: prUrl,
    },
    merge: {
      status: facts.mergeObserved
        ? 'merged'
        : facts.mergeDecisionObserved ? 'ready' : 'waiting',
      url: prUrl,
    },
    testDeploy: {
      status: deploymentStatus(facts.testDeploy?.status),
      url: (facts.testDeploy?.observationVersion ?? 0) > 0
        ? safeFeishuDeliveryUrl(facts.testDeploy?.url)
        : null,
    },
    productionDeploy: {
      status: deploymentStatus(facts.productionDeploy?.status),
      url: (facts.productionDeploy?.observationVersion ?? 0) > 0
        ? safeFeishuDeliveryUrl(facts.productionDeploy?.url)
        : null,
    },
  };
}

function latestTimestamp(values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => value !== null && value !== undefined)
    .sort()
    .at(-1) ?? new Date(0).toISOString();
}

/**
 * Rebuilds immutable card presentations only from D1 projections. This
 * reconciler never reads Task/PR bodies, raw logs, artifacts, or runner output.
 */
export class FeishuDeliveryCardReconciler {
  private readonly now: () => Date;
  private readonly scanner: SecretScanner;

  constructor(
    private readonly db: D1Database,
    private readonly target: FeishuDeliveryCardTarget,
    options: FeishuDeliveryCardReconcilerOptions = {},
  ) {
    assertTarget(target);
    this.now = options.now ?? (() => new Date());
    this.scanner = new SecretScanner({ secrets: options.secrets ?? [] });
  }

  async reconcileRun(runId: string): Promise<FeishuDeliveryCardReconcileResult | 'not_found'> {
    if (!ID_PATTERN.test(runId)) return 'not_found';
    return await this.reconcileRunAttempt(runId, 0);
  }

  /** Safe operations snapshot used to bind a manual refresh request. */
  async operationsView(runId: string): Promise<FeishuDeliveryCardOperationsView | null> {
    if (!ID_PATTERN.test(runId)) return null;
    const row = await this.db.prepare(
      `SELECT cards.card_id, cards.latest_presentation_id, cards.latest_revision,
              presentations.digest AS latest_digest,
              presentations.presentation_id, presentations.run_id,
              presentations.run_version, presentations.schema_version,
              presentations.presentation_json, presentations.refresh_request_id,
              presentations.pr_status, presentations.pr_url,
              presentations.merge_status, presentations.merge_url,
              presentations.test_deploy_status, presentations.test_deploy_url,
              presentations.production_deploy_status,
              presentations.production_deploy_url,
              cards.delivered_presentation_id, cards.delivered_revision,
              cards.delivered_digest, cards.active_message_id,
              outbox.outbox_id, outbox.delivery_state,
              outbox.attempt_count, outbox.last_error_code
       FROM feishu_delivery_cards AS cards
       JOIN feishu_delivery_card_presentations AS presentations
         ON presentations.presentation_id = cards.latest_presentation_id
       JOIN outbox ON outbox.payload_ref =
         'd1://feishu-delivery-card-presentations/' || presentations.presentation_id
       WHERE cards.run_id = ? AND cards.tenant_key = ? AND cards.chat_id = ?`,
    ).bind(runId, this.target.tenantKey, this.target.chatId).first<OperationsViewRow>();
    if (row === null) return null;
    const delivered = row.delivered_presentation_id === null
      ? null
      : row.delivered_digest === null || row.active_message_id === null
        ? null
        : {
            presentationId: row.delivered_presentation_id,
            revision: row.delivered_revision,
            digest: row.delivered_digest,
            messageId: row.active_message_id,
          };
    if (
      !ID_PATTERN.test(row.card_id) || !ID_PATTERN.test(row.latest_presentation_id) ||
      !ID_PATTERN.test(row.outbox_id) || !/^sha256:[a-f0-9]{64}$/.test(row.latest_digest) ||
      !Number.isSafeInteger(row.latest_revision) || row.latest_revision < 1 ||
      !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
      (
        row.last_error_code !== null &&
        !/^[a-z][a-z0-9_]{0,63}$/.test(row.last_error_code)
      ) || (
        row.delivered_presentation_id !== null && delivered === null
      ) || (
        delivered !== null && (
          !ID_PATTERN.test(delivered.presentationId) ||
          !Number.isSafeInteger(delivered.revision) || delivered.revision < 1 ||
          !/^sha256:[a-f0-9]{64}$/.test(delivered.digest) ||
          !MESSAGE_ID_PATTERN.test(delivered.messageId)
        )
      )
    ) throw new Error('Feishu delivery card operations projection is invalid');
    const renderedDigest = await canonicalSha256(renderFeishuDeliveryCard(
      feishuDeliveryCardPresentationFromRow(row),
    ));
    const retryRows = await this.db.prepare(
      `SELECT observations.outbox_id, observations.presentation_id,
              observations.attempt_count, observations.error_code,
              observations.observed_at
       FROM feishu_delivery_card_retry_observations AS observations
       JOIN outbox ON outbox.outbox_id = observations.outbox_id
       WHERE observations.run_id = ? AND outbox.destination = 'feishu_cards'
       ORDER BY observations.observed_at, observations.observation_id
       LIMIT 100`,
    ).bind(runId).all<RetryObservationRow>();
    const retryHistory = retryRows.results.map((retry) => ({
      outboxId: retry.outbox_id,
      presentationId: retry.presentation_id,
      attemptCount: retry.attempt_count,
      errorCode: retry.error_code,
      observedAt: retry.observed_at,
    }));
    if (
      retryHistory.length > 100 || retryHistory.some((retry) =>
        !ID_PATTERN.test(retry.outboxId) || !ID_PATTERN.test(retry.presentationId) ||
        !Number.isSafeInteger(retry.attemptCount) || retry.attemptCount < 1 ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(retry.errorCode) ||
        !/^[0-9TZ:.+-]+$/.test(retry.observedAt)
      )
    ) throw new Error('Feishu delivery card retry projection is invalid');
    const refresh = row.refresh_request_id === null
      ? null
      : await this.db.prepare(
        `SELECT requests.refresh_request_id,
                requests.expected_presentation_id, requests.expected_revision,
                requests.expected_digest,
                presentations.presentation_id AS next_presentation_id,
                presentations.revision AS next_revision,
                presentations.digest AS next_digest,
                outbox.outbox_id AS next_outbox_id,
                outbox.delivery_state AS next_delivery_state
         FROM feishu_delivery_card_refresh_requests AS requests
         JOIN feishu_delivery_card_presentations AS presentations
           ON presentations.refresh_request_id = requests.refresh_request_id
         JOIN outbox ON outbox.payload_ref =
           'd1://feishu-delivery-card-presentations/' || presentations.presentation_id
         WHERE requests.refresh_request_id = ? AND requests.card_id = ?
         LIMIT 1`,
      ).bind(row.refresh_request_id, row.card_id).first<RefreshProjectionRow>();
    if (row.refresh_request_id !== null && refresh === null) {
      throw new Error('Feishu delivery card refresh projection is invalid');
    }
    if (refresh !== null && (
      !ID_PATTERN.test(refresh.refresh_request_id) ||
      !ID_PATTERN.test(refresh.expected_presentation_id) ||
      !ID_PATTERN.test(refresh.next_presentation_id) ||
      !ID_PATTERN.test(refresh.next_outbox_id) ||
      !Number.isSafeInteger(refresh.expected_revision) || refresh.expected_revision < 1 ||
      !Number.isSafeInteger(refresh.next_revision) || refresh.next_revision <= refresh.expected_revision ||
      !/^sha256:[a-f0-9]{64}$/.test(refresh.expected_digest) ||
      !/^sha256:[a-f0-9]{64}$/.test(refresh.next_digest)
    )) throw new Error('Feishu delivery card refresh projection is invalid');
    return {
      runId,
      cardId: row.card_id,
      latest: {
        presentationId: row.latest_presentation_id,
        revision: row.latest_revision,
        digest: row.latest_digest,
        renderedDigest,
        outboxId: row.outbox_id,
        deliveryState: row.delivery_state,
        attemptCount: row.attempt_count,
        lastErrorCode: row.last_error_code,
      },
      delivered,
      retryHistory,
      refresh: refresh === null ? null : {
        requestId: refresh.refresh_request_id,
        expectedPresentationId: refresh.expected_presentation_id,
        expectedRevision: refresh.expected_revision,
        expectedDigest: refresh.expected_digest,
        nextPresentationId: refresh.next_presentation_id,
        nextRevision: refresh.next_revision,
        nextDigest: refresh.next_digest,
        nextOutboxId: refresh.next_outbox_id,
        nextDeliveryState: refresh.next_delivery_state,
      },
    };
  }

  /**
   * Operations-only, allowlisted history for the real-tenant presentation
   * verifier. Presentation JSON is strict-rehydrated, but action nonces and
   * raw JSON are intentionally excluded from the response.
   */
  async presentationEvidenceView(
    runId: string,
  ): Promise<FeishuCardPresentationEvidenceView | null> {
    if (!ID_PATTERN.test(runId)) return null;
    const result = await this.db.prepare(
      `SELECT cards.task_id, tasks.target_repository, cards.tenant_key, cards.chat_id,
              presentations.presentation_id, presentations.card_id,
              presentations.run_id, presentations.run_version,
              presentations.revision, presentations.digest,
              presentations.schema_version, presentations.presentation_json,
              presentations.refresh_request_id,
              presentations.pr_status, presentations.pr_url,
              presentations.merge_status, presentations.merge_url,
              presentations.test_deploy_status, presentations.test_deploy_url,
              presentations.production_deploy_status,
              presentations.production_deploy_url, presentations.created_at,
              lineages.lineage_id, lineages.prior_presentation_id,
              lineages.trigger_reason, lineages.prior_source_observed_at,
              lineages.source_observed_at, lineages.trigger_refresh_at,
              lineages.next_refresh_at, lineages.projected_at,
              outbox.outbox_id, outbox.payload_ref, outbox.delivery_state,
              outbox.attempt_count, outbox.last_error_code,
              deliveries.disposition AS delivery_disposition,
              deliveries.message_id AS delivery_message_id,
              deliveries.delivered_at
       FROM feishu_delivery_cards AS cards
       JOIN tasks ON tasks.task_id = cards.task_id
       JOIN feishu_delivery_card_presentations AS presentations
         ON presentations.card_id = cards.card_id AND presentations.run_id = cards.run_id
       JOIN feishu_delivery_card_presentation_lineages AS lineages
         ON lineages.presentation_id = presentations.presentation_id
        AND lineages.card_id = cards.card_id AND lineages.run_id = cards.run_id
       JOIN outbox ON outbox.payload_ref =
         'd1://feishu-delivery-card-presentations/' || presentations.presentation_id
       LEFT JOIN feishu_delivery_card_deliveries AS deliveries
         ON deliveries.presentation_id = presentations.presentation_id
       WHERE cards.run_id = ? AND cards.tenant_key = ? AND cards.chat_id = ?
       ORDER BY presentations.revision, presentations.presentation_id
       LIMIT 101`,
    ).bind(runId, this.target.tenantKey, this.target.chatId).all<PresentationEvidenceRow>();
    if (result.results.length === 0) return null;
    if (result.results.length > 100) {
      throw new Error('Feishu card presentation evidence is too large');
    }
    const first = result.results[0]!;
    if (
      !ID_PATTERN.test(first.task_id) || !ID_PATTERN.test(first.card_id) ||
      !REPOSITORY_PATTERN.test(first.target_repository) ||
      first.tenant_key !== this.target.tenantKey || first.chat_id !== this.target.chatId
    ) throw new Error('Feishu card presentation evidence is invalid');
    const presentations: FeishuCardPresentationEvidenceView['presentations'] = [];
    for (const row of result.results) {
      if (
        row.task_id !== first.task_id || row.target_repository !== first.target_repository ||
        row.tenant_key !== first.tenant_key || row.chat_id !== first.chat_id ||
        row.card_id !== first.card_id || row.run_id !== runId ||
        !ID_PATTERN.test(row.lineage_id) || !ID_PATTERN.test(row.outbox_id) ||
        row.payload_ref !== `d1://feishu-delivery-card-presentations/${row.presentation_id}` ||
        !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(row.digest) ||
        !/^[0-9TZ:.+-]+$/.test(row.created_at) ||
        !/^[0-9TZ:.+-]+$/.test(row.source_observed_at) ||
        !/^[0-9TZ:.+-]+$/.test(row.projected_at) ||
        (row.prior_presentation_id !== null && !ID_PATTERN.test(row.prior_presentation_id)) ||
        (
          row.prior_source_observed_at !== null &&
          !/^[0-9TZ:.+-]+$/.test(row.prior_source_observed_at)
        ) ||
        (row.trigger_refresh_at !== null && !/^[0-9TZ:.+-]+$/.test(row.trigger_refresh_at)) ||
        (row.next_refresh_at !== null && !/^[0-9TZ:.+-]+$/.test(row.next_refresh_at)) ||
        (
          row.last_error_code !== null &&
          !/^[a-z][a-z0-9_]{0,63}$/.test(row.last_error_code)
        )
      ) throw new Error('Feishu card presentation evidence is invalid');
      const presentation = feishuDeliveryCardPresentationFromRow(row);
      if (presentation.schemaVersion !== '2') {
        throw new Error('Feishu card presentation evidence is invalid');
      }
      const snapshot = {
        runVersion: presentation.runVersion,
        runState: presentation.runState,
        taskRevision: presentation.taskRevision,
        targetRepository: presentation.targetRepository,
        baseSha: presentation.baseSha,
        planVersion: presentation.planVersion,
        planDigest: presentation.planDigest,
        progress: presentation.progress,
        currentGoal: presentation.currentGoal,
        actionUrl: presentation.actionUrl,
        checkUrl: presentation.checkUrl,
        checkpointSummary: presentation.checkpointSummary,
        evidenceSummary: presentation.evidenceSummary,
        evidenceUrl: presentation.evidenceUrl,
        blocker: presentation.blocker,
        approvedEffects: presentation.approvedEffects,
        pr: presentation.pr,
        merge: presentation.merge,
        testDeploy: presentation.testDeploy,
        productionDeploy: presentation.productionDeploy,
      };
      const delivery = row.delivery_disposition === null
        ? null
        : row.delivery_disposition === 'rejected' || row.delivery_message_id === null ||
            row.delivered_at === null || !MESSAGE_ID_PATTERN.test(row.delivery_message_id) ||
            !/^[0-9TZ:.+-]+$/.test(row.delivered_at)
          ? null
          : {
              disposition: row.delivery_disposition,
              messageId: row.delivery_message_id,
              deliveredAt: row.delivered_at,
            };
      presentations.push({
        presentationId: row.presentation_id,
        revision: row.revision,
        digest: row.digest,
        renderedDigest: await canonicalSha256(renderFeishuDeliveryCard(presentation)),
        createdAt: row.created_at,
        lineage: {
          trigger: row.trigger_reason,
          priorPresentationId: row.prior_presentation_id,
          priorSourceObservedAt: row.prior_source_observed_at,
          sourceObservedAt: row.source_observed_at,
          triggerRefreshAt: row.trigger_refresh_at,
          nextRefreshAt: row.next_refresh_at,
          projectedAt: row.projected_at,
        },
        snapshot,
        outbox: {
          outboxId: row.outbox_id,
          deliveryState: row.delivery_state,
          attemptCount: row.attempt_count,
          lastErrorCode: row.last_error_code,
          payloadKind: 'presentation_ref',
        },
        delivery,
      });
    }
    return {
      taskId: first.task_id,
      runId,
      repository: first.target_repository,
      tenantKey: first.tenant_key,
      chatId: first.chat_id,
      cardId: first.card_id,
      presentations,
    };
  }

  /**
   * Records one immutable operations repair intent, then rebuilds only from
   * current D1 facts. The caller cannot supply a message, card, destination,
   * effect, or free-form reason.
   */
  async requestRefresh(
    input: FeishuDeliveryCardRefreshInput,
  ): Promise<FeishuDeliveryCardRefreshResult> {
    if (
      !ID_PATTERN.test(input.runId) || !ID_PATTERN.test(input.expectedPresentationId) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(input.expectedDigest)
    ) throw new FeishuDeliveryCardRefreshError('invalid_argument');
    const card = await this.db.prepare(
      `SELECT card_id, tenant_key, chat_id, latest_revision, latest_presentation_id,
              source_observed_at, refresh_after
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(input.runId).first<CardRow>();
    if (
      card === null || card.tenant_key !== this.target.tenantKey ||
      card.chat_id !== this.target.chatId
    ) throw new FeishuDeliveryCardRefreshError('not_found');
    const requestId = await this.stableId('feishu_card_refresh', {
      cardId: card.card_id,
      expectedPresentationId: input.expectedPresentationId,
      expectedRevision: input.expectedRevision,
      expectedDigest: input.expectedDigest,
    });
    let request = await this.refreshRequest(requestId);
    let requestDisposition: FeishuDeliveryCardRefreshResult['requestDisposition'] = 'unchanged';
    if (request === null) {
      const inserted = await this.db.prepare(
        `INSERT INTO feishu_delivery_card_refresh_requests (
           refresh_request_id, card_id, run_id, expected_presentation_id,
           expected_revision, expected_digest, requested_by, requested_at
         )
         SELECT ?, cards.card_id, cards.run_id, presentations.presentation_id,
                presentations.revision, presentations.digest,
                'service:operations', ?
         FROM feishu_delivery_cards AS cards
         JOIN feishu_delivery_card_presentations AS presentations
           ON presentations.presentation_id = cards.latest_presentation_id
          AND presentations.card_id = cards.card_id
         WHERE cards.card_id = ? AND cards.run_id = ?
           AND cards.tenant_key = ? AND cards.chat_id = ?
           AND cards.latest_presentation_id = ? AND cards.latest_revision = ?
           AND presentations.digest = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        requestId,
        this.now().toISOString(),
        card.card_id,
        input.runId,
        this.target.tenantKey,
        this.target.chatId,
        input.expectedPresentationId,
        input.expectedRevision,
        input.expectedDigest,
      ).run();
      request = await this.refreshRequest(requestId);
      if (request === null) throw new FeishuDeliveryCardRefreshError('stale_snapshot');
      requestDisposition = inserted.meta.changes === 1 ? 'created' : 'unchanged';
    }
    if (
      request.card_id !== card.card_id || request.run_id !== input.runId ||
      request.expected_presentation_id !== input.expectedPresentationId ||
      request.expected_revision !== input.expectedRevision ||
      request.expected_digest !== input.expectedDigest
    ) throw new FeishuDeliveryCardRefreshError('stale_snapshot');
    const alreadyProjected = await this.refreshPresentation(requestId);
    if (alreadyProjected !== null) {
      return {
        runId: input.runId,
        requestId,
        requestDisposition,
        presentationId: alreadyProjected.presentation_id,
        outboxId: alreadyProjected.outbox_id,
        disposition: 'unchanged',
      };
    }
    const projected = await this.reconcileRunAttempt(input.runId, 0, requestId);
    if (projected === 'not_found') throw new FeishuDeliveryCardRefreshError('not_found');
    const linked = await this.refreshPresentation(requestId);
    if (
      linked === null || linked.presentation_id !== projected.presentationId ||
      linked.outbox_id !== projected.outboxId
    ) throw new Error('Feishu delivery card refresh projection conflict');
    return { ...projected, requestId, requestDisposition };
  }

  async reconcileBatch(limit = 25): Promise<FeishuDeliveryCardBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Feishu delivery card reconciliation limit is invalid');
    }
    const nowIso = this.now().toISOString();
    const candidates = await this.db.prepare(
      `SELECT runs.run_id
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       LEFT JOIN feishu_delivery_cards AS cards ON cards.run_id = runs.run_id
       WHERE tasks.tenant_key = ? AND (
         cards.card_id IS NULL OR runs.updated_at > cards.source_observed_at OR
         (cards.refresh_after IS NOT NULL AND cards.refresh_after <= ?) OR
         EXISTS (
           SELECT 1 FROM feishu_delivery_card_refresh_requests AS refresh_requests
           WHERE refresh_requests.card_id = cards.card_id
             AND refresh_requests.expected_presentation_id = cards.latest_presentation_id
             AND NOT EXISTS (
               SELECT 1 FROM feishu_delivery_card_presentations AS refresh_presentations
               WHERE refresh_presentations.refresh_request_id =
                 refresh_requests.refresh_request_id
             )
         ) OR
         EXISTS (
           SELECT 1 FROM execution_plans
           WHERE execution_plans.run_id = runs.run_id
             AND execution_plans.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM plan_item_progress
           JOIN execution_plans ON execution_plans.plan_id = plan_item_progress.plan_id
           WHERE execution_plans.run_id = runs.run_id
             AND plan_item_progress.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM attempts WHERE attempts.run_id = runs.run_id
             AND attempts.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM checkpoints JOIN attempts ON attempts.attempt_id = checkpoints.attempt_id
           WHERE attempts.run_id = runs.run_id
             AND checkpoints.created_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM evidence WHERE evidence.run_id = runs.run_id
             AND evidence.observed_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM approvals WHERE approvals.run_id = runs.run_id
             AND approvals.created_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM identity_bound_approvals AS bindings
           JOIN approvals ON approvals.approval_id = bindings.approval_id
           JOIN identity_mappings ON identity_mappings.principal = bindings.approver_principal
           WHERE approvals.run_id = runs.run_id
             AND identity_mappings.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM identity_bound_approvals AS bindings
           JOIN approvals ON approvals.approval_id = bindings.approval_id
           JOIN channel_identities ON (
             (channel_identities.channel = bindings.approver_channel AND
              channel_identities.channel_user_id = bindings.approver_channel_user_id) OR
             (channel_identities.channel = bindings.pull_request_author_channel AND
              channel_identities.channel_user_id = bindings.pull_request_author_login)
           )
           WHERE approvals.run_id = runs.run_id
             AND channel_identities.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM feishu_card_action_approval_bindings AS bindings
           JOIN approvals ON approvals.approval_id = bindings.approval_id
           JOIN identity_mappings ON identity_mappings.principal = bindings.approver_principal
           WHERE approvals.run_id = runs.run_id
             AND identity_mappings.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM feishu_card_action_approval_bindings AS bindings
           JOIN approvals ON approvals.approval_id = bindings.approval_id
           JOIN channel_identities
             ON channel_identities.channel = bindings.approver_channel
            AND channel_identities.channel_user_id = bindings.approver_channel_user_id
           WHERE approvals.run_id = runs.run_id
             AND channel_identities.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM feishu_card_action_outcomes AS outcomes
           JOIN feishu_card_action_receipts AS receipts
             ON receipts.action_receipt_id = outcomes.action_receipt_id
           WHERE receipts.run_id = runs.run_id
             AND outcomes.completed_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM approval_invalidations
           JOIN approvals ON approvals.approval_id = approval_invalidations.approval_id
           WHERE approvals.run_id = runs.run_id
             AND approval_invalidations.invalidated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM base_conflict_approval_invalidations
           JOIN approvals ON approvals.approval_id = base_conflict_approval_invalidations.approval_id
           WHERE approvals.run_id = runs.run_id
             AND base_conflict_approval_invalidations.invalidated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM base_rebase_approval_invalidations
           JOIN approvals ON approvals.approval_id = base_rebase_approval_invalidations.approval_id
           WHERE approvals.run_id = runs.run_id
             AND base_rebase_approval_invalidations.invalidated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM run_blockers WHERE run_blockers.run_id = runs.run_id
             AND COALESCE(run_blockers.resolved_at, run_blockers.created_at) > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM pull_request_publications
           WHERE pull_request_publications.run_id = runs.run_id
             AND pull_request_publications.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM merge_gate_decisions
           WHERE merge_gate_decisions.run_id = runs.run_id
             AND merge_gate_decisions.created_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM github_merges
           WHERE github_merges.run_id = runs.run_id
             AND github_merges.created_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM test_deployments
           WHERE test_deployments.run_id = runs.run_id
             AND test_deployments.updated_at > cards.source_observed_at
         ) OR EXISTS (
           SELECT 1 FROM production_deployments
           WHERE production_deployments.run_id = runs.run_id
             AND production_deployments.updated_at > cards.source_observed_at
         )
       )
       ORDER BY runs.updated_at, runs.run_id
       LIMIT ?`,
    ).bind(this.target.tenantKey, nowIso, limit).all<{ run_id: string }>();
    const results: FeishuDeliveryCardBatchResult[] = [];
    for (const candidate of candidates.results) {
      const result = await this.reconcileRun(candidate.run_id);
      if (result !== 'not_found') results.push(result);
    }
    return results;
  }

  private async reconcileRunAttempt(
    runId: string,
    attempt: number,
    forcedRefreshRequestId?: string,
  ): Promise<FeishuDeliveryCardReconcileResult | 'not_found'> {
    const snapshot = await this.snapshot(runId);
    if (snapshot === null || snapshot.run.tenant_key !== this.target.tenantKey) return 'not_found';
    const cardId = await this.stableId('feishu_card', {
      runId,
      tenantKey: this.target.tenantKey,
      chatId: this.target.chatId,
    });
    const card = await this.db.prepare(
      `SELECT card_id, tenant_key, chat_id, latest_revision, latest_presentation_id,
              source_observed_at, refresh_after
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(runId).first<CardRow>();
    if (
      card !== null &&
      (card.card_id !== cardId || card.tenant_key !== this.target.tenantKey ||
        card.chat_id !== this.target.chatId)
    ) throw new Error('Feishu delivery card binding conflict');

    const refreshRequestId = forcedRefreshRequestId ?? (
      card === null || card.latest_presentation_id === null
        ? null
        : await this.pendingRefreshRequest(card.card_id, card.latest_presentation_id)
    );

    const actionEffects = await this.cardApprovalEffects(snapshot.run.active_plan_id);
    const taskRevisionDigest = await canonicalSha256({
      kind: 'task_revision',
      value: snapshot.run.task_revision,
    });
    const digestInput = {
      cardId,
      ...snapshot.presentation,
      ...(refreshRequestId === null ? {} : { refreshRequestId }),
    } as const;
    const digest = await canonicalSha256({
      ...digestInput,
      actionContractVersion: CARD_ACTION_CONTRACT_VERSION,
      actionBinding: {
        taskId: snapshot.run.task_id,
        taskRevisionDigest,
        planId: snapshot.run.active_plan_id,
        effects: actionEffects,
        actionEpoch: snapshot.actionEpoch,
      },
    });
    const existing = await this.db.prepare(
      `SELECT presentations.presentation_id, outbox.outbox_id
       FROM feishu_delivery_card_presentations AS presentations
       JOIN outbox ON outbox.payload_ref =
         'd1://feishu-delivery-card-presentations/' || presentations.presentation_id
       WHERE presentations.card_id = ? AND presentations.digest = ?`,
    ).bind(cardId, digest).first<ExistingPresentationRow>();
    if (existing !== null) {
      return {
        runId,
        presentationId: existing.presentation_id,
        outboxId: existing.outbox_id,
        disposition: 'unchanged',
      };
    }

    const revision = (card?.latest_revision ?? 0) + 1;
    const presentationId = await this.stableId('feishu_presentation', { cardId, digest });
    const outboxId = await this.stableId('outbox_feishu_card', { presentationId });
    const actions = await this.cardActions(
      snapshot,
      cardId,
      presentationId,
      taskRevisionDigest,
      actionEffects,
    );
    const presentation = FeishuDeliveryCardPresentationV2Schema.parse({
      ...digestInput,
      presentationId,
      actions,
    });
    const presentationJson = JSON.stringify(presentation);
    const nowIso = this.now().toISOString();
    const priorPresentationId = card?.latest_presentation_id ?? null;
    const priorSourceObservedAt = card?.source_observed_at ?? null;
    const expiryOnly = card !== null && card.latest_presentation_id !== null &&
      refreshRequestId === null && card.refresh_after !== null &&
      card.refresh_after <= nowIso && card.source_observed_at === snapshot.sourceObservedAt;
    const triggerReason = priorPresentationId === null
      ? 'initial'
      : refreshRequestId !== null
        ? 'manual_refresh'
        : expiryOnly
          ? 'approval_expiry'
          : 'source_change';
    const lineageId = await this.stableId('feishu_card_presentation_lineage', {
      presentationId,
    });
    try {
      const batch = await this.db.batch([
        this.db.prepare(
          `INSERT OR IGNORE INTO feishu_delivery_cards (
             card_id, run_id, task_id, tenant_key, chat_id, source_observed_at,
             refresh_after, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          cardId,
          runId,
          snapshot.run.task_id,
          this.target.tenantKey,
          this.target.chatId,
          snapshot.sourceObservedAt,
          snapshot.refreshAfter,
          nowIso,
          nowIso,
        ),
        this.db.prepare(
          `INSERT OR IGNORE INTO feishu_delivery_card_presentations (
             presentation_id, card_id, run_id, run_version, revision, digest,
             pr_status, pr_url, merge_status, merge_url,
             test_deploy_status, test_deploy_url,
             production_deploy_status, production_deploy_url,
             schema_version, presentation_json, refresh_request_id, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM feishu_delivery_cards
             WHERE card_id = ? AND run_id = ? AND tenant_key = ? AND chat_id = ?
           )`,
        ).bind(
          presentationId,
          cardId,
          runId,
          snapshot.run.run_version,
          revision,
          digest,
          presentation.pr.status,
          presentation.pr.url,
          presentation.merge.status,
          presentation.merge.url,
          presentation.testDeploy.status,
          presentation.testDeploy.url,
          presentation.productionDeploy.status,
          presentation.productionDeploy.url,
          presentationJson,
          refreshRequestId,
          nowIso,
          cardId,
          runId,
          this.target.tenantKey,
          this.target.chatId,
        ),
        this.db.prepare(
          `INSERT INTO feishu_delivery_card_presentation_lineages (
             lineage_id, presentation_id, card_id, run_id,
             prior_presentation_id, trigger_reason,
             prior_source_observed_at, source_observed_at,
             trigger_refresh_at, next_refresh_at, projected_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM feishu_delivery_card_presentations
             WHERE presentation_id = ? AND card_id = ? AND run_id = ?
           )
           ON CONFLICT DO NOTHING`,
        ).bind(
          lineageId,
          presentationId,
          cardId,
          runId,
          priorPresentationId,
          triggerReason,
          priorSourceObservedAt,
          snapshot.sourceObservedAt,
          triggerReason === 'approval_expiry' ? card!.refresh_after : null,
          snapshot.refreshAfter,
          nowIso,
          presentationId,
          cardId,
          runId,
        ),
        this.db.prepare(
          `UPDATE feishu_delivery_cards
           SET latest_presentation_id = ?, latest_revision = ?,
               source_observed_at = ?, refresh_after = ?, updated_at = ?
           WHERE card_id = ? AND latest_revision < ?
             AND EXISTS (
               SELECT 1 FROM feishu_delivery_card_presentations
               WHERE presentation_id = ? AND card_id = ? AND revision = ?
             )`,
        ).bind(
          presentationId,
          revision,
          snapshot.sourceObservedAt,
          snapshot.refreshAfter,
          nowIso,
          cardId,
          revision,
          presentationId,
          cardId,
          revision,
        ),
        this.db.prepare(
          `INSERT OR IGNORE INTO outbox (
             outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
             delivery_state, attempt_count, created_at, updated_at
           )
           SELECT ?, ?, 'feishu_delivery_card_upsert', 'feishu_cards',
                  'd1://feishu-delivery-card-presentations/' || ?, ?,
                  'pending', 0, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM feishu_delivery_card_presentations
             WHERE presentation_id = ? AND card_id = ?
           )`,
        ).bind(
          outboxId,
          runId,
          presentationId,
          `feishu-card:${presentationId}`,
          nowIso,
          nowIso,
          presentationId,
          cardId,
        ),
      ]);
      const inserted = batch[1]?.meta.changes === 1;
      const latest = await this.latest(cardId);
      if (latest?.lineage_id !== lineageId) {
        throw new Error('Feishu delivery card presentation lineage is missing');
      }
      if (latest.latest_presentation_id !== presentationId || latest.outbox_id !== outboxId) {
        if (attempt < 2) {
          return await this.reconcileRunAttempt(runId, attempt + 1, refreshRequestId ?? undefined);
        }
        throw new Error('Feishu delivery card reconciliation conflict');
      }
      return {
        runId,
        presentationId,
        outboxId,
        disposition: inserted ? 'created' : 'unchanged',
      };
    } catch (error) {
      if (attempt < 2) {
        return await this.reconcileRunAttempt(runId, attempt + 1, refreshRequestId ?? undefined);
      }
      throw error;
    }
  }

  private async refreshRequest(requestId: string): Promise<RefreshRequestRow | null> {
    return await this.db.prepare(
      `SELECT refresh_request_id, card_id, run_id, expected_presentation_id,
              expected_revision, expected_digest
       FROM feishu_delivery_card_refresh_requests WHERE refresh_request_id = ?`,
    ).bind(requestId).first<RefreshRequestRow>();
  }

  private async refreshPresentation(requestId: string): Promise<ExistingPresentationRow | null> {
    return await this.db.prepare(
      `SELECT presentations.presentation_id, outbox.outbox_id
       FROM feishu_delivery_card_presentations AS presentations
       JOIN outbox ON outbox.payload_ref =
         'd1://feishu-delivery-card-presentations/' || presentations.presentation_id
       WHERE presentations.refresh_request_id = ?`,
    ).bind(requestId).first<ExistingPresentationRow>();
  }

  private async pendingRefreshRequest(
    cardId: string,
    presentationId: string,
  ): Promise<string | null> {
    return await this.db.prepare(
      `SELECT refresh_requests.refresh_request_id
       FROM feishu_delivery_card_refresh_requests AS refresh_requests
       WHERE refresh_requests.card_id = ?
         AND refresh_requests.expected_presentation_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM feishu_delivery_card_presentations AS presentations
           WHERE presentations.refresh_request_id = refresh_requests.refresh_request_id
         )
       ORDER BY refresh_requests.requested_at, refresh_requests.refresh_request_id
       LIMIT 1`,
    ).bind(cardId, presentationId).first<string>('refresh_request_id');
  }

  private async latest(cardId: string): Promise<{
    latest_presentation_id: string | null;
    outbox_id: string;
    lineage_id: string;
  } | null> {
    return await this.db.prepare(
      `SELECT cards.latest_presentation_id,
              CASE WHEN outbox.outbox_id IS NULL THEN '' ELSE outbox.outbox_id END AS outbox_id,
              CASE WHEN lineages.lineage_id IS NULL THEN '' ELSE lineages.lineage_id END
                AS lineage_id
       FROM feishu_delivery_cards AS cards
       LEFT JOIN outbox ON outbox.payload_ref =
         'd1://feishu-delivery-card-presentations/' || cards.latest_presentation_id
       LEFT JOIN feishu_delivery_card_presentation_lineages AS lineages
         ON lineages.presentation_id = cards.latest_presentation_id
        AND lineages.card_id = cards.card_id AND lineages.run_id = cards.run_id
       WHERE cards.card_id = ?`,
    ).bind(cardId).first<{
      latest_presentation_id: string | null;
      outbox_id: string;
      lineage_id: string;
    }>();
  }

  private async snapshot(runId: string): Promise<ProjectionSnapshot | null> {
    const run = await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version, runs.state AS run_state,
              runs.updated_at AS run_updated_at, runs.base_sha,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              tasks.task_id, tasks.tenant_key, tasks.task_revision, tasks.task_digest,
              tasks.target_repository
       FROM runs JOIN tasks ON tasks.task_id = runs.task_id
       WHERE runs.run_id = ?`,
    ).bind(runId).first<RunRow>();
    if (run === null) return null;
    const nowIso = this.now().toISOString();
    const plan = await this.plan(run);
    const planId = plan?.plan_id ?? null;
    const [
      pr,
      decision,
      merge,
      testDeploy,
      productionDeploy,
      progress,
      goal,
      action,
      checkpoint,
      evidence,
      check,
      blocker,
      approvals,
      invalidation,
      approvalAuthority,
      cardAction,
    ] = await Promise.all([
      this.db.prepare(
        `SELECT status, github_pr_url, updated_at
         FROM pull_request_publications WHERE run_id = ?
         ORDER BY updated_at DESC, publication_id DESC LIMIT 1`,
      ).bind(runId).first<PullRequestRow>(),
      this.db.prepare(
        `SELECT created_at FROM merge_gate_decisions WHERE run_id = ?
         ORDER BY created_at DESC, decision_id DESC LIMIT 1`,
      ).bind(runId).first<MergeDecisionRow>(),
      this.db.prepare(
        `SELECT created_at FROM github_merges WHERE run_id = ? LIMIT 1`,
      ).bind(runId).first<MergeRow>(),
      this.db.prepare(
        `SELECT status, external_url, observation_version, updated_at
         FROM test_deployments WHERE run_id = ?
         ORDER BY updated_at DESC, deployment_id DESC LIMIT 1`,
      ).bind(runId).first<DeploymentRow>(),
      this.db.prepare(
        `SELECT status, external_url, observation_version, updated_at
         FROM production_deployments WHERE run_id = ? LIMIT 1`,
      ).bind(runId).first<DeploymentRow>(),
      this.progress(planId),
      this.goal(planId),
      this.db.prepare(
        `SELECT github_run_id, github_external_updated_at
         FROM attempts WHERE run_id = ? AND github_run_id IS NOT NULL
           AND github_observation_version > 0 AND github_external_updated_at IS NOT NULL
         ORDER BY ordinal DESC LIMIT 1`,
      ).bind(runId).first<ActionRow>(),
      this.db.prepare(
        `SELECT checkpoints.summary, checkpoints.created_at
         FROM checkpoints JOIN attempts ON attempts.attempt_id = checkpoints.attempt_id
         WHERE attempts.run_id = ? ORDER BY checkpoints.created_at DESC,
           checkpoints.sequence DESC LIMIT 1`,
      ).bind(runId).first<SummaryRow>(),
      this.db.prepare(
        `SELECT summary, external_url, observed_at FROM evidence
         WHERE run_id = ? AND verification_status = 'verified'
         ORDER BY observed_at DESC, evidence_id DESC LIMIT 1`,
      ).bind(runId).first<SummaryRow>(),
      this.db.prepare(
        `SELECT summary, external_url, observed_at FROM evidence
         WHERE run_id = ? AND kind = 'check' AND verification_status = 'verified'
           AND status = 'passed' AND external_url IS NOT NULL
         ORDER BY observed_at DESC, evidence_id DESC LIMIT 1`,
      ).bind(runId).first<SummaryRow>(),
      this.db.prepare(
        `SELECT reason, retry_scope_digest, attempt_count, needed_human_input,
                created_at, resolved_at
         FROM run_blockers WHERE run_id = ? AND resolved_at IS NULL
         ORDER BY created_at DESC, blocker_id DESC LIMIT 1`,
      ).bind(runId).first<BlockerRow>(),
      this.approvals(run, plan, nowIso),
      this.approvalInvalidationTimestamp(runId),
      this.approvalAuthorityTimestamp(runId),
      this.db.prepare(
        `SELECT MAX(outcomes.completed_at) AS observed_at
         FROM feishu_card_action_outcomes AS outcomes
         JOIN feishu_card_action_receipts AS receipts
           ON receipts.action_receipt_id = outcomes.action_receipt_id
         WHERE receipts.run_id = ?`,
      ).bind(runId).first<TimestampRow>(),
    ]);
    const blockerPaths = blocker === null
      ? []
      : await this.blockerPaths(runId, blocker.retry_scope_digest);
    const projected = projectFeishuDeliveryFacts({
      pr: pr === null ? null : { status: pr.status, url: pr.github_pr_url },
      mergeDecisionObserved: decision !== null,
      mergeObserved: merge !== null,
      testDeploy: testDeploy === null ? null : {
        status: testDeploy.status,
        url: testDeploy.external_url,
        observationVersion: testDeploy.observation_version,
      },
      productionDeploy: productionDeploy === null ? null : {
        status: productionDeploy.status,
        url: productionDeploy.external_url,
        observationVersion: productionDeploy.observation_version,
      },
    });
    const repository = await this.safeRepository(run.target_repository);
    const terminalSuccess = run.run_state === 'succeeded';
    const approvedEffects = (terminalSuccess ? [] : approvals).map((approval) => ({
      effect: approval.effect,
      expiresAt: approval.expires_at,
    }));
    const refreshAfter = terminalSuccess
      ? null
      : approvals.map((approval) => approval.expires_at).sort().at(0) ?? null;
    const presentation: PresentationCore = {
      schemaVersion: '2',
      runId: run.run_id,
      runVersion: run.run_version,
      runState: run.run_state,
      taskRevision: await this.safeRevision(run.task_revision),
      targetRepository: repository,
      baseSha: plan?.base_sha ?? run.base_sha,
      planVersion: plan?.plan_version ?? null,
      planDigest: plan?.digest ?? null,
      progress: {
        passed: progress?.passed ?? 0,
        total: progress?.total ?? 0,
        requiredPassed: progress?.required_passed ?? 0,
        requiredTotal: progress?.required_total ?? 0,
        inProgress: progress?.in_progress ?? 0,
        failed: progress?.failed ?? 0,
        blocked: progress?.blocked ?? 0,
      },
      currentGoal: this.safeSummary(goal?.title, this.defaultGoal(run.run_state)),
      actionUrl: this.actionUrl(repository, action?.github_run_id),
      checkUrl: safeFeishuDeliveryUrl(check?.external_url),
      checkpointSummary: checkpoint === null
        ? null
        : this.safeSummary(checkpoint.summary, HIDDEN_SUMMARY),
      evidenceSummary: evidence === null
        ? null
        : this.safeSummary(evidence.summary, HIDDEN_SUMMARY),
      evidenceUrl: safeFeishuDeliveryUrl(evidence?.external_url),
      blocker: blocker === null ? null : {
        reason: blocker.reason,
        attemptCount: blocker.attempt_count,
        attemptedPaths: blockerPaths,
        neededHumanInput: blocker.needed_human_input,
      },
      approvedEffects,
      ...projected,
    };
    return {
      run,
      refreshAfter,
      actionEpoch: cardAction?.observed_at ?? null,
      sourceObservedAt: latestTimestamp([
        run.run_updated_at,
        plan?.updated_at,
        progress?.updated_at,
        goal?.updated_at,
        action?.github_external_updated_at,
        checkpoint?.created_at,
        evidence?.observed_at,
        check?.observed_at,
        blocker?.resolved_at ?? blocker?.created_at,
        ...approvals.map((approval) => approval.created_at),
        invalidation?.observed_at,
        approvalAuthority?.observed_at,
        cardAction?.observed_at,
        pr?.updated_at,
        decision?.created_at,
        merge?.created_at,
        testDeploy?.updated_at,
        productionDeploy?.updated_at,
      ]),
      presentation,
    };
  }

  private async plan(run: RunRow): Promise<PlanRow | null> {
    const identities = [run.active_plan_id, run.active_plan_version, run.active_plan_digest];
    if (identities.every((value) => value === null)) return null;
    if (identities.some((value) => value === null)) {
      throw new Error('Feishu delivery card active Plan projection is invalid');
    }
    const plan = await this.db.prepare(
      `SELECT plan_id, plan_version, digest, base_sha, updated_at
       FROM execution_plans WHERE plan_id = ? AND run_id = ?
         AND plan_version = ? AND digest = ?`,
    ).bind(
      run.active_plan_id,
      run.run_id,
      run.active_plan_version,
      run.active_plan_digest,
    ).first<PlanRow>();
    if (plan === null) throw new Error('Feishu delivery card active Plan projection is invalid');
    return plan;
  }

  private async progress(planId: string | null): Promise<ProgressRow | null> {
    if (planId === null) return null;
    return await this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN progress.status = 'passed' THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN items.required = 1 THEN 1 ELSE 0 END) AS required_total,
              SUM(CASE WHEN items.required = 1 AND progress.status = 'passed' THEN 1 ELSE 0 END)
                AS required_passed,
              SUM(CASE WHEN progress.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
              SUM(CASE WHEN progress.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN progress.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
              MAX(progress.updated_at) AS updated_at
       FROM plan_items AS items
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       WHERE items.plan_id = ?`,
    ).bind(planId).first<ProgressRow>();
  }

  private async goal(planId: string | null): Promise<GoalRow | null> {
    if (planId === null) return null;
    return await this.db.prepare(
      `SELECT items.title, progress.updated_at
       FROM plan_items AS items
       JOIN plan_item_progress AS progress
         ON progress.plan_id = items.plan_id AND progress.item_id = items.item_id
       WHERE items.plan_id = ?
       ORDER BY CASE progress.status
         WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'failed' THEN 2
         WHEN 'ready' THEN 3 WHEN 'pending' THEN 4 ELSE 5 END,
         items.position, items.item_id LIMIT 1`,
    ).bind(planId).first<GoalRow>();
  }

  private async approvals(run: RunRow, plan: PlanRow | null, nowIso: string): Promise<ApprovalRow[]> {
    if (plan === null) return [];
    const { results } = await this.db.prepare(
      `SELECT approvals.effect, approvals.expires_at, approvals.created_at
       FROM trusted_effect_approvals AS approvals
       WHERE approvals.run_id = ? AND approvals.task_revision = ?
         AND approvals.plan_id = ? AND approvals.plan_version = ?
         AND approvals.plan_digest = ? AND approvals.base_sha = ?
         AND approvals.decision = 'approve' AND approvals.expires_at > ?
         AND NOT EXISTS (
           SELECT 1 FROM invalidated_approvals
           WHERE invalidated_approvals.approval_id = approvals.approval_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM approvals AS rejection
           WHERE rejection.run_id = approvals.run_id
             AND rejection.task_revision = approvals.task_revision
             AND rejection.plan_id = approvals.plan_id
             AND rejection.plan_version = approvals.plan_version
             AND rejection.plan_digest = approvals.plan_digest
             AND rejection.base_sha = approvals.base_sha
             AND rejection.effect = approvals.effect AND rejection.decision = 'reject'
             AND rejection.created_at >= approvals.created_at
         )
       ORDER BY approvals.effect`,
    ).bind(
      run.run_id,
      run.task_revision,
      plan.plan_id,
      plan.plan_version,
      plan.digest,
      plan.base_sha,
      nowIso,
    ).all<ApprovalRow>();
    return results;
  }

  private async approvalInvalidationTimestamp(runId: string): Promise<TimestampRow | null> {
    return await this.db.prepare(
      `SELECT MAX(invalidated_at) AS observed_at FROM (
         SELECT approval_invalidations.invalidated_at
         FROM approval_invalidations JOIN approvals
           ON approvals.approval_id = approval_invalidations.approval_id
         WHERE approvals.run_id = ?
         UNION ALL
         SELECT base_conflict_approval_invalidations.invalidated_at
         FROM base_conflict_approval_invalidations JOIN approvals
           ON approvals.approval_id = base_conflict_approval_invalidations.approval_id
         WHERE approvals.run_id = ?
         UNION ALL
         SELECT base_rebase_approval_invalidations.invalidated_at
         FROM base_rebase_approval_invalidations JOIN approvals
           ON approvals.approval_id = base_rebase_approval_invalidations.approval_id
         WHERE approvals.run_id = ?
       )`,
    ).bind(runId, runId, runId).first<TimestampRow>();
  }

  private async approvalAuthorityTimestamp(runId: string): Promise<TimestampRow | null> {
    return await this.db.prepare(
      `SELECT MAX(updated_at) AS observed_at FROM (
         SELECT identity_mappings.updated_at
         FROM identity_bound_approvals AS bindings
         JOIN approvals ON approvals.approval_id = bindings.approval_id
         JOIN identity_mappings ON identity_mappings.principal = bindings.approver_principal
         WHERE approvals.run_id = ?
         UNION ALL
         SELECT channel_identities.updated_at
         FROM identity_bound_approvals AS bindings
         JOIN approvals ON approvals.approval_id = bindings.approval_id
         JOIN channel_identities ON (
           (channel_identities.channel = bindings.approver_channel AND
            channel_identities.channel_user_id = bindings.approver_channel_user_id) OR
           (channel_identities.channel = bindings.pull_request_author_channel AND
            channel_identities.channel_user_id = bindings.pull_request_author_login)
         )
         WHERE approvals.run_id = ?
         UNION ALL
         SELECT identity_mappings.updated_at
         FROM feishu_card_action_approval_bindings AS bindings
         JOIN approvals ON approvals.approval_id = bindings.approval_id
         JOIN identity_mappings ON identity_mappings.principal = bindings.approver_principal
         WHERE approvals.run_id = ?
         UNION ALL
         SELECT channel_identities.updated_at
         FROM feishu_card_action_approval_bindings AS bindings
         JOIN approvals ON approvals.approval_id = bindings.approval_id
         JOIN channel_identities
           ON channel_identities.channel = bindings.approver_channel
          AND channel_identities.channel_user_id = bindings.approver_channel_user_id
         WHERE approvals.run_id = ?
       )`,
    ).bind(runId, runId, runId, runId).first<TimestampRow>();
  }

  private async blockerPaths(runId: string, retryScopeDigest: string): Promise<AttemptedPath[]> {
    const { results } = await this.db.prepare(
      `SELECT paths.path_code
       FROM attempt_failures AS failures
       JOIN attempt_failure_paths AS paths ON paths.failure_id = failures.failure_id
       WHERE failures.run_id = ? AND failures.retry_scope_digest = ?
       ORDER BY failures.attempt_ordinal, paths.position`,
    ).bind(runId, retryScopeDigest).all<{ path_code: string }>();
    const allowed = new Set<string>(ATTEMPTED_PATHS);
    const paths = [...new Set(results.map((row) => row.path_code))];
    if (paths.some((path) => !allowed.has(path))) {
      throw new Error('Feishu delivery card blocker path is invalid');
    }
    return paths as AttemptedPath[];
  }

  private safeSummary(raw: string | null | undefined, fallback: string): string {
    if (raw === null || raw === undefined) return fallback;
    const bounded = [...raw].slice(0, 4_096).join('');
    if (this.scanner.scanText(bounded).length > 0) {
      return HIDDEN_SUMMARY;
    }
    const withoutControls = [...bounded.normalize('NFKC')].map((character) => {
      const code = character.charCodeAt(0);
      const directional = (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      const zeroWidth = code >= 0x200b && code <= 0x200f;
      return code < 32 || code === 127 || directional || zeroWidth ? ' ' : character;
    }).join('');
    const normalized = withoutControls.replaceAll(/\s+/g, ' ').trim();
    if (normalized.length === 0) return fallback;
    return [...normalized].slice(0, 240).join('');
  }

  private async safeRevision(raw: string): Promise<string> {
    if (
      raw.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(raw) &&
      this.scanner.scanText(raw).length === 0
    ) return raw;
    const digest = await canonicalSha256({ kind: 'task_revision', value: raw });
    return `revision-digest:${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
  }

  private async safeRepository(raw: string): Promise<string> {
    if (REPOSITORY_PATTERN.test(raw) && this.scanner.scanText(raw).length === 0) return raw;
    const digest = await canonicalSha256({ kind: 'target_repository', value: raw });
    return `repository-digest:${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
  }

  private async cardActions(
    snapshot: ProjectionSnapshot,
    cardId: string,
    presentationId: string,
    taskRevisionDigest: string,
    effects: FeishuCardApprovalEffect[],
  ): Promise<FeishuCardActionCommand[]> {
    if (snapshot.run.run_state === 'succeeded' || snapshot.run.run_state === 'cancelled') {
      return [];
    }
    const planId = snapshot.run.active_plan_id;
    const planVersion = snapshot.run.active_plan_version;
    const planDigest = snapshot.run.active_plan_digest;
    const baseSha = snapshot.presentation.baseSha;
    if (
      planId === null || planVersion === null || planDigest === null || baseSha === null ||
      snapshot.presentation.planVersion !== planVersion ||
      snapshot.presentation.planDigest !== planDigest
    ) return [];
    const commands: Array<
      | { command: 'approve' | 'reject'; effect: FeishuCardApprovalEffect }
      | { command: 'cancel'; effect: 'cancel_run' }
      | { command: 'retry'; effect: 'retry_run' }
      | { command: 'replay'; effect: 'replay_run' }
      | {
          command: 'add_context';
          effect: 'add_context';
          contextMode: 'new_run' | 'apply_current';
        }
    > = [];
    for (const effect of effects) {
      commands.push({ command: 'approve', effect }, { command: 'reject', effect });
    }
    if (CARD_CANCELLABLE_STATES.has(snapshot.run.run_state)) {
      commands.push({ command: 'cancel', effect: 'cancel_run' });
    }
    if (snapshot.run.run_state === 'blocked') {
      commands.push({ command: 'retry', effect: 'retry_run' });
    }
    commands.push(
      { command: 'replay', effect: 'replay_run' },
      { command: 'add_context', effect: 'add_context', contextMode: 'new_run' },
      { command: 'add_context', effect: 'add_context', contextMode: 'apply_current' },
    );
    const actions: FeishuCardActionCommand[] = [];
    for (const [index, command] of commands.entries()) {
      const actionId = `delivery-loop:${command.command}:${command.effect}:${index}`;
      const nonceDigest = await canonicalSha256({
        cardId,
        presentationId,
        actionId,
        command,
      });
      actions.push(FeishuCardActionCommandSchema.parse({
        schemaVersion: '1',
        actionId,
        cardId,
        presentationId,
        taskId: snapshot.run.task_id,
        runId: snapshot.run.run_id,
        runVersion: snapshot.run.run_version,
        taskRevision: snapshot.presentation.taskRevision,
        taskRevisionDigest,
        planId,
        planVersion,
        planDigest,
        baseSha,
        nonce: `fa_${nonceDigest.slice('sha256:'.length)}`,
        ...command,
      }));
    }
    return actions;
  }

  private async cardApprovalEffects(planId: string | null): Promise<FeishuCardApprovalEffect[]> {
    if (planId === null) return [];
    const { results } = await this.db.prepare(
      `SELECT DISTINCT effect FROM plan_item_effects
       WHERE plan_id = ? ORDER BY effect`,
    ).bind(planId).all<{ effect: string }>();
    return results.map((row) => row.effect).filter(
      (effect): effect is FeishuCardApprovalEffect =>
        MUTATING_CARD_EFFECTS.has(effect as FeishuCardApprovalEffect),
    );
  }

  private actionUrl(repository: string, githubRunId: string | undefined): string | null {
    if (!REPOSITORY_PATTERN.test(repository) || githubRunId === undefined ||
      !GITHUB_RUN_ID_PATTERN.test(githubRunId)) return null;
    return safeFeishuDeliveryUrl(`https://github.com/${repository}/actions/runs/${githubRunId}`);
  }

  private defaultGoal(state: RunState): string {
    if (state === 'received' || state === 'triaging' || state === 'planning') {
      return '生成并核验 ExecutionPlan';
    }
    if (state === 'awaiting_approval') return '等待所需 effects 获得批准';
    if (state === 'succeeded') return '交付已完成';
    if (state === 'cancelled') return '运行已取消';
    return '等待下一项可执行 DoD Item';
  }

  private async stableId(prefix: string, value: unknown): Promise<string> {
    const digest = await canonicalSha256(value);
    return `${prefix}_${digest.slice('sha256:'.length, 'sha256:'.length + 52)}`;
  }
}
