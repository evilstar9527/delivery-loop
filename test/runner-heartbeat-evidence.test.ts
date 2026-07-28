import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnalysisActionEvidenceManifestV1Schema,
  type AnalysisActionEvidenceManifestV1,
} from '../src/domain/analysis-action-evidence.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  RunnerHeartbeatEvidenceManifestV1Schema,
  type RunnerHeartbeatEvidenceManifestV1,
} from '../src/domain/runner-heartbeat-evidence.js';

vi.mock('../src/pilot/analysis-action-evidence-verifier.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, verifyAnalysisActionEvidence: vi.fn() };
});

import {
  AnalysisActionEvidenceVerificationError,
  verifyAnalysisActionEvidence,
} from '../src/pilot/analysis-action-evidence-verifier.js';
import {
  RunnerHeartbeatEvidenceVerificationError,
  verifyRunnerHeartbeatEvidence,
} from '../src/pilot/runner-heartbeat-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example';
const GITHUB_ORIGIN = 'https://api.github.test';
const CONTROL_TOKEN = 'CANARY_RUNNER_HEARTBEAT_CONTROL_TOKEN';
const OPERATIONS_TOKEN = 'CANARY_RUNNER_HEARTBEAT_OPERATIONS_TOKEN';
const APP_JWT = 'CANARY_RUNNER_HEARTBEAT_APP_JWT';
const INSTALLATION_TOKEN = 'CANARY_RUNNER_HEARTBEAT_INSTALLATION_TOKEN';
const ANALYSIS_EXAMPLE = AnalysisActionEvidenceManifestV1Schema.parse(JSON.parse(readFileSync(
  new URL('../schemas/analysis-action-evidence-v1.example.json', import.meta.url),
  'utf8',
)) as unknown);
const DISPATCH = ANALYSIS_EXAMPLE.dispatchEvidence.dispatch;
const REPOSITORY = ANALYSIS_EXAMPLE.dispatchEvidence.repository.fullName;

