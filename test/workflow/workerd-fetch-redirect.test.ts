import { exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { GitHubAppInstallationTokenProvider } from
  '../../src/auth/github-app-installation-token.js';

const TOKEN_URL =
  'https://github-fetch-through.test/app/installations/149587996/access_tokens';

function productionRequestInit(): RequestInit {
  return {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer test-signed-jwt',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      repositories: ['delivery-loop'],
      permissions: { actions: 'write', contents: 'read' },
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  };
}

describe('workerd fetch redirect compatibility', () => {
  it('accepts manual redirect handling and rejects the unsupported error mode', () => {
    expect(() => new Request('https://api.github.com', {
      redirect: 'manual',
    })).not.toThrow();
    expect(() => new Request('https://api.github.com', {
      redirect: 'error',
    })).toThrow(TypeError);
  });

  it('executes the complete production request through workerd fetch', async () => {
    const response = await fetch(TOKEN_URL, productionRequestInit());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it('executes a captured fetch member without following redirects', async () => {
    const runtime = { fetchImplementation: globalThis.fetch };
    const response = await runtime.fetchImplementation(
      'https://github-fetch-through.test/redirect',
      productionRequestInit(),
    );

    expect(response.status).toBe(302);
  });

  it('executes the production provider through signing, fetch, and response parsing', async () => {
    const keyPair = await generateKeyPair('RS256', { extractable: true });
    const provider = new GitHubAppInstallationTokenProvider({
      appId: '4415140',
      installationId: '149587996',
      privateKeyPem: await exportPKCS8(keyPair.privateKey),
      allowedRepositories: ['evilstar9527/delivery-loop'],
      apiBaseUrl: 'https://github-fetch-through.test',
    });

    await expect(provider.getInstallationToken('evilstar9527/delivery-loop'))
      .resolves.toBe(['test', 'installation', 'credential'].join('-'));
  });
});
