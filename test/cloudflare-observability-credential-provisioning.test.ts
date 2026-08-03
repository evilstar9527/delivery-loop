import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema,
  CloudflareObservabilityCredentialProvisioningSummaryV1Schema,
  cloudflareObservabilityCredentialProvisioningAuthorityDigest,
  type CloudflareObservabilityCredentialProvisioningAuthorizationV1,
} from '../src/domain/cloudflare-observability-credential-provisioning.js';
import {
  CloudflareObservabilityCredentialProvisioningError,
  provisionCloudflareObservabilityCredential,
  type CloudflareObservabilityCredentialProvisionerOptions,
} from '../src/pilot/cloudflare-observability-credential-provisioner.js';

const ACCOUNT_ID = '1'.repeat(32);
const BOOTSTRAP_TOKEN = 'cfat_BOOTSTRAP_ACCOUNT_TOKEN_1234567890';
const CREATED_TOKEN = 'cfat_WORKERS_OBSERVABILITY_READ_1234567890';
const CANARY = 'github_pat_CLOUDFLARE_OBSERVABILITY_CANARY_1234567890';
const API_ORIGIN = 'https://api.cloudflare.test';
const PERMISSION_GROUP_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const AUTHORIZED_AT = '2026-08-02T02:00:00.000Z';
const AUTHORITY_EXPIRES_AT = '2026-08-02T02:20:00.000Z';
const TOKEN_EXPIRES_AT = '2026-08-09T02:20:00Z';
const NOW = new Date('2026-08-02T02:05:00.000Z');
const TOKEN_NAME = 'delivery-loop-workers-observability-read-round215';
const KEYCHAIN_SERVICE =
  'delivery-loop-github-app-transport-diagnostic-cloudflare-observability-token';

async function authorization(
  changes: Record<string, unknown> = {},
): Promise<CloudflareObservabilityCredentialProvisioningAuthorizationV1> {
  const base = {
    schemaVersion: '1' as const,
    authorizationId: 'cloudflare-observability-credential-round215',
    authorizedAt: AUTHORIZED_AT,
    expiresAt: AUTHORITY_EXPIRES_AT,
    accountIdDigest: await canonicalSha256(ACCOUNT_ID),
    tokenName: TOKEN_NAME,
    permissionGroupName: 'Workers Observability Read' as const,
    keychainService: KEYCHAIN_SERVICE,
    tokenExpiresAt: TOKEN_EXPIRES_AT,
    telemetryProbe: {
      scriptName: 'delivery-loop-control-plane',
      window: {
        from: '2026-08-02T00:39:40.000Z',
        to: '2026-08-02T00:39:54.000Z',
      },
    },
    effects: {
      tokenInventoryReads: 1 as const,
      permissionGroupReads: 1 as const,
      tokenCreates: 1 as const,
      keychainWrites: 1 as const,
      tokenVerifications: 1 as const,
      telemetryQueries: 1 as const,
      tokenDeletes: 0 as const,
      retries: 0 as const,
    },
  };
  const changed = { ...base, ...changes };
  return CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema.parse({
    ...changed,
    authorityDigest: await cloudflareObservabilityCredentialProvisioningAuthorityDigest(changed),
  });
}

function envelope(result: unknown, resultInfo?: unknown): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  });
}

interface FakeCloudflareOptions {
  inventory?: readonly unknown[];
  inventoryInfo?: Record<string, number>;
  permissionGroups?: readonly unknown[];
  permissionInfo?: Record<string, number> | null;
  createdToken?: string;
  createExtra?: Record<string, unknown>;
  verifyStatus?: string;
  createStatus?: number;
  createErrorBody?: unknown;
  throwAtCreate?: boolean;
  failAt?: 'inventory' | 'permission_groups' | 'create' | 'verify' | 'telemetry';
}

interface ObservedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body?: unknown;
}

