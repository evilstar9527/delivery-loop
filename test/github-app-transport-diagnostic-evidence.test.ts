import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  GitHubAppTransportDiagnosticEvidenceManifestV1Schema,
  type GitHubAppTransportDiagnosticEvidenceManifestV1,
} from '../src/domain/github-app-transport-diagnostic-evidence.js';
import {
  GitHubAppTransportDiagnosticEvidenceVerificationError,
  type GitHubAppTransportDiagnosticEvidenceVerifierOptions,
  verifyGitHubAppTransportDiagnosticEvidence,
} from '../src/pilot/github-app-transport-diagnostic-evidence-verifier.js';

const REPOSITORY = 'pilot-owner/delivery-loop';
const ACTOR = 'pilot-owner';
const HEAD_SHA = 'a'.repeat(40);
const RUN_ID = '300000001';
const PREFLIGHT_JOB_ID = '900000001';
const READINESS_JOB_ID = '900000002';
const STARTED_AT = '2026-08-02T00:39:33.000Z';
const COMPLETED_AT = '2026-08-02T00:39:55.000Z';
const OBSERVED_AT = '2026-08-02T00:39:50.000Z';
const ACCOUNT_ID = '1'.repeat(32);
const SCRIPT_NAME = 'delivery-loop-control-plane';
const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_TRACE_ID = 'a'.repeat(32);
const GITHUB_TOKEN = 'github_transport_diagnostic_read_token';
const CLOUDFLARE_DEPLOYMENT_TOKEN = 'cloudflare_deployment_read_token';
const CLOUDFLARE_OBSERVABILITY_TOKEN = 'cloudflare_observability_read_token';
const CANARY = 'github_pat_TRANSPORT_DIAGNOSTIC_CANARY_1234567890';
const GITHUB_ORIGIN = 'https://api.github.test';
const LOG_ORIGIN = 'https://results.github.test';
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.test';

const PUBLIC_SUMMARY = {
  requestAttempts: 1 as const,
  status: 503 as const,
  ready: false as const,
  reason: 'credential_transport_unavailable' as const,
  cacheControl: 'no-store' as const,
};

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

async function manifest(): Promise<GitHubAppTransportDiagnosticEvidenceManifestV1> {
  return GitHubAppTransportDiagnosticEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: 'github-app-transport-diagnostic-round208',
    recordedAt: '2026-08-02T01:00:00.000Z',
    repository: REPOSITORY,
    github: {
      actor: ACTOR,
      headSha: HEAD_SHA,
      runId: RUN_ID,
      runAttempt: 1,
      preflightJobId: PREFLIGHT_JOB_ID,
      readinessJobId: READINESS_JOB_ID,
      readinessStartedAt: STARTED_AT,
      readinessCompletedAt: COMPLETED_AT,
      publicSummary: PUBLIC_SUMMARY,
      publicSummaryDigest: await canonicalSha256(PUBLIC_SUMMARY),
    },
    cloudflare: {
      accountIdDigest: await canonicalSha256(ACCOUNT_ID),
      scriptName: SCRIPT_NAME,
      environment: 'production',
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      deploymentCreatedAt: '2026-08-02T00:35:29.095Z',
      window: { from: STARTED_AT, to: COMPLETED_AT },
    },
    diagnostic: {
      observedAt: OBSERVED_AT,
      workerTraceId: WORKER_TRACE_ID,
      failureKind: 'tcp_failed',
      logRecordDigest: await canonicalSha256(DIAGNOSTIC_RECORD),
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      reviewer: 'platform-observability-reviewer',
      reviewedAt: '2026-08-02T01:05:00.000Z',
      githubRunEvidenceUrl: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
      workerDeploymentEvidenceUrl: 'https://dash.cloudflare.com/evidence/worker-deployment',
      workersLogsEvidenceUrl: 'https://dash.cloudflare.com/evidence/worker-logs',
      workersTracesEvidenceUrl: 'https://dash.cloudflare.com/evidence/worker-traces',
      secretScanReviewed: true,
    },
  });
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers });
}

function publicLog(summary = PUBLIC_SUMMARY): string {
  return [
    'readiness\tRun exactly one GitHub base readiness GET\t2026-08-02T00:39:49Z begin',
    `readiness\tRun exactly one GitHub base readiness GET\t${JSON.stringify(summary)}`,
    'readiness\tComplete job\t2026-08-02T00:39:55Z end',
  ].join('\n');
}

function filterValue(body: Record<string, unknown>, key: string): unknown {
  const parameters = body.parameters as Record<string, unknown>;
  const filters = parameters.filters as Array<Record<string, unknown>>;
  return filters.find((filter) => filter.key === key)?.value;
}

interface FakeOptions {
  publicSummary?: typeof PUBLIC_SUMMARY;
  duplicateDiagnostic?: boolean;
  missingTrace?: boolean;
  deploymentDuringWindow?: boolean;
  deploymentAtWindowStart?: boolean;
  wrongWorkflowPath?: boolean;
  leak?: string;
}

