import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubAppInstallationTokenProvider } from '../src/auth/github-app-installation-token.js';

describe('GitHub App installation token provider', () => {
  it('accepts the PKCS#1 PEM returned by the GitHub App manifest conversion', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    expect(privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
    let requested = false;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        requested = true;
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
        return Response.json({
          token: 'CANARY_PKCS1_INSTALLATION_TOKEN',
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getInstallationToken('example/delivery-target')).resolves.toBe(
      'CANARY_PKCS1_INSTALLATION_TOKEN',
    );
    expect(requested).toBe(true);
  });

  it('rejects malformed, duplicated, trailing, or oversized PEM input', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString().trim();
    const edge = '-----';
    const unknown = [
      `${edge}BEGIN EC PRIVATE KEY${edge}`,
      btoa('invalid-key-shape'.repeat(6)),
      `${edge}END EC PRIVATE KEY${edge}`,
    ].join('\n');
    const candidates = [
      unknown,
      `${pkcs1}\n${pkcs1}`,
      `${pkcs1}\ntrailing-data`,
      'x'.repeat(20_001),
    ];
    for (const privateKeyPem of candidates) {
      expect(() => new GitHubAppInstallationTokenProvider({
        appId: '7890',
        installationId: '123456',
        privateKeyPem,
        allowedRepositories: ['example/delivery-target'],
      })).toThrow('GitHub App private key is invalid');
    }
  });

  it('rejects malformed PKCS#8 DER before the GitHub request', async () => {
    const edge = '-----';
    const privateKeyPem = [
      `${edge}BEGIN PRIVATE KEY${edge}`,
      btoa('invalid-der'.repeat(10)),
      `${edge}END PRIVATE KEY${edge}`,
    ].join('\n');
    let requested = false;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async () => {
        requested = true;
        return new Response(null, { status: 500 });
      },
    });

    await expect(provider.getInstallationToken('example/delivery-target'))
      .rejects.toThrow('GitHub App private key could not be loaded');
    expect(requested).toBe(false);
  });

  it('signs a short App JWT, narrows the token to the allowed repository, and caches it', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const fetchImplementation: typeof fetch = async (input, init) => {
      requestCount += 1;
      expect(String(input)).toBe(
        'https://api.github.test/app/installations/123456/access_tokens',
      );
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      expect(authorization).toMatch(/^Bearer /);
      const jwt = authorization?.slice('Bearer '.length);
      if (jwt === undefined) throw new Error('missing test JWT');
      const verified = await jwtVerify(jwt, keys.publicKey, {
        algorithms: ['RS256'],
        issuer: '7890',
        currentDate: new Date('2026-07-25T12:00:00.000Z'),
      });
      expect(verified.protectedHeader.alg).toBe('RS256');
      expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(600);
      expect(JSON.parse(String(init?.body))).toEqual({
        repositories: ['delivery-target'],
        permissions: { actions: 'write', contents: 'read' },
      });
      return Response.json(
        {
          token: 'CANARY_INSTALLATION_TOKEN',
          expires_at: '2026-07-25T13:00:00.000Z',
        },
        { status: 201 },
      );
    };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      apiBaseUrl: 'https://api.github.test',
      fetch: fetchImplementation,
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    expect(await provider.getInstallationToken('example/delivery-target')).toBe(
      'CANARY_INSTALLATION_TOKEN',
    );
    expect(await provider.getInstallationToken('example/delivery-target')).toBe(
      'CANARY_INSTALLATION_TOKEN',
    );
    expect(requestCount).toBe(1);
    await expect(provider.getInstallationToken('attacker/other-repo')).rejects.toThrow(
      'GitHub repository is not allowed',
    );
  });

  it('does not include GitHub response bodies or private key material in errors', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const responseCanary = 'CANARY_GITHUB_TOKEN_RESPONSE_BODY';
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async () => new Response(responseCanary, { status: 403 }),
    });
    const promise = provider.getInstallationToken('example/delivery-target');
    await expect(promise).rejects.toThrow('GitHub installation token request failed');
    await expect(promise).rejects.not.toThrow(responseCanary);
    await expect(promise).rejects.not.toThrow(privateKeyPem);
  });

  it('issues an uncached repo-scoped write credential and revokes it through GitHub', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        if (calls.length === 1) {
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({
            repositories: ['delivery-target'],
            permissions: { contents: 'write', pull_requests: 'write' },
          });
          return Response.json({
            token: 'CANARY_WRITE_INSTALLATION_TOKEN',
            expires_at: '2026-07-25T13:00:00.000Z',
          }, { status: 201 });
        }
        expect(String(input)).toBe('https://api.github.test/installation/token');
        expect(init?.method).toBe('DELETE');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer CANARY_WRITE_INSTALLATION_TOKEN',
        );
        expect(init?.body).toBeUndefined();
        return new Response(null, { status: 204 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.issueWriteCredential('example/delivery-target')).resolves.toEqual({
      token: 'CANARY_WRITE_INSTALLATION_TOKEN',
      expiresAt: '2026-07-25T13:00:00.000Z',
    });
    await expect(
      provider.revokeWriteCredential('CANARY_WRITE_INSTALLATION_TOKEN'),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.test/app/installations/123456/access_tokens',
      'https://api.github.test/installation/token',
    ]);
  });

  it('issues and caches a PR-only token without contents or Actions permission', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      apiBaseUrl: 'https://api.github.test',
      fetch: async (_input, init) => {
        requestCount += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ['delivery-target'],
          permissions: { pull_requests: 'write' },
        });
        return Response.json({
          token: 'CANARY_PULL_REQUEST_ONLY_TOKEN',
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getPullRequestToken('example/delivery-target')).resolves.toBe(
      'CANARY_PULL_REQUEST_ONLY_TOKEN',
    );
    await expect(provider.getPullRequestToken('example/delivery-target')).resolves.toBe(
      'CANARY_PULL_REQUEST_ONLY_TOKEN',
    );
    expect(requestCount).toBe(1);
  });

  it('issues a separate base-observation token with contents read and no Actions or write permission', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        requestCount += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ['delivery-target'],
          permissions: { contents: 'read' },
        });
        return Response.json({
          token: 'CANARY_BASE_OBSERVATION_INSTALLATION_TOKEN',
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getBaseObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_BASE_OBSERVATION_INSTALLATION_TOKEN',
    );
    await expect(provider.getBaseObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_BASE_OBSERVATION_INSTALLATION_TOKEN',
    );
    expect(requestCount).toBe(1);
  });

  it('issues a separate merge-observation token with read-only PR/check/status permissions', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      apiBaseUrl: 'https://api.github.test',
      fetch: async (_input, init) => {
        requestCount += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ['delivery-target'],
          permissions: {
            checks: 'read',
            contents: 'read',
            pull_requests: 'read',
            statuses: 'read',
          },
        });
        return Response.json({
          token: 'CANARY_MERGE_OBSERVATION_INSTALLATION_TOKEN',
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getMergeObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_MERGE_OBSERVATION_INSTALLATION_TOKEN',
    );
    await expect(provider.getMergeObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_MERGE_OBSERVATION_INSTALLATION_TOKEN',
    );
    expect(requestCount).toBe(1);
  });

  it('issues and caches a deployment-only token without Actions, contents, or PR permission', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        requestCount += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ['delivery-target'],
          permissions: { deployments: 'write' },
        });
        return Response.json({
          token: 'CANARY_DEPLOYMENT_ONLY_TOKEN',
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getDeploymentToken('example/delivery-target')).resolves.toBe(
      'CANARY_DEPLOYMENT_ONLY_TOKEN',
    );
    await expect(provider.getDeploymentToken('example/delivery-target')).resolves.toBe(
      'CANARY_DEPLOYMENT_ONLY_TOKEN',
    );
    expect(requestCount).toBe(1);
  });

  it('keeps production deployment on a separate deployments-only token cache', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        requestCount += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ['delivery-target'],
          permissions: { deployments: 'write' },
        });
        return Response.json({
          token: `CANARY_DEPLOYMENT_TOKEN_${requestCount}`,
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getDeploymentToken('example/delivery-target')).resolves.toBe(
      'CANARY_DEPLOYMENT_TOKEN_1',
    );
    await expect(
      provider.getProductionDeploymentToken('example/delivery-target'),
    ).resolves.toBe('CANARY_DEPLOYMENT_TOKEN_2');
    await expect(
      provider.getProductionDeploymentToken('example/delivery-target'),
    ).resolves.toBe('CANARY_DEPLOYMENT_TOKEN_2');
    expect(requestCount).toBe(2);
  });

  it('uses another read-only cache for production status reconciliation', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const permissions: unknown[] = [];
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        permissions.push(JSON.parse(String(init?.body)));
        return Response.json({
          token: `CANARY_PRODUCTION_TOKEN_${permissions.length}`,
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });
    await provider.getProductionDeploymentToken('example/delivery-target');
    await expect(
      provider.getProductionDeploymentObservationToken('example/delivery-target'),
    ).resolves.toBe('CANARY_PRODUCTION_TOKEN_2');
    await expect(
      provider.getProductionDeploymentObservationToken('example/delivery-target'),
    ).resolves.toBe('CANARY_PRODUCTION_TOKEN_2');
    expect(permissions).toEqual([
      {
        repositories: ['delivery-target'],
        permissions: { deployments: 'write' },
      },
      {
        repositories: ['delivery-target'],
        permissions: { deployments: 'read' },
      },
    ]);
  });

  it('keeps test deployment status reads separate from deployment writes', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const permissions: unknown[] = [];
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        permissions.push(JSON.parse(String(init?.body)));
        return Response.json({
          token: `CANARY_TEST_DEPLOYMENT_TOKEN_${permissions.length}`,
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });
    await provider.getDeploymentToken('example/delivery-target');
    await expect(
      provider.getTestDeploymentObservationToken('example/delivery-target'),
    ).resolves.toBe('CANARY_TEST_DEPLOYMENT_TOKEN_2');
    await expect(
      provider.getTestDeploymentObservationToken('example/delivery-target'),
    ).resolves.toBe('CANARY_TEST_DEPLOYMENT_TOKEN_2');
    expect(permissions).toEqual([
      {
        repositories: ['delivery-target'],
        permissions: { deployments: 'write' },
      },
      {
        repositories: ['delivery-target'],
        permissions: { deployments: 'read' },
      },
    ]);
  });

  it('keeps acceptance dispatch on a separate cache with only Actions write and contents read', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        requestCount += 1;
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ['delivery-target'],
          permissions: { actions: 'write', contents: 'read' },
        });
        return Response.json({
          token: `CANARY_ACTIONS_TOKEN_${requestCount}`,
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getInstallationToken('example/delivery-target')).resolves.toBe(
      'CANARY_ACTIONS_TOKEN_1',
    );
    await expect(provider.getAcceptanceToken('example/delivery-target')).resolves.toBe(
      'CANARY_ACTIONS_TOKEN_2',
    );
    await expect(provider.getAcceptanceToken('example/delivery-target')).resolves.toBe(
      'CANARY_ACTIONS_TOKEN_2',
    );
    expect(requestCount).toBe(2);
  });

  it('separates rollback dispatch, status observation, and policy observation tokens', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const permissions: unknown[] = [];
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: async (_input, init) => {
        permissions.push(JSON.parse(String(init?.body)));
        return Response.json({
          token: `CANARY_ROLLBACK_TOKEN_${permissions.length}`,
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });
    await expect(provider.getPolicyObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_ROLLBACK_TOKEN_1',
    );
    await expect(provider.getRollbackToken('example/delivery-target')).resolves.toBe(
      'CANARY_ROLLBACK_TOKEN_2',
    );
    await expect(provider.getRollbackObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_ROLLBACK_TOKEN_3',
    );
    await expect(provider.getPolicyObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_ROLLBACK_TOKEN_1',
    );
    await expect(provider.getRollbackToken('example/delivery-target')).resolves.toBe(
      'CANARY_ROLLBACK_TOKEN_2',
    );
    await expect(provider.getRollbackObservationToken('example/delivery-target')).resolves.toBe(
      'CANARY_ROLLBACK_TOKEN_3',
    );
    expect(permissions).toEqual([
      {
        repositories: ['delivery-target'],
        permissions: { contents: 'read' },
      },
      {
        repositories: ['delivery-target'],
        permissions: { actions: 'write', contents: 'read' },
      },
      {
        repositories: ['delivery-target'],
        permissions: { actions: 'read' },
      },
    ]);
  });
});
