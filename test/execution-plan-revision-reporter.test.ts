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
  it.each([
    ['transport', null],
    ['conflict', 409],
    ['upstream unavailable', 503],
  ] as const)(
    'retries one recoverable %s failure with the exact same fenced request',
    async (_label, firstStatus) => {
      const requests: Array<{ authorization: string | null; body: string }> = [];
      let calls = 0;
      const reporter = new ControlPlanePlanRevisionReporter({
        controlPlaneUrl: 'https://control.delivery.test',
        attemptId: 'attempt-review-plan-revision',
        fencing: fencing(),
      }, async (_input, init) => {
        calls += 1;
        requests.push({
          authorization: new Headers(init?.headers).get('authorization'),
          body: String(init?.body),
        });
        if (calls === 1) {
          if (firstStatus === null) throw new TypeError('synthetic transport failure');
          return Response.json({ code: 'temporary' }, {
            status: firstStatus,
            headers: { 'cache-control': 'no-store' },
          });
        }
        return Response.json({
          accepted: true,
          revisionId: 'plan_revision_review',
          analysisAttemptId: 'attempt_replan_review',
          dispatchOutboxId: 'dispatch_replan_review',
          created: firstStatus !== 409,
          runVersion: 12,
        }, { status: 200, headers: { 'cache-control': 'no-store' } });
      });

      await expect(reporter.request()).resolves.toMatchObject({
        revisionId: 'plan_revision_review',
        analysisAttemptId: 'attempt_replan_review',
        dispatchOutboxId: 'dispatch_replan_review',
        runVersion: 12,
      });
      expect(calls).toBe(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(JSON.parse(requests[0]!.body)).toEqual({
        expectedVersion: 7,
        leaseGeneration: 3,
      });
    },
  );

  it('does not retry authentication or authorization rejection', async () => {
    let calls = 0;
    const reporter = new ControlPlanePlanRevisionReporter({
      controlPlaneUrl: 'https://control.delivery.test',
      attemptId: 'attempt-review-plan-revision',
      fencing: fencing(),
    }, async () => {
      calls += 1;
      return Response.json({ code: 'unauthenticated' }, {
        status: 401,
        headers: { 'cache-control': 'no-store' },
      });
    });

    await expect(reporter.request()).rejects.toBeInstanceOf(
      ExecutionControlPlaneReporterError,
    );
    expect(calls).toBe(1);
  });

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
