import { describe, expect, it } from 'vitest';
import {
  GitHubTestDeploymentApiClient,
} from '../src/outbox/github-test-deployment.js';

describe('GitHub test deployment API', () => {
  it('creates one test-only deployment with a reference-only payload', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let visible = false;
    const client = new GitHubTestDeploymentApiClient({
      getDeploymentToken: async () => 'CANARY_TEST_DEPLOYMENT_TOKEN',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(init === undefined ? { url } : { url, init });
        if (init?.method === 'POST') {
          visible = true;
          return Response.json({ id: 7001 }, { status: 201 });
        }
        return Response.json(visible ? [{
          id: 7001,
          sha: 'b'.repeat(40),
          task: 'delivery-loop:test',
          environment: 'test',
          payload: { schema_version: '1', delivery_deployment_id: 'deployment-test-1' },
        }] : []);
      },
    });
    await expect(client.ensureTestDeployment({
      deploymentId: 'deployment-test-1',
      repository: 'example/delivery-target',
      refSha: 'b'.repeat(40),
      environment: 'test',
    })).resolves.toEqual({ disposition: 'created', githubDeploymentId: '7001' });
    const post = calls.find((call) => call.init?.method === 'POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      ref: 'b'.repeat(40),
      task: 'delivery-loop:test',
      auto_merge: false,
      required_contexts: [],
      environment: 'test',
      description: 'delivery-loop test deployment',
      payload: { schema_version: '1', delivery_deployment_id: 'deployment-test-1' },
    });
    expect(calls.every((call) =>
      new Headers(call.init?.headers).get('authorization') ===
        'Bearer CANARY_TEST_DEPLOYMENT_TOKEN')).toBe(true);
  });
});
