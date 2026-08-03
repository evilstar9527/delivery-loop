import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  GitHubAppTransportDiagnosticCollectionRequestV1Schema,
  type GitHubAppTransportDiagnosticCollectionRequestV1,
} from '../src/domain/github-app-transport-diagnostic-evidence.js';
import {
  GitHubAppTransportDiagnosticCollectionError,
  collectGitHubAppTransportDiagnosticObservation,
  type GitHubAppTransportDiagnosticCollectorOptions,
} from '../src/pilot/github-app-transport-diagnostic-collector.js';

const REPOSITORY = 'pilot-owner/delivery-loop';
const ACTOR = 'pilot-owner';
const HEAD_SHA = 'a'.repeat(40);
const RUN_ID = '300000101';
const READINESS_JOB_ID = '900000102';
const STARTED_AT = '2026-08-02T00:39:40.000Z';
const COMPLETED_AT = '2026-08-02T00:39:54.000Z';
const OBSERVED_AT = '2026-08-02T00:39:50.000Z';
const ACCOUNT_ID = '1'.repeat(32);
const SCRIPT_NAME = 'delivery-loop-control-plane';
const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_TRACE_ID = 'a'.repeat(32);
const GITHUB_TOKEN = 'github_transport_diagnostic_read_token';
const CLOUDFLARE_DEPLOYMENT_TOKEN = 'cloudflare_deployment_read_token';
const CLOUDFLARE_OBSERVABILITY_TOKEN = 'cloudflare_observability_read_token';
const CANARY = 'github_pat_TRANSPORT_DIAGNOSTIC_COLLECTION_CANARY_1234567890';
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.test';

const DIAGNOSTIC_RECORD = {
  schemaVersion: '1' as const,
  level: 'warn' as const,
  component: 'github_app_credential' as const,
  event: 'github_app_installation_token_transport_failed' as const,
  operation: 'installation_token_exchange' as const,
  failureKind: 'tcp_failed' as const,
  requestAttempts: 1 as const,
  observedAt: OBSERVED_AT,
};

