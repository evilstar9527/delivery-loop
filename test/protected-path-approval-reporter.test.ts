import { describe, expect, it, vi } from 'vitest';
import { computeProtectedPathDiffDigest } from '../src/domain/protected-path-change.js';
import {
  ControlPlaneProtectedPathApprovalReporter,
  ProtectedPathApprovalReporterError,
  type ProtectedPathApprovalFetch,
} from '../src/runner/protected-path-approval-reporter.js';

const BASE_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const REPORT = {
  schemaVersion: '1' as const,
  baseSha: BASE_SHA,
  stagedTreeSha: TREE_SHA,
  policyDigest: `sha256:${'c'.repeat(64)}`,
  diffDigest: await computeProtectedPathDiffDigest(BASE_SHA, TREE_SHA),
  totalChangedFiles: 1,
  protectedChanges: [{
    path: '.github/workflows/deploy.yml',
    changeType: 'modified' as const,
    additions: 2,
    deletions: 1,
  }],
};

describe('control-plane protected path reporter', () => {
  it('posts the exact safe report with attempt CAS and accepts only a bound 202 response', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: ProtectedPathApprovalFetch = vi.fn(async (input, init) => {
      requests.push({ url: input.toString(), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({
        gateId: 'protected_path_gate_1',
        created: true,
        state: 'awaiting_approval',
        runVersion: 5,
        report: REPORT,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    const reporter = new ControlPlaneProtectedPathApprovalReporter({
      controlPlaneUrl: 'https://control.delivery.test',
      attemptId: 'attempt-protected-path',
      attemptToken: 'runner-token-secret',
      expectedVersion: 2,
      leaseGeneration: 1,
    }, fetcher);

    await expect(reporter.report(REPORT)).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://control.delivery.test/v1/attempts/attempt-protected-path/protected-path-changes',
    );
    expect(requests[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      expectedVersion: 2,
      leaseGeneration: 1,
      report: REPORT,
    });
  });

  it('fails closed on an unbound response without including the bearer in its error', async () => {
    const reporter = new ControlPlaneProtectedPathApprovalReporter({
      controlPlaneUrl: 'https://control.delivery.test',
      attemptId: 'attempt-protected-path',
      attemptToken: 'runner-token-secret',
      expectedVersion: 2,
      leaseGeneration: 1,
    }, async () => new Response(JSON.stringify({
      gateId: 'protected_path_gate_1',
      created: true,
      state: 'awaiting_approval',
      runVersion: 5,
      report: { ...REPORT, stagedTreeSha: '0'.repeat(40) },
    }), { status: 202 }));
    await expect(reporter.report(REPORT)).rejects.toMatchObject({
      name: ProtectedPathApprovalReporterError.name,
      message: 'protected path approval report failed',
    });
  });
});
