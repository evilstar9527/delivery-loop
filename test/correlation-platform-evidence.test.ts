import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  CorrelationPlatformEvidenceManifestV1Schema,
  CorrelationPlatformLogRecordV1Schema,
  type CorrelationPlatformEvidenceManifestV1,
  type CorrelationPlatformLogRecordV1,
} from '../src/domain/correlation-platform-evidence.js';
import {
  verifyCorrelationPlatformEvidence,
  type CorrelationPlatformEvidenceVerifierOptions,
} from '../src/pilot/correlation-platform-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example';
const GITHUB_ORIGIN = 'https://api.github.example';
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.example';
const CONTROL_TOKEN = 'correlation-control-read-purpose';
const GITHUB_TOKEN = 'correlation-github-read-purpose';
const CLOUDFLARE_TOKEN = 'correlation-cloudflare-observability-read-purpose';
const CANARY = 'github_pat_CORRELATION_PLATFORM_CANARY_1234567890';
const ACCOUNT_ID = 'a'.repeat(32);
const SCRIPT_NAME = 'delivery-loop-control-plane';
const REPOSITORY = 'example/delivery-pilot';
const TASK_ID = 'task-correlation-platform';
const RUN_ID = 'run-correlation-platform';
const ATTEMPT_ID = 'attempt-correlation-platform';
const ACTION_RUN_ID = '901';
const PR_NUMBER = 41;
const HEAD_SHA = 'b'.repeat(40);
const TEST_DEPLOYMENT_ID = 'test-deployment-correlation';
const TEST_GITHUB_DEPLOYMENT_ID = '7001';
const TEST_SHA = 'c'.repeat(40);
const PRODUCTION_DEPLOYMENT_ID = 'production-deployment-correlation';
const PRODUCTION_GITHUB_DEPLOYMENT_ID = '7002';
const PRODUCTION_SHA = 'd'.repeat(40);
const TOOL_TRACE_ID = 'tooltrace-correlation-platform';

type Lookup = CorrelationPlatformEvidenceManifestV1['lookups'][number];

interface Fixture {
  manifest: CorrelationPlatformEvidenceManifestV1;
  records: Map<string, CorrelationPlatformLogRecordV1>;
}

function key(lookup: Pick<Lookup, 'kind' | 'id' | 'repository'>): string {
  return `${lookup.kind}\0${lookup.id}\0${lookup.repository ?? ''}`;
}

async function fixture(): Promise<Fixture> {
  const lookupInputs: Array<Pick<Lookup, 'kind' | 'id' | 'repository'>> = [
    { kind: 'task', id: TASK_ID },
    { kind: 'run', id: RUN_ID },
    { kind: 'attempt', id: ATTEMPT_ID },
    { kind: 'github_run', id: ACTION_RUN_ID },
    { kind: 'github_pr', id: String(PR_NUMBER), repository: REPOSITORY },
    { kind: 'test_deployment', id: TEST_DEPLOYMENT_ID },
    { kind: 'production_deployment', id: PRODUCTION_DEPLOYMENT_ID },
    { kind: 'github_deployment', id: TEST_GITHUB_DEPLOYMENT_ID, repository: REPOSITORY },
    { kind: 'github_deployment', id: PRODUCTION_GITHUB_DEPLOYMENT_ID,
      repository: REPOSITORY },
    { kind: 'trace', id: TOOL_TRACE_ID },
  ];
  const records = new Map<string, CorrelationPlatformLogRecordV1>();
  const lookups: Lookup[] = [];
  for (const [index, input] of lookupInputs.entries()) {
    const observedAt = new Date(Date.parse('2026-07-27T14:00:00.000Z') + index * 60_000)
      .toISOString();
    const record = CorrelationPlatformLogRecordV1Schema.parse({
      schemaVersion: '1',
      level: 'info',
      component: 'correlation',
      event: 'correlation_lookup',
      correlationId: RUN_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      attemptIds: [ATTEMPT_ID],
      githubRunIds: [ACTION_RUN_ID],
      pullRequestNumbers: [PR_NUMBER],
      deploymentIds: [PRODUCTION_DEPLOYMENT_ID, TEST_DEPLOYMENT_ID].sort(),
      githubDeploymentIds: [TEST_GITHUB_DEPLOYMENT_ID, PRODUCTION_GITHUB_DEPLOYMENT_ID].sort(),
      traceIds: [TOOL_TRACE_ID],
      matchedByKind: input.kind,
      matchedById: input.id,
      ...(input.repository === undefined ? {} : { matchedByRepository: input.repository }),
      observedAt,
    });
    records.set(key(input), record);
    lookups.push({
      ...input,
      observedAt,
      logRecordDigest: await canonicalSha256(record),
      workerTraceId: (index + 1).toString(16).padStart(32, '0'),
    });
  }
  const manifest = CorrelationPlatformEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: 'correlation-platform-round-115',
    recordedAt: '2026-07-27T14:30:00.000Z',
    repository: REPOSITORY,
    runId: RUN_ID,
    lineage: {
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      githubRun: { id: ACTION_RUN_ID, headSha: HEAD_SHA },
      pullRequest: {
        number: PR_NUMBER, headSha: HEAD_SHA, state: 'closed', draft: false,
      },
      testDeployment: {
        deploymentId: TEST_DEPLOYMENT_ID,
        githubDeploymentId: TEST_GITHUB_DEPLOYMENT_ID,
        sha: TEST_SHA,
        environment: 'test',
      },
      productionDeployment: {
        deploymentId: PRODUCTION_DEPLOYMENT_ID,
        githubDeploymentId: PRODUCTION_GITHUB_DEPLOYMENT_ID,
        sha: PRODUCTION_SHA,
        environment: 'production',
      },
      toolTraceId: TOOL_TRACE_ID,
    },
    cloudflare: {
      accountIdDigest: await canonicalSha256(ACCOUNT_ID),
      scriptName: SCRIPT_NAME,
      environment: 'production',
      window: {
        from: '2026-07-27T13:59:00.000Z',
        to: '2026-07-27T14:15:00.000Z',
      },
      retentionDays: 7,
      logHeadSamplingRate: 1,
      traceHeadSamplingRate: 1,
      logsPersisted: true,
      tracesPersisted: true,
      invocationLogs: false,
    },
    lookups,
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      reviewer: 'platform-observability-reviewer',
      reviewedAt: '2026-07-27T14:20:00.000Z',
      workerDeploymentEvidenceUrl:
        'https://dash.cloudflare.com/evidence/delivery-loop/deployment',
      workersLogsEvidenceUrl: 'https://dash.cloudflare.com/evidence/delivery-loop/logs',
      workersTracesEvidenceUrl: 'https://dash.cloudflare.com/evidence/delivery-loop/traces',
      retentionAndIndexReviewed: true,
      secretScanReviewed: true,
    },
  });
  return { manifest, records };
}