function fakeCloudflare(
  options: FakeCloudflareOptions = {},
  requests: ObservedRequest[] = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    requests.push({
      url: url.toString(),
      method,
      authorization: new Headers(init?.headers).get('authorization'),
      ...(body === undefined ? {} : { body }),
    });
    const tokenBase = `/client/v4/accounts/${ACCOUNT_ID}/tokens`;
    if (url.pathname === tokenBase && method === 'GET') {
      if (options.failAt === 'inventory') return new Response('', { status: 403 });
      expect(url.searchParams.get('per_page')).toBe('50');
      expect(url.searchParams.get('include_expired')).toBe('true');
      return envelope(options.inventory ?? [], options.inventoryInfo ?? {
        page: 1,
        per_page: 50,
        count: options.inventory?.length ?? 0,
        total_count: options.inventory?.length ?? 0,
        total_pages: 1,
      });
    }
    if (url.pathname === `${tokenBase}/permission_groups` && method === 'GET') {
      if (options.failAt === 'permission_groups') return new Response('', { status: 403 });
      expect(url.searchParams.get('name')).toBe('Workers Observability Read');
      expect(url.searchParams.get('scope')).toBe('com.cloudflare.api.account');
      const groups = options.permissionGroups ?? [{
        id: PERMISSION_GROUP_ID,
        name: 'Workers Observability Read',
        scopes: ['com.cloudflare.api.account'],
      }];
      return envelope(groups, options.permissionInfo === null ? undefined :
        options.permissionInfo ?? {
          page: 1,
          per_page: 20,
          count: groups.length,
          total_count: 273,
        });
    }
    if (url.pathname === tokenBase && method === 'POST') {
      if (options.throwAtCreate === true) throw new Error('unsafe create transport detail');
      if (options.createStatus !== undefined) {
        return options.createErrorBody === undefined
          ? new Response('unsafe create response detail', { status: options.createStatus })
          : Response.json(options.createErrorBody, { status: options.createStatus });
      }
      if (options.failAt === 'create') return new Response('', { status: 403 });
      return envelope({
        id: TOKEN_ID,
        name: TOKEN_NAME,
        status: 'active',
        value: options.createdToken ?? CREATED_TOKEN,
        ...(options.createExtra ?? {}),
      });
    }
    if (url.pathname === `${tokenBase}/verify` && method === 'GET') {
      if (options.failAt === 'verify') return new Response('', { status: 403 });
      return envelope({ id: TOKEN_ID, status: options.verifyStatus ?? 'active' });
    }
    if (
      url.pathname ===
        `/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query` &&
      method === 'POST'
    ) {
      if (options.failAt === 'telemetry') return new Response('', { status: 403 });
      return envelope({ run: { accountId: ACCOUNT_ID, dry: true }, events: { count: 0, events: [] } });
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`);
  };
}

function provisionerOptions(
  fetcher: typeof fetch,
  stored: string[] = [],
): CloudflareObservabilityCredentialProvisionerOptions {
  return {
    bootstrapToken: BOOTSTRAP_TOKEN,
    cloudflareAccountId: ACCOUNT_ID,
    canary: CANARY,
    assertStorageAvailable: async () => undefined,
    now: () => NOW,
    cloudflareApiOrigin: API_ORIGIN,
    fetcher,
    storeSecret: async (secret) => { stored.push(secret); },
  };
}

function code(
  expected: string,
  stage?: string,
  failureKind?: string,
  cloudflareErrorCode?: number,
): (error: unknown) => boolean {
  return (error) => error instanceof CloudflareObservabilityCredentialProvisioningError &&
    error.code === expected && (stage === undefined || error.stage === stage) &&
    (failureKind === undefined || error.failureKind === failureKind) &&
    (cloudflareErrorCode === undefined || error.cloudflareErrorCode === cloudflareErrorCode);
}

describe('Cloudflare Workers Observability credential provisioning', () => {
  it('accepts only a strict synthetic authority with a canonical digest', async () => {
    const example = JSON.parse(readFileSync(resolve(
      'schemas/cloudflare-observability-credential-provisioning-v1.example.json',
    ), 'utf8')) as unknown;
    expect(CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema.safeParse(example)
      .success).toBe(true);
    await expect(cloudflareObservabilityCredentialProvisioningAuthorityDigest(example as object))
      .resolves.toBe((example as { authorityDigest: string }).authorityDigest);
    const valid = await authorization();
    await expect(cloudflareObservabilityCredentialProvisioningAuthorityDigest(valid))
      .resolves.toBe(valid.authorityDigest);
  });

  it('requires the provider-bound expiry to use UTC RFC3339 whole seconds', async () => {
    const valid = await authorization();
    for (const tokenExpiresAt of [
      '2026-08-09T02:20:00.123Z',
      '2026-08-09T10:20:00+08:00',
    ]) {
      const changed = { ...valid, tokenExpiresAt };
      changed.authorityDigest =
        await cloudflareObservabilityCredentialProvisioningAuthorityDigest(changed);
      expect(CloudflareObservabilityCredentialProvisioningAuthorizationV1Schema.safeParse(changed)
        .success).toBe(false);
    }
  });

  it('creates the exact account-scoped token, stores it once, verifies it and probes telemetry', async () => {
    const value = await authorization();
    const requests: ObservedRequest[] = [];
    const stored: string[] = [];
    const summary = await provisionCloudflareObservabilityCredential(
      value,
      provisionerOptions(fakeCloudflare({}, requests), stored),
    );
    expect(CloudflareObservabilityCredentialProvisioningSummaryV1Schema.parse(summary)).toEqual({
      schemaVersion: '1',
      authorizationId: value.authorizationId,
      accountIdDigest: value.accountIdDigest,
      tokenName: TOKEN_NAME,
      permissionGroupName: 'Workers Observability Read',
      keychainService: KEYCHAIN_SERVICE,
      tokenExpiresAt: TOKEN_EXPIRES_AT,
      status: 'verified',
      effects: value.effects,
      plaintextLeaks: 0,
    });
    expect(stored).toEqual([CREATED_TOKEN]);
    expect(requests).toHaveLength(5);
    expect(requests.map((request) => request.authorization)).toEqual([
      `Bearer ${BOOTSTRAP_TOKEN}`,
      `Bearer ${BOOTSTRAP_TOKEN}`,
      `Bearer ${BOOTSTRAP_TOKEN}`,
      `Bearer ${CREATED_TOKEN}`,
      `Bearer ${CREATED_TOKEN}`,
    ]);
    expect(requests[2]).toMatchObject({
      method: 'POST',
      body: {
        name: TOKEN_NAME,
        policies: [{
          effect: 'allow',
          permission_groups: [{ id: PERMISSION_GROUP_ID }],
          resources: { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: '*' },
        }],
        expires_on: TOKEN_EXPIRES_AT,
      },
    });
    expect(requests[2]?.body).not.toHaveProperty('not_before');
    expect(requests[4]?.body).toEqual({
      queryId: value.authorizationId,
      view: 'events',
      dry: true,
      timeframe: {
        from: Date.parse(value.telemetryProbe.window.from),
        to: Date.parse(value.telemetryProbe.window.to),
      },
      limit: 1,
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
      },
    });
  });

  it('accepts the permission-group collection shapes allowed by current Cloudflare OpenAPI', async () => {
    const value = await authorization();
    for (const permissionInfo of [
      null,
      {},
      { count: 1, page: 1, per_page: 20, total_count: 273 },
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        value,
        provisionerOptions(fakeCloudflare({ permissionInfo }, requests)),
      )).resolves.toMatchObject({ status: 'verified' });
      expect(requests).toHaveLength(5);
    }
  });

  it('requires seven full days after authority expiry without exceeding seven days 30 minutes', async () => {
    const valid = await authorization();
    const tooShort = {
      ...valid,
      tokenExpiresAt: '2026-08-09T02:19:59Z',
    };
    tooShort.authorityDigest =
      await cloudflareObservabilityCredentialProvisioningAuthorityDigest(tooShort);
    const tooLong = {
      ...valid,
      tokenExpiresAt: '2026-08-09T02:30:01Z',
    };
    tooLong.authorityDigest =
      await cloudflareObservabilityCredentialProvisioningAuthorityDigest(tooLong);
    for (const input of [tooShort, tooLong]) {
      const requests: ObservedRequest[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        input,
        provisionerOptions(fakeCloudflare({}, requests)),
      )).rejects.toSatisfy(code('authorization_invalid'));
      expect(requests).toHaveLength(0);
    }
  });

  it('rejects authority, account and purpose-token drift before network', async () => {
    const valid = await authorization();
    for (const [input, options] of [
      [{ ...valid, authorityDigest: `sha256:${'f'.repeat(64)}` }, {}],
      [valid, { cloudflareAccountId: '2'.repeat(32) }],
      [valid, { canary: BOOTSTRAP_TOKEN }],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        input,
        { ...provisionerOptions(fakeCloudflare({}, requests)), ...options },
      )).rejects.toSatisfy((error: unknown) =>
        code('configuration_invalid')(error) || code('authorization_invalid')(error)
      );
      expect(requests).toHaveLength(0);
    }
  });

  it('fails closed on inventory pagination, duplicate name or permission-group drift', async () => {
    const value = await authorization();
    for (const [options, expected, count] of [
      [{ inventoryInfo: { page: 1, per_page: 50, count: 0, total_count: 51,
        total_pages: 2 } }, 'token_inventory_invalid', 1],
      [{ inventory: [{ id: TOKEN_ID, name: TOKEN_NAME, status: 'expired' }] },
        'duplicate_token_name', 1],
      [{ permissionGroups: [
        { id: PERMISSION_GROUP_ID, name: 'Workers Observability Read', scopes: ['user'] },
      ] }, 'permission_group_mismatch', 2],
      [{ permissionGroups: [
        { id: PERMISSION_GROUP_ID, name: 'Workers Observability Read',
          scopes: ['com.cloudflare.api.account'] },
        { id: '44444444-4444-4444-8444-444444444444',
          name: 'Workers Observability Read', scopes: ['com.cloudflare.api.account'] },
      ] }, 'permission_group_mismatch', 2],
      [{ permissionInfo: { page: 2, per_page: 20, count: 1, total_count: 273 } },
        'permission_groups_invalid', 2],
      [{ permissionInfo: { page: 1, per_page: 20, count: 2, total_count: 273 } },
        'permission_groups_invalid', 2],
      [{ permissionInfo: { page: 1, per_page: 20, count: 1, total_count: 0 } },
        'permission_groups_invalid', 2],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        value,
        provisionerOptions(fakeCloudflare(options, requests)),
      )).rejects.toSatisfy(code(expected));
      expect(requests).toHaveLength(count);
    }
  });

  it('allows the created secret only at result.value and rejects token reuse', async () => {
    const value = await authorization();
    for (const options of [
      { createExtra: { echoed: CREATED_TOKEN } },
      { createdToken: BOOTSTRAP_TOKEN },
      { createdToken: CANARY },
    ]) {
      const requests: ObservedRequest[] = [];
      const stored: string[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        value,
        provisionerOptions(fakeCloudflare(options, requests), stored),
      )).rejects.toSatisfy(code('created_unverified', 'token_create', 'response_invalid'));
      expect(requests).toHaveLength(3);
      expect(stored).toHaveLength(0);
    }
  });

  it('classifies create responses safely without retrying the POST', async () => {
    const value = await authorization();
    for (const [fakeOptions, failureKind] of [
      [{ throwAtCreate: true }, 'transport_unavailable'],
      [{ createStatus: 403 }, 'auth_rejected'],
      [{ createStatus: 422 }, 'request_rejected'],
      [{ createStatus: 429 }, 'rate_limited'],
      [{ createStatus: 500 }, 'upstream_unavailable'],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        value,
        provisionerOptions(fakeCloudflare(fakeOptions, requests)),
      )).rejects.toSatisfy(code('created_unverified', 'token_create', failureKind));
      expect(requests).toHaveLength(3);
      expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    }
  });

  it('extracts only a unique integer Cloudflare error code from a bounded safe create body', async () => {
    const value = await authorization();
    const requests: ObservedRequest[] = [];
    await expect(provisionCloudflareObservabilityCredential(
      value,
      provisionerOptions(fakeCloudflare({
        createStatus: 422,
        createErrorBody: {
          success: false,
          errors: [{ code: 1004, message: 'invalid expires_on' }],
          messages: [],
          result: null,
        },
      }, requests)),
    )).rejects.toSatisfy(code(
      'created_unverified',
      'token_create',
      'request_rejected',
      1004,
    ));
    expect(requests).toHaveLength(3);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('drops the provider code when the create error body is unsafe or ambiguous', async () => {
    const value = await authorization();
    for (const createErrorBody of [
      {
        success: false,
        errors: [{ code: 1004, message: CANARY }],
        messages: [],
        result: null,
      },
      {
        success: false,
        errors: [{ code: 1004, message: ACCOUNT_ID }],
        messages: [],
        result: null,
      },
      {
        success: false,
        errors: [{ code: 1004 }, { code: 1005 }],
        messages: [],
        result: null,
      },
      {
        success: false,
        errors: [{ code: '1004' }],
        messages: [],
        result: null,
      },
    ]) {
      const requests: ObservedRequest[] = [];
      let observed: unknown;
      try {
        await provisionCloudflareObservabilityCredential(
          value,
          provisionerOptions(fakeCloudflare({ createStatus: 422, createErrorBody }, requests)),
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(CloudflareObservabilityCredentialProvisioningError);
      expect(observed).toMatchObject({
        code: 'created_unverified',
        stage: 'token_create',
        failureKind: 'request_rejected',
      });
      expect((observed as CloudflareObservabilityCredentialProvisioningError)
        .cloudflareErrorCode).toBeUndefined();
      expect(String(observed)).not.toContain(CANARY);
      expect(String(observed)).not.toContain(ACCOUNT_ID);
      expect(requests).toHaveLength(3);
      expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    }
  });

  it('returns created_unverified without retry after any post-create failure', async () => {
    const value = await authorization();
    const keychainRequests: ObservedRequest[] = [];
    await expect(provisionCloudflareObservabilityCredential(value, {
      ...provisionerOptions(fakeCloudflare({}, keychainRequests)),
      storeSecret: async () => { throw new Error('unsafe raw detail'); },
    })).rejects.toSatisfy(code('created_unverified', 'keychain'));
    expect(keychainRequests).toHaveLength(3);

    for (const [failAt, stage, expectedRequests] of [
      ['verify', 'token_verify', 4],
      ['telemetry', 'telemetry_probe', 5],
    ] as const) {
      const requests: ObservedRequest[] = [];
      const stored: string[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        value,
        provisionerOptions(fakeCloudflare({ failAt }, requests), stored),
      )).rejects.toSatisfy(code('created_unverified', stage));
      expect(requests).toHaveLength(expectedRequests);
      expect(stored).toEqual([CREATED_TOKEN]);
    }
  });

  it('stops every failed stage without retry and checks the Keychain slot before network', async () => {
    const value = await authorization();
    const storageRequests: ObservedRequest[] = [];
    await expect(provisionCloudflareObservabilityCredential(value, {
      ...provisionerOptions(fakeCloudflare({}, storageRequests)),
      assertStorageAvailable: async () => { throw new Error('slot occupied'); },
    })).rejects.toSatisfy(code('configuration_invalid'));
    expect(storageRequests).toHaveLength(0);

    for (const [failAt, expected, stage, requestCount] of [
      ['inventory', 'token_inventory_unavailable', undefined, 1],
      ['permission_groups', 'permission_groups_unavailable', undefined, 2],
      ['create', 'created_unverified', 'token_create', 3],
    ] as const) {
      const requests: ObservedRequest[] = [];
      await expect(provisionCloudflareObservabilityCredential(
        value,
        provisionerOptions(fakeCloudflare({ failAt }, requests)),
      )).rejects.toSatisfy(code(
        expected,
        stage,
        failAt === 'create' ? 'auth_rejected' : undefined,
      ));
      expect(requests).toHaveLength(requestCount);
    }
  });

  it('keeps the CLI at exit 2 before authority-file, keychain or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_PROVISIONING;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/provision-cloudflare-observability-credential.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'cloudflare-observability-credential-provisioning: opt-in missing\n',
    );

    environment.DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_PROVISIONING = '1';
    for (const name of [
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_AUTHORITY_FILE',
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_BOOTSTRAP_TOKEN',
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_ACCOUNT_ID',
      'CLOUDFLARE_OBSERVABILITY_CREDENTIAL_CANARY_SECRET',
    ]) delete environment[name];
    const incomplete = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/provision-cloudflare-observability-credential.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(incomplete.status).toBe(2);
    expect(incomplete.stdout).toBe('');
    expect(incomplete.stderr).toBe(
      'cloudflare-observability-credential-provisioning: required configuration is incomplete\n',
    );
  });

  it('keeps the macOS Keychain service fixed and receives the secret only on stdin', () => {
    const source = readFileSync(resolve('scripts/store-macos-keychain-secret.swift'), 'utf8');
    expect(source).toContain('FileHandle.standardInput.readDataToEndOfFile()');
    expect(source).toContain(`"${KEYCHAIN_SERVICE}"`);
    expect(source).toContain('SecItemAdd');
    expect(source).not.toContain('CommandLine.arguments');
    expect(source).not.toContain('print(');
  });
});
