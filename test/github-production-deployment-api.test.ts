import { describe, expect, it } from 'vitest';
import { GitHubProductionDeploymentApiClient } from '../src/outbox/github-production-deployment.js';

describe('GitHub production deployment API', () => {
  it('creates one exact-merge production deployment with a reference-only payload', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let visible = false;
    const client = new GitHubProductionDeploymentApiClient({
      getProductionDeploymentToken: async () => 'CANARY_PRODUCTION_DEPLOYMENT_TOKEN',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(init === undefined ? { url } : { url, init });
        if (init?.method === 'POST') {
          visible = true;
          return Response.json({ id: 8801 }, { status: 201 });
        }
        return Response.json(visible ? [{
          id: 8801,
          sha: 'c'.repeat(40),
          task: 'delivery-loop:production',
          environment: 'production',
          payload: {
            schema_version: '1',
            delivery_production_deployment_id: 'deployment-production-1',
          },
        }] : []);
      },
    });
    await expect(client.ensureProductionDeployment({
      deploymentId: 'deployment-production-1',
      repository: 'example/delivery-target',
      mergeSha: 'c'.repeat(40),
      environment: 'production',
    })).resolves.toEqual({ disposition: 'created', githubDeploymentId: '8801' });
    const post = calls.find((call) => call.init?.method === 'POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      ref: 'c'.repeat(40),
      task: 'delivery-loop:production',
      auto_merge: false,
      required_contexts: [],
      environment: 'production',
      description: 'delivery-loop production deployment',
      payload: {
        schema_version: '1',
        delivery_production_deployment_id: 'deployment-production-1',
      },
    });
    expect(JSON.stringify(post?.init?.body)).not.toMatch(/revision|approval|token/i);
    expect(calls.every((call) =>
      new Headers(call.init?.headers).get('authorization') ===
        'Bearer CANARY_PRODUCTION_DEPLOYMENT_TOKEN')).toBe(true);
  });
});