async function collectionRequest(): Promise<GitHubAppTransportDiagnosticCollectionRequestV1> {
  return GitHubAppTransportDiagnosticCollectionRequestV1Schema.parse({
    schemaVersion: '1',
    collectionId: 'github-app-transport-diagnostic-round212',
    recordedAt: '2026-08-02T01:00:00.000Z',
    repository: REPOSITORY,
    github: {
      actor: ACTOR,
      headSha: HEAD_SHA,
      runId: RUN_ID,
      runAttempt: 1,
      readinessJobId: READINESS_JOB_ID,
      readinessStartedAt: STARTED_AT,
      readinessCompletedAt: COMPLETED_AT,
    },
    cloudflare: {
      accountIdDigest: await canonicalSha256(ACCOUNT_ID),
      scriptName: SCRIPT_NAME,
      environment: 'production',
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      window: { from: STARTED_AT, to: COMPLETED_AT },
    },
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function filterValue(body: Record<string, unknown>, key: string): unknown {
  const parameters = record(body.parameters);
  const filters = Array.isArray(parameters?.filters)
    ? parameters.filters.map(record).filter((item) => item !== null)
    : [];
  return filters.find((filter) => filter.key === key)?.value;
}

interface FakeOptions {
  duplicateDiagnostic?: boolean;
  invalidSource?: boolean;
  leak?: string;
  missingWorkers?: boolean;
  noDiagnostic?: boolean;
  outsideWindow?: boolean;
  wrongService?: boolean;
  truncated?: boolean;
}

function collectorFetch(
  value: GitHubAppTransportDiagnosticCollectionRequestV1,
  options: FakeOptions = {},
  requests: Array<{ url: string; init?: RequestInit }> = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requests.push(init === undefined ? { url: url.toString() } : { url: url.toString(), init });
    expect(url.origin).toBe(CLOUDFLARE_ORIGIN);
    expect(url.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${CLOUDFLARE_OBSERVABILITY_TOKEN}`,
    );
    expect(init?.method).toBe('POST');
    if (options.leak !== undefined) return Response.json({ leaked: options.leak });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.queryId).toBe(value.collectionId);
    expect(body.view).toBe('events');
    expect(body.dry).toBe(true);
    expect(body.timeframe).toEqual({
      from: Date.parse(value.cloudflare.window.from),
      to: Date.parse(value.cloudflare.window.to),
    });
    expect(body.limit).toBe(2);
    expect(filterValue(body, '$metadata.service')).toBe(SCRIPT_NAME);
    expect(filterValue(body, '$metadata.traceId')).toBeUndefined();
    expect(filterValue(body, 'event')).toBe(
      'github_app_installation_token_transport_failed',
    );
    expect(filterValue(body, 'component')).toBe('github_app_credential');
    expect(filterValue(body, 'operation')).toBe('installation_token_exchange');
    expect(filterValue(body, 'requestAttempts')).toBe(1);
    expect(record(body.parameters)?.limit).toBeUndefined();
    const event = {
      $metadata: {
        account: ACCOUNT_ID,
        service: options.wrongService === true ? 'another-worker' : SCRIPT_NAME,
        traceId: WORKER_TRACE_ID,
        type: 'cf-worker-log',
      },
      ...(options.missingWorkers === true ? {} : { $workers: {
        scriptName: SCRIPT_NAME,
        eventType: 'fetch',
        requestId: 'request-round212',
        truncated: options.truncated === true,
      } }),
      dataset: 'cloudflare-workers',
      source: options.invalidSource === true ? { unexpected: true } : DIAGNOSTIC_RECORD,
      timestamp: Date.parse(options.outsideWindow === true
        ? '2026-08-02T00:40:00.000Z'
        : OBSERVED_AT),
    };
    const events = options.noDiagnostic === true
      ? []
      : options.duplicateDiagnostic === true ? [event, { ...event }] : [event];
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: {
        run: { accountId: ACCOUNT_ID, dry: true },
        events: { count: events.length, events },
      },
    });
  };
}

function collectorOptions(
  fetcher: typeof fetch,
): GitHubAppTransportDiagnosticCollectorOptions {
  return {
    githubToken: GITHUB_TOKEN,
    cloudflareDeploymentReadToken: CLOUDFLARE_DEPLOYMENT_TOKEN,
    cloudflareObservabilityToken: CLOUDFLARE_OBSERVABILITY_TOKEN,
    cloudflareAccountId: ACCOUNT_ID,
    canary: CANARY,
    cloudflareApiOrigin: CLOUDFLARE_ORIGIN,
    fetcher,
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GitHubAppTransportDiagnosticCollectionError &&
    error.code === code;
}

describe('GitHub App transport diagnostic collector', () => {
  it('accepts the synthetic collection request without treating it as live authority', () => {
    const example = JSON.parse(readFileSync(resolve(
      'schemas/github-app-transport-diagnostic-collection-v1.example.json',
    ), 'utf8')) as unknown;
    expect(GitHubAppTransportDiagnosticCollectionRequestV1Schema.safeParse(example).success)
      .toBe(true);
  });

  it('discovers one strict diagnostic with exactly one bounded events query', async () => {
    const value = await collectionRequest();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await expect(collectGitHubAppTransportDiagnosticObservation(
      value,
      collectorOptions(collectorFetch(value, {}, requests)),
    )).resolves.toEqual({
      schemaVersion: '1',
      collectionId: value.collectionId,
      repository: REPOSITORY,
      githubRunId: RUN_ID,
      githubHeadSha: HEAD_SHA,
      githubRunAttempt: 1,
      readinessJobId: READINESS_JOB_ID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      observedAt: OBSERVED_AT,
      workerTraceId: WORKER_TRACE_ID,
      failureKind: 'tcp_failed',
      logRecordDigest: await canonicalSha256(DIAGNOSTIC_RECORD),
      requestAttempts: 1,
      cloudflareLogQueries: 1,
      plaintextLeaks: 0,
      formalVerification: 'still_required',
    });
    expect(requests).toHaveLength(1);
  });

  it('returns only fixed safe mismatch categories for strict observation failures', async () => {
    const value = await collectionRequest();
    for (const [options, code] of [
      [{ noDiagnostic: true }, 'cloudflare_log_absent'],
      [{ duplicateDiagnostic: true }, 'cloudflare_log_ambiguous'],
      [{ missingWorkers: true }, 'cloudflare_log_envelope_mismatch'],
      [{ truncated: true }, 'cloudflare_log_envelope_mismatch'],
      [{ wrongService: true }, 'cloudflare_log_envelope_mismatch'],
      [{ invalidSource: true }, 'cloudflare_log_source_mismatch'],
      [{ outsideWindow: true }, 'cloudflare_log_time_mismatch'],
    ] as const) {
      await expect(collectGitHubAppTransportDiagnosticObservation(
        value,
        collectorOptions(collectorFetch(value, options)),
      )).rejects.toSatisfy(expectCode(code));
    }
  });

  it('rejects purpose-token reuse before network and scans plaintext before parse', async () => {
    const value = await collectionRequest();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await expect(collectGitHubAppTransportDiagnosticObservation(value, {
      ...collectorOptions(collectorFetch(value, {}, requests)),
      cloudflareObservabilityToken: CLOUDFLARE_DEPLOYMENT_TOKEN,
    })).rejects.toSatisfy(expectCode('configuration_invalid'));
    expect(requests).toHaveLength(0);
    await expect(collectGitHubAppTransportDiagnosticObservation(
      value,
      collectorOptions(collectorFetch(value, { leak: CANARY })),
    )).rejects.toSatisfy(expectCode('secret_leak_detected'));
  });

  it('rejects a widened or unbound collection window', async () => {
    const value = await collectionRequest();
    const changed = structuredClone(value) as Record<string, unknown>;
    const cloudflare = changed.cloudflare as Record<string, unknown>;
    cloudflare.window = { from: '2026-08-02T00:30:00.000Z', to: COMPLETED_AT };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await expect(collectGitHubAppTransportDiagnosticObservation(
      changed as never,
      collectorOptions(collectorFetch(value, {}, requests)),
    )).rejects.toSatisfy(expectCode('request_invalid'));
    expect(requests).toHaveLength(0);
  });

  it('does not retry an unavailable observability query', async () => {
    const value = await collectionRequest();
    let requests = 0;
    const unavailable: typeof fetch = async () => {
      requests += 1;
      return Response.json({ errors: [{ code: 10_000 }] }, { status: 403 });
    };
    await expect(collectGitHubAppTransportDiagnosticObservation(
      value,
      collectorOptions(unavailable),
    )).rejects.toSatisfy(expectCode('cloudflare_api_unavailable'));
    expect(requests).toBe(1);
  });

  it('keeps the collection CLI default at exit 2 before file or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_GITHUB_APP_TRANSPORT_DIAGNOSTIC_COLLECTION;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/collect-github-app-transport-diagnostic.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'github-app-transport-diagnostic-collection: opt-in missing\n',
    );

    environment.DELIVERY_LOOP_GITHUB_APP_TRANSPORT_DIAGNOSTIC_COLLECTION = '1';
    for (const name of [
      'GITHUB_APP_TRANSPORT_DIAGNOSTIC_COLLECTION_REQUEST_FILE',
      'GITHUB_APP_TRANSPORT_DIAGNOSTIC_GITHUB_READ_TOKEN',
      'GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_DEPLOYMENT_READ_TOKEN',
      'GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_OBSERVABILITY_TOKEN',
      'GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_ACCOUNT_ID',
      'GITHUB_APP_TRANSPORT_DIAGNOSTIC_CANARY_SECRET',
    ]) delete environment[name];
    const incomplete = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/collect-github-app-transport-diagnostic.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(incomplete.status).toBe(2);
    expect(incomplete.stdout).toBe('');
    expect(incomplete.stderr).toBe(
      'github-app-transport-diagnostic-collection: required configuration is incomplete\n',
    );
  });
});
