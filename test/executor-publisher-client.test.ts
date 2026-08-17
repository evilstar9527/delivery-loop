import { describe, expect, it, vi } from 'vitest';
import {
  ControlPlaneExecutorPublisherCompletionReporter,
  ExecutorPublisherHeadReporter,
  ExecutorPublisherVerificationReporter,
  requestExecutorPublisherCredential,
} from '../src/runner/executor-publisher-client.js';

const context = {
  controlPlaneUrl: 'http://control.delivery-loop.internal',
  attemptId: 'attempt-publisher-client',
  publisherExecutionId: 'execution-publisher-client',
  publicationId: 'publication-publisher-client',
};

describe('executor publisher control-plane client', () => {
  it('keeps callback placeholders separate from the one-time Git credential', async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = await request.clone().json<Record<string, unknown>>();
      const headers = { 'cache-control': 'no-store' };
      if (request.url.endsWith('/write-token')) {
        return Response.json({
          credentialId: 'credential-publisher-client',
          publicationId: context.publicationId,
          publisherExecutionId: context.publisherExecutionId,
          repository: 'example/repository',
          targetBranch: 'agent/task/attempt',
          approvalId: 'approval-publisher-client',
          token: 'one-time-github-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          permissions: { contents: 'write', pullRequests: 'write' },
          created: true,
        }, { status: 201, headers });
      }
      if (request.url.endsWith('/head')) {
        return Response.json({
          updateId: 'update-publisher-client',
          evidenceId: 'evidence-head-publisher-client',
          created: true,
          version: 3,
          leaseGeneration: 1,
          parentSha: body.parentSha,
          headSha: body.headSha,
          branch: body.branch,
        }, { status: 201, headers });
      }
      if (request.url.endsWith('/verifications')) {
        return Response.json({
          suiteId: 'verification_publisher_client',
          created: true,
          status: 'running',
          commands: [
            { position: 0, phase: 'targeted', commandRef: 'test:unit' },
            { position: 1, phase: 'required_verify', commandRef: 'verify:required' },
          ],
        }, { status: 201, headers });
      }
      if (request.url.endsWith('/results')) {
        return Response.json({
          evidenceId: 'evidence-verification-client',
          created: true,
          suiteStatus: 'running',
        }, { status: 201, headers });
      }
      return Response.json({ accepted: true }, { headers });
    });
    const credential = await requestExecutorPublisherCredential({
      ...context,
      repository: 'example/repository',
      targetBranch: 'agent/task/attempt',
    }, fetcher);
    expect(credential.token).toBe('one-time-github-token');
    const headSha = 'b'.repeat(40);
    await new ExecutorPublisherHeadReporter(context, fetcher).record({
      parentSha: 'a'.repeat(40),
      headSha,
      branch: 'agent/task/attempt',
    });
    const reporter = new ExecutorPublisherVerificationReporter(context, fetcher);
    const suite = await reporter.start({
      schemaVersion: '1',
      headSha,
      policyDigest: `sha256:${'c'.repeat(64)}`,
      targetedCommandRefs: ['test:unit'],
      requiredVerifyCommandRefs: ['verify:required'],
    });
    await reporter.record(suite.suiteId, {
      schemaVersion: '1',
      position: 0,
      phase: 'targeted',
      commandRef: 'test:unit',
      exitCode: 0,
      durationMs: 10,
      headSha,
    });
    await new ControlPlaneExecutorPublisherCompletionReporter(context, fetcher).complete({
      publicationId: context.publicationId,
      publisherExecutionId: context.publisherExecutionId,
      recomputedPatchDigest: `sha256:${'d'.repeat(64)}`,
      headSha,
      branch: 'agent/task/attempt',
      suiteId: suite.suiteId,
      evidenceIds: ['evidence-1', 'evidence-2'],
    });
    expect(requests).toHaveLength(5);
    expect(requests.every((request) =>
      request.headers.get('authorization') === 'Bearer executor-proxy-placeholder')).toBe(true);
    expect(JSON.stringify(await Promise.all(requests.map(async (request) =>
      await request.clone().json())))).not.toContain('one-time-github-token');
  });
});
