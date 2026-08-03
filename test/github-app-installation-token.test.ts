import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GitHubAppCredentialError,
  GitHubAppInstallationTokenProvider,
  type GitHubAppCredentialErrorCode,
} from '../src/auth/github-app-installation-token.js';
import type { Bindings } from '../src/env.js';
import { githubActionsRuntimeFromEnv } from '../src/reconciliation/github-run-reconciliation-runtime.js';

function expectCredentialCode(code: GitHubAppCredentialErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof GitHubAppCredentialError && error.code === code;
}

function asRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

async function requestJson(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  return asRequest(input, init).clone().json();
}

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
      fetch: async (input, init) => {
        requested = true;
        expect(asRequest(input, init).headers.get('authorization')).toMatch(/^Bearer /);
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
      })).toThrow(GitHubAppCredentialError);
      try {
        new GitHubAppInstallationTokenProvider({
          appId: '7890',
          installationId: '123456',
          privateKeyPem,
          allowedRepositories: ['example/delivery-target'],
        });
      } catch (error) {
        expect(error).toSatisfy(expectCredentialCode('credential_signing_unavailable'));
      }
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
      .rejects.toSatisfy(expectCredentialCode('credential_signing_unavailable'));
    expect(requested).toBe(false);
  });

  it('signs a short App JWT, narrows the token to the allowed repository, and caches it', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    let requestCount = 0;
    const fetchImplementation: typeof fetch = async (input, init) => {
      requestCount += 1;
      const request = asRequest(input, init);
      expect(request.url).toBe(
        'https://api.github.test/app/installations/123456/access_tokens',
      );
      expect(request.method).toBe('POST');
      const authorization = request.headers.get('authorization');
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
      await expect(request.clone().json()).resolves.toEqual({
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
    await expect(promise).rejects.toSatisfy(expectCredentialCode('credential_auth_rejected'));
    await expect(promise).rejects.not.toThrow(responseCanary);
    await expect(promise).rejects.not.toThrow(privateKeyPem);
  });

  it('separates request construction failure from transport execution', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const fetchImplementation = vi.fn(async () => Response.json({
      token: 'CANARY_REQUEST_CONSTRUCTION_TOKEN',
      expires_at: '2099-01-01T00:00:00.000Z',
    }, { status: 201 }));
    const diagnostics: unknown[] = [];
    const originalRequest = globalThis.Request;
    vi.stubGlobal('Request', class extends originalRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        throw new TypeError('CANARY_REQUEST_CONSTRUCTION_DETAIL');
      }
    });
    try {
      const provider = new GitHubAppInstallationTokenProvider({
        appId: '7890',
        installationId: '123456',
        privateKeyPem,
        allowedRepositories: ['example/delivery-target'],
        fetch: fetchImplementation,
        transportDiagnostic: (record: unknown) => diagnostics.push(record),
      });

      await expect(provider.getBaseObservationToken('example/delivery-target'))
        .rejects.toSatisfy(expectCredentialCode('credential_request_invalid'));
      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(diagnostics).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('executes the exact validated Request object without reparsing RequestInit in fetch', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const inputs: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        inputs.push({ input, init });
        return Response.json({
          token: 'CANARY_VALIDATED_REQUEST_TOKEN',
          expires_at: '2026-07-25T13:00:00.000Z',
        }, { status: 201 });
      },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    });

    await expect(provider.getBaseObservationToken('example/delivery-target'))
      .resolves.toBe('CANARY_VALIDATED_REQUEST_TOKEN');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.input).toBeInstanceOf(Request);
    expect(inputs[0]?.init).toBeUndefined();
    const request = inputs[0]?.input as Request;
    expect(request.url).toBe(
      'https://api.github.test/app/installations/123456/access_tokens',
    );
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('manual');
    expect(request.signal).toBeInstanceOf(AbortSignal);
    await expect(request.clone().json()).resolves.toEqual({
      repositories: ['delivery-target'],
      permissions: { contents: 'read' },
    });
  });

  it('invokes the default runtime fetch through globalThis instead of the provider receiver', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const usedGlobalReceiver: boolean[] = [];
    const fetchImplementation = vi.fn(function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      usedGlobalReceiver.push(this === globalThis);
      expect(input).toBeInstanceOf(Request);
      expect(init).toBeUndefined();
      return Promise.resolve(Response.json({
        token: 'CANARY_GLOBAL_FETCH_RECEIVER_TOKEN',
        expires_at: '2026-07-25T13:00:00.000Z',
      }, { status: 201 }));
    }) as typeof fetch;
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      const provider = new GitHubAppInstallationTokenProvider({
        appId: '7890',
        installationId: '123456',
        privateKeyPem,
        allowedRepositories: ['example/delivery-target'],
        apiBaseUrl: 'https://api.github.test',
        now: () => new Date('2026-07-25T12:00:00.000Z'),
      });

      await expect(provider.getBaseObservationToken('example/delivery-target'))
        .resolves.toBe('CANARY_GLOBAL_FETCH_RECEIVER_TOKEN');
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(usedGlobalReceiver).toEqual([true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['network', null, 'credential_transport_unavailable'],
    ['unauthenticated', 401, 'credential_auth_rejected'],
    ['forbidden', 403, 'credential_auth_rejected'],
    ['installation missing', 404, 'credential_installation_not_found'],
    ['policy rejected', 422, 'credential_policy_rejected'],
    ['redirect rejected', 302, 'credential_response_invalid'],
    ['server unavailable', 503, 'credential_upstream_unavailable'],
    ['unexpected status', 418, 'credential_response_invalid'],
    ['invalid success response', 201, 'credential_response_invalid'],
  ] as const)(
    'classifies %s with a fixed safe stage',
    async (_label, status, expectedCode) => {
      const keys = await generateKeyPair('RS256', { extractable: true });
      const privateKeyPem = await exportPKCS8(keys.privateKey);
      const responseCanary = 'CANARY_GITHUB_CREDENTIAL_STAGE_BODY';
      const provider = new GitHubAppInstallationTokenProvider({
        appId: '7890',
        installationId: '123456',
        privateKeyPem,
        allowedRepositories: ['example/delivery-target'],
        fetch: async () => {
          if (status === null) throw new Error(responseCanary);
          if (status === 201) {
            return Response.json({ canary: responseCanary }, { status });
          }
          return new Response(responseCanary, { status });
        },
      });

      const result = provider.getBaseObservationToken('example/delivery-target');
      await expect(result).rejects.toSatisfy(expectCredentialCode(expectedCode));
      await expect(result).rejects.not.toThrow(responseCanary);
      await expect(result).rejects.not.toThrow(privateKeyPem);
    },
  );

  it.each([
    ['request_timed_out', Object.assign(new Error('CANARY_TIMEOUT_DETAIL'), {
      name: 'TimeoutError',
    })],
    ['dns_failed', new TypeError('CANARY_DNS_DETAIL', { cause: { code: 'ENOTFOUND' } })],
    ['tcp_failed', new TypeError('CANARY_TCP_DETAIL', { cause: { code: 'ECONNRESET' } })],
    ['tls_failed', new TypeError('CANARY_TLS_DETAIL', { cause: { code: 'CERT_HAS_EXPIRED' } })],
    ['request_failed', Object.defineProperty({}, 'name', {
      get: () => { throw new Error('CANARY_HOSTILE_GETTER'); },
    })],
  ] as const)(
    'emits one fixed %s installation-token transport diagnostic without retry or raw detail',
    async (failureKind, failure) => {
      const keys = await generateKeyPair('RS256', { extractable: true });
      const privateKeyPem = await exportPKCS8(keys.privateKey);
      const diagnostics: unknown[] = [];
      let request: Request | undefined;
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = asRequest(input, init);
        throw failure;
      });
      const provider = new GitHubAppInstallationTokenProvider({
        appId: '7890',
        installationId: '123456',
        privateKeyPem,
        allowedRepositories: ['example/delivery-target'],
        fetch: fetchImplementation,
        transportDiagnostic: (record: unknown) => diagnostics.push(record),
      });

      const result = provider.getBaseObservationToken('example/delivery-target');
      await expect(result).rejects.toSatisfy(
        expectCredentialCode('credential_transport_unavailable'),
      );
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(request?.redirect).toBe('manual');
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      expect(diagnostics).toEqual([{
        schemaVersion: '1',
        event: 'github_app_installation_token_transport_failed',
        operation: 'installation_token_exchange',
        failureKind,
        requestAttempts: 1,
      }]);
      const safeProjection = JSON.stringify(diagnostics);
      expect(safeProjection).not.toContain('CANARY_');
      expect(safeProjection).not.toContain(privateKeyPem);
      expect(safeProjection).not.toContain('ENOTFOUND');
      expect(safeProjection).not.toContain('ECONNRESET');
      expect(safeProjection).not.toContain('CERT_HAS_EXPIRED');
    },
  );

  it('keeps the fixed credential stage when the diagnostic sink rejects the record', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError('CANARY_TRANSPORT_DETAIL', { cause: { code: 'EAI_AGAIN' } });
    });
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      fetch: fetchImplementation,
      transportDiagnostic: () => { throw new Error('CANARY_DIAGNOSTIC_SINK_DETAIL'); },
    });

    const result = provider.getBaseObservationToken('example/delivery-target');
    await expect(result).rejects.toSatisfy(
      expectCredentialCode('credential_transport_unavailable'),
    );
    await expect(result).rejects.not.toThrow('CANARY_');
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('wires the fixed diagnostic through the production secure structured log sink', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const transportCanary = 'CANARY_PRODUCTION_TRANSPORT_DETAIL';
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError(`${transportCanary} ${privateKeyPem}`, {
        cause: { code: 'EAI_AGAIN' },
      });
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      const runtime = githubActionsRuntimeFromEnv({
        GITHUB_APP_ID: '7890',
        GITHUB_APP_INSTALLATION_ID: '123456',
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        GITHUB_ALLOWED_REPOSITORIES: '["example/delivery-target"]',
      } as Bindings);
      expect(runtime).not.toBeNull();

      const result = runtime!.provider.getBaseObservationToken('example/delivery-target');
      await expect(result).rejects.toSatisfy(
        expectCredentialCode('credential_transport_unavailable'),
      );
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
      const record = warning.mock.calls[0]?.[0];
      expect(record).toEqual({
        schemaVersion: '1',
        level: 'warn',
        component: 'github_app_credential',
        event: 'github_app_installation_token_transport_failed',
        operation: 'installation_token_exchange',
        failureKind: 'dns_failed',
        requestAttempts: 1,
        observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      const safeProjection = JSON.stringify(record);
      expect(safeProjection).not.toContain(transportCanary);
      expect(safeProjection).not.toContain(privateKeyPem);
      expect(safeProjection).not.toContain('EAI_AGAIN');
    } finally {
      vi.unstubAllGlobals();
      warning.mockRestore();
    }
  });

  it('issues an uncached repo-scoped write credential and revokes it through GitHub', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(keys.privateKey);
    const calls: Request[] = [];
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '7890',
      installationId: '123456',
      privateKeyPem,
      allowedRepositories: ['example/delivery-target'],
      apiBaseUrl: 'https://api.github.test',
      fetch: async (input, init) => {
        const request = asRequest(input, init);
        calls.push(request);
        if (calls.length === 1) {
          expect(request.method).toBe('POST');
          await expect(request.clone().json()).resolves.toEqual({
            repositories: ['delivery-target'],
            permissions: { contents: 'write', pull_requests: 'write' },
          });
          return Response.json({
            token: 'CANARY_WRITE_INSTALLATION_TOKEN',
            expires_at: '2026-07-25T13:00:00.000Z',
          }, { status: 201 });
        }
        expect(request.url).toBe('https://api.github.test/installation/token');
        expect(request.method).toBe('DELETE');
        expect(request.headers.get('authorization')).toBe(
          'Bearer CANARY_WRITE_INSTALLATION_TOKEN',
        );
        expect(request.body).toBeNull();
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
      fetch: async (input, init) => {
        requestCount += 1;
        await expect(requestJson(input, init)).resolves.toEqual({
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
      fetch: async (input, init) => {
        requestCount += 1;
        await expect(requestJson(input, init)).resolves.toEqual({
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
      fetch: async (input, init) => {
        requestCount += 1;
        await expect(requestJson(input, init)).resolves.toEqual({
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
      fetch: async (input, init) => {
        requestCount += 1;
        await expect(requestJson(input, init)).resolves.toEqual({
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
      fetch: async (input, init) => {
        requestCount += 1;
        await expect(requestJson(input, init)).resolves.toEqual({
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
      fetch: async (input, init) => {
        permissions.push(await requestJson(input, init));
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
      fetch: async (input, init) => {
        permissions.push(await requestJson(input, init));
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
      fetch: async (input, init) => {
        requestCount += 1;
        await expect(requestJson(input, init)).resolves.toEqual({
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
      fetch: async (input, init) => {
        permissions.push(await requestJson(input, init));
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
