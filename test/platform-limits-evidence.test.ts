import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  CLOUDFLARE_PAID_WORKFLOW_LIMITS,
  CLOUDFLARE_WORKFLOWS_LIMITS_AUTHORITY,
  GITHUB_ACTIONS_LIMITS_AUTHORITY,
  PlatformLimitsEvidenceManifestV1Schema,
  type PlatformLimitsEvidenceManifestV1,
} from '../src/domain/platform-limits-evidence.js';
import { RunnerHeartbeatEvidenceManifestV1Schema } from
  '../src/domain/runner-heartbeat-evidence.js';
import { WorkflowHibernateEvidenceManifestV1Schema } from
  '../src/domain/workflow-hibernate-evidence.js';
import { ControlledReplayEvidenceManifestV1Schema } from
  '../src/domain/controlled-replay-evidence.js';

vi.mock('../src/pilot/runner-heartbeat-evidence-verifier.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, verifyRunnerHeartbeatEvidence: vi.fn() };
});
vi.mock('../src/pilot/workflow-hibernate-evidence-verifier.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, verifyWorkflowHibernateEvidence: vi.fn() };
});
vi.mock('../src/pilot/controlled-replay-evidence-verifier.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, verifyControlledReplayEvidence: vi.fn() };
});

import { verifyRunnerHeartbeatEvidence } from
  '../src/pilot/runner-heartbeat-evidence-verifier.js';
import { verifyWorkflowHibernateEvidence } from
  '../src/pilot/workflow-hibernate-evidence-verifier.js';
import { verifyControlledReplayEvidence } from
  '../src/pilot/controlled-replay-evidence-verifier.js';
import {
  PlatformLimitsEvidenceVerificationError,
  verifyPlatformLimitsEvidence,
  type PlatformLimitsEvidenceVerifierOptions,
} from '../src/pilot/platform-limits-evidence-verifier.js';

const API_ORIGIN = 'https://api.github.test';
const GITHUB_TOKEN = 'CANARY_PLATFORM_LIMITS_GITHUB_ORG_TOKEN';
const REPOSITORY = 'example/delivery-target';
const ORGANIZATION = 'example';
const HEAD_SHA = 'a'.repeat(40);
const CONCURRENCY_RUN_ID = '501';
const DURATION_RUN_ID = '601';

const GITHUB_LIMITS_SOURCE = `
| Workflow execution limit | Workflow run time | 35 days / workflow run |
| Workflow execution limit | Job Matrix | 256 jobs / workflow run |
| All GitHub-hosted runners | Job execution time | 6 hours |
GitHub Support **can** increase job concurrency limits for GitHub Actions.
| Standard GitHub-hosted runner | Free | 20 | 5 | Not applicable |
| Standard GitHub-hosted runner | Pro | 40 | 5 | Not applicable |
| Standard GitHub-hosted runner | Team | 60 | 5 | Not applicable |
| Standard GitHub-hosted runner | Enterprise | 500 | 50 | Not applicable |
| Larger runner | Team | 1000 | 5 | 100 |
| Larger runner | Enterprise | 1000 | 50 | 100 |
`;

const CLOUDFLARE_LIMITS_SOURCE = `
| Workflow class definitions per script | 3MB max script size | 10MB max script size |
| Compute time per step | 10 ms | 30 seconds (default) / configurable to 5 minutes |
| Duration (wall clock) per step | Unlimited | Unlimited |
| Maximum non-stream step result per step | 1MiB (2^20 bytes) | 1MiB (2^20 bytes) |
| Maximum event payload size | 1MiB (2^20 bytes) | 1MiB (2^20 bytes) |
| Maximum state that can be persisted per Workflow instance | 100MB | 1GB |
| Maximum step.sleep duration | 365 days (1 year) | 365 days (1 year) |
| Maximum steps per Workflow | 1,024 | 10,000 (default) / configurable up to 25,000 |
| Concurrent Workflow instances (executions) per account | 100 | 50,000 |
| Maximum Workflow instance creation rate | 100 per second | 300 per second per account, 100 per second per workflow |
| Maximum number of queued instances | 100,000 | 2,000,000 |
| Retention limit for completed Workflow instance state | 3 days | 30 days |
| Maximum number of subrequests per Workflow instance | 50/request | 10,000/request (default) / configurable up to 10 million |
only actively running instances count towards the 10,000 concurrent instance limit.
Each instance created or restarted counts towards this limit.
`;

