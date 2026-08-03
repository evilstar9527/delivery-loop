import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  CloudflareObservabilityCredentialVerificationAuthorizationV1Schema,
  CloudflareObservabilityCredentialVerificationSummaryV1Schema,
  cloudflareObservabilityCredentialVerificationAuthorityDigest,
  type CloudflareObservabilityCredentialVerificationAuthorizationV1,
} from '../src/domain/cloudflare-observability-credential-verification.js';
import {
  CloudflareObservabilityCredentialVerificationError,
  verifyExistingCloudflareObservabilityCredential,
} from '../src/pilot/cloudflare-observability-credential-verifier.js';

const ACCOUNT_ID = '1'.repeat(32);
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'cfat_WORKERS_OBSERVABILITY_READ_1234567890';
const CANARY = 'github_pat_CLOUDFLARE_OBSERVABILITY_VERIFY_CANARY_1234567890';
const API_ORIGIN = 'https://api.cloudflare.test';
const AUTHORIZED_AT = '2026-08-03T02:00:00.000Z';
const AUTHORITY_EXPIRES_AT = '2026-08-03T02:20:00.000Z';
const NOW = new Date('2026-08-03T02:05:00.000Z');

async function authorization(
  changes: Record<string, unknown> = {},
): Promise<CloudflareObservabilityCredentialVerificationAuthorizationV1> {
  const base = {
    schemaVersion: '1' as const,
    authorizationId: 'cloudflare-observability-credential-verification-round256',
    authorizedAt: AUTHORIZED_AT,
    expiresAt: AUTHORITY_EXPIRES_AT,
    accountIdDigest: await canonicalSha256(ACCOUNT_ID),
    tokenIdDigest: await canonicalSha256(TOKEN_ID),
    tokenName: 'delivery-loop-workers-observability-read-r250-20260802223250',
    keychainService:
      'delivery-loop-github-app-transport-diagnostic-cloudflare-observability-token' as const,
    keychainAccount: 'delivery-loop-transport-diagnostic' as const,
    telemetryProbe: {
      scriptName: 'delivery-loop-control-plane',
      window: {
        from: '2026-08-02T00:39:40.000Z',
        to: '2026-08-02T00:39:54.000Z',
      },
    },
    effects: {
      keychainReads: 1 as const,
      tokenVerifications: 1 as const,
      telemetryQueries: 1 as const,
      tokenInventoryReads: 0 as const,
      permissionGroupReads: 0 as const,
      tokenCreates: 0 as const,
      keychainWrites: 0 as const,
      tokenDeletes: 0 as const,
      retries: 0 as const,
    },
  };
  const changed = { ...base, ...changes };
  return CloudflareObservabilityCredentialVerificationAuthorizationV1Schema.parse({
    ...changed,
    authorityDigest: await cloudflareObservabilityCredentialVerificationAuthorityDigest(changed),
  });
}

function envelope(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

interface ObservedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body?: unknown;
}

function fakeCloudflare(
  requests: ObservedRequest[],
  options: {
    tokenId?: string;
    verifyResponse?: Response;
    probeResponse?: Response;
    probeThrows?: boolean;
  } = {},
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    requests.push({
      method,
      url: url.toString(),
      authorization: new Headers(init?.headers).get('authorization'),
      ...(body === undefined ? {} : { body }),
    });
    if (url.pathname.endsWith('/tokens/verify')) {
      return options.verifyResponse ?? envelope({ id: options.tokenId ?? TOKEN_ID, status: 'active' });
    }
    if (url.pathname.endsWith('/workers/observability/telemetry/query')) {
      if (options.probeThrows === true) throw new Error('unsafe transport detail');
      return options.probeResponse ?? envelope({
        run: { accountId: ACCOUNT_ID, dry: true },
        events: { count: 0, events: [] },
      });
    }
    throw new Error('unexpected request');
  };
}

function verifierOptions(fetcher: typeof fetch) {
  return {
    credential: CREDENTIAL,
    cloudflareAccountId: ACCOUNT_ID,
    canary: CANARY,
    now: () => NOW,
    cloudflareApiOrigin: API_ORIGIN,
    fetcher,
  };
}

function code(
  expected: string,
  stage?: string,
  failureKind?: string,
): (error: unknown) => boolean {
  return (error) => error instanceof CloudflareObservabilityCredentialVerificationError &&
    error.code === expected && (stage === undefined || error.stage === stage) &&
    (failureKind === undefined || error.failureKind === failureKind);
}

