import { describe, expect, it } from 'vitest';
import { GitHubPatTokenProvider } from '../src/auth/github-pat-token.js';
import type { Bindings } from '../src/env.js';
import { githubActionsRuntimeFromEnv } from '../src/reconciliation/github-run-reconciliation-runtime.js';

const PAT = 'github_pat_test_canary_123';
const BASE = {
  DB_CONTROL: {} as D1Database,
  GITHUB_AUTH_MODE: 'pat',
  GITHUB_PAT: PAT,
  GITHUB_ALLOWED_REPOSITORIES: '["example/repo"]',
} as Bindings;

describe('GitHub PAT provider', () => {
  it('returns the PAT only for an allowlisted repository', async () => {
    const provider = new GitHubPatTokenProvider({
      pat: PAT,
      allowedRepositories: ['example/repo'],
    });
    await expect(provider.getInstallationToken('example/repo')).resolves.toBe(PAT);
    await expect(provider.getBaseObservationToken('example/repo')).resolves.toBe(PAT);
    await expect(provider.getPullRequestToken('attacker/repo')).rejects.toThrow(
      'GitHub repository is not allowed',
    );
  });

  it('fails closed for malformed or expired credentials', async () => {
    expect(() => new GitHubPatTokenProvider({ pat: 'bad\npat', allowedRepositories: ['example/repo'] }))
      .toThrow('GitHub PAT is invalid');
    expect(() => new GitHubPatTokenProvider({
      pat: PAT,
      allowedRepositories: ['example/repo'],
      patExpiresAt: '2026-07-25T12:00:00.000Z',
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    })).toThrow('GitHub PAT expiry is invalid');
    const provider = new GitHubPatTokenProvider({
      pat: PAT,
      allowedRepositories: ['example/repo'],
      patExpiresAt: '2026-07-25T12:00:01.000Z',
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });
    await expect(provider.issueWriteCredential('example/repo')).resolves.toEqual({
      token: PAT,
      expiresAt: '2026-07-25T12:00:01.000Z',
    });
  });

  it('selects PAT mode and rejects mixed App/PAT credentials', () => {
    const runtime = githubActionsRuntimeFromEnv(BASE);
    expect(runtime?.allowedRepositories).toEqual(['example/repo']);
    expect(() => githubActionsRuntimeFromEnv({
      ...BASE,
      GITHUB_APP_ID: '123',
    })).toThrow('mixes App and PAT credentials');
    expect(() => githubActionsRuntimeFromEnv({
      ...BASE,
      GITHUB_AUTH_MODE: 'invalid',
    })).toThrow('configuration is invalid');
  });
});
