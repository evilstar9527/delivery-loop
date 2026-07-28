import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const componentMocks = vi.hoisted(() => ({
  meegleWorkItem: vi.fn(),
  analysisAction: vi.fn(),
  feishuCardAction: vi.fn(),
}));

vi.mock('../src/pilot/meegle-work-item-evidence-verifier.js', () => ({
  verifyMeegleWorkItemEvidence: componentMocks.meegleWorkItem,
}));
vi.mock('../src/pilot/analysis-action-evidence-verifier.js', () => ({
  verifyAnalysisActionEvidence: componentMocks.analysisAction,
}));
vi.mock('../src/pilot/feishu-card-action-evidence-verifier.js', () => ({
  verifyFeishuCardActionEvidence: componentMocks.feishuCardAction,
}));
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  RequirementE2EEvidenceManifestV1Schema,
  type RequirementE2EEvidenceManifestV1,
} from '../src/domain/requirement-e2e-evidence.js';
import {
  MeegleWorkItemEvidenceManifestV1Schema,
} from '../src/domain/meegle-work-item-evidence.js';
import {
  AnalysisActionEvidenceManifestV1Schema,
} from '../src/domain/analysis-action-evidence.js';
import {
  FeishuCardActionEvidenceManifestV1Schema,
} from '../src/domain/feishu-card-action-evidence.js';
import {
  verifyRequirementE2EEvidence,
  type RequirementE2EEvidenceSources,
  type RequirementE2EEvidenceVerifierOptions,
} from '../src/pilot/requirement-e2e-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example';
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.test/client/v4';
const ACCOUNT_ID = 'a'.repeat(32);
const CANARY = `ghp_${'R'.repeat(36)}`;
const VERSION_ID = '11111111-2222-4333-8444-555555555555';
const TOKENS = {
  control: 'control-token-e2e-1',
  operations: 'operations-token-e2e-1',
  app: 'github-app-jwt-e2e-1',
  installation: 'github-installation-token-e2e-1',
  feishuObserver: 'feishu-observer-token-e2e-1',
  cloudflare: 'cloudflare-token-e2e-1',
};

interface Fixture {
  manifest: RequirementE2EEvidenceManifestV1;
  sources: RequirementE2EEvidenceSources;
}

function example(name: string): unknown {
  return JSON.parse(readFileSync(resolve(`schemas/${name}`), 'utf8')) as unknown;
}

