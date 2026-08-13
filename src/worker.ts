import { Hono } from 'hono';
import type { Bindings } from './env.js';
import { secureStructuredLogSink } from './observability/structured-log.js';
import { configuredSecrets } from './security/runtime-secrets.js';
import { R2BackupManager } from './backup/r2-backup-manager.js';
import { backupApi } from './http/backup-api.js';
import { case8AuditApi } from './http/case8-audit-api.js';
import { approvalApi } from './http/approval-api.js';
import { attemptApi } from './http/attempt-api.js';
import { correlationApi } from './http/correlation-api.js';
import { deadLetterApi } from './http/dead-letter-api.js';
import { dataRetentionApi } from './http/data-retention-api.js';
import { diagnosticEvidenceApi } from './http/diagnostic-evidence-api.js';
import { errorResponse } from './http/errors.js';
import { feishuWebhookApi } from './http/feishu-webhook-api.js';
import { feishuWebhookEvidenceApi } from './http/feishu-webhook-evidence-api.js';
import { feishuIngressEvidenceApi } from './http/feishu-ingress-evidence-api.js';
import { feishuDeliveryCardRefreshApi } from './http/feishu-delivery-card-refresh-api.js';
import { feishuCardPresentationEvidenceApi } from './http/feishu-card-presentation-evidence-api.js';
import { feishuCardActionEvidenceApi } from './http/feishu-card-action-evidence-api.js';
import { supplementalContextEvidenceApi } from './http/supplemental-context-evidence-api.js';
import { githubWebhookApi } from './http/github-webhook-api.js';
import { githubCommitApprovalApi } from './http/github-commit-approval-api.js';
import { meegleTriageApi } from './http/meegle-triage-api.js';
import { meegleWorkItemEvidenceApi } from './http/meegle-work-item-evidence-api.js';
import { monitorAlertApi } from './http/monitor-alert-api.js';
import { taskApi } from './http/task-api.js';
import { testAcceptanceApi } from './http/test-acceptance-api.js';
import { testDeploymentApi } from './http/test-deployment-api.js';
import { testRollbackApi } from './http/test-rollback-api.js';
import { productionDeploymentApi } from './http/production-deployment-api.js';
import { githubDispatchProcessorFromEnv } from './outbox/github-dispatch-runtime.js';
import {
  githubTestAcceptanceRuntimeFromEnv,
  reconcileTestAcceptancesFromEnv,
} from './outbox/github-test-acceptance-runtime.js';
import {
  githubTestDeploymentRuntimeFromEnv,
  reconcileTestDeploymentsFromEnv,
} from './outbox/github-test-deployment-runtime.js';
import {
  githubTestRollbackRuntimeFromEnv,
  reconcileTestRollbacksFromEnv,
} from './outbox/github-test-rollback-runtime.js';
import {
  githubProductionDeploymentRuntimeFromEnv,
  reconcileProductionDeploymentsFromEnv,
} from './outbox/github-production-deployment-runtime.js';
import {
  githubPullRequestRuntimeFromEnv,
  reconcileGitHubPullRequestsFromEnv,
} from './outbox/github-pull-request-runtime.js';
import {
  feishuDeliveryCardRuntimeFromEnv,
  reconcileFeishuDeliveryCardsFromEnv,
} from './outbox/feishu-delivery-card-runtime.js';
import {
  OutboxDestinationRouter,
  consumeOutboxBatch,
} from './outbox/outbox-queue-consumer.js';
import {
  FEISHU_INGRESS_DEAD_LETTER_QUEUE_NAME,
  FEISHU_INGRESS_QUEUE_NAME,
  FeishuIngressRelay,
  consumeFeishuIngressBatch,
  consumeFeishuIngressDeadLetterBatch,
} from './outbox/feishu-ingress.js';
import {
  OUTBOX_DEAD_LETTER_QUEUE,
  PRIMARY_OUTBOX_QUEUE,
  OutboxDeadLetterStore,
  consumeOutboxDeadLetterBatch,
} from './outbox/outbox-dead-letter.js';
import {
  CloudflareWorkflowEffectClient,
  WorkflowOutboxRelay,
  WorkflowOutboxProcessor,
  type RelayDestination,
  type WorkflowOutboxMessage,
} from './outbox/workflow-outbox.js';
import {
  reconcileAtRiskGitHubRunsFromEnv,
  reconcileGitHubRunsFromEnv,
} from './reconciliation/github-run-reconciliation-runtime.js';
import { reconcileGitHubBasesFromEnv } from './reconciliation/github-base-observation-runtime.js';
import { InitialAnalysisReconciler } from './reconciliation/initial-analysis-reconciler.js';
import { reconcileGitHubMergeGatesFromEnv } from './reconciliation/github-merge-gate-runtime.js';
import {
  reconcileGitHubReviewFeedbacksFromEnv,
  recoverApprovedGitHubReviewFeedbacksFromEnv,
  recoverLostGitHubReviewFeedbacksFromEnv,
} from './reconciliation/github-review-feedback-runtime.js';
import { reconcileGitHubMergeStatusesFromEnv } from './reconciliation/github-merge-status-runtime.js';
import { reconcileGitHubProductionDeploymentStatusesFromEnv } from './reconciliation/github-production-deployment-status-runtime.js';
import { BaseRebaseAttemptReconciler } from './reconciliation/base-rebase-attempt-reconciler.js';
import { ExecutionProgressReconciler } from './reconciliation/execution-progress-reconciler.js';
import { PlanRevisionAnalysisReconciler } from
  './reconciliation/plan-revision-analysis-reconciler.js';
