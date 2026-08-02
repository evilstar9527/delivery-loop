import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema,
  CloudflareObservabilityCredentialReconciliationSummaryV1Schema,
  cloudflareObservabilityCredentialReconciliationAuthorityDigest,
  type CloudflareObservabilityCredentialReconciliationAuthorizationV1,
} from '../src/domain/cloudflare-observability-credential-reconciliation.js';
import {
  CloudflareObservabilityCredentialReconciliationError,
  reconcileCloudflareObservabilityCredential,
  type CloudflareObservabilityCredentialReconcilerOptions,
} from '../src/pilot/cloudflare-observability-credential-reconciler.js';
import {
  StrictAuthorityReadError,
  readStrictExternalAuthority,
} from '../scripts/read-strict-external-authority.js';

const ACCOUNT_ID = '1'.repeat(32);
const BOOTSTRAP_TOKEN = 'cfat_BOOTSTRAP_ACCOUNT_TOKEN_1234567890';
const CANARY = 'github_pat_CLOUDFLARE_RECONCILIATION_CANARY_1234567890';
const API_ORIGIN = 'https://api.cloudflare.test';
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN_NAME = 'delivery-loop-workers-observability-read-round221-20260802130249';
const AUTHORIZED_AT = '2026-08-02T13:35:00.000Z';
const AUTHORITY_EXPIRES_AT = '2026-08-02T13:55:00.000Z';
const SOURCE_PROVISIONING_AUTHORIZED_AT = '2026-08-02T13:02:49.300Z';
const TOKEN_EXPIRES_AT = '2026-08-02T15:02:19.300Z';
const NOW = new Date('2026-08-02T13:40:00.000Z');

async function authorization(
  changes: Record<string, unknown> = {},
): Promise<CloudflareObservabilityCredentialReconciliationAuthorizationV1> {
  const base = {
    schemaVersion: '1' as const,
    authorizationId: 'cloudflare-observability-credential-reconciliation-round222',
    authorizedAt: AUTHORIZED_AT,
    expiresAt: AUTHORITY_EXPIRES_AT,
    sourceProvisioningAuthorizationId:
      'cloudflare-observability-credential-round221-20260802130249',
    sourceProvisioningAuthorityDigest: `sha256:${'2'.repeat(64)}`,
    sourceProvisioningAuthorizedAt: SOURCE_PROVISIONING_AUTHORIZED_AT,
    accountIdDigest: await canonicalSha256(ACCOUNT_ID),
    tokenName: TOKEN_NAME,
    tokenNotBefore: null,
    tokenExpiresAt: TOKEN_EXPIRES_AT,
    effects: {
      tokenInventoryReads: 1 as const,
      permissionGroupReads: 0 as const,
      tokenCreates: 0 as const,
      keychainReads: 0 as const,
      keychainWrites: 0 as const,
      tokenVerifications: 0 as const,
      telemetryQueries: 0 as const,
      tokenDeletes: 0 as const,
      retries: 0 as const,
    },
  };
  const changed = { ...base, ...changes };
  return CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema.parse({
    ...changed,
    authorityDigest:
      await cloudflareObservabilityCredentialReconciliationAuthorityDigest(changed),
  });
}

interface ObservedRequest {
  method: string;
  url: string;
  authorization: string | null;
}

interface FakeCloudflareOptions {
  entries?: readonly unknown[];
  resultInfo?: Record<string, number>;
  response?: Response;
}

function fakeCloudflare(
  options: FakeCloudflareOptions = {},
  requests: ObservedRequest[] = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      method: init?.method ?? 'GET',
      url: url.toString(),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    expect(url.pathname).toBe(`/client/v4/accounts/${ACCOUNT_ID}/tokens`);
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(url.searchParams.get('include_expired')).toBe('true');
    if (options.response !== undefined) return options.response;
    const entries = options.entries ?? [];
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: entries,
      result_info: options.resultInfo ?? {
        page: 1,
        per_page: 50,
        count: entries.length,
        total_count: entries.length,
        total_pages: 1,
      },
    });
  };
}

function targetEntry(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TOKEN_ID,
    name: TOKEN_NAME,
    status: 'active',
    expires_on: TOKEN_EXPIRES_AT,
    ...changes,
  };
}

