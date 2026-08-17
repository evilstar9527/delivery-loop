import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256, sha256Bytes } from '../src/domain/digest.js';
import {
  ExecutorPatchClientError,
  downloadExecutorPublisherPatch,
  uploadExecutorWorkPatch,
} from '../src/runner/executor-patch-client.js';
import { downloadPublisherPatch } from '../scripts/run-publisher-attempt.js';

const proposal = {
  schemaVersion: '1' as const,
  changes: [{
    path: 'src/worker.ts',
    baseDigest: null,
    content: 'export const worker = true;\n',
  }],
};

async function publisherResponse(): Promise<Record<string, unknown>> {
  const serialized = JSON.stringify(proposal);
  return {
    schemaVersion: '1',
    patchId: 'patch-client-1',
    publicationId: 'publication-client-1',
    publisherExecutionId: 'execution-publisher-1',
    repository: 'example/repository',
    taskId: 'task-client-1',
    baseSha: 'a'.repeat(40),
    checkoutSha: 'a'.repeat(40),
    baseBranch: 'main',
    targetBranch: 'agent/task/attempt',
    targetBranchMode: 'new',
    planVersion: 1,
    planItemId: 'change',
    targetedCommandRefs: ['test:unit'],
    patchDigest: await sha256Bytes(new TextEncoder().encode(serialized)),
    changedPathsDigest: await canonicalSha256({
      schemaVersion: '1',
      paths: ['src/worker.ts'],
    }),
    proposal,
  };
}

describe('executor patch runtime client', () => {
  it('uploads with the short work token and downloads with only a proxy placeholder', async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === 'POST') {
        return Response.json({
          schemaVersion: '1',
          patchId: 'patch-client-1',
          workExecutionId: 'execution-work-1',
          patchRef: 'r2://executor-patches/patch-client-1',
          patchDigest: `sha256:${'1'.repeat(64)}`,
          changedPathsDigest: `sha256:${'2'.repeat(64)}`,
          byteLength: 100,
          created: true,
        }, { status: 201 });
      }
      return Response.json(await publisherResponse());
    });
    await expect(uploadExecutorWorkPatch({
      controlPlaneUrl: 'http://control.delivery-loop.internal',
      attemptId: 'attempt-client-1',
      executionId: 'execution-work-1',
      attemptToken: 'short-work-token',
      expectedVersion: 2,
      leaseGeneration: 1,
      proposal,
    }, fetcher)).resolves.toMatchObject({ created: true });
    await expect(downloadExecutorPublisherPatch({
      controlPlaneUrl: 'http://control.delivery-loop.internal',
      attemptId: 'attempt-client-1',
      executionId: 'execution-publisher-1',
      patchId: 'patch-client-1',
    }, fetcher)).resolves.toMatchObject({ proposal });
    expect(requests.map((request) => ({
      method: request.method,
      authorization: request.headers.get('authorization'),
      redirect: request.redirect,
    }))).toEqual([
      {
        method: 'POST',
        authorization: 'Bearer short-work-token',
        redirect: 'error',
      },
      {
        method: 'GET',
        authorization: 'Bearer executor-proxy-placeholder',
        redirect: 'error',
      },
    ]);
  });

  it('rejects tampered content and retries only bounded publisher startup races', async () => {
    const tampered = await publisherResponse();
    tampered.patchDigest = `sha256:${'9'.repeat(64)}`;
    await expect(downloadExecutorPublisherPatch({
      controlPlaneUrl: 'http://control.delivery-loop.internal',
      attemptId: 'attempt-client-1',
      executionId: 'execution-publisher-1',
      patchId: 'patch-client-1',
    }, async () => Response.json(tampered))).rejects.toMatchObject({
      code: 'response_invalid',
    });

    const responses = [
      new Response('CANARY_PROVIDER_BODY', { status: 409 }),
      Response.json(await publisherResponse()),
    ];
    const waits: number[] = [];
    await expect(downloadPublisherPatch({
      DELIVERY_CONTROL_PLANE_URL: 'http://control.delivery-loop.internal',
      DELIVERY_ATTEMPT_ID: 'attempt-client-1',
      DELIVERY_EXECUTION_ID: 'execution-publisher-1',
      DELIVERY_PATCH_ARTIFACT_ID: 'patch-client-1',
    }, async () => responses.shift()!, async (milliseconds) => {
      waits.push(milliseconds);
    })).resolves.toMatchObject({ patchId: 'patch-client-1' });
    expect(waits).toEqual([100]);

    await expect(downloadPublisherPatch({
      DELIVERY_CONTROL_PLANE_URL: 'http://control.delivery-loop.internal',
      DELIVERY_ATTEMPT_ID: 'attempt-client-1',
      DELIVERY_EXECUTION_ID: 'execution-publisher-1',
      DELIVERY_PATCH_ARTIFACT_ID: 'patch-client-1',
    }, async () => new Response('CANARY_PROVIDER_BODY', { status: 418 }), async () => {}))
      .rejects.toMatchObject({ code: 'publisher_patch_unavailable' });
    const rejection = await downloadExecutorPublisherPatch({
      controlPlaneUrl: 'http://control.delivery-loop.internal',
      attemptId: 'attempt-client-1',
      executionId: 'execution-publisher-1',
      patchId: 'patch-client-1',
    }, async () => new Response('CANARY_PROVIDER_BODY', { status: 418 }))
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ExecutorPatchClientError);
    expect((rejection as Error).message).not.toContain('CANARY_PROVIDER_BODY');
  });
});
