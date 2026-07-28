import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  GitHubPullRequestApiClient,
  type GitHubPullRequestRequest,
  type GitHubPullRequestTokenProvider,
} from '../src/outbox/github-pull-request.js';

const BODY = '# Delivery Loop Draft PR\n\nEvidence-backed body.\n';
const HEAD_SHA = 'a'.repeat(40);

async function request(): Promise<GitHubPullRequestRequest> {
  return {
    repository: 'example/delivery-target',
    title: 'Delivery Loop: task-pr-publication',
    body: BODY,
    bodyDigest: await canonicalSha256(BODY),
    headBranch: 'agent/task-pr-publication/attempt-pr-publication',
    headSha: HEAD_SHA,
    baseBranch: 'main',
  };
}

function pullRequest(body = BODY): Record<string, unknown> {
  return {
    number: 42,
    html_url: 'https://github.com/example/delivery-target/pull/42',
    state: 'open',
    draft: true,
    title: 'Delivery Loop: task-pr-publication',
    body,
    head: {
      ref: 'agent/task-pr-publication/attempt-pr-publication',
      sha: HEAD_SHA,
      repo: { full_name: 'example/delivery-target' },
    },
    base: {
      ref: 'main',
      repo: { full_name: 'example/delivery-target' },
    },
    updated_at: '2026-07-25T17:01:00Z',
  };
}

class FakeTokenProvider implements GitHubPullRequestTokenProvider {
  readonly repositories: string[] = [];

  async getPullRequestToken(repository: string): Promise<string> {
    this.repositories.push(repository);
    return 'CANARY_PULL_REQUEST_INSTALLATION_TOKEN';
  }
}

describe('GitHub Draft PR REST adapter', () => {
  it('uses a pull-request-scoped token, reconciles by exact head, and creates a Draft PR once', async () => {
    const tokenProvider = new FakeTokenProvider();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new GitHubPullRequestApiClient(tokenProvider, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        if (calls.length === 1) return Response.json([], { status: 200 });
        return Response.json(pullRequest(), { status: 201 });
      },
    });

    await expect(client.ensureDraftPullRequest(await request())).resolves.toMatchObject({
      disposition: 'created',
      fact: {
        repository: 'example/delivery-target',
        number: 42,
        draft: true,
        state: 'open',
        headSha: HEAD_SHA,
      },
    });
    expect(tokenProvider.repositories).toEqual(['example/delivery-target']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/repos/example/delivery-target/pulls?');
    expect(calls[0]!.url).toContain('state=all');
    expect(calls[0]!.url).toContain('base=main');
    expect(calls[0]!.url).toContain('head=example%3Aagent%2Ftask-pr-publication%2Fattempt-pr-publication');
    expect(calls[1]!.url).toBe('https://api.github.test/repos/example/delivery-target/pulls');
    expect(calls[1]!.init?.method).toBe('POST');
    expect(new Headers(calls[1]!.init?.headers).get('authorization')).toBe(
      'Bearer CANARY_PULL_REQUEST_INSTALLATION_TOKEN',
    );
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      title: 'Delivery Loop: task-pr-publication',
      body: BODY,
      head: 'agent/task-pr-publication/attempt-pr-publication',
      base: 'main',
      draft: true,
      maintainer_can_modify: false,
    });
  });

  it('reuses an exact existing PR, supports exact-number reconciliation, and rejects conflicting bodies safely', async () => {
    const tokenProvider = new FakeTokenProvider();
    const expected = await request();
    const existing = new GitHubPullRequestApiClient(tokenProvider, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input) => {
        const url = String(input);
        return url.endsWith('/pulls/42')
          ? Response.json(pullRequest(), { status: 200 })
          : Response.json([pullRequest()], { status: 200 });
      },
    });
    await expect(existing.ensureDraftPullRequest(expected)).resolves.toMatchObject({
      disposition: 'existing',
      fact: { number: 42 },
    });
    await expect(existing.getPullRequest(expected, 42)).resolves.toMatchObject({
      number: 42,
      bodyDigest: expected.bodyDigest,
    });

    const responseCanary = 'CANARY_CONFLICTING_GITHUB_PR_BODY';
    const conflicting = new GitHubPullRequestApiClient(tokenProvider, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async () => Response.json([pullRequest(responseCanary)], { status: 200 }),
    });
    const operation = conflicting.ensureDraftPullRequest(expected);
    await expect(operation).rejects.toThrow('GitHub pull request response is invalid');
    await expect(operation).rejects.not.toThrow(responseCanary);
  });
});
