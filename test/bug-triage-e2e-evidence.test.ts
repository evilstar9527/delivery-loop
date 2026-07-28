import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const componentMock = vi.hoisted(() => vi.fn());
vi.mock('../src/pilot/analysis-action-evidence-verifier.js', () => ({
  verifyAnalysisActionEvidence: componentMock,
}));

import { canonicalSha256 } from '../src/domain/digest.js';
import {
  BugTriageE2EEvidenceManifestV1Schema,
} from '../src/domain/bug-triage-e2e-evidence.js';
import {
  AnalysisActionEvidenceManifestV1Schema,
} from '../src/domain/analysis-action-evidence.js';
import {
  verifyBugTriageE2EEvidence,
  type BugTriageE2EEvidenceSources,
  type BugTriageE2EEvidenceVerifierOptions,
} from '../src/pilot/bug-triage-e2e-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example.test';
const CANARY = 'CANARY_E2E_2_ROOT_CAUSE_RESPONSE';
const TOKENS = {
  control: 'e2e2-control-token', operations: 'e2e2-operations-token',
  app: 'e2e2-app-jwt', installation: 'e2e2-installation-token',
};

function example(name: string): unknown {
  return JSON.parse(readFileSync(resolve('schemas', name), 'utf8')) as unknown;
}

async function fixture(): Promise<{
  manifest: ReturnType<typeof BugTriageE2EEvidenceManifestV1Schema.parse>;
  sources: BugTriageE2EEvidenceSources;
}> {
  const raw = structuredClone(example('analysis-action-evidence-v1.example.json')) as
    Record<string, unknown>;
  const context = raw.context as Record<string, unknown>;
  Object.assign(context, {
    categories: ['logs', 'repository', 'traces'],
    totalCalls: 3,
    successfulCalls: 3,
    deniedCalls: 0,
    contextReadsDigest: `sha256:${'8'.repeat(64)}`,
  });
  const analysis = AnalysisActionEvidenceManifestV1Schema.parse(raw);
  const dispatch = analysis.dispatchEvidence.dispatch;
  const evidenceId = 'diagnostic_e2e_2_root_cause';
  const manifest = BugTriageE2EEvidenceManifestV1Schema.parse({
    schemaVersion: '1', scenario: 'E2E-2', evidenceId: 'bug-triage-e2e-round-118',
    recordedAt: '2026-07-27T05:00:00.000Z',
    components: {
      analysisAction: {
        evidenceId: analysis.evidenceId,
        manifestDigest: await canonicalSha256(analysis),
      },
    },
    lineage: {
      repository: analysis.dispatchEvidence.repository.fullName,
      taskId: analysis.task.taskId,
      taskRevision: dispatch.taskRevision,
      taskDigest: dispatch.taskDigest,
      runId: dispatch.runId,
      runVersion: dispatch.runVersion,
      planId: dispatch.planId,
      planVersion: dispatch.planVersion,
      planDigest: dispatch.planDigest,
      baseSha: dispatch.baseSha,
      analysisAttemptId: dispatch.attemptId,
      analysisActionRunId: dispatch.actionRunId,
    },
    diagnosis: {
      evidenceId,
      evidenceRef: `d1://evidence/${evidenceId}`,
      locatorKinds: ['uid', 'cid', 'path'],
      locatorDigest: `sha256:${'a'.repeat(64)}`,
      rootCauseDigest: `sha256:${'b'.repeat(64)}`,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      logsTraceId: 'tooltrace_logs_e2e_2',
      requestTraceId: 'tooltrace_request_e2e_2',
      observedAt: '2026-07-27T03:10:00.000Z',
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      reviewer: 'incident-reviewer',
      reviewedAt: '2026-07-27T04:30:00.000Z',
      sourceEvidenceUrl: 'https://evidence.example/e2e-2/round-118',
      locatorInputReviewed: true,
      rootCauseReviewed: true,
      noProductionWriteReviewed: true,
    },
  });
  return { manifest, sources: { analysisAction: analysis } };
}

function diagnosticResponse(
  manifest: Awaited<ReturnType<typeof fixture>>['manifest'],
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    schemaVersion: '1', runId: manifest.lineage.runId,
    task: {
      id: manifest.lineage.taskId, intentKind: 'bug',
      revision: manifest.lineage.taskRevision, digest: manifest.lineage.taskDigest,
      repository: manifest.lineage.repository,
    },
    plan: {
      id: manifest.lineage.planId, version: manifest.lineage.planVersion,
      digest: manifest.lineage.planDigest, status: 'active',
      diagnosticEvidenceRefs: [manifest.diagnosis.evidenceRef],
    },
    evidence: [{
      evidenceId: manifest.diagnosis.evidenceId,
      evidenceRef: manifest.diagnosis.evidenceRef,
      attemptId: manifest.lineage.analysisAttemptId,
      locatorKinds: manifest.diagnosis.locatorKinds,
      locatorDigest: manifest.diagnosis.locatorDigest,
      rootCauseDigest: manifest.diagnosis.rootCauseDigest,
      evidenceDigest: manifest.diagnosis.evidenceDigest,
      observedAt: manifest.diagnosis.observedAt,
      sourceTraces: [
        {
          traceId: manifest.diagnosis.logsTraceId, toolPath: 'logs/search',
          action: 'logs:read', effect: 'read', resultCategory: 'success',
          occurredAt: '2026-07-27T03:05:00.000Z',
        },
        {
          traceId: manifest.diagnosis.requestTraceId, toolPath: 'traces/get',
          action: 'trace:read', effect: 'read', resultCategory: 'success',
          occurredAt: '2026-07-27T03:06:00.000Z',
        },
      ],
      ...overrides,
    }],
  });
}

