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

  it('finalizes passed work before scheduling and observes at-risk completion before fencing', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const workflowDrain = worker.indexOf(').drain(5);');
    const relay = worker.indexOf('await relay.relay();');
    const priorityFinalization = worker.indexOf(
      'await executionProgress.reconcileFinalizations(1);',
      relay,
    );
    const executionScheduling = worker.indexOf(
      'await executionProgress.reconcileScheduling(5);',
      relay,
    );
    const atRiskGitHubReconciliation = worker.indexOf(
      'await reconcileAtRiskGitHubRunsFromEnv(env, {',
      executionScheduling,
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
    expect(relay).toBeGreaterThan(-1);
    expect(workflowDrain).toBeLessThan(relay);
    expect(priorityFinalization).toBeGreaterThan(relay);
    expect(priorityFinalization).toBeLessThan(executionScheduling);
    expect(executionScheduling).toBeGreaterThan(relay);
    expect(atRiskGitHubReconciliation).toBeGreaterThan(executionScheduling);
    expect(executionFinalization).toBeGreaterThan(atRiskGitHubReconciliation);
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
    expect(worker.slice(relay, atRiskGitHubReconciliation)).not.toContain(
      'reconcileGitHubRunsFromEnv(env',
    );
    expect(worker.slice(concurrentStart, concurrentEnd)).not.toContain('relay.relay()');
  });
});