import { revokeRepoWriteCredentialsFromEnv } from './reconciliation/repo-write-credential-runtime.js';
import { RunStuckDetector } from './reconciliation/run-stuck-detector.js';
import { reconcileWorkflowInstancesFromEnv } from './reconciliation/workflow-instance-reconciler.js';
import { QuotaControlStore } from './storage/quota-control-store.js';
import { BackupRestoreCoordinator } from './storage/backup-restore-store.js';
import { DataRetentionStore } from './storage/data-retention-store.js';
import { AutomatedReviewScheduler } from './storage/automated-review-store.js';

export { DeliveryRunWorkflow } from './workflows/delivery-run-workflow.js';
export { ControlPlaneBackupWorkflow } from './workflows/control-plane-backup-workflow.js';

export const app = new Hono<{ Bindings: Bindings }>();

function recovery(env: Bindings): BackupRestoreCoordinator {
  return new BackupRestoreCoordinator(
    env.DB_CONTROL,
    new R2BackupManager(env.BACKUP_OBJECTS, {
      task: env.TASK_OBJECTS,
      checkpoint: env.CHECKPOINT_OBJECTS,
    }),
  );
}

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const revokedAttemptContextProbe = c.req.method === 'GET' &&
    /^\/v1\/attempts\/[A-Za-z0-9_-]+\/context$/.test(path);
  if (
    path === '/healthz' || path === '/v1/backups' ||
    path.startsWith('/v1/restores/') || revokedAttemptContextProbe
  ) {
    await next();
    return;
  }
  const state = await recovery(c.env).servingState();
  if (state.servingState !== 'active') {
    return errorResponse(c, 503, 'unavailable', 'control plane restore in progress', true);
  }
  await next();
});

app.get('/healthz', (c) => c.json({ ok: true, service: 'delivery-loop-control-plane' }));
app.route('/', backupApi());
app.route('/', case8AuditApi());
app.route('/', approvalApi());
app.route('/', attemptApi());
app.route('/', correlationApi());
app.route('/', deadLetterApi());
app.route('/', dataRetentionApi());
app.route('/', diagnosticEvidenceApi());
app.route('/', feishuWebhookApi());
app.route('/', feishuWebhookEvidenceApi());
app.route('/', feishuIngressEvidenceApi());
app.route('/', feishuCardPresentationEvidenceApi());
app.route('/', feishuCardActionEvidenceApi());
app.route('/', supplementalContextEvidenceApi());
app.route('/', feishuDeliveryCardRefreshApi());
app.route('/', githubWebhookApi());
app.route('/', githubCommitApprovalApi());
app.route('/', meegleTriageApi());
app.route('/', meegleWorkItemEvidenceApi());
app.route('/', monitorAlertApi());
app.route('/', taskApi());
app.route('/', testAcceptanceApi());
app.route('/', testDeploymentApi());
app.route('/', testRollbackApi());
app.route('/', productionDeploymentApi());
app.notFound((c) => errorResponse(c, 404, 'not_found', 'route not found', false));
app.onError((error, c) => {
  secureStructuredLogSink({
    component: 'control_plane',
    level: 'error',
    secrets: configuredSecrets(c.env),
  })({
    schemaVersion: '1',
    event: 'unhandled_error',
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    errorName: error.name,
  });
  return errorResponse(c, 500, 'internal', 'internal error', true);
});

