import { describe, expect, it, vi } from 'vitest';
import {
  GitHubMergeStatusApiClient,
  type GitHubMergeStatusRequest,
} from '../src/reconciliation/github-merge-status-reconciler.js';

const HEAD_SHA = 'b'.repeat(40);
const MERGE_SHA = 'd'.repeat(40);
const REQUEST: GitHubMergeStatusRequest = {
  repository: 'example/delivery-target',
  number: 7,
  url: 'https://github.test/example/delivery-target/pull/7',
  headBranch: 'agent/task/attempt',
  headSha: HEAD_SHA,
  baseBranch: 'main',
};

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    html_url: REQUEST.url,
    state: 'closed',
    merged: true,
    merge_commit_sha: MERGE_SHA,
    merged_at: '2026-07-26T03:01:00.000Z',
    merged_by: { login: 'merge-reviewer' },
    head: {
      ref: REQUEST.headBranch,
      sha: HEAD_SHA,
      repo: { full_name: REQUEST.repository },
    },
    base: {
      ref: 'main',
      sha: 'a'.repeat(40),
      repo: { full_name: REQUEST.repository },
    },
    updated_at: '2026-07-26T03:01:01.000Z',
    ...overrides,
  };
}

describe('GitHub merge status read-only adapter', () => {
  it('uses the merge-observation token and parses one exact merged PR fact', async () => {
    const getMergeObservationToken = vi.fn(async () => 'CANARY_MERGE_READ_TOKEN');
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        'https://api.github.test/repos/example/delivery-target/pulls/7',
      );
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer CANARY_MERGE_READ_TOKEN',
      );
      expect(init?.body).toBeUndefined();
      return Response.json(response());
    });
    const client = new GitHubMergeStatusApiClient(
      { getMergeObservationToken },
      { apiBaseUrl: 'https://api.github.test', fetch: fetcher },
    );
    await expect(client.getMergeStatus(REQUEST)).resolves.toEqual({
      schemaVersion: '1',
      repository: REQUEST.repository,
      number: 7,
      url: REQUEST.url,
      state: 'closed',
      merged: true,
      headBranch: REQUEST.headBranch,
      headSha: HEAD_SHA,
      baseBranch: 'main',
      mergeSha: MERGE_SHA,
      mergedByLogin: 'merge-reviewer',
      mergedAt: '2026-07-26T03:01:00.000Z',
      externalUpdatedAt: '2026-07-26T03:01:01.000Z',
    });
    expect(getMergeObservationToken).toHaveBeenCalledWith(REQUEST.repository);
  });

  it('returns pending for an exact open PR without inventing a merge SHA', async () => {
    const client = new GitHubMergeStatusApiClient({
      async getMergeObservationToken() {
        return 'CANARY_MERGE_READ_TOKEN';
      },
    }, {
      fetch: async () => Response.json(response({
        state: 'open',
        merged: false,
        merge_commit_sha: null,
        merged_at: null,
        merged_by: null,
      })),
    });
    await expect(client.getMergeStatus(REQUEST)).resolves.toBeNull();
  });

  it('fails closed on changed identity or malformed merge data without leaking the response', async () => {
    const rawCanary = 'CANARY_GITHUB_MERGE_RESPONSE_BODY';
    const client = new GitHubMergeStatusApiClient({
      async getMergeObservationToken() {
        return 'CANARY_MERGE_READ_TOKEN';
      },
    }, {
      fetch: async () => Response.json(response({
        head: {
          ref: REQUEST.headBranch,
          sha: 'e'.repeat(40),
          repo: { full_name: REQUEST.repository },
        },
        merge_commit_sha: rawCanary,
      })),
    });
    const promise = client.getMergeStatus(REQUEST);
    await expect(promise).rejects.toThrow('GitHub merge status response is invalid');
    await expect(promise).rejects.not.toThrow(rawCanary);
    await expect(promise).rejects.not.toThrow('CANARY_MERGE_READ_TOKEN');
  });
});
