import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  SevenDayTrialEvidenceManifestV1Schema,
  SevenDayTrialObservabilityReportV1Schema,
  type SevenDayTrialEvidenceManifestV1,
  type SevenDayTrialObservabilityReportV1,
} from '../src/domain/seven-day-trial-evidence.js';
import {
  SevenDayTrialVerificationError,
  verifySevenDayTrialEvidence,
} from '../src/pilot/seven-day-trial-verifier.js';

const STARTED_AT = '2026-07-19T00:00:00.000Z';
const ENDED_AT = '2026-07-26T00:00:00.000Z';
const PR_SHA = 'a'.repeat(40);
const TEST_SHA = 'b'.repeat(40);
const PRODUCTION_SHA = 'c'.repeat(40);
const REPOSITORY = 'example/delivery-pilot';

interface Fixture {
  manifest: SevenDayTrialEvidenceManifestV1;
  observability: SevenDayTrialObservabilityReportV1;
}

async function fixture(): Promise<Fixture> {
  const observabilityBody = {
    schemaVersion: '1' as const,
    trialId: 'trial-20260719-20260726',
    service: 'delivery-loop-control-plane' as const,
    repository: REPOSITORY,
    window: { startedAt: STARTED_AT, endedAt: ENDED_AT },
    generatedAt: '2026-07-26T00:05:00.000Z',
    detectors: {
      stuckRun: 'active' as const,
      runtimeSecret: 'active' as const,
    },
    minuteBuckets: { expected: 10_080, observed: 10_080, missing: 0 },
    runIds: ['run-trial-1', 'run-trial-2'],
    detectedStuckIncidentIds: ['incident-known-1'],
    resolvedStuckIncidentIds: ['incident-known-1'],
    unresolvedKnownStuckRunIds: [],
    unknownStuckRunIds: [],
    runtimeSecretAlertIds: [],
  };
  const reportDigest = await canonicalSha256(observabilityBody);
  const observability = { ...observabilityBody, reportDigest };
  const manifest = {
    schemaVersion: '1' as const,
    trialId: observability.trialId,
    repository: REPOSITORY,
    githubActorLogin: 'delivery-loop-bot',
    window: observability.window,
    recordedAt: '2026-07-26T00:10:00.000Z',
    observabilityReportUrl: 'https://observability.example/trials/trial-20260719-20260726',
    observabilityReportDigest: reportDigest,
    metricsDashboardUrl: 'https://observability.example/dashboards/delivery-loop-seven-day',
    logQueryUrl: 'https://observability.example/logs/delivery-loop-seven-day',
    secretAlertQueryUrl: 'https://observability.example/alerts/delivery-loop-seven-day',
  };
  return {
    manifest: SevenDayTrialEvidenceManifestV1Schema.parse(manifest),
    observability: SevenDayTrialObservabilityReportV1Schema.parse(observability),
  };
}

function audit(runId: string) {
  const first = runId === 'run-trial-1';
  return {
    schemaVersion: '1',
    runId,
    reportDigest: `sha256:${(first ? '1' : '2').repeat(64)}`,
    run: {
      state: 'succeeded',
      version: 7,
      createdAt: first ? '2026-07-20T01:00:00.000Z' : '2026-07-21T01:00:00.000Z',
      updatedAt: first ? '2026-07-20T02:00:00.000Z' : '2026-07-21T02:00:00.000Z',
    },
    task: { id: `task-${runId}`, repository: REPOSITORY },
    answers: {
      changes: first
        ? [{
          kind: 'pull_request',
          publicationId: 'publication-trial-1',
          repository: REPOSITORY,
          status: 'verified',
          headBranch: 'delivery/trial-1',
          headSha: PR_SHA,
          number: 11,
          evidenceId: 'evidence-pr-trial-1',
        }]
        : [],
      deployments: first
        ? [{
          kind: 'test',
          deploymentId: 'deployment-trial-test',
          repository: REPOSITORY,
          environment: 'test',
          status: 'succeeded',
          sha: TEST_SHA,
          githubDeploymentId: '101',
          evidenceId: 'evidence-deployment-test',
        }]
        : [{
          kind: 'production',
          deploymentId: 'deployment-trial-production',
          repository: REPOSITORY,
          environment: 'production',
          status: 'succeeded',
          sha: PRODUCTION_SHA,
          githubDeploymentId: '201',
          evidenceId: 'evidence-deployment-production',
        }],
    },
  };
}