function options(
  fetcher: typeof fetch,
): CloudflareObservabilityCredentialReconcilerOptions {
  return {
    bootstrapToken: BOOTSTRAP_TOKEN,
    cloudflareAccountId: ACCOUNT_ID,
    canary: CANARY,
    now: () => NOW,
    cloudflareApiOrigin: API_ORIGIN,
    fetcher,
  };
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof CloudflareObservabilityCredentialReconciliationError &&
    error.code === expected;
}

describe('Cloudflare Workers Observability post-create reconciliation', () => {
  it('accepts only the strict synthetic authority and canonical digest', async () => {
    const example = JSON.parse(readFileSync(resolve(
      'schemas/cloudflare-observability-credential-reconciliation-v1.example.json',
    ), 'utf8')) as unknown;
    expect(CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema.safeParse(example)
      .success).toBe(true);
    await expect(cloudflareObservabilityCredentialReconciliationAuthorityDigest(example as object))
      .resolves.toBe((example as { authorityDigest: string }).authorityDigest);
    const valid = await authorization();
    await expect(cloudflareObservabilityCredentialReconciliationAuthorityDigest(valid))
      .resolves.toBe(valid.authorityDigest);
  });

  it('accepts legacy sources and the seven-day lifecycle with a seven-day 30-minute ceiling', async () => {
    await expect(authorization({
      tokenNotBefore: SOURCE_PROVISIONING_AUTHORIZED_AT,
      tokenExpiresAt: '2026-08-03T13:40:00.000Z',
    })).resolves.toMatchObject({ tokenExpiresAt: '2026-08-03T13:40:00.000Z' });
    await expect(authorization({
      tokenExpiresAt: '2026-08-09T13:32:49.300Z',
    })).resolves.toMatchObject({ tokenExpiresAt: '2026-08-09T13:32:49.300Z' });
    await expect(authorization({
      tokenExpiresAt: '2026-08-09T13:32:49.301Z',
    })).rejects.toBeDefined();
  });

  it('shares the strict repo-external 0600 non-symlink authority reader', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'delivery-loop-reconciliation-authority-'));
    try {
      const file = join(directory, 'authority.json');
      writeFileSync(file, JSON.stringify(await authorization()), { mode: 0o600 });
      await expect(readStrictExternalAuthority(
        file,
        CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema,
      )).resolves.toMatchObject({ tokenName: TOKEN_NAME });

      chmodSync(file, 0o644);
      await expect(readStrictExternalAuthority(
        file,
        CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema,
      )).rejects.toSatisfy((error: unknown) =>
        error instanceof StrictAuthorityReadError && error.kind === 'invalid'
      );

      chmodSync(file, 0o600);
      const symlink = join(directory, 'authority-link.json');
      symlinkSync(file, symlink);
      await expect(readStrictExternalAuthority(
        symlink,
        CloudflareObservabilityCredentialReconciliationAuthorizationV1Schema,
      )).rejects.toBeInstanceOf(StrictAuthorityReadError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports one exact present target from one inventory GET without any mutation', async () => {
    const authority = await authorization();
    const requests: ObservedRequest[] = [];
    const summary = await reconcileCloudflareObservabilityCredential(
      authority,
      options(fakeCloudflare({ entries: [targetEntry()] }, requests)),
    );
    expect(CloudflareObservabilityCredentialReconciliationSummaryV1Schema.parse(summary))
      .toEqual({
        schemaVersion: '1',
        authorizationId: authority.authorizationId,
        sourceProvisioningAuthorizationId: authority.sourceProvisioningAuthorizationId,
        sourceProvisioningAuthorityDigest: authority.sourceProvisioningAuthorityDigest,
        sourceProvisioningAuthorizedAt: SOURCE_PROVISIONING_AUTHORIZED_AT,
        accountIdDigest: authority.accountIdDigest,
        tokenName: TOKEN_NAME,
        tokenNotBefore: null,
        tokenExpiresAt: TOKEN_EXPIRES_AT,
        status: 'present',
        tokenIdDigest: await canonicalSha256(TOKEN_ID),
        tokenStatus: 'active',
        effects: authority.effects,
        plaintextLeaks: 0,
      });
    expect(requests).toEqual([{
      method: 'GET',
      url: `${API_ORIGIN}/client/v4/accounts/${ACCOUNT_ID}` +
        '/tokens?per_page=50&include_expired=true',
      authorization: `Bearer ${BOOTSTRAP_TOKEN}`,
    }]);
  });

  it('reports absent only after one complete inventory GET', async () => {
    const authority = await authorization();
    const requests: ObservedRequest[] = [];
    await expect(reconcileCloudflareObservabilityCredential(
      authority,
      options(fakeCloudflare({ entries: [targetEntry({ name: 'unrelated-token' })] }, requests)),
    )).resolves.toMatchObject({ status: 'absent', plaintextLeaks: 0 });
    expect(requests).toHaveLength(1);
  });

  it('accepts equivalent Cloudflare timestamp normalization for the exact lifecycle', async () => {
    const authority = await authorization();
    await expect(reconcileCloudflareObservabilityCredential(
      authority,
      options(fakeCloudflare({
        entries: [targetEntry({
          expires_on: '2026-08-02T15:02:19.300+00:00',
        })],
      })),
    )).resolves.toMatchObject({ status: 'present' });
  });

  it('rejects pagination, ambiguous names, lifecycle drift and unsafe status after one GET', async () => {
    const authority = await authorization();
    for (const [fakeOptions, expected] of [
      [{ entries: [], resultInfo: {
        page: 1, per_page: 50, count: 0, total_count: 51, total_pages: 2,
      } }, 'token_inventory_invalid'],
      [{ entries: [targetEntry(), targetEntry({ id: '44444444-4444-4444-8444-444444444444' })] },
        'target_ambiguous'],
      [{ entries: [targetEntry({ expires_on: '2026-08-02T15:03:19.300Z' })] },
        'target_mismatch'],
      [{ entries: [targetEntry({ not_before: SOURCE_PROVISIONING_AUTHORIZED_AT })] },
        'target_mismatch'],
      [{ entries: [targetEntry({ status: 'mystery' })] }, 'target_mismatch'],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(reconcileCloudflareObservabilityCredential(
        authority,
        options(fakeCloudflare(fakeOptions, requests)),
      )).rejects.toSatisfy(code(expected));
      expect(requests).toHaveLength(1);
    }
  });

  it('rejects authority, account, purpose-token and canary drift before network', async () => {
    const valid = await authorization();
    for (const [input, optionChanges] of [
      [{ ...valid, authorityDigest: `sha256:${'f'.repeat(64)}` }, {}],
      [valid, { cloudflareAccountId: '2'.repeat(32) }],
      [valid, { bootstrapToken: CANARY }],
      [valid, { canary: BOOTSTRAP_TOKEN }],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(reconcileCloudflareObservabilityCredential(
        input,
        { ...options(fakeCloudflare({}, requests)), ...optionChanges },
      )).rejects.toSatisfy((error: unknown) =>
        code('authorization_invalid')(error) || code('configuration_invalid')(error)
      );
      expect(requests).toHaveLength(0);
    }
  });

  it('fails closed without retry on unavailable, malformed or secret-bearing responses', async () => {
    const authority = await authorization();
    for (const [response, expected] of [
      [new Response('', { status: 403 }), 'token_inventory_unavailable'],
      [Response.json({ success: true, errors: [], messages: [], result: [] }),
        'token_inventory_invalid'],
      [Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ ...targetEntry(), echo: BOOTSTRAP_TOKEN }],
        result_info: { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 },
      }), 'secret_leak_detected'],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(reconcileCloudflareObservabilityCredential(
        authority,
        options(fakeCloudflare({ response }, requests)),
      )).rejects.toSatisfy(code(expected));
      expect(requests).toHaveLength(1);
    }
  });

  it('keeps the CLI at exit 2 before authority-file or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/reconcile-cloudflare-observability-credential.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'cloudflare-observability-credential-reconciliation: opt-in missing\n',
    );

    environment.DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION = '1';
    for (const name of [
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_AUTHORITY_FILE',
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_BOOTSTRAP_TOKEN',
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_ACCOUNT_ID',
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_CANARY_SECRET',
    ]) delete environment[name];
    const incomplete = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/reconcile-cloudflare-observability-credential.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(incomplete.status).toBe(2);
    expect(incomplete.stdout).toBe('');
    expect(incomplete.stderr).toBe(
      'cloudflare-observability-credential-reconciliation: required configuration is incomplete\n',
    );
  });
});