export default {
  fetch: app.fetch,
  scheduled(controller, env, context): void {
    const scheduledNow = () => new Date(controller.scheduledTime);
    const githubDispatch = githubDispatchProcessorFromEnv(env);
    const githubPullRequests = githubPullRequestRuntimeFromEnv(env);
    const githubTestDeployments = githubTestDeploymentRuntimeFromEnv(env);
    const githubTestAcceptances = githubTestAcceptanceRuntimeFromEnv(env);
    const githubTestRollbacks = githubTestRollbackRuntimeFromEnv(env);
    const githubProductionDeployments = githubProductionDeploymentRuntimeFromEnv(env);
    const feishuCards = feishuDeliveryCardRuntimeFromEnv(env);
    const destinations: RelayDestination[] = ['cloudflare_workflows'];
    if (githubDispatch !== null) destinations.push('github_actions');
    if (githubPullRequests !== null) destinations.push('github_api');
    if (githubTestDeployments !== null) destinations.push(githubTestDeployments.destination);
    if (githubTestAcceptances !== null) destinations.push('github_acceptance');
    if (githubTestRollbacks !== null) destinations.push('github_test_rollback');
    if (githubProductionDeployments !== null) {
      destinations.push('github_production_deployments');
    }
    if (feishuCards !== null) destinations.push('feishu_cards');
    const relay = new WorkflowOutboxRelay(
      env.DB_CONTROL,
      env.WORKFLOW_OUTBOX_QUEUE,
      destinations,
    );
    context.waitUntil((async () => {
      const recoveryState = await recovery(env).servingState();
      if (recoveryState.servingState !== 'active') {
        // External credential revocation is the only effect allowed while the
        // recovered database remains fenced. Completion proves it converged.
        await revokeRepoWriteCredentialsFromEnv(env);
        return;
      }
      const workflowOutbox = new WorkflowOutboxProcessor(
        env.DB_CONTROL,
        new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
      );
      // A Task accepted with a trusted base already has its unique root
      // Workflow intent in D1. Deliver one such create before any GitHub/R2
      // observation: older cancellation or signal effects and the Free-plan
      // CPU fence must not leave a fresh Run queued without ever being claimed.
      await workflowOutbox.drainCreates(1);
      const executionProgress = new ExecutionProgressReconciler(
        env.DB_CONTROL,
        env.TASK_OBJECTS,
        { now: scheduledNow },
      );
      const planRevisionAnalysis = new PlanRevisionAnalysisReconciler(env.DB_CONTROL, {
        now: scheduledNow,
      });
      const initialAnalysis = new InitialAnalysisReconciler(env.DB_CONTROL, {
        now: scheduledNow,
      });
      // An exact human approval is already a durable external fact. Activate
      // and claim one approved Item before any recovery or observation scan can
      // consume the Free-plan 10 ms CPU budget.
      await executionProgress.reconcileScheduling(1);
      // The claim above may have created the only approved execution dispatch.
      // Relay one GitHub Actions outbox ID immediately: later GitHub reads and
      // R2-backed completion can exhaust the same CPU budget. Destination
      // filtering does not bypass D1 fencing; the Queue consumer still reloads
      // the immutable outbox and Attempt before performing any effect.
      await relay.relayDestination('github_actions', 1);
      // This D1-only recovery binds one exact blocked analysis lineage. Run it
      // before any GitHub GET: a Free-plan scheduled invocation can otherwise
      // exhaust its CPU budget on external observation before reaching the
      // background recovery section every minute.
      if (await initialAnalysis.reconcilePlaintextSourceFailures(1) > 0) {
        await relay.relayDestination('github_actions', 1);
      } else if (await initialAnalysis.reconcileSourceSnapshotCapacityFailures(1) > 0) {
        await relay.relayDestination('github_actions', 1);
      } else if (await initialAnalysis.reconcileToolBridgeSecretValueFailures(1) > 0) {
        await relay.relayDestination('github_actions', 1);
      } else if (await initialAnalysis.reconcileToolBridgeScopeFailures(1) > 0) {
        await relay.relayDestination('github_actions', 1);
      } else if (await initialAnalysis.reconcileToolBridgeTransportFailures(1) > 0) {
        await relay.relayDestination('github_actions', 1);
      } else if (await initialAnalysis.reconcileToolBridgeFailures(1) > 0) {
        await relay.relayDestination('github_actions', 1);
      }
      // A Draft PR already created by an earlier invocation is the shortest
      // active-run path to the automated review loop. Observe that exact PR
      // before stale at-risk Action recovery: on the Free plan, one historical
      // GitHub GET can otherwise consume the scheduled invocation's CPU budget
      // every minute and permanently starve the fresh publication. The
      // publication/run/version fences still select only current verifying
      // work; review scheduling and this destination-only relay remain D1
      // idempotent and cannot create a second PR or review for the same head.
      await reconcileGitHubPullRequestsFromEnv(env, 1);
      await new AutomatedReviewScheduler(env.DB_CONTROL).scheduleBatch(5, scheduledNow());
      await relay.relayDestination('github_actions', 1);
      // A re-analysis Runner may already have persisted a validated
      // replacement Plan, its result projection, and the durable signal. This
      // recovery is D1-only, so activate one before any global relay or
      // external observation can starve the next approval boundary.
      await planRevisionAnalysis.reconcilePreparedPlans(1);
      // The root Workflow still waits for its immutable first Attempt event.
      // A bounded replacement therefore advances the D1 business projection
      // directly after its callback is durable; no Workflow restart is needed.
      await initialAnalysis.reconcilePreparedPlans(1);
      // A fresh identity-bound approval may already have fenced an exact
      // pre-effect review failure and made its unique replacement ready. This
      // recovery is D1-only; create and relay one replacement before a stale
      // GitHub observation can consume the Free-plan scheduled CPU budget.
      if ((await recoverApprovedGitHubReviewFeedbacksFromEnv(env)).length > 0) {
        await relay.relayDestination('github_actions', 1);
      }
      // A completed Action is the authority needed to verify Evidence and
      // close its Plan Item. Project stale active runs before even the global
      // relay: that relay scans historical pending outbox rows and can exhaust
      // the same CPU budget before the one exact GitHub GET. The newly claimed
      // dispatch was already offered to Queue above; duplicate Queue delivery
      // remains D1-fenced.
      await reconcileAtRiskGitHubRunsFromEnv(env, {
        limit: 5,
        runningThresholdSeconds: 90,
        now: scheduledNow,
      });
      // A read-only automated review runs while the business Run remains at
      // pull_request_open, outside the generic execution stuck states. Once
      // GitHub has authoritatively projected a failed Action and its lease is
      // expired, fence the root Attempt and create one head-bound replacement
      // entirely in D1. Relay only when that bounded recovery found work.
      const automatedReviews = new AutomatedReviewScheduler(env.DB_CONTROL);
      const redispatched = await automatedReviews
        .redispatchFailedReplacementsBatch(1, scheduledNow());
      if (redispatched.length > 0 ||
        (await automatedReviews.recoverFailedBatch(1, scheduledNow())).length > 0) {
        await relay.relayDestination('github_actions', 1);
      }
      // Once GitHub success and the complete verification ledger are durable,
      // project one Attempt/Item completion before any further external read.
      // R2-backed Draft creation stays below the base observer so a moved main
      // cannot race publication authority derived from the old base.
      await executionProgress.reconcileAttemptCompletions(1);
      // A new protected main invalidates execution and publication authority
      // derived from the old base. Observe one eligible base before prepared
      // Draft recovery or any global relay can consume the scheduled CPU
      // budget; the resulting revision/analysis dispatch remains D1-fenced.
      await reconcileGitHubBasesFromEnv(env, 1);
      // A prior invocation may have completed the R2-backed immutable Draft
      // but lost CPU before scheduling its D1 publication. Recover that cheap
      // prepared state before the completion path can attempt R2 work again.
      await executionProgress.reconcilePreparedPublications(1);
      await executionProgress.reconcileFinalizations(5);
      await relay.relay();
      // Free-plan scheduled and Queue invocations have a 10 ms CPU ceiling.
      // Keep a direct workflow-root delivery after the priority relay so a
      // Queue delay cannot strand Task creation, without starving an already
      // approved Run before its first execution dispatch is durable.
      await workflowOutbox.drain(5);
      // Lost pre-effect review work already has a settled Workflow fence. Its
      // bounded D1-only recovery must run before external scans can consume the
      // Free-plan CPU budget; the new dispatch remains durable for relay.
      await recoverLostGitHubReviewFeedbacksFromEnv(env);
      // A Run already activated by an exact approval has no remaining external
      // read dependency. Claim one ready Item before higher-cost observation
      // work can exhaust the Free-plan scheduled CPU budget; the resulting
      // dispatch stays durable and is relayed below.
      await executionProgress.reconcileReadyAttempts(1);
      await new AutomatedReviewScheduler(env.DB_CONTROL).resumeFixedRuns(5, scheduledNow());
      await initialAnalysis.reconcileCapacityFailures(1);
      await initialAnalysis.reconcileInventoryAdapterFailures(1);
      await initialAnalysis.reconcileFailedAttempts(5);
      await planRevisionAnalysis.reconcileBatch(5);
      // Relay every remaining durable effect, then activate and schedule more
      // work. Prepared Draft recovery already ran before the first relay, so
      // this background half cannot become its only recovery opportunity.
      await relay.relay();
      await executionProgress.reconcileScheduling(5);
      // Detect/re-arm after existing outbox and execution progress have had a
      // chance to advance. Re-armed effects remain safe for the next minute.
      await new RunStuckDetector(env.DB_CONTROL, {
        now: scheduledNow,
        sink: secureStructuredLogSink({
          component: 'run_stuck',
          secrets: configuredSecrets(env),
        }),
      }).scan(5);
      // Recover missed review webhooks before merge/base readers can race the
      // same pull_request_open Run-version transition.
      await reconcileGitHubReviewFeedbacksFromEnv(env);
      await Promise.all([
        reconcileWorkflowInstancesFromEnv(env),
        reconcileGitHubRunsFromEnv(env, 1),
        new FeishuIngressRelay(env.DB_CONTROL, env.FEISHU_INGRESS_QUEUE).relay(),
        reconcileGitHubMergeGatesFromEnv(env),
        reconcileGitHubMergeStatusesFromEnv(env),
        reconcileGitHubProductionDeploymentStatusesFromEnv(env),
        new BaseRebaseAttemptReconciler(env.DB_CONTROL).reconcileBatch(25),
        reconcileTestDeploymentsFromEnv(env),
        reconcileTestAcceptancesFromEnv(env),
        reconcileTestRollbacksFromEnv(env),
        reconcileProductionDeploymentsFromEnv(env),
        reconcileFeishuDeliveryCardsFromEnv(env),
        revokeRepoWriteCredentialsFromEnv(env),
        new QuotaControlStore(env.DB_CONTROL).reconcile(),
        new OutboxDeadLetterStore(env.DB_CONTROL).reconcile(100),
        new DataRetentionStore(env.DB_CONTROL, env.RAW_AGENT_OBJECTS)
          .run('execute', 'scheduled', 25),
      ]);
    })());
  },
  async queue(batch: MessageBatch<WorkflowOutboxMessage>, env): Promise<void> {
    if ((await recovery(env).servingState()).servingState !== 'active') {
      batch.retryAll();
      return;
    }
    if (batch.queue === OUTBOX_DEAD_LETTER_QUEUE) {
      await consumeOutboxDeadLetterBatch(
        batch,
        new OutboxDeadLetterStore(env.DB_CONTROL),
        new Date(),
        secureStructuredLogSink({
          component: 'outbox_dead_letter',
          secrets: configuredSecrets(env),
        }),
      );
      return;
    }
    if (batch.queue === FEISHU_INGRESS_QUEUE_NAME) {
      await consumeFeishuIngressBatch(batch, env.DB_CONTROL);
      return;
    }
    if (batch.queue === FEISHU_INGRESS_DEAD_LETTER_QUEUE_NAME) {
      await consumeFeishuIngressDeadLetterBatch(batch, env.DB_CONTROL);
      return;
    }
    if (batch.queue !== PRIMARY_OUTBOX_QUEUE) {
      batch.ackAll();
      return;
    }
    const workflowProcessor = new WorkflowOutboxProcessor(
      env.DB_CONTROL,
      new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
    );
    const githubPullRequests = githubPullRequestRuntimeFromEnv(env);
    const githubTestDeployments = githubTestDeploymentRuntimeFromEnv(env);
    const githubTestAcceptances = githubTestAcceptanceRuntimeFromEnv(env);
    const githubTestRollbacks = githubTestRollbackRuntimeFromEnv(env);
    const githubProductionDeployments = githubProductionDeploymentRuntimeFromEnv(env);
    const feishuCards = feishuDeliveryCardRuntimeFromEnv(env);
    const router = new OutboxDestinationRouter(
      env.DB_CONTROL,
      workflowProcessor,
      githubDispatchProcessorFromEnv(env),
      githubPullRequests?.processor ?? null,
      githubTestDeployments?.destination === 'github_deployments'
        ? githubTestDeployments.processor : null,
      githubTestAcceptances?.processor ?? null,
      githubProductionDeployments?.processor ?? null,
      githubTestRollbacks?.processor ?? null,
      feishuCards?.processor ?? null,
      githubTestDeployments?.destination === 'yunxiao_pipelines'
        ? githubTestDeployments.processor : null,
    );
    await consumeOutboxBatch(batch, router);
  },
} satisfies ExportedHandler<Bindings, WorkflowOutboxMessage>;