describe('existing Cloudflare Workers Observability credential verification', () => {
  it('accepts only a strict authority with a canonical digest', async () => {
    const example = JSON.parse(readFileSync(resolve(
      'schemas/cloudflare-observability-credential-verification-v1.example.json',
    ), 'utf8')) as Record<string, unknown>;
    expect(CloudflareObservabilityCredentialVerificationAuthorizationV1Schema.safeParse(example)
      .success).toBe(true);
    await expect(cloudflareObservabilityCredentialVerificationAuthorityDigest(example))
      .resolves.toBe(example.authorityDigest);
  });

  it('verifies the exact token identity then runs one dry telemetry probe', async () => {
    const value = await authorization();
    const requests: ObservedRequest[] = [];
    const summary = await verifyExistingCloudflareObservabilityCredential(
      value,
      verifierOptions(fakeCloudflare(requests)),
    );
    expect(CloudflareObservabilityCredentialVerificationSummaryV1Schema.parse(summary))
      .toEqual({
        schemaVersion: '1',
        authorizationId: value.authorizationId,
        accountIdDigest: value.accountIdDigest,
        tokenIdDigest: value.tokenIdDigest,
        tokenName: value.tokenName,
        keychainService: value.keychainService,
        keychainAccount: value.keychainAccount,
        status: 'verified',
        effects: value.effects,
        plaintextLeaks: 0,
      });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.authorization))
      .toEqual([`Bearer ${CREDENTIAL}`, `Bearer ${CREDENTIAL}`]);
    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(requests[1]).toMatchObject({
      method: 'POST',
      body: {
        view: 'events',
        dry: true,
        timeframe: value.telemetryProbe.window,
        parameters: {
          datasets: ['cloudflare-workers'],
          filters: [{
            key: '$metadata.service',
            operation: 'eq',
            type: 'string',
            value: value.telemetryProbe.scriptName,
          }],
          groupBys: [],
          calculations: [],
          limit: 1,
        },
      },
    });
  });

  it('rejects authority, account, credential and canary drift before network', async () => {
    const valid = await authorization();
    for (const [input, changes] of [
      [{ ...valid, authorityDigest: `sha256:${'f'.repeat(64)}` }, {}],
      [valid, { cloudflareAccountId: '2'.repeat(32) }],
      [valid, { credential: 'invalid' }],
      [valid, { canary: CREDENTIAL }],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(verifyExistingCloudflareObservabilityCredential(
        input,
        { ...verifierOptions(fakeCloudflare(requests)), ...changes },
      )).rejects.toSatisfy((error: unknown) =>
        code('configuration_invalid')(error) || code('authorization_invalid')(error)
      );
      expect(requests).toHaveLength(0);
    }
  });

  it('fails closed on token identity drift before telemetry and never retries', async () => {
    const value = await authorization();
    const requests: ObservedRequest[] = [];
    await expect(verifyExistingCloudflareObservabilityCredential(
      value,
      verifierOptions(fakeCloudflare(requests, {
        tokenId: '44444444-4444-4444-8444-444444444444',
      })),
    )).rejects.toSatisfy(code('token_identity_mismatch', 'token_verify'));
    expect(requests).toHaveLength(1);
  });

  it('rejects unavailable or secret-bearing responses with one request per stage', async () => {
    const value = await authorization();
    for (const [options, expected, stage, failureKind, count] of [
      [{ verifyResponse: new Response('', { status: 403 }) },
        'token_verification_failed', 'token_verify', 'auth_rejected', 1],
      [{ probeResponse: new Response('', { status: 403 }) },
        'telemetry_probe_failed', 'telemetry_probe', 'auth_rejected', 2],
      [{ probeThrows: true },
        'telemetry_probe_failed', 'telemetry_probe', 'transport_unavailable', 2],
      [{ verifyResponse: envelope({ id: TOKEN_ID, status: 'active', leaked: CREDENTIAL }) },
        'secret_leak_detected', 'token_verify', undefined, 1],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(verifyExistingCloudflareObservabilityCredential(
        value,
        verifierOptions(fakeCloudflare(requests, options)),
      )).rejects.toSatisfy(code(expected, stage, failureKind));
      expect(requests).toHaveLength(count);
    }
  });

  it('defaults to exit 2 before authority, Keychain or network access', () => {
    const marker = 'github_pat_DEFAULT_ZERO_NETWORK_CANARY_1234567890';
    const result = spawnSync('pnpm', [
      'exec',
      'tsx',
      'scripts/verify-cloudflare-observability-credential.ts',
    ], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION: '',
        CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_AUTHORITY_FILE: marker,
        CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_ACCOUNT_ID: marker,
        CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_CANARY_SECRET: marker,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('opt-in missing');
    expect(result.stderr).not.toContain(marker);
  });
});