function correlationView(manifest: CorrelationPlatformEvidenceManifestV1, lookup: Lookup) {
  return {
    schemaVersion: '1',
    correlationId: RUN_ID,
    matchedBy: {
      kind: lookup.kind,
      id: lookup.id,
      ...(lookup.repository === undefined ? {} : { repository: lookup.repository }),
    },
    task: { id: TASK_ID },
    run: { id: RUN_ID, state: 'succeeded', version: 12 },
    attempts: [{
      id: ATTEMPT_ID, mode: 'implement', status: 'completed', githubRunId: ACTION_RUN_ID,
      githubStatus: 'completed', githubConclusion: 'success',
    }],
    githubRuns: [{
      kind: 'agent', id: ACTION_RUN_ID, attemptId: ATTEMPT_ID,
      status: 'completed', conclusion: 'success',
    }],
    pullRequests: [{
      publicationId: 'publication-correlation', status: 'verified', number: PR_NUMBER,
      url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
      evidenceId: 'evidence-pr-correlation',
    }],
    deployments: [
      {
        kind: 'test', id: TEST_DEPLOYMENT_ID, status: 'succeeded', sha: TEST_SHA,
        githubDeploymentId: TEST_GITHUB_DEPLOYMENT_ID,
        evidenceId: 'evidence-test-deployment-correlation',
      },
      {
        kind: 'production', id: PRODUCTION_DEPLOYMENT_ID, status: 'succeeded',
        sha: PRODUCTION_SHA, githubDeploymentId: PRODUCTION_GITHUB_DEPLOYMENT_ID,
        evidenceId: 'evidence-production-deployment-correlation',
      },
    ],
    traces: [{
      id: TOOL_TRACE_ID, attemptId: ATTEMPT_ID, toolPath: 'observability/logs',
      action: 'read_logs', effect: 'read', durationMs: 123,
      resultCategory: 'success', observedAt: '2026-07-27T13:58:00.000Z',
    }],
    truncated: {
      attempts: false, githubRuns: false, pullRequests: false,
      deployments: false, traces: false,
    },
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function filterValue(body: Record<string, unknown>, filterKey: string): unknown {
  const parameters = body.parameters as Record<string, unknown>;
  const filters = parameters.filters as Array<Record<string, unknown>>;
  return filters.find((filter) => filter.key === filterKey)?.value;
}

interface FakeOptions {
  controlMismatch?: boolean;
  githubMismatch?: boolean;
  cloudflareLogTruncated?: boolean;
  cloudflareTraceMissing?: boolean;
  leak?: boolean;
}

function fakeFetch(
  value: Fixture,
  options: FakeOptions = {},
  cloudflareBodies: Array<Record<string, unknown>> = [],
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.origin === CONTROL_ORIGIN) {
      expect(authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
      const lookup = value.manifest.lookups.find((candidate) =>
        candidate.kind === url.searchParams.get('kind') &&
        candidate.id === url.searchParams.get('id') &&
        (candidate.repository ?? null) === url.searchParams.get('repository'));
      if (lookup === undefined) return json({ message: 'missing' }, 404);
      const response = correlationView(value.manifest, lookup);
      if (options.controlMismatch === true && lookup.kind === 'attempt') {
        response.correlationId = 'run-foreign';
      }
      return json(response);
    }
    if (url.origin === GITHUB_ORIGIN) {
      expect(authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      if (url.pathname.endsWith(`/actions/runs/${ACTION_RUN_ID}`)) {
        return json({
          id: Number(ACTION_RUN_ID), status: 'completed', conclusion: 'success',
          head_sha: HEAD_SHA, repository: { full_name: REPOSITORY },
        });
      }
      if (url.pathname.endsWith(`/pulls/${PR_NUMBER}`)) {
        return json({
          number: PR_NUMBER, state: 'closed', draft: false,
          html_url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
          head: {
            sha: options.githubMismatch === true ? 'e'.repeat(40) : HEAD_SHA,
            repo: { full_name: REPOSITORY },
          },
          base: { repo: { full_name: REPOSITORY } },
        });
      }
      if (url.pathname.endsWith(`/deployments/${TEST_GITHUB_DEPLOYMENT_ID}`)) {
        return json({
          id: Number(TEST_GITHUB_DEPLOYMENT_ID), sha: TEST_SHA, environment: 'test',
          repository_url: `${GITHUB_ORIGIN}/repos/${REPOSITORY}`,
        });
      }
      if (url.pathname.endsWith(`/deployments/${PRODUCTION_GITHUB_DEPLOYMENT_ID}`)) {
        return json({
          id: Number(PRODUCTION_GITHUB_DEPLOYMENT_ID), sha: PRODUCTION_SHA,
          environment: 'production', repository_url: `${GITHUB_ORIGIN}/repos/${REPOSITORY}`,
        });
      }
      return json({ message: 'missing' }, 404);
    }
    if (url.origin === CLOUDFLARE_ORIGIN) {
      expect(authorization).toBe(`Bearer ${CLOUDFLARE_TOKEN}`);
      expect(init?.method).toBe('POST');
      if (options.leak === true) return json({ leaked: CANARY });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      cloudflareBodies.push(body);
      const run = { accountId: ACCOUNT_ID, dry: true };
      if (body.view === 'events') {
        const lookup = value.manifest.lookups.find((candidate) =>
          candidate.kind === filterValue(body, 'matchedByKind') &&
          candidate.id === filterValue(body, 'matchedById') &&
          (candidate.repository ?? null) ===
            (filterValue(body, 'matchedByRepository') ?? null));
        if (lookup === undefined) return json({ success: true, errors: [], result: { run } });
        const source = value.records.get(key(lookup));
        return json({
          success: true, errors: [], messages: [{ message: 'Successful request' }],
          result: {
            run,
            events: {
              count: 1,
              events: [{
                $metadata: {
                  id: `event-${lookup.kind}-${lookup.id}`,
                  account: ACCOUNT_ID,
                  service: SCRIPT_NAME,
                  traceId: lookup.workerTraceId,
                  type: 'cf-worker-log',
                  truncated: options.cloudflareLogTruncated === true,
                },
                dataset: 'cloudflare-workers',
                source,
                timestamp: Date.parse(lookup.observedAt),
              }],
            },
          },
        });
      }
      const traceId = filterValue(body, '$metadata.traceId');
      const lookup = value.manifest.lookups.find((candidate) =>
        candidate.workerTraceId === traceId);
      const traces = options.cloudflareTraceMissing === true || lookup === undefined
        ? []
        : [{
            rootSpanName: 'fetch', rootTransactionName: 'GET /v1/correlations',
            service: [SCRIPT_NAME], spans: 1, traceDurationMs: 200,
            traceStartMs: Date.parse(lookup.observedAt) - 100,
            traceEndMs: Date.parse(lookup.observedAt) + 100,
            traceId: lookup.workerTraceId, errors: [],
          }];
      return json({
        success: true, errors: [], messages: [{ message: 'Successful request' }],
        result: { run, traces },
      });
    }
    return json({ message: 'unexpected origin' }, 500);
  };
}

function verifierOptions(value: Fixture): CorrelationPlatformEvidenceVerifierOptions {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    controlPlaneToken: CONTROL_TOKEN,
    githubApiOrigin: GITHUB_ORIGIN,
    githubToken: GITHUB_TOKEN,
    cloudflareApiOrigin: CLOUDFLARE_ORIGIN,
    cloudflareAccountId: ACCOUNT_ID,
    cloudflareObservabilityToken: CLOUDFLARE_TOKEN,
    canary: CANARY,
    fetcher: fakeFetch(value),
  };
}

describe('correlation platform evidence', () => {
  it('parses the checked-in example and pins persisted 100% logs/traces safely', async () => {
    const example = JSON.parse(readFileSync(
      resolve('schemas/correlation-platform-evidence-v1.example.json'), 'utf8')) as unknown;
    expect(CorrelationPlatformEvidenceManifestV1Schema.parse(example).lookups).toHaveLength(10);
    const wrangler = JSON.parse(readFileSync(resolve('wrangler.jsonc'), 'utf8')) as {
      observability?: Record<string, unknown>;
    };
    expect(wrangler.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: {
        enabled: true, head_sampling_rate: 1, invocation_logs: false, persist: true,
      },
      traces: { enabled: true, head_sampling_rate: 1, persist: true },
    });
  });

  it('cross-checks ten D1 lookups, four GitHub facts, Workers Logs, and traces', async () => {
    const value = await fixture();
    const cloudflareBodies: Array<Record<string, unknown>> = [];
    const summary = await verifyCorrelationPlatformEvidence(value.manifest, {
      ...verifierOptions(value),
      fetcher: fakeFetch(value, {}, cloudflareBodies),
    });
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: value.manifest.evidenceId,
      repository: REPOSITORY,
      runId: RUN_ID,
      verifiedLookups: 10,
      controlPlaneQueries: 10,
      githubFacts: 4,
      cloudflareLogQueries: 10,
      cloudflareTraces: 10,
      plaintextLeaks: 0,
      humanReview: 'required_and_recorded',
    });
    expect(cloudflareBodies).toHaveLength(20);
    expect(cloudflareBodies.every((body) => body.dry === true)).toBe(true);
    expect(cloudflareBodies.filter((body) => body.view === 'events')).toHaveLength(10);
    expect(cloudflareBodies.filter((body) => body.view === 'traces')).toHaveLength(10);
  });

  it('rejects control-plane lineage drift or a live GitHub object drift', async () => {
    const value = await fixture();
    await expect(verifyCorrelationPlatformEvidence(value.manifest, {
      ...verifierOptions(value), fetcher: fakeFetch(value, { controlMismatch: true }),
    })).rejects.toMatchObject({ code: 'control_plane_correlation_mismatch' });
    await expect(verifyCorrelationPlatformEvidence(value.manifest, {
      ...verifierOptions(value), fetcher: fakeFetch(value, { githubMismatch: true }),
    })).rejects.toMatchObject({ code: 'github_fact_mismatch' });
  });

  it('rejects truncated logs, missing traces, and credential-shaped plaintext', async () => {
    const value = await fixture();
    await expect(verifyCorrelationPlatformEvidence(value.manifest, {
      ...verifierOptions(value), fetcher: fakeFetch(value, { cloudflareLogTruncated: true }),
    })).rejects.toMatchObject({ code: 'cloudflare_log_mismatch' });
    await expect(verifyCorrelationPlatformEvidence(value.manifest, {
      ...verifierOptions(value), fetcher: fakeFetch(value, { cloudflareTraceMissing: true }),
    })).rejects.toMatchObject({ code: 'cloudflare_trace_mismatch' });
    await expect(verifyCorrelationPlatformEvidence(value.manifest, {
      ...verifierOptions(value), fetcher: fakeFetch(value, { leak: true }),
    })).rejects.toMatchObject({ code: 'secret_leak_detected' });
  });

  it('keeps CLI opt-in and incomplete prerequisites distinct from fact failure', () => {
    const run = (environment: NodeJS.ProcessEnv) => spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-correlation-platform-evidence.ts'],
      { cwd: resolve('.'), env: { ...process.env, ...environment }, encoding: 'utf8' },
    );
    const disabled = run({ DELIVERY_LOOP_CORRELATION_PLATFORM_E2E: '' });
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain('correlation-platform-e2e: opt-in missing');
    const incomplete = run({ DELIVERY_LOOP_CORRELATION_PLATFORM_E2E: '1' });
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain('required evidence configuration is incomplete');
    expect(incomplete.stderr).not.toContain(CANARY);
  });
});