interface HeartbeatReceipt {
  id: string;
  attemptId: string;
  leaseGeneration: number;
  previousVersion: number;
  version: number;
  previousHeartbeatAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

const RECEIPTS: HeartbeatReceipt[] = [
  {
    id: 'heartbeat-analysis-example-3',
    attemptId: DISPATCH.attemptId,
    leaseGeneration: 1,
    previousVersion: 2,
    version: 3,
    previousHeartbeatAt: '2026-07-27T03:16:30.000Z',
    heartbeatAt: '2026-07-27T03:17:15.000Z',
    leaseExpiresAt: '2026-07-27T03:18:45.000Z',
  },
  {
    id: 'heartbeat-analysis-example-4',
    attemptId: DISPATCH.attemptId,
    leaseGeneration: 1,
    previousVersion: 3,
    version: 4,
    previousHeartbeatAt: '2026-07-27T03:17:15.000Z',
    heartbeatAt: '2026-07-27T03:18:00.000Z',
    leaseExpiresAt: '2026-07-27T03:19:30.000Z',
  },
];

type Manifest = RunnerHeartbeatEvidenceManifestV1;
type Drift =
  | 'none'
  | 'version_gap'
  | 'too_fast'
  | 'too_slow'
  | 'lease'
  | 'result'
  | 'github'
  | 'webhook'
  | 'oversize';

async function manifest(): Promise<Manifest> {
  const analysisActionEvidence = structuredClone(
    ANALYSIS_EXAMPLE,
  ) as AnalysisActionEvidenceManifestV1;
  return {
    schemaVersion: '1',
    evidenceId: 'runner-heartbeat-evidence-test',
    recordedAt: '2026-07-27T04:30:00.000Z',
    analysisActionEvidence,
    heartbeat: {
      receiptCount: RECEIPTS.length,
      receiptsDigest: await canonicalSha256(RECEIPTS),
      leaseGeneration: 1,
      firstVersion: 3,
      lastVersion: 4,
      firstHeartbeatAt: '2026-07-27T03:17:15.000Z',
      lastHeartbeatAt: '2026-07-27T03:18:00.000Z',
      minimumIntervalMs: 45_000,
      maximumIntervalMs: 45_000,
    },
    result: {
      eventId: 'event-analysis-result-example',
      sequence: 1,
      digest: DISPATCH.planDigest,
      reportedAt: '2026-07-27T03:19:00.000Z',
    },
    webhookObservation: {
      sourceId: 'delivery-analysis-completed-example',
      sourceDigest: `sha256:${'c'.repeat(64)}`,
      externalUpdatedAt: DISPATCH.actionUpdatedAt,
      observedAt: '2026-07-27T03:20:05.000Z',
      processedAt: '2026-07-27T03:20:06.000Z',
    },
  };
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function planProjection(input: Manifest, drift: Drift): Record<string, unknown> {
  const receipts = structuredClone(RECEIPTS);
  if (drift === 'version_gap') {
    receipts[1]!.version = 5;
    receipts[1]!.previousVersion = 4;
  }
  if (drift === 'too_fast') {
    receipts[0]!.previousHeartbeatAt = '2026-07-27T03:16:55.000Z';
  }
  if (drift === 'too_slow') {
    receipts[0]!.previousHeartbeatAt = '2026-07-27T03:16:00.000Z';
  }
  if (drift === 'lease') receipts[1]!.leaseExpiresAt = '2026-07-27T03:19:29.999Z';
  return {
    run: {
      id: DISPATCH.runId,
      taskId: input.analysisActionEvidence.task.taskId,
      taskRevision: DISPATCH.taskRevision,
      taskDigest: DISPATCH.taskDigest,
      state: DISPATCH.runState,
      version: DISPATCH.runVersion,
      baseSha: DISPATCH.baseSha,
      activePlan: { id: DISPATCH.planId, version: 1, digest: DISPATCH.planDigest },
      createdAt: '2026-07-27T03:00:00.000Z',
      updatedAt: '2026-07-27T03:19:01.000Z',
    },
    plan: {
      id: DISPATCH.planId,
      version: DISPATCH.planVersion,
      taskRevision: DISPATCH.taskRevision,
      baseSha: DISPATCH.baseSha,
      digest: DISPATCH.planDigest,
      status: 'active',
      createdByAttemptId: DISPATCH.attemptId,
    },
    items: [],
    attempts: [{
      id: DISPATCH.attemptId,
      ordinal: 1,
      mode: 'analysis',
      status: 'completed',
      baseSha: DISPATCH.baseSha,
      version: 5,
      leaseGeneration: 1,
      leaseExpiresAt: RECEIPTS[1]!.leaseExpiresAt,
      heartbeatAt: RECEIPTS[1]!.heartbeatAt,
      result: {
        eventId: drift === 'result' ? 'event-result-drift' : input.result.eventId,
        sequence: 1,
        payloadRef: `d1://execution-plans/${DISPATCH.planId}`,
        digest: DISPATCH.planDigest,
        reportedAt: input.result.reportedAt,
      },
      githubRunId: DISPATCH.actionRunId,
      githubStatus: 'completed',
      githubConclusion: drift === 'github' ? 'failure' : 'success',
      githubObservedAt: input.webhookObservation.observedAt,
      githubExternalUpdatedAt: DISPATCH.actionUpdatedAt,
      githubObservationVersion: 1,
      createdAt: '2026-07-27T03:00:00.000Z',
      updatedAt: '2026-07-27T03:19:01.000Z',
    }],
    heartbeats: receipts,
    checkpoints: [],
    evidence: [],
  };
}

function auditProjection(input: Manifest, drift: Drift): Record<string, unknown> {
  return {
    schemaVersion: '1',
    runId: DISPATCH.runId,
    answers: {
      checks: {
        githubRunObservations: [{
          sourceKind: drift === 'webhook' ? 'api' : 'webhook',
          sourceId: input.webhookObservation.sourceId,
          sourceDigest: input.webhookObservation.sourceDigest,
          repository: REPOSITORY,
          githubRunId: DISPATCH.actionRunId,
          attemptId: DISPATCH.attemptId,
          processingState: 'applied',
          ignoreReason: null,
          externalUpdatedAt: input.webhookObservation.externalUpdatedAt,
          observedAt: input.webhookObservation.observedAt,
          processedAt: input.webhookObservation.processedAt,
        }],
      },
    },
  };
}

function fakeFetch(input: Manifest, drift: Drift = 'none'): typeof fetch {
  return (async (request, init) => {
    const url = new URL(String(request));
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.origin !== CONTROL_ORIGIN) return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/plan')) {
      if (authorization !== `Bearer ${CONTROL_TOKEN}`) return new Response(null, { status: 401 });
      if (drift === 'oversize') {
        return json({}, { headers: { 'content-length': String(2 * 1_024 * 1_024) } });
      }
      return json(planProjection(input, drift));
    }
    if (url.pathname.endsWith('/audit')) {
      if (authorization !== `Bearer ${OPERATIONS_TOKEN}`) return new Response(null, { status: 401 });
      return json(auditProjection(input, drift));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

function options(input: Manifest, drift: Drift = 'none') {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    controlPlaneToken: CONTROL_TOKEN,
    operationsToken: OPERATIONS_TOKEN,
    githubAppJwt: APP_JWT,
    githubInstallationToken: INSTALLATION_TOKEN,
    githubApiOrigin: GITHUB_ORIGIN,
    expectedRunnerContractDigest: input.analysisActionEvidence.runner.contractDigest,
    fetch: fakeFetch(input, drift),
  };
}

beforeEach(() => {
  vi.mocked(verifyAnalysisActionEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1',
    evidenceId: ANALYSIS_EXAMPLE.evidenceId,
    repository: REPOSITORY,
    runId: DISPATCH.runId,
    actionRunId: DISPATCH.actionRunId,
    taskInputClass: 'user_feedback',
    planId: DISPATCH.planId,
    planVersion: 1,
    evidenceRefCount: 1,
    itemCount: 1,
    contextCategories: ['repository'],
    contextCallCount: 1,
    codexVersion: ANALYSIS_EXAMPLE.runner.codexVersion,
    runnerContractDigest: ANALYSIS_EXAMPLE.runner.contractDigest,
    immutableHeadVerified: true,
    detachedHeadVerified: true,
    repositoryCleanVerified: true,
    repositoryWriteCredentials: 0,
  });
});

describe('real Runner heartbeat and GitHub final-state evidence', () => {
  it('derives cadence, completion, and final webhook state from live safe projections', async () => {
    const input = await manifest();
    expect(RunnerHeartbeatEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/runner-heartbeat-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(RunnerHeartbeatEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyRunnerHeartbeatEvidence(input, options(input))).resolves.toEqual({
      schemaVersion: '1',
      evidenceId: input.evidenceId,
      repository: REPOSITORY,
      runId: DISPATCH.runId,
      actionRunId: DISPATCH.actionRunId,
      attemptId: DISPATCH.attemptId,
      receiptCount: 2,
      firstVersion: 3,
      lastVersion: 4,
      minimumIntervalMs: 45_000,
      maximumIntervalMs: 45_000,
      resultEventId: input.result.eventId,
      planDigest: DISPATCH.planDigest,
      githubStatus: 'completed',
      githubConclusion: 'success',
      webhookDeliveryId: input.webhookObservation.sourceId,
      externalUpdatedAt: DISPATCH.actionUpdatedAt,
      cadenceVerified: true,
      resultVerified: true,
      externalStateVerified: true,
    });
    expect(verifyAnalysisActionEvidence).toHaveBeenCalledOnce();
  });

  it('rejects version discontinuity, out-of-window cadence, lease drift, and receipt drift', async () => {
    for (const drift of ['version_gap', 'too_fast', 'too_slow', 'lease'] as const) {
      const input = await manifest();
      await expect(verifyRunnerHeartbeatEvidence(input, options(input, drift)))
        .rejects.toMatchObject({ code: 'heartbeat_projection_mismatch' });
    }
    const input = await manifest();
    input.heartbeat.receiptsDigest = `sha256:${'f'.repeat(64)}`;
    await expect(verifyRunnerHeartbeatEvidence(input, options(input)))
      .rejects.toMatchObject({ code: 'heartbeat_projection_mismatch' });
  });

  it('rejects result, final GitHub projection, webhook, or reused analysis evidence drift', async () => {
    for (const drift of ['result', 'github', 'webhook'] as const) {
      const input = await manifest();
      await expect(verifyRunnerHeartbeatEvidence(input, options(input, drift)))
        .rejects.toMatchObject({
          code: drift === 'result' ? 'result_projection_mismatch' :
            drift === 'github' ? 'github_projection_mismatch' :
              'webhook_observation_mismatch',
        });
    }
    const input = await manifest();
    vi.mocked(verifyAnalysisActionEvidence).mockRejectedValueOnce(
      new AnalysisActionEvidenceVerificationError('runner_contract_mismatch'),
    );
    await expect(verifyRunnerHeartbeatEvidence(input, options(input)))
      .rejects.toMatchObject({ code: 'analysis_evidence_mismatch' });
  });

  it('fails closed on bounded responses without propagating raw data or credentials', async () => {
    const oversized = await manifest();
    await expect(verifyRunnerHeartbeatEvidence(oversized, options(oversized, 'oversize')))
      .rejects.toMatchObject({ code: 'control_plane_response_invalid' });
    const input = await manifest();
    const raw = `RAW_${CONTROL_TOKEN}_${OPERATIONS_TOKEN}_${INSTALLATION_TOKEN}`;
    const error = await verifyRunnerHeartbeatEvidence(input, {
      ...options(input),
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RunnerHeartbeatEvidenceVerificationError);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(OPERATIONS_TOKEN);
    expect(String(error)).not.toContain(INSTALLATION_TOKEN);
  });

  it('keeps the real E2E command behind the Watt-derived opt-in gate', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_RUNNER_HEARTBEAT_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-runner-heartbeat-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('runner-heartbeat-e2e: opt-in missing');
  });
});