const HEARTBEAT_MANIFEST = RunnerHeartbeatEvidenceManifestV1Schema.parse(JSON.parse(
  readFileSync(new URL('../schemas/runner-heartbeat-evidence-v1.example.json', import.meta.url), 'utf8'),
) as unknown);
const HIBERNATE_MANIFEST = WorkflowHibernateEvidenceManifestV1Schema.parse(JSON.parse(
  readFileSync(new URL('../schemas/workflow-hibernate-evidence-v1.example.json', import.meta.url), 'utf8'),
) as unknown);
const REPLAY_MANIFEST = ControlledReplayEvidenceManifestV1Schema.parse({
  ...JSON.parse(readFileSync(
    new URL('../schemas/controlled-replay-evidence-v1.example.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>,
  repository: REPOSITORY,
});

const ACTIONS_POLICY = {
  actions: { enabledRepositories: 'selected', allowedActions: 'selected' },
  workflow: { defaultWorkflowPermissions: 'read', canApprovePullRequestReviews: false },
  artifactAndLogRetention: { days: 90 },
};
const ACTIONS_USAGE_ITEM = {
  date: '2026-07-01',
  product: 'Actions',
  sku: 'actions_linux',
  quantity: 600,
  unitType: 'Minutes',
  pricePerUnit: 0.008,
  grossAmount: 4.8,
  discountAmount: 0.8,
  netAmount: 4,
  organizationName: ORGANIZATION,
  repositoryName: REPOSITORY,
};
const NORMALIZED_ACTIONS_USAGE = [{
  product: 'actions',
  date: '2026-07-01',
  sku: 'actions_linux',
  unitType: 'Minutes',
  pricePerUnit: 0.008,
  quantity: 600,
  grossAmount: 4.8,
  discountAmount: 0.8,
  netAmount: 4,
}];

async function manifest(): Promise<PlatformLimitsEvidenceManifestV1> {
  const concurrencySource = readFileSync(
    new URL('../.github/workflows/platform-concurrency-probe.yml', import.meta.url),
    'utf8',
  );
  const durationSource = readFileSync(
    new URL('../.github/workflows/platform-duration-probe.yml', import.meta.url),
    'utf8',
  );
  return {
    schemaVersion: '1',
    evidenceId: 'platform-limits-evidence-example',
    recordedAt: '2026-07-27T12:00:00.000Z',
    officialDocumentation: {
      githubActions: {
        ...GITHUB_ACTIONS_LIMITS_AUTHORITY,
        contentDigest: await canonicalSha256(GITHUB_LIMITS_SOURCE),
      },
      cloudflareWorkflows: {
        ...CLOUDFLARE_WORKFLOWS_LIMITS_AUTHORITY,
        contentDigest: await canonicalSha256(CLOUDFLARE_LIMITS_SOURCE),
      },
    },
    github: {
      organization: ORGANIZATION,
      repository: REPOSITORY,
      organizationPolicy: {
        digest: await canonicalSha256(ACTIONS_POLICY),
        enabledRepositories: 'selected',
        allowedActions: 'selected',
        defaultWorkflowPermissions: 'read',
        canApprovePullRequestReviews: false,
        artifactAndLogRetentionDays: 90,
      },
      billing: {
        year: 2026,
        month: 7,
        actionsUsageDigest: await canonicalSha256(NORMALIZED_ACTIONS_USAGE),
        actionsUsageItemCount: 1,
        unitTypes: ['Minutes'],
        quantity: 600,
        grossAmount: 4.8,
        discountAmount: 0.8,
        netAmount: 4,
        reviewedAt: '2026-07-27T10:00:00.000Z',
        auditUrl: 'https://github.com/organizations/example/settings/billing/usage',
      },
      concurrencyProbe: {
        workflowPath: '.github/workflows/platform-concurrency-probe.yml',
        workflowHeadSha: HEAD_SHA,
        workflowBlobSha: 'b'.repeat(40),
        workflowContentDigest: await canonicalSha256(concurrencySource),
        runIds: [CONCURRENCY_RUN_ID],
        requestedJobCount: 3,
        reviewedOrganizationLimit: 2,
        observedMaximumConcurrency: 2,
        startedAt: '2026-07-26T22:00:00.000Z',
        completedAt: '2026-07-26T22:10:00.000Z',
        auditUrls: ['https://github.com/example/delivery-target/actions/runs/501'],
      },
      durationProbe: {
        workflowPath: '.github/workflows/platform-duration-probe.yml',
        workflowHeadSha: HEAD_SHA,
        workflowBlobSha: 'c'.repeat(40),
        workflowContentDigest: await canonicalSha256(durationSource),
        runId: DURATION_RUN_ID,
        maximumJobDurationMinutes: 360,
        observedDurationMs: 21_600_000,
        startedAt: '2026-07-26T12:00:00.000Z',
        completedAt: '2026-07-26T18:00:00.000Z',
        conclusion: 'failure',
        auditUrl: 'https://github.com/example/delivery-target/actions/runs/601',
      },
    },
    cloudflare: {
      accountIdDigest: HIBERNATE_MANIFEST.cloudflare.accountIdDigest,
      paidPlanReviewedAt: '2026-07-27T10:30:00.000Z',
      paidPlanAuditUrl: 'https://dash.cloudflare.com/example/workers/plans',
      paidLimits: CLOUDFLARE_PAID_WORKFLOW_LIMITS,
    },
    reusedEvidence: {
      runnerHeartbeatEvidenceId: HEARTBEAT_MANIFEST.evidenceId,
      workflowHibernateEvidenceId: HIBERNATE_MANIFEST.evidenceId,
      controlledReplayEvidenceId: REPLAY_MANIFEST.evidenceId,
    },
  };
}

type Drift =
  | 'none'
  | 'github_docs'
  | 'cloudflare_docs'
  | 'policy'
  | 'billing'
  | 'concurrency'
  | 'duration'
  | 'oversize';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function content(path: string, sha: string, source: string): Response {
  return json({ path, sha, encoding: 'base64', content: Buffer.from(source).toString('base64') });
}

function run(id: string, path: string, conclusion: 'success' | 'failure'): Response {
  return json({
    id: Number(id),
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion,
    head_sha: HEAD_SHA,
    path,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    created_at: id === CONCURRENCY_RUN_ID
      ? '2026-07-26T21:59:00.000Z' : '2026-07-26T11:59:00.000Z',
    updated_at: id === CONCURRENCY_RUN_ID
      ? '2026-07-26T22:10:00.000Z' : '2026-07-26T18:00:00.000Z',
  });
}

function concurrencyJobs(drift: boolean): Response {
  const jobs = [
    ['platform-concurrency-1', '2026-07-26T22:00:00.000Z', '2026-07-26T22:05:00.000Z'],
    ['platform-concurrency-2', '2026-07-26T22:00:00.000Z', '2026-07-26T22:05:00.000Z'],
    ['platform-concurrency-3', '2026-07-26T22:05:00.000Z', '2026-07-26T22:10:00.000Z'],
  ].map(([name, startedAt, completedAt], index) => ({
    id: 7_000 + index,
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: startedAt,
    completed_at: drift && index === 1 ? '2026-07-26T22:03:00.000Z' : completedAt,
    labels: ['ubuntu-latest'],
  }));
  return json({ total_count: jobs.length, jobs });
}

function durationJobs(drift: boolean): Response {
  return json({
    total_count: 1,
    jobs: [{
      id: 8_001,
      name: 'platform-duration',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-07-26T12:00:00.000Z',
      completed_at: drift ? '2026-07-26T17:00:00.000Z' : '2026-07-26T18:00:00.000Z',
      labels: ['ubuntu-latest'],
    }],
  });
}

function fetcher(drift: Drift = 'none'): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (drift === 'oversize') return new Response('x'.repeat(1_048_577));
    if (url.includes('/repos/github/docs/contents/')) {
      return content(
        GITHUB_ACTIONS_LIMITS_AUTHORITY.path,
        GITHUB_ACTIONS_LIMITS_AUTHORITY.blobSha,
        drift === 'github_docs' ? 'drift' : GITHUB_LIMITS_SOURCE,
      );
    }
    if (url.includes('/repos/cloudflare/cloudflare-docs/contents/')) {
      return content(
        CLOUDFLARE_WORKFLOWS_LIMITS_AUTHORITY.path,
        CLOUDFLARE_WORKFLOWS_LIMITS_AUTHORITY.blobSha,
        drift === 'cloudflare_docs' ? 'drift' : CLOUDFLARE_LIMITS_SOURCE,
      );
    }
    if (url.includes(`/orgs/${ORGANIZATION}/actions/permissions/workflow`)) {
      return json({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false });
    }
    if (url.includes(`/orgs/${ORGANIZATION}/actions/permissions/artifact-and-log-retention`)) {
      return json({ days: 90 });
    }
    if (url.includes(`/orgs/${ORGANIZATION}/actions/permissions`)) {
      return json({
        enabled_repositories: drift === 'policy' ? 'all' : 'selected',
        allowed_actions: 'selected',
        selected_actions_url: `${API_ORIGIN}/orgs/${ORGANIZATION}/actions/permissions/selected-actions`,
      });
    }
    if (url.includes(`/organizations/${ORGANIZATION}/settings/billing/usage`)) {
      return json({
        usageItems: drift === 'billing'
          ? [{ ...ACTIONS_USAGE_ITEM, netAmount: 5 }]
          : [ACTIONS_USAGE_ITEM],
      });
    }
    if (url.includes('/contents/.github/workflows/platform-concurrency-probe.yml')) {
      return content(
        '.github/workflows/platform-concurrency-probe.yml',
        'b'.repeat(40),
        readFileSync(new URL('../.github/workflows/platform-concurrency-probe.yml', import.meta.url), 'utf8'),
      );
    }
    if (url.includes('/contents/.github/workflows/platform-duration-probe.yml')) {
      return content(
        '.github/workflows/platform-duration-probe.yml',
        'c'.repeat(40),
        readFileSync(new URL('../.github/workflows/platform-duration-probe.yml', import.meta.url), 'utf8'),
      );
    }
    if (url.includes(`/actions/runs/${CONCURRENCY_RUN_ID}/jobs`)) {
      return concurrencyJobs(drift === 'concurrency');
    }
    if (url.includes(`/actions/runs/${DURATION_RUN_ID}/jobs`)) {
      return durationJobs(drift === 'duration');
    }
    if (url.endsWith(`/actions/runs/${CONCURRENCY_RUN_ID}`)) {
      return run(CONCURRENCY_RUN_ID, '.github/workflows/platform-concurrency-probe.yml', 'success');
    }
    if (url.endsWith(`/actions/runs/${DURATION_RUN_ID}`)) {
      return run(DURATION_RUN_ID, '.github/workflows/platform-duration-probe.yml', 'failure');
    }
    return json({ error: 'not found' }, 404);
  };
}

function options(drift: Drift = 'none'): PlatformLimitsEvidenceVerifierOptions {
  const commonChild = {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_PLATFORM_LIMITS_OPERATIONS_TOKEN',
    githubToken: 'CANARY_PLATFORM_LIMITS_CHILD_GITHUB_TOKEN',
    githubApiOrigin: API_ORIGIN,
    fetch: fetcher(drift),
  };
  return {
    githubToken: GITHUB_TOKEN,
    githubApiOrigin: API_ORIGIN,
    fetch: fetcher(drift),
    runnerHeartbeat: {
      manifest: HEARTBEAT_MANIFEST,
      options: {
        ...commonChild,
        controlPlaneToken: 'CANARY_PLATFORM_LIMITS_QUERY_TOKEN',
        githubAppJwt: 'CANARY_PLATFORM_LIMITS_APP_JWT',
        githubInstallationToken: 'CANARY_PLATFORM_LIMITS_INSTALLATION_TOKEN',
        expectedRunnerContractDigest: `sha256:${'d'.repeat(64)}`,
      },
    },
    workflowHibernate: {
      manifest: HIBERNATE_MANIFEST,
      options: {
        ...commonChild,
        controlPlaneToken: 'CANARY_PLATFORM_LIMITS_QUERY_TOKEN',
        cloudflareToken: 'CANARY_PLATFORM_LIMITS_CLOUDFLARE_TOKEN',
        cloudflareAccountId: 'account-example',
        canary: `ghp_${'P'.repeat(36)}`,
      },
    },
    controlledReplay: {
      manifest: REPLAY_MANIFEST,
      options: {
        controlPlaneOrigin: commonChild.controlPlaneOrigin,
        operationsToken: commonChild.operationsToken,
        queryToken: 'CANARY_PLATFORM_LIMITS_QUERY_TOKEN',
        githubToken: commonChild.githubToken,
        githubApiOrigin: API_ORIGIN,
        fetch: fetcher(drift),
      },
    },
  };
}

beforeEach(() => {
  vi.mocked(verifyRunnerHeartbeatEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: HEARTBEAT_MANIFEST.evidenceId,
    repository: REPOSITORY, runId: 'run-analysis-example', actionRunId: '1001',
    attemptId: 'attempt-analysis-example', receiptCount: 2, firstVersion: 3,
    lastVersion: 4, minimumIntervalMs: 45_000, maximumIntervalMs: 45_000,
    resultEventId: 'result-analysis-example', planDigest: `sha256:${'a'.repeat(64)}`,
    githubStatus: 'completed', githubConclusion: 'success',
    webhookDeliveryId: 'delivery-analysis-example',
    externalUpdatedAt: '2026-07-27T03:20:00.000Z', cadenceVerified: true,
    resultVerified: true, externalStateVerified: true,
  });
  vi.mocked(verifyWorkflowHibernateEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: HIBERNATE_MANIFEST.evidenceId,
    runId: HIBERNATE_MANIFEST.run.runId, repository: REPOSITORY,
    workflowInstanceId: HIBERNATE_MANIFEST.run.runId,
    beforeVersionId: HIBERNATE_MANIFEST.cloudflare.beforeDeployment.versionId,
    afterVersionId: HIBERNATE_MANIFEST.cloudflare.afterDeployment.versionId,
    verifiedStepCount: 7, analysisAttemptCount: 1, analysisDispatchOutboxCount: 1,
    githubActionRunCount: 1, reusedCompletedSteps: true, duplicateDispatches: 0,
    controlledReplayCount: 0, plaintextLeaks: 0,
  });
  vi.mocked(verifyControlledReplayEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: REPLAY_MANIFEST.evidenceId, repository: REPOSITORY,
    runId: REPLAY_MANIFEST.runId, replay: 'verified', duplicateDispatchCount: 0,
    duplicatePullRequestCount: 0, duplicateDeploymentCount: 0,
    verifiedAgentActionCount: REPLAY_MANIFEST.agentActions.length,
    verifiedPullRequestCount: 1, verifiedDeploymentCount: REPLAY_MANIFEST.deployments.length,
  });
});

