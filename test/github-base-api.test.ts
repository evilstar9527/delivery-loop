import { describe, expect, it } from 'vitest';
import {
  GitHubBaseApiClient,
  GitHubBaseResolutionError,
} from '../src/reconciliation/github-base-observation-reconciler.js';

const REPOSITORY = 'example/delivery-target';
const BEFORE_SHA = 'a'.repeat(40);
const AFTER_SHA = 'b'.repeat(40);

describe('GitHub base observation API client', () => {
  it('binds the exact branch ref and proves a fast-forward through compare commits', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new GitHubBaseApiClient({
      getBaseObservationToken: async () => 'CANARY_BASE_OBSERVATION_TOKEN',
    }, {
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        if (url.endsWith('/git/ref/heads/main')) {
          return Response.json({
            ref: 'refs/heads/main',
            object: { type: 'commit', sha: AFTER_SHA },
          });
        }
        return Response.json({
          status: 'ahead',
          ahead_by: 3,
          behind_by: 0,
          base_commit: { sha: BEFORE_SHA },
          merge_base_commit: { sha: BEFORE_SHA },
        });
      },
    });

    await expect(client.observeBase(REPOSITORY, 'main', BEFORE_SHA)).resolves.toMatchObject({
      disposition: 'fast_forward',
      fact: {
        schemaVersion: '1',
        repository: REPOSITORY,
        baseBranch: 'main',
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        relationship: 'ahead',
        aheadBy: 3,
      },
    });
    expect(requests).toEqual([
      {
        url: `https://api.github.test/repos/${REPOSITORY}/git/ref/heads/main`,
        authorization: 'Bearer CANARY_BASE_OBSERVATION_TOKEN',
      },
      {
        url: `https://api.github.test/repos/${REPOSITORY}/compare/${BEFORE_SHA}...${AFTER_SHA}`,
        authorization: 'Bearer CANARY_BASE_OBSERVATION_TOKEN',
      },
    ]);
  });

  it('does not compare an unchanged head and classifies non-fast-forward history without a source fact', async () => {
    let requestCount = 0;
    const unchanged = new GitHubBaseApiClient({
      getBaseObservationToken: async () => 'base-read-token',
    }, {
      fetch: async () => {
        requestCount += 1;
        return Response.json({
          ref: 'refs/heads/main',
          object: { type: 'commit', sha: BEFORE_SHA },
        });
      },
    });
    await expect(unchanged.observeBase(REPOSITORY, 'main', BEFORE_SHA)).resolves.toEqual({
      disposition: 'unchanged',
      headSha: BEFORE_SHA,
    });
    expect(requestCount).toBe(1);

    const divergent = new GitHubBaseApiClient({
      getBaseObservationToken: async () => 'base-read-token',
    }, {
      fetch: async (input) => String(input).includes('/git/ref/')
        ? Response.json({
          ref: 'refs/heads/main',
          object: { type: 'commit', sha: AFTER_SHA },
        })
        : Response.json({
          status: 'diverged',
          ahead_by: 2,
          behind_by: 1,
          base_commit: { sha: BEFORE_SHA },
          merge_base_commit: { sha: 'c'.repeat(40) },
        }),
    });
    await expect(divergent.observeBase(REPOSITORY, 'main', BEFORE_SHA)).resolves.toEqual({
      disposition: 'non_fast_forward',
      fact: {
        schemaVersion: '1',
        repository: REPOSITORY,
        baseBranch: 'main',
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        relationship: 'diverged',
        aheadBy: 2,
        behindBy: 1,
        mergeBaseSha: 'c'.repeat(40),
        referenceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        comparisonDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
  });

  it('rejects mismatched refs and unsafe responses without exposing tokens or response bodies', async () => {
    const tokenCanary = 'CANARY_BASE_READ_TOKEN';
    const bodyCanary = 'CANARY_GITHUB_BASE_RESPONSE';
    const client = new GitHubBaseApiClient({
      getBaseObservationToken: async () => tokenCanary,
    }, {
      fetch: async () => Response.json({
        ref: 'refs/heads/attacker',
        object: { type: 'commit', sha: AFTER_SHA },
        bodyCanary,
      }),
    });
    const result = client.observeBase(REPOSITORY, 'main', BEFORE_SHA);
    await expect(result).rejects.toThrow('GitHub base reference response is invalid');
    await expect(result).rejects.not.toThrow(tokenCanary);
    await expect(result).rejects.not.toThrow(bodyCanary);
  });

  it('classifies credential, reference availability, and reference shape failures safely', async () => {
    const credentialCanary = 'CANARY_GITHUB_CREDENTIAL_FAILURE';
    const credentialFailure = new GitHubBaseApiClient({
      getBaseObservationToken: async () => {
        throw new Error(credentialCanary);
      },
    });
    const credentialResult = credentialFailure.resolveBaseSha(REPOSITORY, 'main');
    await expect(credentialResult).rejects.toMatchObject({
      name: 'GitHubBaseResolutionError',
      code: 'credential_unavailable',
    });
    await expect(credentialResult).rejects.not.toThrow(credentialCanary);

    const networkCanary = 'CANARY_GITHUB_REFERENCE_NETWORK_FAILURE';
    const referenceUnavailable = new GitHubBaseApiClient({
      getBaseObservationToken: async () => 'base-read-token',
    }, {
      fetch: async () => {
        throw new Error(networkCanary);
      },
    });
    const unavailableResult = referenceUnavailable.resolveBaseSha(REPOSITORY, 'main');
    await expect(unavailableResult).rejects.toMatchObject({
      name: 'GitHubBaseResolutionError',
      code: 'reference_unavailable',
    });
    await expect(unavailableResult).rejects.not.toThrow(networkCanary);

    const responseCanary = 'CANARY_GITHUB_REFERENCE_RESPONSE';
    const nonSuccess = new GitHubBaseApiClient({
      getBaseObservationToken: async () => 'base-read-token',
    }, {
      fetch: async () => new Response(responseCanary, { status: 403 }),
    });
    const nonSuccessResult = nonSuccess.resolveBaseSha(REPOSITORY, 'main');
    await expect(nonSuccessResult).rejects.toMatchObject({
      name: 'GitHubBaseResolutionError',
      code: 'reference_unavailable',
    });
    await expect(nonSuccessResult).rejects.not.toThrow(responseCanary);

    const malformed = new GitHubBaseApiClient({
      getBaseObservationToken: async () => 'base-read-token',
    }, {
      fetch: async () => new Response(`{"canary":"${responseCanary}"}`, { status: 200 }),
    });
    const malformedResult = malformed.resolveBaseSha(REPOSITORY, 'main');
    await expect(malformedResult).rejects.toBeInstanceOf(GitHubBaseResolutionError);
    await expect(malformedResult).rejects.toMatchObject({ code: 'reference_invalid' });
    await expect(malformedResult).rejects.not.toThrow(responseCanary);
  });
});
