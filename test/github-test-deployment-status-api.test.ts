import { describe, expect, it } from 'vitest';
import { GitHubTestDeploymentStatusApiClient } from '../src/reconciliation/github-test-deployment-status-reconciler.js';

const REQUEST = {
  deploymentId: 'deployment-test-api',
  repository: 'example/repo',
  githubDeploymentId: '7001',
  refSha: 'b'.repeat(40),
};

function deployment(): Record<string, unknown> {
  return {
    id: 7001,
    sha: REQUEST.refSha,
    task: 'delivery-loop:test',
    environment: 'test',
    payload: {
      schema_version: '1',
      delivery_deployment_id: REQUEST.deploymentId,
    },
  };
}

function status(state: string, updatedAt: string): Record<string, unknown> {
  return {
    state,
    environment: 'test',
    environment_url: 'https://test.example.test/app?token=redacted#fragment',
    deployment_url: 'https://api.github.test/repos/example/repo/deployments/7001',
    updated_at: updatedAt,
  };
}

describe('GitHub test deployment status API', () => {
  it('verifies deployment identity and returns only the latest read-only platform fact', async () => {
    const calls: string[] = [];
    const client = new GitHubTestDeploymentStatusApiClient({
      getTestDeploymentObservationToken: async () => 'CANARY_TEST_DEPLOYMENT_READ_TOKEN',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        expect(init?.method).toBe('GET');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_TEST_DEPLOYMENT_READ_TOKEN',
        );
        return url.includes('/statuses')
          ? Response.json([
              status('in_progress', '2026-07-26T06:01:00.000Z'),
              status('success', '2026-07-26T06:02:00.000Z'),
            ])
          : Response.json(deployment());
      },
    });

    await expect(client.getTestDeploymentStatus(REQUEST)).resolves.toEqual({
      repository: 'example/repo',
      githubDeploymentId: '7001',
      deploymentId: 'deployment-test-api',
      sha: 'b'.repeat(40),
      task: 'delivery-loop:test',
      environment: 'test',
      state: 'success',
      environmentUrl: 'https://test.example.test/app',
      externalUpdatedAt: '2026-07-26T06:02:00.000Z',
    });
    expect(calls).toEqual([
      'https://api.github.test/repos/example/repo/deployments/7001',
      'https://api.github.test/repos/example/repo/deployments/7001/statuses?per_page=100',
    ]);
  });

  it('does not expose a token or response body when the API is unavailable', async () => {
    const rawCanary = 'CANARY_GITHUB_TEST_STATUS_RESPONSE';
    const token = 'CANARY_GITHUB_TEST_STATUS_TOKEN';
    const client = new GitHubTestDeploymentStatusApiClient({
      getTestDeploymentObservationToken: async () => token,
    }, {
      fetch: async () => new Response(rawCanary, { status: 403 }),
    });
    const promise = client.getTestDeploymentStatus(REQUEST);
    await expect(promise).rejects.toThrow('GitHub test deployment status query failed');
    await expect(promise).rejects.not.toThrow(rawCanary);
    await expect(promise).rejects.not.toThrow(token);
  });

  it('rejects paginated status responses instead of silently accepting an incomplete latest fact', async () => {
    const client = new GitHubTestDeploymentStatusApiClient({
      getTestDeploymentObservationToken: async () => 'CANARY_TEST_DEPLOYMENT_READ_TOKEN',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input) => {
        const url = String(input);
        return new Response(
          JSON.stringify(url.includes('/statuses') ? [] : deployment()),
          { status: 200, headers: { link: '<https://api.github.test/next>; rel="next"' } },
        );
      },
    });
    await expect(client.getTestDeploymentStatus(REQUEST)).rejects.toThrow(
      'GitHub test deployment status response is invalid',
    );
  });
});