describe('pilot platform limits evidence', () => {
  it('recomputes immutable docs, organization policy/billing, probes, and reused evidence', async () => {
    const input = await manifest();
    expect(PlatformLimitsEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/platform-limits-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(PlatformLimitsEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyPlatformLimitsEvidence(input, options())).resolves.toEqual({
      schemaVersion: '1',
      evidenceId: input.evidenceId,
      organization: ORGANIZATION,
      repository: REPOSITORY,
      githubHostedMaximumMinutes: 360,
      reviewedOrganizationConcurrency: 2,
      observedMaximumConcurrency: 2,
      concurrencyProbeJobCount: 3,
      actionsUsageItemCount: 1,
      actionsUsageDigest: input.github.billing.actionsUsageDigest,
      githubDocumentationVerified: true,
      githubOrganizationPolicyVerified: true,
      githubBillingVerified: true,
      githubConcurrencyProbeVerified: true,
      githubDurationProbeVerified: true,
      githubAppAndEventSemanticsVerified: true,
      cloudflarePaidLimitsVerified: true,
      cloudflareCreateSendEventUpgradeVerified: true,
      cloudflareRestartVerified: true,
      cloudflareConcurrencyDocumentationConflictObserved: true,
    });
    expect(verifyRunnerHeartbeatEvidence).toHaveBeenCalledOnce();
    expect(verifyWorkflowHibernateEvidence).toHaveBeenCalledOnce();
    expect(verifyControlledReplayEvidence).toHaveBeenCalledOnce();
  });

  it('fails closed on official document, policy, billing, and live probe drift', async () => {
    const expected = {
      github_docs: 'official_document_mismatch',
      cloudflare_docs: 'official_document_mismatch',
      policy: 'github_policy_mismatch',
      billing: 'github_billing_mismatch',
      concurrency: 'github_concurrency_probe_mismatch',
      duration: 'github_duration_probe_mismatch',
    } as const;
    for (const [drift, code] of Object.entries(expected)) {
      await expect(verifyPlatformLimitsEvidence(await manifest(), options(drift as Drift)))
        .rejects.toMatchObject({ code });
    }
  });

  it('rejects self-reported Cloudflare limits and reused evidence drift', async () => {
    const input = await manifest();
    expect(PlatformLimitsEvidenceManifestV1Schema.safeParse({
      ...input,
      cloudflare: {
        ...input.cloudflare,
        paidLimits: { ...input.cloudflare.paidLimits, concurrentInstances: 10_000 },
      },
    }).success).toBe(false);
    vi.mocked(verifyControlledReplayEvidence).mockResolvedValueOnce({
      ...(await vi.mocked(verifyControlledReplayEvidence)(
        REPLAY_MANIFEST,
        options().controlledReplay.options,
      )),
      repository: 'other/repository',
    });
    await expect(verifyPlatformLimitsEvidence(input, options()))
      .rejects.toMatchObject({ code: 'reused_evidence_mismatch' });
  });

  it('bounds responses and never propagates raw responses or credentials', async () => {
    await expect(verifyPlatformLimitsEvidence(await manifest(), options('oversize')))
      .rejects.toMatchObject({ code: 'github_response_invalid' });
    const raw = `RAW_${GITHUB_TOKEN}`;
    const failure = await verifyPlatformLimitsEvidence(await manifest(), {
      ...options(),
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformLimitsEvidenceVerificationError);
    expect(String(failure)).not.toContain(raw);
    expect(String(failure)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the real command behind the Watt-derived explicit opt-in gate', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_PLATFORM_LIMITS_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-platform-limits-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('platform-limits-e2e: opt-in missing');
  });
});
