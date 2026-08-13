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

  it('activates approved work and projects completed Actions before the global relay', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const priorityWorkflowCreateDrain = worker.indexOf('await workflowOutbox.drainCreates(1);');
    const workflowDrain = worker.indexOf('await workflowOutbox.drain(5);');
    const priorityExecutionScheduling = worker.indexOf(
      'await executionProgress.reconcileScheduling(1);',
    );
    const priorityAgentDispatchRelay = worker.indexOf(
      "await relay.relayDestination('github_actions', 1);",
      priorityExecutionScheduling,
    );
    const priorityRelay = worker.indexOf('await relay.relay();', priorityAgentDispatchRelay);
    const priorityPullRequestReconciliation = worker.indexOf(
      'await reconcileGitHubPullRequestsFromEnv(env, 1);',
      priorityAgentDispatchRelay,
    );
    const priorityAutomatedReviewScheduling = worker.indexOf(
      'await new AutomatedReviewScheduler(env.DB_CONTROL).scheduleBatch(5, scheduledNow());',
      priorityPullRequestReconciliation,
    );
    const priorityReviewRelay = worker.indexOf(
      "await relay.relayDestination('github_actions', 1);",
      priorityAutomatedReviewScheduling,
    );
    const preparedPlanRevisionRecovery = worker.indexOf(
      'await planRevisionAnalysis.reconcilePreparedPlans(1);',
      priorityExecutionScheduling,
    );
    const planRevisionAnalysisRecovery = worker.indexOf(
      'await planRevisionAnalysis.reconcileBatch(5);',
      workflowDrain,
    );
    const toolBridgeAnalysisRecovery = worker.indexOf(
      'initialAnalysis.reconcileToolBridgeFailures(1)',
      priorityExecutionScheduling,
    );
    const toolBridgeAnalysisRecoveryRelay = worker.indexOf(
      "await relay.relayDestination('github_actions', 1);",
      toolBridgeAnalysisRecovery,
    );
    const ordinaryAnalysisRecovery = worker.indexOf(
      'await initialAnalysis.reconcileFailedAttempts(5);',
      workflowDrain,
    );
    const reviewAttemptRecovery = worker.indexOf(
      'await recoverLostGitHubReviewFeedbacksFromEnv(env);',
      workflowDrain,
    );
    const reviewApprovalRecovery = worker.indexOf(
      'await recoverApprovedGitHubReviewFeedbacksFromEnv(env)',
      preparedPlanRevisionRecovery,
    );
    const reviewApprovalRecoveryRelay = worker.indexOf(
      "await relay.relayDestination('github_actions', 1);",
      reviewApprovalRecovery,
    );
    const readyAttemptScheduling = worker.indexOf(
      'await executionProgress.reconcileReadyAttempts(1);',
      reviewAttemptRecovery,
    );
    const relay = worker.indexOf('await relay.relay();', workflowDrain);
    const preparedPublicationRecovery = worker.indexOf(
      'await executionProgress.reconcilePreparedPublications(1);',
      priorityExecutionScheduling,
    );
    const executionScheduling = worker.indexOf(
      'await executionProgress.reconcileScheduling(5);',
      relay,
    );
    const atRiskGitHubReconciliation = worker.indexOf(
      'await reconcileAtRiskGitHubRunsFromEnv(env, {',
      priorityExecutionScheduling,
    );
    const automatedReviewRecovery = worker.indexOf(
      '.recoverFailedBatch(1, scheduledNow())',
      atRiskGitHubReconciliation,
    );
    const automatedReviewRecoveryRelay = worker.indexOf(
      "await relay.relayDestination('github_actions', 1);",
      automatedReviewRecovery,
    );
    const priorityGitHubBaseReconciliation = worker.indexOf(
      'await reconcileGitHubBasesFromEnv(env, 1);',
      atRiskGitHubReconciliation,
    );
    const executionCompletion = worker.indexOf(
      'await executionProgress.reconcileAttemptCompletions(1);',
      atRiskGitHubReconciliation,
    );
    const executionFinalization = worker.indexOf(
      'await executionProgress.reconcileFinalizations(5);',
      executionCompletion,
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

    expect(priorityWorkflowCreateDrain).toBeGreaterThan(-1);
    expect(toolBridgeAnalysisRecovery).toBeGreaterThan(priorityExecutionScheduling);
    expect(toolBridgeAnalysisRecoveryRelay).toBeGreaterThan(toolBridgeAnalysisRecovery);
    expect(toolBridgeAnalysisRecoveryRelay).toBeLessThan(priorityPullRequestReconciliation);
    expect(ordinaryAnalysisRecovery).toBeGreaterThan(toolBridgeAnalysisRecoveryRelay);
    expect(workflowDrain).toBeGreaterThan(-1);
    expect(priorityExecutionScheduling).toBeGreaterThan(-1);
    expect(priorityWorkflowCreateDrain).toBeLessThan(priorityExecutionScheduling);
    expect(priorityAgentDispatchRelay).toBeGreaterThan(priorityExecutionScheduling);
    expect(priorityAgentDispatchRelay).toBeLessThan(atRiskGitHubReconciliation);
    expect(priorityExecutionScheduling).toBeLessThan(priorityRelay);
    expect(priorityPullRequestReconciliation).toBeGreaterThan(priorityAgentDispatchRelay);
    expect(priorityAutomatedReviewScheduling).toBeGreaterThan(
      priorityPullRequestReconciliation,
    );
    expect(priorityReviewRelay).toBeGreaterThan(priorityAutomatedReviewScheduling);
    expect(preparedPlanRevisionRecovery).toBeGreaterThan(priorityExecutionScheduling);
    expect(priorityPullRequestReconciliation).toBeLessThan(preparedPlanRevisionRecovery);
    expect(priorityAutomatedReviewScheduling).toBeLessThan(preparedPlanRevisionRecovery);
    expect(priorityReviewRelay).toBeLessThan(preparedPlanRevisionRecovery);
    expect(preparedPlanRevisionRecovery).toBeLessThan(atRiskGitHubReconciliation);
    expect(preparedPlanRevisionRecovery).toBeLessThan(priorityRelay);
    expect(reviewApprovalRecovery).toBeGreaterThan(preparedPlanRevisionRecovery);
    expect(reviewApprovalRecovery).toBeLessThan(atRiskGitHubReconciliation);
    expect(reviewApprovalRecoveryRelay).toBeGreaterThan(reviewApprovalRecovery);
    expect(reviewApprovalRecoveryRelay).toBeLessThan(atRiskGitHubReconciliation);
    expect(priorityRelay).toBeLessThan(workflowDrain);
    expect(reviewAttemptRecovery).toBeGreaterThan(workflowDrain);
    expect(readyAttemptScheduling).toBeGreaterThan(reviewAttemptRecovery);
    expect(atRiskGitHubReconciliation).toBeGreaterThan(priorityExecutionScheduling);
    expect(atRiskGitHubReconciliation).toBeLessThan(priorityRelay);
    expect(priorityPullRequestReconciliation).toBeLessThan(atRiskGitHubReconciliation);
    expect(priorityAutomatedReviewScheduling).toBeLessThan(atRiskGitHubReconciliation);
    expect(priorityReviewRelay).toBeLessThan(atRiskGitHubReconciliation);
    expect(automatedReviewRecovery).toBeGreaterThan(atRiskGitHubReconciliation);
    expect(automatedReviewRecoveryRelay).toBeGreaterThan(automatedReviewRecovery);
    expect(automatedReviewRecoveryRelay).toBeLessThan(executionCompletion);
    expect(executionCompletion).toBeGreaterThan(atRiskGitHubReconciliation);
    expect(executionCompletion).toBeLessThan(priorityGitHubBaseReconciliation);
    expect(priorityGitHubBaseReconciliation).toBeGreaterThan(atRiskGitHubReconciliation);
    expect(priorityGitHubBaseReconciliation).toBeLessThan(preparedPublicationRecovery);
    expect(priorityGitHubBaseReconciliation).toBeLessThan(priorityRelay);
    expect(executionFinalization).toBeGreaterThan(priorityGitHubBaseReconciliation);
    expect(priorityPullRequestReconciliation).toBeLessThan(executionFinalization);
    expect(planRevisionAnalysisRecovery).toBeGreaterThan(executionFinalization);
    expect(planRevisionAnalysisRecovery).toBeLessThan(relay);
    expect(reviewAttemptRecovery).toBeLessThan(relay);
    expect(relay).toBeGreaterThan(priorityRelay);
    expect(workflowDrain).toBeLessThan(relay);
    expect(preparedPublicationRecovery).toBeGreaterThan(atRiskGitHubReconciliation);
    expect(preparedPublicationRecovery).toBeLessThan(executionFinalization);
    expect(preparedPublicationRecovery).toBeLessThan(priorityRelay);
    expect(executionScheduling).toBeGreaterThan(relay);
    expect(executionFinalization).toBeLessThan(workflowDrain);
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
      'await recoverApprovedGitHubReviewFeedbacksFromEnv(env)',
    );
    expect(worker.slice(relay, atRiskGitHubReconciliation)).not.toContain(
      'reconcileGitHubRunsFromEnv(env',
    );
    expect(worker.slice(concurrentStart, concurrentEnd)).not.toContain('relay.relay()');
    expect(worker.slice(concurrentStart, concurrentEnd)).not.toContain(
      'reconcileGitHubPullRequestsFromEnv(env)',
    );
    expect(worker.slice(concurrentStart, concurrentEnd)).not.toContain(
      'reconcileGitHubBasesFromEnv(env)',
    );
    expect(worker.slice(priorityPullRequestReconciliation + 1)).not.toContain(
      'await reconcileGitHubPullRequestsFromEnv(env, 1);',
    );
    expect(worker.slice(priorityAutomatedReviewScheduling + 1)).not.toContain(
      'await new AutomatedReviewScheduler(env.DB_CONTROL).scheduleBatch(5, scheduledNow());',
    );
  });
});