function auditResponse(
  manifest: Awaited<ReturnType<typeof fixture>>['manifest'],
  overrides: { changes?: unknown[]; deployments?: unknown[]; credentials?: unknown[] } = {},
): Response {
  return Response.json({
    schemaVersion: '1', runId: manifest.lineage.runId,
    run: {
      state: 'awaiting_approval', version: manifest.lineage.runVersion,
      baseSha: manifest.lineage.baseSha,
    },
    answers: {
      permissions: {
        repositoryWriteCredentials: overrides.credentials ?? [],
        planEffects: [{ effect: 'repo_read' }, { effect: 'logs_read' }],
      },
      changes: overrides.changes ?? [], deployments: overrides.deployments ?? [],
      checks: { effectOutboxes: [{ kind: 'analysis_dispatch' }] },
    },
  });
}

function options(
  manifest: Awaited<ReturnType<typeof fixture>>['manifest'],
  fetcher?: typeof fetch,
): BugTriageE2EEvidenceVerifierOptions {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    controlPlaneToken: TOKENS.control,
    operationsToken: TOKENS.operations,
    githubAppJwt: TOKENS.app,
    githubInstallationToken: TOKENS.installation,
    expectedRunnerContractDigest: `sha256:${'9'.repeat(64)}`,
    canarySecret: CANARY,
    fetch: fetcher ?? (async (input) => String(input).endsWith('/diagnostic-evidence')
      ? diagnosticResponse(manifest) : auditResponse(manifest)),
  };
}

describe('E2E-2 bug triage evidence', () => {
  beforeEach(() => componentMock.mockReset().mockResolvedValue({ analysisActions: 1 }));

  it('requires a strict E2E-2 manifest and checked-in schema example', async () => {
    const value = await fixture();
    expect(BugTriageE2EEvidenceManifestV1Schema.parse(value.manifest).scenario).toBe('E2E-2');
    expect(BugTriageE2EEvidenceManifestV1Schema.safeParse(
      example('bug-triage-e2e-evidence-v1.example.json'),
    ).success).toBe(true);
    expect(BugTriageE2EEvidenceManifestV1Schema.safeParse({
      ...value.manifest, rawLogs: CANARY,
    }).success).toBe(false);
    expect(BugTriageE2EEvidenceManifestV1Schema.safeParse({
      ...value.manifest,
      diagnosis: { ...value.manifest.diagnosis, evidenceRef: 'd1://evidence/other' },
    }).success).toBe(false);
  });

  it('cross-checks user feedback, read-only logs/trace, root cause, Plan ref and zero writes',
    async () => {
      const value = await fixture();
      await expect(verifyBugTriageE2EEvidence(
        value.manifest, value.sources, options(value.manifest),
      )).resolves.toMatchObject({
        scenario: 'E2E-2', diagnosticEvidence: 1, logSearches: 1, traceReads: 1,
        planDiagnosticRefs: 1, repositoryWrites: 0, deployments: 0, plaintextLeaks: 0,
      });
      expect(componentMock).toHaveBeenCalledOnce();
    });

  it('rejects component, diagnosis and production-write drift', async () => {
    const value = await fixture();
    await expect(verifyBugTriageE2EEvidence({
      ...value.manifest,
      components: { analysisAction: {
        ...value.manifest.components.analysisAction,
        manifestDigest: `sha256:${'f'.repeat(64)}`,
      } },
    }, value.sources, options(value.manifest))).rejects.toMatchObject({
      code: 'component_digest_mismatch',
    });
    await expect(verifyBugTriageE2EEvidence(
      value.manifest, value.sources,
      options(value.manifest, async (input) => String(input).endsWith('/diagnostic-evidence')
        ? diagnosticResponse(value.manifest, { rootCauseDigest: `sha256:${'e'.repeat(64)}` })
        : auditResponse(value.manifest)),
    )).rejects.toMatchObject({ code: 'diagnostic_evidence_mismatch' });
    await expect(verifyBugTriageE2EEvidence(
      value.manifest, value.sources,
      options(value.manifest, async (input) => String(input).endsWith('/diagnostic-evidence')
        ? diagnosticResponse(value.manifest)
        : auditResponse(value.manifest, { deployments: [{ environment: 'production' }] })),
    )).rejects.toMatchObject({ code: 'production_write_detected' });
  });

  it('rejects leaked credentials before parsing a control-plane response', async () => {
    const value = await fixture();
    await expect(verifyBugTriageE2EEvidence(
      value.manifest, value.sources,
      options(value.manifest, async () => Response.json({ leaked: TOKENS.operations })),
    )).rejects.toMatchObject({ code: 'secret_leak_detected' });
  });

  it('keeps CLI opt-in and incomplete prerequisites distinct from fact failure', () => {
    const run = (environment: NodeJS.ProcessEnv) => spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-bug-triage-e2e-evidence.ts'],
      { cwd: resolve('.'), env: { ...process.env, ...environment }, encoding: 'utf8' },
    );
    const disabled = run({ DELIVERY_LOOP_BUG_TRIAGE_E2E: '' });
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain('bug-triage-e2e: opt-in missing');
    const incomplete = run({ DELIVERY_LOOP_BUG_TRIAGE_E2E: '1' });
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain('required evidence configuration is incomplete');
    expect(incomplete.stderr).not.toContain(CANARY);
  });
});
