import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('periodic external-fact reconciliation wiring', () => {
  it('runs GitHub and Feishu missed-result recovery from the one-minute Cron', () => {
    const wrangler = JSON.parse(
      readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    ) as { triggers: { crons: string[] } };
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const testDeploymentRuntime = readFileSync(
      new URL('../src/outbox/github-test-deployment-runtime.ts', import.meta.url),
      'utf8',
    );
    const feishuRuntime = readFileSync(
      new URL('../src/outbox/feishu-delivery-card-runtime.ts', import.meta.url),
      'utf8',
    );

    expect(wrangler.triggers.crons).toContain('* * * * *');
    expect(worker).toContain('reconcileTestDeploymentsFromEnv(env)');
    expect(worker).toContain('reconcileFeishuDeliveryCardsFromEnv(env)');
    expect(worker).toContain('reconcileWorkflowInstancesFromEnv(env)');
    expect(testDeploymentRuntime).toContain('runtime.statusReconciler.reconcileBatch(25)');
    expect(feishuRuntime).toContain('runtime.messageReconciler.reconcileBatch(25)');
  });

  it('activates approved work and relays its dispatch before optional Cron work', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const workflowDrain = worker.indexOf(').drain(5);');
    const priorityExecutionScheduling = worker.indexOf(
      'await executionProgress.reconcileScheduling(1);',
    );
    const priorityRelay = worker.indexOf('await relay.relay();');
    const priorityPullRequestReconciliation = worker.indexOf(
      'await reconcileGitHubPullRequestsFromEnv(env);',
      priorityRelay,
    );
    const priorityAutomatedReviewScheduling = worker.indexOf(
      'await new AutomatedReviewScheduler(env.DB_CONTROL).scheduleBatch(5, scheduledNow());',
      priorityPullRequestReconciliation,
    );
    const priorityReviewRelay = worker.indexOf(
      'await relay.relay();',
      priorityAutomatedReviewScheduling,
    );
    const preparedPlanRevisionRecovery = worker.indexOf(
      'await planRevisionAnalysis.reconcilePreparedPlans(1);',
      priorityReviewRelay,
    );
    const planRevisionAnalysisRecovery = worker.indexOf(
      'await planRevisionAnalysis.reconcileBatch(5);',
      workflowDrain,
    );
    const reviewAttemptRecovery = worker.indexOf(
      'await recoverLostGitHubReviewFeedbacksFromEnv(env);',
      workflowDrain,
    );
    const reviewApprovalRecovery = worker.indexOf(
      'await recoverApprovedGitHubReviewFeedbacksFromEnv(env);',
      reviewAttemptRecovery,
    );
    const readyAttemptScheduling = worker.indexOf(
      'await executionProgress.reconcileReadyAttempts(1);',
      reviewApprovalRecovery,
    );
    const relay = worker.indexOf('await relay.relay();', priorityReviewRelay + 1);
    const priorityFinalization = worker.indexOf(
      'await executionProgress.reconcileFinalizations(1);',
      relay,
    );
    const preparedPublicationRecovery = worker.indexOf(
      'await executionProgress.reconcilePreparedPublications(1);',
      relay,
    );
    const executionScheduling = worker.indexOf(
      'await executionProgress.reconcileScheduling(5);',
      relay,
    );
    const atRiskGitHubReconciliation = worker.indexOf(
      'await reconcileAtRiskGitHubRunsFromEnv(env, {',
      workflowDrain,
    );
    const executionFinalization = worker.indexOf(
      'await executionProgress.reconcileObservedCompletions(5);',
      atRiskGitHubReconciliation,
    );
    const detectorEnd = worker.indexOf('}).scan(5);');
    const concurrentStart = worker.indexOf('await Promise.all([', detectorEnd);
    const concurrentEnd = worker.indexOf(']);', concurrentStart);
    const workflowReconciliation = worker.indexOf(
      'reconcileWorkflowInstancesFromEnv(env),',
      concurrentStart,
    );
    const backgroundGitHubReconciliation = worker.indexOf(
      'reconcileGitHubRunsFromEnv(env, 1),',
      concurrentStart,
    );

    expect(workflowDrain).toBeGreaterThan(-1);
    expect(priorityExecutionScheduling).toBeGreaterThan(-1);
    expect(priorityExecutionScheduling).toBeLessThan(priorityRelay);
    expect(priorityPullRequestReconciliation).toBeGreaterThan(priorityRelay);
    expect(priorityAutomatedReviewScheduling).toBeGreaterThan(
      priorityPullRequestReconciliation,
    );
    expect(priorityReviewRelay).toBeGreaterThan(priorityAutomatedReviewScheduling);
    expect(priorityReviewRelay).toBeLessThan(preparedPlanRevisionRecovery);
    expect(preparedPlanRevisionRecovery).toBeGreaterThan(priorityReviewRelay);
    expect(preparedPlanRevisionRecovery).toBeLessThan(workflowDrain);
    expect(priorityRelay).toBeLessThan(workflowDrain);
    expect(reviewAttemptRecovery).toBeGreaterThan(workflowDrain);
    expect(reviewApprovalRecovery).toBeGreaterThan(reviewAttemptRecovery);
    expect(readyAttemptScheduling).toBeGreaterThan(reviewApprovalRecovery);
    expect(readyAttemptScheduling).toBeLessThan(atRiskGitHubReconciliation);
    expect(reviewApprovalRecovery).toBeLessThan(atRiskGitHubReconciliation);
    expect(reviewAttemptRecovery).toBeLessThan(atRiskGitHubReconciliation);
    expect(atRiskGitHubReconciliation).toBeGreaterThan(workflowDrain);
    expect(executionFinalization).toBeGreaterThan(atRiskGitHubReconciliation);
    expect(planRevisionAnalysisRecovery).toBeGreaterThan(executionFinalization);
    expect(planRevisionAnalysisRecovery).toBeLessThan(relay);
    expect(reviewAttemptRecovery).toBeLessThan(relay);
    expect(relay).toBeGreaterThan(priorityRelay);
    expect(workflowDrain).toBeLessThan(relay);
    expect(preparedPublicationRecovery).toBeGreaterThan(relay);
    expect(preparedPublicationRecovery).toBeLessThan(priorityFinalization);
    expect(priorityFinalization).toBeGreaterThan(relay);
    expect(priorityFinalization).toBeLessThan(executionScheduling);
    expect(executionScheduling).toBeGreaterThan(relay);
    expect(executionFinalization).toBeLessThan(relay);
    expect(detectorEnd).toBeGreaterThan(-1);
    expect(executionFinalization).toBeLessThan(detectorEnd);
    expect(concurrentStart).toBeGreaterThan(detectorEnd);
    expect(concurrentEnd).toBeGreaterThan(concurrentStart);
    expect(workflowReconciliation).toBeGreaterThan(concurrentStart);
    expect(workflowReconciliation).toBeLessThan(concurrentEnd);
    expect(backgroundGitHubReconciliation).toBeGreaterThan(concurrentStart);
    expect(backgroundGitHubReconciliation).toBeLessThan(concurrentEnd);
    expect(worker.slice(workflowDrain, concurrentStart)).not.toContain(
      'reconcileWorkflowInstancesFromEnv(env)',
    );
    expect(worker.slice(reviewAttemptRecovery + 1)).not.toContain(
      'await recoverLostGitHubReviewFeedbacksFromEnv(env);',
    );
    expect(worker.slice(reviewApprovalRecovery + 1)).not.toContain(
      'await recoverApprovedGitHubReviewFeedbacksFromEnv(env);',
    );
    expect(worker.slice(relay, atRiskGitHubReconciliation)).not.toContain(
      'reconcileGitHubRunsFromEnv(env',
    );
    expect(worker.slice(concurrentStart, concurrentEnd)).not.toContain('relay.relay()');
    expect(worker.slice(concurrentStart, concurrentEnd)).not.toContain(
      'reconcileGitHubPullRequestsFromEnv(env)',
    );
    expect(worker.slice(priorityPullRequestReconciliation + 1)).not.toContain(
      'await reconcileGitHubPullRequestsFromEnv(env);',
    );
    expect(worker.slice(priorityAutomatedReviewScheduling + 1)).not.toContain(
      'await new AutomatedReviewScheduler(env.DB_CONTROL).scheduleBatch(5, scheduledNow());',
    );
  });
});
