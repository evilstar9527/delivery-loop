import { describe, expect, it, vi } from 'vitest';
import type { VerificationCommandResultV1 } from '../src/domain/verification-evidence.js';
import {
  ControlPlaneVerificationEvidenceReporter,
  VerificationEvidenceReporterError,
  type VerificationEvidenceFetch,
} from '../src/runner/verification-evidence-reporter.js';

const MANIFEST = {
  schemaVersion: '1' as const,
  headSha: 'a'.repeat(40),
  policyDigest: `sha256:${'b'.repeat(64)}`,
  targetedCommandRefs: ['test:unit'],
  requiredVerifyCommandRefs: ['verify:all'],
};

const RESULT: VerificationCommandResultV1 = {
  schemaVersion: '1',
  position: 0,
  phase: 'targeted',
  commandRef: 'test:unit',
  exitCode: 0,
  durationMs: 123,
  headSha: MANIFEST.headSha,
};

function response(body: unknown, status: 200 | 201): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

describe('control-plane verification Evidence reporter', () => {
  it('uses the latest fencing snapshot for suite start and each result', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: VerificationEvidenceFetch = vi.fn(async (input, init) => {
      requests.push({ url: input.toString(), ...(init === undefined ? {} : { init }) });
      return requests.length === 1
        ? response({
          suiteId: 'verification-suite-1',
          created: true,
          status: 'running',
          commands: [
            { position: 0, phase: 'targeted', commandRef: 'test:unit' },
            { position: 1, phase: 'required_verify', commandRef: 'verify:all' },
          ],
        }, 201)
        : response({
          evidenceId: 'evidence-verification-1',
          created: true,
          suiteStatus: 'running',
        }, 201);
    });
    let authCall = 0;
    const reporter = new ControlPlaneVerificationEvidenceReporter({
      controlPlaneUrl: 'https://control.delivery.test',
      attemptId: 'attempt-verification',
      authorization: () => {
        authCall += 1;
        return {
          attemptToken: `rotated-token-${authCall}`,
          expectedVersion: authCall + 1,
          leaseGeneration: 3,
        };
      },
    }, fetcher);

    await expect(reporter.start(MANIFEST)).resolves.toMatchObject({
      suiteId: 'verification-suite-1',
      status: 'running',
    });
    await expect(reporter.record('verification-suite-1', RESULT)).resolves.toEqual({
      evidenceId: 'evidence-verification-1',
      created: true,
      suiteStatus: 'running',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'https://control.delivery.test/v1/attempts/attempt-verification/verifications',
      'https://control.delivery.test/v1/attempts/attempt-verification/verifications/verification-suite-1/results',
    ]);
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer rotated-token-1',
    });
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: 'Bearer rotated-token-2',
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      expectedVersion: 3,
      leaseGeneration: 3,
      result: RESULT,
    });
  });

  it('rejects a reordered server manifest and cacheable responses', async () => {
    const context = {
      controlPlaneUrl: 'https://control.delivery.test',
      attemptId: 'attempt-verification',
      authorization: () => ({
        attemptToken: 'runner-token',
        expectedVersion: 2,
        leaseGeneration: 1,
      }),
    };
    const reordered = new ControlPlaneVerificationEvidenceReporter(
      context,
      async () => response({
        suiteId: 'verification-suite-1',
        created: true,
        status: 'running',
        commands: [
          { position: 0, phase: 'required_verify', commandRef: 'verify:all' },
          { position: 1, phase: 'targeted', commandRef: 'test:unit' },
        ],
      }, 201),
    );
    await expect(reordered.start(MANIFEST)).rejects.toBeInstanceOf(
      VerificationEvidenceReporterError,
    );

    const cacheable = new ControlPlaneVerificationEvidenceReporter(
      context,
      async () => Response.json({}, { status: 201 }),
    );
    await expect(cacheable.start(MANIFEST)).rejects.toBeInstanceOf(
      VerificationEvidenceReporterError,
    );
  });
});
