import { describe, expect, it } from 'vitest';
import { GitHubProductionDeploymentStatusApiClient } from '../src/reconciliation/github-production-deployment-status-reconciler.js';

const REQUEST = {
  deploymentId: 'deployment-production-api',
  repository: 'example/repo',
  githubDeploymentId: '8801',
  mergeSha: 'c'.repeat(40),
};

function deployment(): Record<string, unknown> {
  return {
    id: 8801,
    sha: REQUEST.mergeSha,
    task: 'delivery-loop:production',
    environment: 'production',
    payload: {
      schema_version: '1',
      delivery_production_deployment_id: REQUEST.deploymentId,
    },
  };
}

function status(
  state: string,
  updatedAt: string,
): Record<string, unknown> {
  return {
    id: 9901,
    state,
    environment: 'production',
    environment_url: 'https://production.example.test/app?token=redacted#fragment',
    deployment_url: 'https://api.github.test/repos/example/repo/deployments/8801',
    updated_at: updatedAt,
  };
}

describe('GitHub production deployment status API', () => {
  it('verifies the deployment first and returns only the latest platform status', async () => {
    const calls: string[] = [];
    const client = new GitHubProductionDeploymentStatusApiClient({
      getProductionDeploymentObservationToken: async () =>
        'CANARY_PRODUCTION_DEPLOYMENT_READ_TOKEN',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        expect(init?.method).toBe('GET');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_PRODUCTION_DEPLOYMENT_READ_TOKEN',
        );
        if (!url.includes('/statuses')) return Response.json(deployment());
        return Response.json([
          status('in_progress', '2026-07-26T04:31:00.000Z'),
          status('success', '2026-07-26T04:32:00.000Z'),
        ]);
      },
    });
    await expect(client.getProductionDeploymentStatus(REQUEST)).resolves.toEqual({
      schemaVersion: '1',
      repository: 'example/repo',
      githubDeploymentId: '8801',
      deploymentId: 'deployment-production-api',
      sha: 'c'.repeat(40),
      task: 'delivery-loop:production',
      environment: 'production',
      state: 'success',
      environmentUrl: 'https://production.example.test/app',
      externalUpdatedAt: '2026-07-26T04:32:00.000Z',
    });
    expect(calls).toEqual([
      'https://api.github.test/repos/example/repo/deployments/8801',
      'https://api.github.test/repos/example/repo/deployments/8801/statuses?per_page=100',
    ]);
  });

  it('does not resurrect an older success when the latest status is pending', async () => {
    const client = new GitHubProductionDeploymentStatusApiClient({
      getProductionDeploymentObservationToken: async () => 'read-token',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input) => String(input).includes('/statuses')
        ? Response.json([
            status('success', '2026-07-26T04:31:00.000Z'),
            status('pending', '2026-07-26T04:32:00.000Z'),
          ])
        : Response.json(deployment()),
    });
    await expect(client.getProductionDeploymentStatus(REQUEST)).resolves.toBeNull();
  });

  it('rejects a deployment identity drift before reading statuses', async () => {
    let calls = 0;
    const client = new GitHubProductionDeploymentStatusApiClient({
      getProductionDeploymentObservationToken: async () => 'read-token',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async () => {
        calls += 1;
        return Response.json({ ...deployment(), sha: 'f'.repeat(40) });
      },
    });
    await expect(client.getProductionDeploymentStatus(REQUEST)).rejects.toThrow(
      'GitHub production deployment response is invalid',
    );
    expect(calls).toBe(1);
  });

  it('does not expose token or GitHub response body in errors', async () => {
    const rawCanary = 'CANARY_GITHUB_PRODUCTION_STATUS_RESPONSE';
    const token = 'CANARY_GITHUB_PRODUCTION_STATUS_TOKEN';
    const client = new GitHubProductionDeploymentStatusApiClient({
      getProductionDeploymentObservationToken: async () => token,
    }, {
      fetch: async () => new Response(rawCanary, { status: 403 }),
    });
    const promise = client.getProductionDeploymentStatus(REQUEST);
    await expect(promise).rejects.toThrow('GitHub production deployment status query failed');
    await expect(promise).rejects.not.toThrow(rawCanary);
    await expect(promise).rejects.not.toThrow(token);
  });

  it('fails closed on paginated status responses', async () => {
    const client = new GitHubProductionDeploymentStatusApiClient({
      getProductionDeploymentObservationToken: async () => 'read-token',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input) => String(input).includes('/statuses')
        ? new Response('[]', { status: 200, headers: { link: '<next>; rel="next"' } })
        : Response.json(deployment()),
    });
    await expect(client.getProductionDeploymentStatus(REQUEST)).rejects.toThrow(
      'GitHub production deployment status response is invalid',
    );
  });
});
