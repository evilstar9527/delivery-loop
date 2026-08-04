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

  it('direct-drains durable Workflow effects before Queue relay and background recovery', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const workflowDrain = worker.indexOf(').drain(5);');
    const relay = worker.indexOf('await relay.relay();');
    const executionProgress = worker.indexOf(').reconcileBatch(5);', relay);
    const detectorEnd = worker.indexOf('}).scan(25);');
    const concurrentStart = worker.indexOf('await Promise.all([', detectorEnd);
    const concurrentEnd = worker.indexOf(']);', concurrentStart);
    const workflowReconciliation = worker.indexOf(
      'reconcileWorkflowInstancesFromEnv(env),',
      concurrentStart,
    );

    expect(workflowDrain).toBeGreaterThan(-1);
    expect(relay).toBeGreaterThan(-1);
    expect(workflowDrain).toBeLessThan(relay);
    expect(executionProgress).toBeGreaterThan(relay);
    expect(detectorEnd).toBeGreaterThan(-1);
    expect(executionProgress).toBeLessThan(detectorEnd);
    expect(concurrentStart).toBeGreaterThan(detectorEnd);
    expect(concurrentEnd).toBeGreaterThan(concurrentStart);
    expect(workflowReconciliation).toBeGreaterThan(concurrentStart);
    expect(workflowReconciliation).toBeLessThan(concurrentEnd);
    expect(worker.slice(workflowDrain, concurrentStart)).not.toContain(
      'reconcileWorkflowInstancesFromEnv(env)',
    );
    expect(worker.slice(concurrentStart, concurrentEnd)).not.toContain('relay.relay()');
  });
});
