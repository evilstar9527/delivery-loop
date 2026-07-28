import { describe, expect, it } from 'vitest';
import { GitHubMergeGateApiClient } from '../src/reconciliation/github-merge-gate-reconciler.js';

const REPOSITORY = 'example/delivery-target';
const HEAD_SHA = 'b'.repeat(40);
const BASE_SHA = 'a'.repeat(40);
const NEW_BASE_SHA = 'c'.repeat(40);

function response(url: string, options: { pending?: boolean; newBase?: boolean } = {}): Response {
  if (url.endsWith('/pulls/7')) {
    return Response.json({
      state: 'open',
      draft: false,
      mergeable: true,
      mergeable_state: options.pending ? 'blocked' : 'clean',
      updated_at: '2026-07-26T03:00:00.000Z',
      user: { login: 'delivery-author' },
      head: { ref: 'agent/task/attempt', sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
      base: { ref: 'main', sha: options.newBase ? NEW_BASE_SHA : BASE_SHA,
        repo: { full_name: REPOSITORY } },
    });
  }
  if (url.endsWith('/git/ref/heads/main')) {
    return Response.json({
      ref: 'refs/heads/main',
      object: { type: 'commit', sha: options.newBase ? NEW_BASE_SHA : BASE_SHA },
    });
  }
  if (url.endsWith('/rules/branches/main')) {
    return Response.json([
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'ci', integration_id: 42 }],
        },
      },
      {
        type: 'pull_request',
        parameters: { required_approving_review_count: 1 },
      },
    ]);
  }
  if (url.includes('/check-runs')) {
    return Response.json({
      total_count: 1,
      check_runs: [{
        name: 'ci',
        status: options.pending ? 'in_progress' : 'completed',
        conclusion: options.pending ? null : 'success',
        app: { id: 42 },
      }],
    });
  }
  if (url.includes('/status?')) return Response.json({ statuses: [] });
  if (url.endsWith('/pulls/7/reviews?per_page=100')) {
    return Response.json(options.pending ? [] : [{
      id: 9001,
      user: { login: 'human-reviewer' },
      state: 'APPROVED',
      commit_id: HEAD_SHA,
      submitted_at: '2026-07-26T02:59:00.000Z',
    }]);
  }
  throw new Error(`unexpected fake GitHub URL: ${url}`);
}

describe('GitHub merge gate API client', () => {
  it('derives an exact passing fact from PR, base, rules, checks, statuses, and reviews', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const client = new GitHubMergeGateApiClient({
      getMergeObservationToken: async () => 'CANARY_MERGE_OBSERVATION_TOKEN',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
        return response(url);
      },
    });

    await expect(client.observeMergeGate({
      repository: REPOSITORY,
      number: 7,
      headBranch: 'agent/task/attempt',
      baseBranch: 'main',
    })).resolves.toMatchObject({
      schemaVersion: '1',
      repository: REPOSITORY,
      number: 7,
      pullRequestAuthorLogin: 'delivery-author',
      headBranch: 'agent/task/attempt',
      headSha: HEAD_SHA,
      baseBranch: 'main',
      baseSha: BASE_SHA,
      pullRequestBaseSha: BASE_SHA,
      state: 'open',
      draft: false,
      mergeability: 'mergeable',
      mergeState: 'clean',
      reviewDecision: 'approved',
      requiredApprovals: 1,
      approvedReviewCount: 1,
      requiredChecks: [{ context: 'ci', integrationId: 42, state: 'passed' }],
      policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      checksDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      reviewsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(calls).toHaveLength(6);
    expect(calls.every((call) =>
      call.authorization === 'Bearer CANARY_MERGE_OBSERVATION_TOKEN')).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.test/repos/${REPOSITORY}/pulls/7`,
      `https://api.github.test/repos/${REPOSITORY}/git/ref/heads/main`,
      `https://api.github.test/repos/${REPOSITORY}/rules/branches/main`,
      `https://api.github.test/repos/${REPOSITORY}/commits/${HEAD_SHA}/check-runs?filter=latest&per_page=100`,
      `https://api.github.test/repos/${REPOSITORY}/commits/${HEAD_SHA}/status?per_page=100`,
      `https://api.github.test/repos/${REPOSITORY}/pulls/7/reviews?per_page=100`,
    ]);
  });

  it('returns bounded failing facts for pending checks/reviews and a moved base', async () => {
    const client = new GitHubMergeGateApiClient({
      getMergeObservationToken: async () => 'merge-read-token',
    }, {
      fetch: async (input) => response(String(input), { pending: true, newBase: true }),
    });
    await expect(client.observeMergeGate({
      repository: REPOSITORY,
      number: 7,
      headBranch: 'agent/task/attempt',
      baseBranch: 'main',
    })).resolves.toMatchObject({
      baseSha: NEW_BASE_SHA,
      mergeState: 'blocked',
      reviewDecision: 'review_required',
      approvedReviewCount: 0,
      requiredChecks: [{ context: 'ci', integrationId: 42, state: 'pending' }],
    });
  });

  it('fails closed on malformed bindings without exposing token or response body', async () => {
    const token = 'CANARY_MERGE_GATE_TOKEN';
    const bodyCanary = 'CANARY_MERGE_GATE_RESPONSE';
    const client = new GitHubMergeGateApiClient({
      getMergeObservationToken: async () => token,
    }, {
      fetch: async () => Response.json({ state: 'open', bodyCanary }),
    });
    const observed = client.observeMergeGate({
      repository: REPOSITORY,
      number: 7,
      headBranch: 'agent/task/attempt',
      baseBranch: 'main',
    });
    await expect(observed).rejects.toThrow('GitHub pull request merge query response is invalid');
    await expect(observed).rejects.not.toThrow(token);
    await expect(observed).rejects.not.toThrow(bodyCanary);
  });

  it('rejects paginated or oversized responses before parsing an unbounded body', async () => {
    const raw = 'CANARY_MERGE_GATE_OVERSIZED_RESPONSE';
    const client = new GitHubMergeGateApiClient({
      getMergeObservationToken: async () => 'merge-read-token',
    }, {
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/pulls/7')) {
          return new Response(raw, {
            status: 200,
            headers: { link: '<https://api.github.test/next>; rel="next"' },
          });
        }
        return new Response(raw, { status: 200 });
      },
    });
    const observed = client.observeMergeGate({
      repository: REPOSITORY,
      number: 7,
      headBranch: 'agent/task/attempt',
      baseBranch: 'main',
    });
    await expect(observed).rejects.toThrow('GitHub pull request merge query failed');
    await expect(observed).rejects.not.toThrow(raw);
  });
});