function pull(number = 11, branch = 'delivery/trial-1') {
  return {
    number,
    state: 'open',
    draft: true,
    created_at: '2026-07-20T01:30:00.000Z',
    html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
    user: { login: 'delivery-loop-bot' },
    head: { ref: branch, sha: PR_SHA, repo: { full_name: REPOSITORY } },
    base: { ref: 'main', repo: { full_name: REPOSITORY } },
  };
}

function deployment(
  id: number,
  stableId: string,
  sha: string,
  kind: 'test' | 'production',
) {
  return {
    id,
    sha,
    task: `delivery-loop:${kind}`,
    environment: kind,
    created_at: kind === 'test'
      ? '2026-07-20T01:40:00.000Z'
      : '2026-07-21T01:40:00.000Z',
    payload: kind === 'test'
      ? { delivery_deployment_id: stableId }
      : { delivery_production_deployment_id: stableId },
  };
}

function fakeFetch(
  evidence: Fixture,
  options: {
    pulls?: unknown[];
    deployments?: unknown[];
    observability?: SevenDayTrialObservabilityReportV1;
    pagination?: boolean;
    rawCanary?: string;
  } = {},
): typeof fetch {
  const implementation = async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://observability.example') {
      return Response.json(options.observability ?? evidence.observability);
    }
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2)!;
      return Response.json(audit(runId));
    }
    if (url.pathname.endsWith('/pulls')) {
      return Response.json(options.pulls ?? [pull()], {
        headers: options.pagination ? { link: '<https://api.github.test/next>; rel="next"' } : {},
      });
    }
    if (url.pathname.endsWith('/deployments')) {
      return Response.json(options.deployments ?? [
        deployment(101, 'deployment-trial-test', TEST_SHA, 'test'),
        deployment(201, 'deployment-trial-production', PRODUCTION_SHA, 'production'),
      ]);
    }
    return Response.json({ message: options.rawCanary ?? 'not found' }, { status: 404 });
  };
  return implementation as typeof fetch;
}

function verify(evidence: Fixture, fetcher: typeof fetch) {
  return verifySevenDayTrialEvidence(evidence.manifest, {
    controlPlaneOrigin: 'https://control.example',
    observabilityReportUrl: evidence.manifest.observabilityReportUrl,
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    githubToken: 'CANARY_GITHUB_TOKEN',
    observabilityToken: 'CANARY_OBSERVABILITY_TOKEN',
    githubApiOrigin: 'https://api.github.test',
    fetch: fetcher,
  });
}