function fakeFetch(
  value: GitHubAppTransportDiagnosticEvidenceManifestV1,
  options: FakeOptions = {},
  requests: Array<{ url: string; init?: RequestInit }> = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    requests.push(init === undefined ? { url: url.toString() } : { url: url.toString(), init });
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.origin === GITHUB_ORIGIN) {
      expect(authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      if (url.pathname.endsWith(`/actions/runs/${RUN_ID}`)) {
        return json({
          id: Number(RUN_ID), event: 'workflow_dispatch', run_attempt: 1,
          status: 'completed', conclusion: 'failure', head_sha: HEAD_SHA,
          head_branch: 'main',
          path: options.wrongWorkflowPath === true
            ? '.github/workflows/another.yml'
            : '.github/workflows/github-base-readiness.yml',
          actor: { login: ACTOR }, repository: { full_name: REPOSITORY },
        });
      }
      if (url.pathname.endsWith(`/actions/runs/${RUN_ID}/jobs`)) {
        return json({
          total_count: 2,
          jobs: [
            {
              id: Number(PREFLIGHT_JOB_ID), name: 'preflight', status: 'completed',
              conclusion: 'success', started_at: '2026-08-02T00:38:10.000Z',
              completed_at: '2026-08-02T00:39:05.000Z',
            },
            {
              id: Number(READINESS_JOB_ID), name: 'readiness', status: 'completed',
              conclusion: 'failure', started_at: STARTED_AT, completed_at: COMPLETED_AT,
            },
          ],
        });
      }
      if (url.pathname.endsWith(`/actions/jobs/${READINESS_JOB_ID}/logs`)) {
        return new Response(null, {
          status: 302,
          headers: { location: `${LOG_ORIGIN}/job-${READINESS_JOB_ID}.txt` },
        });
      }
      return json({ message: 'missing' }, 404);
    }
    if (url.origin === LOG_ORIGIN) {
      expect(authorization).toBeNull();
      return new Response(publicLog(options.publicSummary), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url.origin === CLOUDFLARE_ORIGIN) {
      if (url.pathname.endsWith(`/workers/scripts/${SCRIPT_NAME}/deployments`)) {
        expect(authorization).toBe(`Bearer ${CLOUDFLARE_DEPLOYMENT_TOKEN}`);
        return json({
          success: true, errors: [], messages: [],
          result: {
            deployments: [
              {
                id: DEPLOYMENT_ID,
                created_on: value.cloudflare.deploymentCreatedAt,
                versions: [{ version_id: VERSION_ID, percentage: 100 }],
              },
              ...(options.deploymentDuringWindow === true ? [{
                id: '18686f28-8793-4725-943a-17c1d755654e',
                created_on: '2026-08-02T00:39:45.000Z',
                versions: [{
                  version_id: '2441c4b4-07c5-4837-8ae4-c72063aea417', percentage: 100,
                }],
              }] : []),
              ...(options.deploymentAtWindowStart === true ? [{
                id: '31111111-1111-4111-8111-111111111111',
                created_on: STARTED_AT,
                versions: [{
                  version_id: '42222222-2222-4222-8222-222222222222', percentage: 100,
                }],
              }] : []),
            ],
          },
        });
      }
      expect(authorization).toBe(`Bearer ${CLOUDFLARE_OBSERVABILITY_TOKEN}`);
      expect(init?.method).toBe('POST');
      if (options.leak !== undefined) return json({ leaked: options.leak });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const run = { accountId: ACCOUNT_ID, dry: true };
      if (body.view === 'events') {
        expect(filterValue(body, '$metadata.service')).toBe(SCRIPT_NAME);
        expect(filterValue(body, '$metadata.traceId')).toBe(WORKER_TRACE_ID);
        expect(filterValue(body, 'event')).toBe(
          'github_app_installation_token_transport_failed',
        );
        const event = {
          $metadata: {
            id: 'event-transport-diagnostic', account: ACCOUNT_ID,
            service: SCRIPT_NAME, traceId: WORKER_TRACE_ID,
            type: 'cf-worker-log', truncated: false,
          },
          dataset: 'cloudflare-workers', source: DIAGNOSTIC_RECORD,
          timestamp: Date.parse(OBSERVED_AT),
        };
        const events = options.duplicateDiagnostic === true ? [event, { ...event }] : [event];
        return json({
          success: true, errors: [], messages: [],
          result: { run, events: { count: events.length, events } },
        });
      }
      expect(body.view).toBe('traces');
      const traces = options.missingTrace === true ? [] : [{
        rootSpanName: 'fetch', rootTransactionName: 'GET /v1/operations/github-base/readiness',
        service: [SCRIPT_NAME], spans: 1, traceDurationMs: 200,
        traceStartMs: Date.parse(OBSERVED_AT) - 100,
        traceEndMs: Date.parse(OBSERVED_AT) + 100,
        traceId: WORKER_TRACE_ID, errors: [],
      }];
      return json({ success: true, errors: [], messages: [], result: { run, traces } });
    }
    return json({ message: 'unexpected origin' }, 500);
  };
}

