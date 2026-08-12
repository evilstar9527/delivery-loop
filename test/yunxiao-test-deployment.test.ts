import { describe, expect, it, vi } from 'vitest';
import {
  YunxiaoTestDeploymentClient,
  YunxiaoTestDeploymentStatusClient,
} from '../src/outbox/yunxiao-test-deployment.js';
import type { ToolBridgeClient } from '../src/tools/tool-bridge-client.js';

const request = {
  deploymentId: 'deployment-yunxiao-1',
  repository: 'lightspeed-intelligence/tipsy-backend',
  refSha: 'a'.repeat(40),
  environment: 'test' as const,
  runId: 'run-yunxiao-1',
  attemptId: 'attempt-yunxiao-1',
  sourceRef: 'agent/task-yunxiao/attempt-yunxiao-1',
  repositoryUrl: 'https://github.com/Lightspeed-Intelligence/tipsy-backend.git',
  deliveryAttempt: 1,
};

const statusBody = {
  pipelineId: 5186274,
  pipelineRunId: 12345,
  status: 'SUCCESS',
  endTime: 1_780_000_000_000,
  sources: [{
    data: {
      repo: request.repositoryUrl,
      branch: request.sourceRef,
      commit: JSON.stringify([{ commitId: request.refSha }]),
    },
  }],
  globalParams: [{ key: 'CI_COMMIT_SHA', value: request.refSha }],
};

describe('Yunxiao test deployment adapter', () => {
  it('starts a pipeline with exact commit metadata and returns its run id', async () => {
    const call = vi.fn<ToolBridgeClient['call']>().mockResolvedValue({
      ok: true,
      result: JSON.stringify({ pipelineRunId: 12345 }),
    });
    const client = new YunxiaoTestDeploymentClient(
      { call }, '68c3d49cbb64aae551955854', '5186274',
    );
    await expect(client.ensureTestDeployment(request)).resolves.toEqual({
      disposition: 'created', githubDeploymentId: '12345',
    });
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      toolPath: 'mcp/yunxiao/create_pipeline_run',
      runId: request.runId,
      attemptId: request.attemptId,
      arguments: expect.objectContaining({
        organizationId: '68c3d49cbb64aae551955854',
        pipelineId: '5186274',
        branch: request.sourceRef,
        repositories: [{ url: request.repositoryUrl, branch: request.sourceRef }],
        environmentVariables: {
          DELIVERY_LOOP_DEPLOYMENT_ID: request.deploymentId,
          DELIVERY_LOOP_COMMIT_SHA: request.refSha,
        },
      }),
    }));
  });

  it('normalizes Yunxiao pipeline status for the existing deployment projector', async () => {
    const call = vi.fn<ToolBridgeClient['call']>().mockResolvedValue({
      ok: true,
      result: JSON.stringify(statusBody),
    });
    const client = new YunxiaoTestDeploymentStatusClient(
      { call }, '68c3d49cbb64aae551955854', '5186274', request.repositoryUrl,
    );
    await expect(client.getTestDeploymentStatus({
      deploymentId: request.deploymentId,
      repository: request.repository,
      githubDeploymentId: '12345',
      refSha: request.refSha,
    })).resolves.toMatchObject({
      state: 'success',
      githubDeploymentId: '12345',
      deploymentId: request.deploymentId,
      sha: request.refSha,
    });
  });

  it('fails closed when a successful run does not prove the exact commit', async () => {
    const client = new YunxiaoTestDeploymentStatusClient(
      { call: vi.fn<ToolBridgeClient['call']>().mockResolvedValue({
        ok: true,
        result: JSON.stringify({
          ...statusBody,
          globalParams: [],
          sources: [{ data: { repo: request.repositoryUrl, commit: '[]' } }],
        }),
      }) },
      '68c3d49cbb64aae551955854', '5186274', request.repositoryUrl,
    );
    await expect(client.getTestDeploymentStatus({
      deploymentId: request.deploymentId,
      repository: request.repository,
      githubDeploymentId: '12345',
      refSha: request.refSha,
    })).resolves.toMatchObject({ state: 'failure' });
  });

  it('fails closed when pipeline and source commit bindings drift', async () => {
    const client = new YunxiaoTestDeploymentStatusClient(
      { call: vi.fn<ToolBridgeClient['call']>().mockResolvedValue({
        ok: true,
        result: JSON.stringify({
          ...statusBody,
          globalParams: [{ key: 'CI_COMMIT_SHA', value: 'b'.repeat(40) }],
        }),
      }) },
      '68c3d49cbb64aae551955854', '5186274', request.repositoryUrl,
    );
    await expect(client.getTestDeploymentStatus({
      deploymentId: request.deploymentId,
      repository: request.repository,
      githubDeploymentId: '12345',
      refSha: request.refSha,
    })).resolves.toMatchObject({ state: 'failure' });

    const wrongRun = new YunxiaoTestDeploymentStatusClient(
      { call: vi.fn<ToolBridgeClient['call']>().mockResolvedValue({
        ok: true,
        result: JSON.stringify({ ...statusBody, pipelineRunId: 99999 }),
      }) },
      '68c3d49cbb64aae551955854', '5186274', request.repositoryUrl,
    );
    await expect(wrongRun.getTestDeploymentStatus({
      deploymentId: request.deploymentId,
      repository: request.repository,
      githubDeploymentId: '12345',
      refSha: request.refSha,
    })).rejects.toThrow('Yunxiao pipeline status response is invalid');
  });

  it('does not replay a non-idempotent create after an uncertain first attempt', async () => {
    const call = vi.fn<ToolBridgeClient['call']>().mockResolvedValue({
      ok: true,
      result: JSON.stringify({ items: [] }),
    });
    const client = new YunxiaoTestDeploymentClient(
      { call }, '68c3d49cbb64aae551955854', '5186274',
    );
    await expect(client.ensureTestDeployment({ ...request, deliveryAttempt: 2 })).rejects.toThrow(
      'Yunxiao pipeline create outcome is uncertain',
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      toolPath: 'mcp/yunxiao/list_pipeline_runs',
    }));
  });

  it('recovers a lost create response from the bounded recent-run inventory', async () => {
    const call = vi.fn<ToolBridgeClient['call']>().mockImplementation(async (input) => {
      if (input.toolPath === 'mcp/yunxiao/list_pipeline_runs') {
        return { ok: true, result: JSON.stringify({ items: [{ pipelineRunId: 12345 }] }) };
      }
      return {
        ok: true,
        result: JSON.stringify({
          ...statusBody,
          globalParams: [
            ...statusBody.globalParams,
            { key: 'DELIVERY_LOOP_DEPLOYMENT_ID', value: request.deploymentId },
          ],
        }),
      };
    });
    const client = new YunxiaoTestDeploymentClient(
      { call }, '68c3d49cbb64aae551955854', '5186274',
    );
    await expect(client.ensureTestDeployment({ ...request, deliveryAttempt: 2 })).resolves.toEqual({
      disposition: 'existing',
      githubDeploymentId: '12345',
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.some(([input]) => input.toolPath === 'mcp/yunxiao/create_pipeline_run'))
      .toBe(false);
  });

  it('fails closed on malformed pipeline responses', async () => {
    const client = new YunxiaoTestDeploymentClient(
      { call: vi.fn<ToolBridgeClient['call']>().mockResolvedValue({ ok: true, result: {} }) },
      '68c3d49cbb64aae551955854', '5186274',
    );
    await expect(client.ensureTestDeployment(request)).rejects.toThrow(
      'Yunxiao pipeline response is invalid',
    );
  });
});