describe('seven-day trial evidence', () => {
  it('requires an exact continuous seven-day window, safe links, and a digest-bound report', async () => {
    const evidence = await fixture();
    expect(SevenDayTrialEvidenceManifestV1Schema.safeParse(evidence.manifest).success).toBe(true);
    expect(SevenDayTrialEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      window: { ...evidence.manifest.window, endedAt: '2026-07-25T23:59:59.000Z' },
    }).success).toBe(false);
    expect(SevenDayTrialEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      logQueryUrl: 'https://user:secret@observability.example/logs',
    }).success).toBe(false);

    const exampleManifest = JSON.parse(await readFile(
      new URL('../schemas/seven-day-trial-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    const exampleReport = SevenDayTrialObservabilityReportV1Schema.parse(JSON.parse(
      await readFile(
        new URL('../schemas/seven-day-trial-observability-v1.example.json', import.meta.url),
        'utf8',
      ),
    ));
    expect(SevenDayTrialEvidenceManifestV1Schema.safeParse(exampleManifest).success).toBe(true);
    const { reportDigest, ...body } = exampleReport;
    expect(await canonicalSha256(body)).toBe(reportDigest);

    let requests = 0;
    await expect(verifySevenDayTrialEvidence(evidence.manifest, {
      controlPlaneOrigin: 'https://control.example',
      observabilityReportUrl: 'https://attacker.example/collect',
      operationsToken: 'CANARY_OPERATIONS_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      observabilityToken: 'CANARY_OBSERVABILITY_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: async () => {
        requests += 1;
        return Response.json({});
      },
    })).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(requests).toBe(0);
  });

  it('cross-checks every observed Run, GitHub PR/deployment, metrics bucket, stuck incident, and Secret alert', async () => {
    const evidence = await fixture();
    const summary = await verify(evidence, fakeFetch(evidence));
    expect(summary).toEqual({
      schemaVersion: '1',
      trialId: evidence.manifest.trialId,
      repository: REPOSITORY,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      observedMinuteBuckets: 10_080,
      verifiedRunCount: 2,
      verifiedPullRequestCount: 1,
      verifiedDeploymentCount: 2,
      resolvedStuckIncidentCount: 1,
      unknownStuckRunCount: 0,
      duplicatePullRequestCount: 0,
      duplicateDeploymentCount: 0,
      runtimeSecretAlertCount: 0,
      observabilityReportDigest: evidence.manifest.observabilityReportDigest,
    });
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('fails closed on duplicate external PR or Deployment identity', async () => {
    const evidence = await fixture();
    await expect(verify(evidence, fakeFetch(evidence, {
      pulls: [pull(), pull(12)],
    }))).rejects.toMatchObject({ code: 'duplicate_pull_request' });
    await expect(verify(evidence, fakeFetch(evidence, {
      deployments: [
        deployment(101, 'deployment-trial-test', TEST_SHA, 'test'),
        deployment(102, 'deployment-trial-test', TEST_SHA, 'test'),
        deployment(201, 'deployment-trial-production', PRODUCTION_SHA, 'production'),
      ],
    }))).rejects.toMatchObject({ code: 'duplicate_deployment' });
  });

  it('rejects incomplete coverage, unknown/unresolved stuck runs, and runtime Secret alerts', async () => {
    const evidence = await fixture();
    const variants = [
      [{ minuteBuckets: { expected: 10_080, observed: 10_079, missing: 1 } }, 'metrics_coverage_incomplete'],
      [{ unknownStuckRunIds: ['run-unknown-stuck'] }, 'unknown_stuck_runs'],
      [{ unresolvedKnownStuckRunIds: ['run-known-stuck'] }, 'stuck_incidents_unresolved'],
      [{ runtimeSecretAlertIds: ['secret-alert-1'] }, 'runtime_secret_alerts'],
    ] as const;
    for (const [change, code] of variants) {
      const body = { ...evidence.observability, ...change };
      const reportBody = Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== 'reportDigest'),
      );
      const observability = {
        ...body,
        reportDigest: await canonicalSha256(reportBody),
      } as SevenDayTrialObservabilityReportV1;
      const manifest = {
        ...evidence.manifest,
        observabilityReportDigest: observability.reportDigest,
      };
      await expect(verify(
        { manifest, observability },
        fakeFetch({ manifest, observability }, { observability }),
      )).rejects.toMatchObject({ code });
    }
  });

  it('rejects paginated/incomplete GitHub inventory and never propagates raw upstream text', async () => {
    const evidence = await fixture();
    await expect(verify(evidence, fakeFetch(evidence, { pagination: true })))
      .rejects.toMatchObject({ code: 'github_inventory_incomplete' });
    const rawCanary = 'CANARY_RAW_SEVEN_DAY_TRIAL_RESPONSE';
    const operation = verify(evidence, fakeFetch(evidence, {
      pulls: [],
      rawCanary,
    }));
    await expect(operation).rejects.toSatisfy((error: unknown) =>
      error instanceof SevenDayTrialVerificationError &&
      error.code === 'github_pull_request_mismatch');
    await expect(operation).rejects.not.toThrow(rawCanary);
  });
});