function verifierOptions(
  value: GitHubAppTransportDiagnosticEvidenceManifestV1,
  fetcher: typeof fetch,
): GitHubAppTransportDiagnosticEvidenceVerifierOptions {
  return {
    githubToken: GITHUB_TOKEN,
    cloudflareDeploymentReadToken: CLOUDFLARE_DEPLOYMENT_TOKEN,
    cloudflareObservabilityToken: CLOUDFLARE_OBSERVABILITY_TOKEN,
    cloudflareAccountId: ACCOUNT_ID,
    canary: CANARY,
    githubApiOrigin: GITHUB_ORIGIN,
    cloudflareApiOrigin: CLOUDFLARE_ORIGIN,
    fetcher,
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GitHubAppTransportDiagnosticEvidenceVerificationError &&
    error.code === code;
}

describe('GitHub App transport diagnostic evidence', () => {
  it('accepts the synthetic schema example without treating it as live evidence', () => {
    const example = JSON.parse(readFileSync(
      resolve('schemas/github-app-transport-diagnostic-evidence-v1.example.json'),
      'utf8',
    )) as unknown;
    const parsed = GitHubAppTransportDiagnosticEvidenceManifestV1Schema.parse(example);
    expect(parsed.evidenceId).toBe('example-only-not-live');
  });

  it('binds one failed readiness job to one exact deployment, diagnostic log and trace', async () => {
    const value = await manifest();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const summary = await verifyGitHubAppTransportDiagnosticEvidence(
      value,
      verifierOptions(value, fakeFetch(value, {}, requests)),
    );

    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: value.evidenceId,
      repository: REPOSITORY,
      githubRunId: RUN_ID,
      readinessJobId: READINESS_JOB_ID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      failureKind: 'tcp_failed',
      requestAttempts: 1,
      githubLogQueries: 1,
      cloudflareDeploymentQueries: 1,
      cloudflareLogQueries: 1,
      cloudflareTraces: 1,
      plaintextLeaks: 0,
      humanReview: 'required_and_recorded',
    });
    const telemetry = requests.filter((request) =>
      request.url.includes('/workers/observability/telemetry/query'));
    expect(telemetry).toHaveLength(2);
    for (const request of telemetry) {
      const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
      expect(body.dry).toBe(true);
      expect(body.timeframe).toEqual({ from: STARTED_AT, to: COMPLETED_AT });
      expect((body.parameters as Record<string, unknown>).limit).toBe(2);
    }
  });

  it('rejects a GitHub log summary that is not the one-shot transport failure', async () => {
    const value = await manifest();
    const changed = { ...PUBLIC_SUMMARY, reason: 'credential_upstream_unavailable' as const };
    await expect(verifyGitHubAppTransportDiagnosticEvidence(
      value,
      verifierOptions(value, fakeFetch(value, { publicSummary: changed as never })),
    )).rejects.toSatisfy(expectCode('github_log_mismatch'));
  });

  it('rejects duplicate diagnostics, missing traces, wrong workflow and deployment drift',
    async () => {
    const value = await manifest();
    for (const [options, code] of [
      [{ duplicateDiagnostic: true }, 'cloudflare_log_mismatch'],
      [{ missingTrace: true }, 'cloudflare_trace_mismatch'],
      [{ deploymentDuringWindow: true }, 'cloudflare_deployment_mismatch'],
      [{ deploymentAtWindowStart: true }, 'cloudflare_deployment_mismatch'],
      [{ wrongWorkflowPath: true }, 'github_fact_mismatch'],
    ] as const) {
      await expect(verifyGitHubAppTransportDiagnosticEvidence(
        value,
        verifierOptions(value, fakeFetch(value, options)),
      )).rejects.toSatisfy(expectCode(code));
    }
  });

  it('rejects purpose-token reuse and plaintext leakage before parsing', async () => {
    const value = await manifest();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await expect(verifyGitHubAppTransportDiagnosticEvidence(value, {
      ...verifierOptions(value, fakeFetch(value, {}, requests)),
      cloudflareObservabilityToken: CLOUDFLARE_DEPLOYMENT_TOKEN,
    })).rejects.toSatisfy(expectCode('configuration_invalid'));
    expect(requests).toHaveLength(0);
    await expect(verifyGitHubAppTransportDiagnosticEvidence(
      value,
      verifierOptions(value, fakeFetch(value, { leak: CANARY })),
    )).rejects.toSatisfy(expectCode('secret_leak_detected'));
  });

  it('rejects a widened telemetry window in the manifest', async () => {
    const value = await manifest();
    const changed = structuredClone(value) as Record<string, unknown>;
    const cloudflare = changed.cloudflare as Record<string, unknown>;
    cloudflare.window = {
      from: '2026-08-02T00:30:00.000Z',
      to: COMPLETED_AT,
    };
    await expect(verifyGitHubAppTransportDiagnosticEvidence(
      changed as never,
      verifierOptions(value, fakeFetch(value)),
    )).rejects.toSatisfy(expectCode('manifest_invalid'));
  });

  it('keeps the CLI default at exit 2 before configuration or network', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_GITHUB_APP_TRANSPORT_DIAGNOSTIC_E2E;
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-github-app-transport-diagnostic-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'github-app-transport-diagnostic-e2e: opt-in missing\n',
    );
  });
});
