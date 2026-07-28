import { describe, expect, it, vi } from 'vitest';
import { GitHubActionsApiClient } from '../src/outbox/github-dispatcher.js';
import {
  GitHubDeliveryPolicyApiClient,
  GitHubDeliveryPolicyError,
} from '../src/reconciliation/test-rollback-reconciler.js';

const SHA = 'b'.repeat(40);
const POLICY = `schemaVersion: '1'
commands:
  setup:
    install: { argv: [pnpm, install], timeoutSeconds: 600 }
  targeted:
    unit: { argv: [pnpm, test], timeoutSeconds: 300 }
  verify:
    all: { argv: [pnpm, run, verify], timeoutSeconds: 1200 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment: { mode: none }
`;

describe('GitHub test rollback adapters', () => {
  it('reads only delivery.yaml at the exact SHA with a contents-read token', async () => {
    const getPolicyObservationToken = vi.fn(async () => 'policy-read-token');
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        `https://api.github.test/repos/example/repo/contents/delivery.yaml?ref=${SHA}`,
      );
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe('GET');
      expect(headers.get('authorization')).toBe('Bearer policy-read-token');
      expect(headers.get('accept')).toBe('application/vnd.github.raw+json');
      return new Response(POLICY, { status: 200 });
    });
    const client = new GitHubDeliveryPolicyApiClient({ getPolicyObservationToken }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: fetcher,
    });
    await expect(client.getDeliveryPolicy('example/repo', SHA)).resolves.toMatchObject({
      policy: { deployment: { mode: 'none' } },
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(getPolicyObservationToken).toHaveBeenCalledOnce();
  });

  it('distinguishes an absent policy from invalid content without exposing response bodies', async () => {
    const tokens = { getPolicyObservationToken: async () => 'policy-read-token' };
    const missing = new GitHubDeliveryPolicyApiClient(tokens, {
      fetch: async () => new Response(null, { status: 404 }),
    });
    await expect(missing.getDeliveryPolicy('example/repo', SHA)).resolves.toBeNull();
    const invalid = new GitHubDeliveryPolicyApiClient(tokens, {
      fetch: async () => new Response('CANARY_INVALID_POLICY_BODY', { status: 200 }),
    });
    await expect(invalid.getDeliveryPolicy('example/repo', SHA)).rejects.toMatchObject({
      name: GitHubDeliveryPolicyError.name,
      code: 'invalid_policy',
      message: 'GitHub delivery policy read failed: invalid_policy',
    });
  });

  it('dispatches rollback with the dedicated token and reconciles by stable run title', async () => {
    const getInstallationToken = vi.fn(async () => 'agent-token');
    const getRollbackToken = vi.fn(async () => 'rollback-token');
    const getRollbackObservationToken = vi.fn(async () => 'rollback-observation-token');
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith('/repos/example/repo/actions/runs/9010')) {
        expect(headers.get('authorization')).toBe('Bearer rollback-observation-token');
        return Response.json({
          id: 9010,
          repository: { full_name: 'example/repo' },
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: 'success',
          head_sha: SHA,
          head_branch: 'main',
          path: '.github/workflows/delivery-test-rollback.yml',
          display_title: 'delivery-loop/rollback/rollback-test-adapter',
          run_attempt: 1,
          updated_at: '2026-07-26T05:00:00.000Z',
        });
      }
      expect(headers.get('authorization')).toBe('Bearer rollback-token');
      if (url.includes('/runs?')) {
        reads += 1;
        return Response.json({
          workflow_runs: reads === 1 ? [] : [{
            id: 9010,
            event: 'workflow_dispatch',
            display_title: 'delivery-loop/rollback/rollback-test-adapter',
            path: '.github/workflows/delivery-test-rollback.yml',
            head_branch: 'main',
          }],
        });
      }
      expect(url).toContain(
        '/actions/workflows/.github%2Fworkflows%2Fdelivery-test-rollback.yml/dispatches',
      );
      expect(init?.method).toBe('POST');
      return new Response(null, { status: 204 });
    });
    const client = new GitHubActionsApiClient({
      getInstallationToken,
      getRollbackToken,
      getRollbackObservationToken,
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: fetcher,
      reconciliationAttempts: 2,
    });
    await expect(client.ensureDispatch({
      repository: 'example/repo',
      workflowFile: '.github/workflows/delivery-test-rollback.yml',
      ref: 'refs/heads/main',
      inputs: {
        schema_version: '1',
        rollback_id: 'rollback-test-adapter',
        source_kind: 'deployment_failure',
        ref_sha: SHA,
        control_plane_url: 'https://control.example.test',
      },
    })).resolves.toEqual({ disposition: 'created', githubRunId: '9010' });
    await expect(client.getRollbackWorkflowRun('example/repo', '9010')).resolves.toMatchObject({
      repository: 'example/repo',
      githubRunId: '9010',
      status: 'completed',
      conclusion: 'success',
      workflowPath: '.github/workflows/delivery-test-rollback.yml',
    });
    expect(getRollbackToken).toHaveBeenCalledOnce();
    expect(getRollbackObservationToken).toHaveBeenCalledOnce();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });
});