async function fixture(): Promise<Fixture> {
  const analysisRaw = structuredClone(example(
    'analysis-action-evidence-v1.example.json',
  )) as Record<string, unknown>;
  const analysisTask = analysisRaw.task as Record<string, unknown>;
  analysisTask.inputClass = 'prd';
  analysisTask.intentKind = 'requirement';
  const analysis = AnalysisActionEvidenceManifestV1Schema.parse(analysisRaw);
  const dispatch = analysis.dispatchEvidence.dispatch;

  const meegleRaw = structuredClone(example(
    'meegle-work-item-evidence-v1.example.json',
  )) as Record<string, unknown>;
  const mappingProfile = meegleRaw.mappingProfile as Record<string, unknown>;
  mappingProfile.allowedRepositories = [analysis.dispatchEvidence.repository.fullName];
  const meegleCases = meegleRaw.cases as Record<string, Record<string, unknown>>;
  meegleCases.mapped!.revision = dispatch.taskRevision;
  const meegleResult = meegleRaw.mappedResult as Record<string, unknown>;
  meegleResult.sourceTaskKey = `${(meegleRaw.source as Record<string, unknown>).projectKey}/` +
    `${(meegleRaw.source as Record<string, unknown>).workItemTypeKey}/` +
    `${meegleCases.mapped!.workItemId}`;
  meegleResult.taskRevision = dispatch.taskRevision;
  meegleResult.taskDigest = dispatch.taskDigest;
  meegleResult.taskId = analysis.task.taskId;
  meegleResult.runId = dispatch.runId;
  meegleResult.workflowInstanceId = dispatch.runId;
  const meegle = MeegleWorkItemEvidenceManifestV1Schema.parse(meegleRaw);

  const cardRaw = structuredClone(example(
    'feishu-card-action-evidence-v1.example.json',
  )) as Record<string, unknown>;
  const successes = cardRaw.successes as Array<Record<string, unknown>>;
  const approve = successes.find((item) => item.scenario === 'approve')!;
  Object.assign(approve, {
    taskId: analysis.task.taskId,
    runId: dispatch.runId,
    runVersion: dispatch.runVersion,
    taskRevisionDigest: await canonicalSha256(dispatch.taskRevision),
    planId: dispatch.planId,
    planVersion: dispatch.planVersion,
    planDigest: dispatch.planDigest,
    baseSha: dispatch.baseSha,
  });
  (cardRaw.safety as Record<string, unknown>).canaryDigest = await canonicalSha256(CANARY);
  const card = FeishuCardActionEvidenceManifestV1Schema.parse(cardRaw);
  const approved = card.successes.find((item) => item.scenario === 'approve')!;

  const sources = {
    meegleWorkItem: meegle,
    analysisAction: analysis,
    feishuCardAction: card,
  } satisfies RequirementE2EEvidenceSources;
  const manifest = RequirementE2EEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    scenario: 'E2E-1',
    evidenceId: 'requirement-e2e-round-117',
    recordedAt: '2026-07-27T14:00:00.000Z',
    components: {
      meegleWorkItem: {
        evidenceId: meegle.evidenceId,
        manifestDigest: await canonicalSha256(meegle),
      },
      analysisAction: {
        evidenceId: analysis.evidenceId,
        manifestDigest: await canonicalSha256(analysis),
      },
      feishuCardAction: {
        evidenceId: card.evidenceId,
        manifestDigest: await canonicalSha256(card),
      },
    },
    lineage: {
      repository: analysis.dispatchEvidence.repository.fullName,
      sourceEventId: meegle.cases.mapped.eventId,
      sourceWorkItemId: meegle.cases.mapped.workItemId,
      taskId: analysis.task.taskId,
      taskRevision: dispatch.taskRevision,
      taskDigest: dispatch.taskDigest,
      runId: dispatch.runId,
      runVersion: dispatch.runVersion,
      workflowInstanceId: dispatch.runId,
      planId: dispatch.planId,
      planVersion: dispatch.planVersion,
      planDigest: dispatch.planDigest,
      baseSha: dispatch.baseSha,
      analysisAttemptId: dispatch.attemptId,
      analysisActionRunId: dispatch.actionRunId,
    },
    approval: {
      eventId: approved.eventId,
      actionReceiptId: approved.actionReceiptId,
      approvalId: approved.resultId,
      actorKey: approved.actorKey,
      decision: 'approve',
      effect: 'repo_write',
    },
    cloudflare: {
      accountIdDigest: await canonicalSha256(ACCOUNT_ID),
      workflowName: 'delivery-run',
      instanceVersionId: VERSION_ID,
      instanceStatus: 'waiting',
      instanceStartedAt: '2026-07-27T03:00:00.000Z',
      dashboardUrl: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/workflows/delivery-run`,
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      reviewer: 'release-owner',
      reviewedAt: '2026-07-27T13:45:00.000Z',
      crossLineageEvidenceUrl: 'https://evidence.example/e2e-1/round-117',
      requirementSemanticsReviewed: true,
      planAndEffectReviewed: true,
    },
  });
  return { manifest, sources };
}

function cloudflareResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: {
      status: 'waiting',
      versionId: VERSION_ID,
      start: '2026-07-27T03:00:00.000Z',
      ...overrides,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function auditResponse(overrides: {
  runState?: string;
  approvalId?: string;
  repositoryWriteCredentials?: Array<Record<string, unknown>>;
} = {}): Response {
  return new Response(JSON.stringify({
    schemaVersion: '1',
    runId: 'run-analysis-action-example',
    run: {
      state: overrides.runState ?? 'awaiting_approval',
      version: 8,
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    answers: {
      permissions: {
        repositoryWriteCredentials: overrides.repositoryWriteCredentials ?? [],
      },
      approvals: [{
        approvalId: overrides.approvalId ?? 'approval_approve',
        effect: 'repo_write',
        decision: 'approve',
        planId: 'plan-analysis-action-example',
        planVersion: 1,
        planDigest: `sha256:${'3'.repeat(64)}`,
        baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        invalidated: false,
      }],
      changes: [],
      deployments: [],
      checks: {
        effectOutboxes: [{
          id: 'outbox-analysis-action-example',
          kind: 'analysis_dispatch',
          state: 'settled',
        }],
      },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function defaultFetch(input: string | URL | Request): Promise<Response> {
  return String(input).includes('/audit') ? auditResponse() : cloudflareResponse();
}

function options(
  fetcher: typeof fetch = defaultFetch,
): RequirementE2EEvidenceVerifierOptions {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    controlPlaneToken: TOKENS.control,
    operationsToken: TOKENS.operations,
    meegleProfile: 'delivery-loop-evidence',
    tenantKey: 'tenant_delivery_loop_pilot',
    projectKey: 'project_delivery',
    workItemTypeKey: 'story',
    githubAppJwt: TOKENS.app,
    githubInstallationToken: TOKENS.installation,
    expectedRunnerContractDigest: `sha256:${'9'.repeat(64)}`,
    feishuObservabilityReportUrl: 'https://observer.example/feishu/card-actions/round-110',
    feishuObservabilityToken: TOKENS.feishuObserver,
    canarySecret: CANARY,
    cloudflareAccountId: ACCOUNT_ID,
    cloudflareToken: TOKENS.cloudflare,
    cloudflareApiOrigin: CLOUDFLARE_ORIGIN,
    fetch: fetcher,
  };
}

describe('E2E-1 requirement lineage evidence', () => {
  beforeEach(() => {
    componentMocks.meegleWorkItem.mockReset().mockResolvedValue({ mappedWorkItemCount: 1 });
    componentMocks.analysisAction.mockReset().mockResolvedValue({ analysisActions: 1 });
    componentMocks.feishuCardAction.mockReset().mockResolvedValue({ planApprovals: 1 });
  });

  it('keeps a strict E2E-1 manifest and checked-in schema example', async () => {
    const value = await fixture();
    expect(RequirementE2EEvidenceManifestV1Schema.parse(value.manifest).scenario).toBe('E2E-1');
    expect(RequirementE2EEvidenceManifestV1Schema.safeParse(example(
      'requirement-e2e-evidence-v1.example.json',
    )).success).toBe(true);
    expect(RequirementE2EEvidenceManifestV1Schema.safeParse({
      ...value.manifest,
      lineage: { ...value.manifest.lineage, workflowInstanceId: 'run_duplicate' },
    }).success).toBe(false);
    expect(RequirementE2EEvidenceManifestV1Schema.safeParse({
      ...value.manifest, rawRequirement: CANARY,
    }).success).toBe(false);
  });

  it('cross-checks one Meegle Task, Workflow, read-only Action, Plan and card approval',
    async () => {
      const value = await fixture();
      const verificationOptions = options(async (input, init) => {
        if (String(input).includes('/audit')) return auditResponse();
        expect(String(input)).toBe(
          `${CLOUDFLARE_ORIGIN}/accounts/${ACCOUNT_ID}/workflows/delivery-run/instances/` +
            value.manifest.lineage.runId,
        );
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${TOKENS.cloudflare}`,
        );
        return cloudflareResponse();
      });
      await expect(verifyRequirementE2EEvidence(
        value.manifest, value.sources, verificationOptions,
      )).resolves.toMatchObject({
        scenario: 'E2E-1', source: 'meegle', mappedTasks: 1, runs: 1,
        workflowInstances: 1, analysisActions: 1, plans: 1,
        approvalRecords: 1, planSnapshotsApproved: 1, effectsApproved: 1,
        repositoryWrites: 0, duplicateRuns: 0, plaintextLeaks: 0,
      });
      expect(componentMocks.meegleWorkItem).toHaveBeenCalledOnce();
      expect(componentMocks.analysisAction).toHaveBeenCalledOnce();
      expect(componentMocks.feishuCardAction).toHaveBeenCalledOnce();
    });

  it('rejects component digest and Task/Run/Plan/approval lineage drift', async () => {
    const value = await fixture();
    await expect(verifyRequirementE2EEvidence({
      ...value.manifest,
      components: {
        ...value.manifest.components,
        meegleWorkItem: {
          ...value.manifest.components.meegleWorkItem,
          manifestDigest: `sha256:${'f'.repeat(64)}`,
        },
      },
    }, value.sources, options())).rejects.toMatchObject({ code: 'component_digest_mismatch' });

    const sources = structuredClone(value.sources);
    const approve = sources.feishuCardAction.successes.find(
      (item) => item.scenario === 'approve',
    )!;
    approve.planDigest = `sha256:${'e'.repeat(64)}`;
    const driftedManifest = {
      ...value.manifest,
      components: {
        ...value.manifest.components,
        feishuCardAction: {
          ...value.manifest.components.feishuCardAction,
          manifestDigest: await canonicalSha256(sources.feishuCardAction),
        },
      },
    };
    await expect(verifyRequirementE2EEvidence(
      driftedManifest, sources, options(),
    )).rejects.toMatchObject({ code: 'lineage_mismatch' });
  });

  it('rejects failed component evidence, live Workflow drift and leaked credentials', async () => {
    const value = await fixture();
    const failed = options();
    componentMocks.analysisAction.mockRejectedValueOnce(new Error('external action drift'));
    await expect(verifyRequirementE2EEvidence(
      value.manifest, value.sources, failed,
    )).rejects.toMatchObject({ code: 'analysis_evidence_mismatch' });

    await expect(verifyRequirementE2EEvidence(
      value.manifest, value.sources,
      options(async (input) => String(input).includes('/audit')
        ? auditResponse() : cloudflareResponse({ status: 'running' })),
    )).rejects.toMatchObject({ code: 'workflow_instance_mismatch' });

    await expect(verifyRequirementE2EEvidence(
      value.manifest, value.sources,
      options(async (input) => String(input).includes('/audit')
        ? auditResponse({ runState: 'executing' }) : cloudflareResponse()),
    )).rejects.toMatchObject({ code: 'approval_state_mismatch' });

    await expect(verifyRequirementE2EEvidence(
      value.manifest, value.sources,
      options(async () => new Response(JSON.stringify({ leaked: TOKENS.cloudflare }), {
        status: 200,
      })),
    )).rejects.toMatchObject({ code: 'secret_leak_detected' });
  });

  it('keeps CLI opt-in and incomplete prerequisites distinct from fact failure', () => {
    const run = (environment: NodeJS.ProcessEnv) => spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-requirement-e2e-evidence.ts'],
      { cwd: resolve('.'), env: { ...process.env, ...environment }, encoding: 'utf8' },
    );
    const disabled = run({ DELIVERY_LOOP_REQUIREMENT_E2E: '' });
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain('requirement-e2e: opt-in missing');
    const incomplete = run({ DELIVERY_LOOP_REQUIREMENT_E2E: '1' });
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain('required evidence configuration is incomplete');
    expect(incomplete.stderr).not.toContain(CANARY);
  });
});
