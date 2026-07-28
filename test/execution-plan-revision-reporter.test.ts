import { describe, expect, it } from 'vitest';
import {
  ControlPlanePlanRevisionReporter,
  ExecutionControlPlaneReporterError,
  type MutableExecutionReporterAuthorization,
} from '../src/runner/execution-control-plane-reporters.js';

function fencing(): MutableExecutionReporterAuthorization {
  const authorization = {
    attemptToken: 'attempt-plan-revision-token',
    expectedVersion: 7,
    leaseGeneration: 3,
  };
  return {
    authorization: () => authorization,
    updateVersion: () => { throw new Error('Plan revision cancels instead of advancing the old Attempt'); },
    withAuthorization: async (operation) => await operation(authorization),
  };
}

describe('execution Plan revision reporter', () => {
  it('submits only current Attempt fencing and accepts the strict durable revision reference', async () => {
    let observedUrl = '';
    let observedBody: unknown;
    const reporter = new ControlPlanePlanRevisionReporter({
      controlPlaneUrl: 'https://control.delivery.test',
      attemptId: 'attempt-review-plan-revision',
      fencing: fencing(),
    }, async (input, init) => {
      observedUrl = String(input);
      expect(new Headers(init?.headers).get('authorization'))
        .toBe('Bearer attempt-plan-revision-token');
      observedBody = JSON.parse(String(init?.body)) as unknown;
      return Response.json({
        accepted: true,
        revisionId: 'plan_revision_review',
        analysisAttemptId: 'attempt_replan_review',
        dispatchOutboxId: 'dispatch_replan_review',
        created: true,
        runVersion: 12,
      }, { status: 202, headers: { 'cache-control': 'no-store' } });
    });

    await expect(reporter.request()).resolves.toEqual({
      revisionId: 'plan_revision_review',
      analysisAttemptId: 'attempt_replan_review',
      dispatchOutboxId: 'dispatch_replan_review',
      runVersion: 12,
    });
    expect(observedUrl).toBe(
      'https://control.delivery.test/v1/attempts/attempt-review-plan-revision/plan-revision',
    );
    expect(observedBody).toEqual({ expectedVersion: 7, leaseGeneration: 3 });
  });

  it('rejects a response that tries to add caller-authored Plan data', async () => {
    const reporter = new ControlPlanePlanRevisionReporter({
      controlPlaneUrl: 'https://control.delivery.test',
      attemptId: 'attempt-review-plan-revision',
      fencing: fencing(),
    }, async () => Response.json({
      accepted: true,
      revisionId: 'plan_revision_review',
      analysisAttemptId: 'attempt_replan_review',
      dispatchOutboxId: 'dispatch_replan_review',
      created: true,
      runVersion: 12,
      plan: { objective: 'untrusted response data' },
    }, { status: 202, headers: { 'cache-control': 'no-store' } }));

    await expect(reporter.request()).rejects.toBeInstanceOf(
      ExecutionControlPlaneReporterError,
    );
  });
});
