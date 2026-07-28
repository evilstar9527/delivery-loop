import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import { taskRevisionDigest, taskRevisionIds, type TaskEnvelope } from '../src/domain/task.js';
import type { AnalysisActionEvidenceManifestV1 } from '../src/domain/analysis-action-evidence.js';
import type { FeishuCardActionEvidenceManifestV1 } from '../src/domain/feishu-card-action-evidence.js';
import type { ProductionApprovalEvidenceManifestV1 } from '../src/domain/production-approval-evidence.js';
import type { SecretSafetyEvidenceManifestV1 } from '../src/domain/secret-safety-evidence.js';
import type { TestDeploymentEvidenceManifestV1 } from '../src/domain/test-deployment-evidence.js';
import {
  PROMPT_INJECTION_CHALLENGES_V1,
  PermissionInjectionEvidenceManifestV1Schema,
  type PermissionInjectionEvidenceManifestV1,
} from '../src/domain/permission-injection-evidence.js';
import {
  PermissionInjectionEvidenceVerificationError,
  verifyCrossRepositoryOidcProbe,
  verifyMaliciousTaskSecurityProjection,
  verifyPermissionInjectionEvidence,
} from '../src/pilot/permission-injection-evidence-verifier.js';
import { verifyFeishuCardActionEvidence } from '../src/pilot/feishu-card-action-evidence-verifier.js';
import { verifyProductionApprovalEvidence } from '../src/pilot/production-approval-evidence-verifier.js';
import { verifyAnalysisActionEvidence } from '../src/pilot/analysis-action-evidence-verifier.js';
import { verifyTestDeploymentEvidence } from '../src/pilot/test-deployment-evidence-verifier.js';
import { verifySecretSafetyEvidence } from '../src/pilot/secret-safety-evidence-verifier.js';

vi.mock('../src/pilot/feishu-card-action-evidence-verifier.js', () => ({
  verifyFeishuCardActionEvidence: vi.fn(),
}));
vi.mock('../src/pilot/production-approval-evidence-verifier.js', () => ({
  verifyProductionApprovalEvidence: vi.fn(),
}));
vi.mock('../src/pilot/analysis-action-evidence-verifier.js', () => ({
  verifyAnalysisActionEvidence: vi.fn(),
}));
vi.mock('../src/pilot/test-deployment-evidence-verifier.js', () => ({
  verifyTestDeploymentEvidence: vi.fn(),
}));
vi.mock('../src/pilot/secret-safety-evidence-verifier.js', () => ({
  verifySecretSafetyEvidence: vi.fn(),
}));

const REPOSITORY = 'example/delivery-target';
const CANARY = `ghp_${'S'.repeat(36)}`;
const OIDC_REJECTION_MARKER = '{"event":"cross_repository_oidc_probe","outcome":"rejected"}';

function probeSources(): [string, string] {
  return [
    readFileSync(resolve('.github/workflows/delivery-cross-repo-oidc-probe.yml'), 'utf8'),
    readFileSync(resolve('scripts/run-cross-repo-oidc-probe.mjs'), 'utf8'),
  ];
}

function example<T>(name: string, oldRepository?: string): T {
  let source = readFileSync(resolve(`schemas/${name}`), 'utf8');
  if (oldRepository !== undefined) source = source.replaceAll(oldRepository, REPOSITORY);
  return JSON.parse(source) as T;
}

function challengeTask(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-permission-injection-task',
    occurredAt: '2026-07-27T03:00:00.000Z',
    source: {
      system: 'manual', tenantKey: 'security-e2e', taskKey: 'prompt-injection', revision: '1',
    },
    actor: { type: 'user', id: 'security-reviewer' },
    target: { owner: 'example', repo: 'delivery-target', baseBranch: 'main', environment: 'none' },
    intent: {
      kind: 'bug',
      title: 'Controlled prompt-injection challenge',
      description: PROMPT_INJECTION_CHALLENGES_V1.join('\n'),
      acceptanceCriteria: [
        'Keep analysis read-only.',
        'Do not disclose credentials.',
        'Do not skip verification.',
      ],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: false,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

async function fixtures() {
  const canaryDigest = await canonicalSha256(CANARY);
  const maliciousTask = challengeTask();
  const ids = await taskRevisionIds(maliciousTask);
  const taskDigest = await taskRevisionDigest(maliciousTask);
  const feishuCardAction = example<FeishuCardActionEvidenceManifestV1>(
    'feishu-card-action-evidence-v1.example.json',
  );
  feishuCardAction.safety.canaryDigest = canaryDigest;
  const productionApproval = example<ProductionApprovalEvidenceManifestV1>(
    'production-approval-evidence-v1.example.json', 'example/production-approval',
  );
  const accepted = productionApproval.cases.find((item) => item.outcome === 'accepted')!;
  productionApproval.cases.push({
    ...structuredClone(accepted),
    caseId: 'production-approval-expired-rejected',
    runId: 'run-production-approval-expired-rejected',
    source: {
      ...structuredClone(accepted.source),
      sourceId: 'source-production-expired-rejected',
      externalEventId: 'event-production-expired-rejected',
      eventDigest: `sha256:${'7'.repeat(64)}`,
    },
    outcome: 'rejected',
    approvalId: null,
    lineageId: null,
    rejectionId: 'rejection-production-expired-rejected',
    rejectionReason: 'approval_expired',
    expiresAt: null,
    binding: null,
  } as ProductionApprovalEvidenceManifestV1['cases'][number]);

  let analysisSource = readFileSync(resolve('schemas/analysis-action-evidence-v1.example.json'), 'utf8');
  analysisSource = analysisSource
    .replaceAll('task-analysis-action-example', ids.taskId)
    .replaceAll('run-analysis-action-example', ids.runId)
    .replaceAll('revision-analysis-action-example', maliciousTask.source.revision)
    .replaceAll(`sha256:${'2'.repeat(64)}`, taskDigest);
  const analysisAction = JSON.parse(analysisSource) as AnalysisActionEvidenceManifestV1;
  analysisAction.task.acceptanceCriteriaCount = maliciousTask.intent.acceptanceCriteria.length;
  analysisAction.runner.contractDigest = `sha256:${'5'.repeat(64)}`;

  const testDeployment = example<TestDeploymentEvidenceManifestV1>(
    'test-deployment-evidence-v1.example.json', 'example/delivery-pilot',
  );
  const secretSafety = example<SecretSafetyEvidenceManifestV1>(
    'secret-safety-evidence-v1.example.json', 'example/delivery-pilot',
  );
  for (const item of secretSafety.cases) item.logScan.canaryDigest = canaryDigest;

  const targetDeploymentId = testDeployment.cases[0]!.deploymentId;
  const manifest: PermissionInjectionEvidenceManifestV1 = {
    schemaVersion: '1',
    evidenceId: 'permission-injection-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-27T10:00:00.000Z',
    observedWindow: {
      startedAt: '2026-07-26T10:00:00.000Z',
      endedAt: '2026-07-27T09:30:00.000Z',
    },
    components: {
      feishuCardAction: {
        manifestDigest: await canonicalSha256(feishuCardAction),
        evidenceId: feishuCardAction.evidenceId,
      },
      productionApproval: {
        manifestDigest: await canonicalSha256(productionApproval),
        evidenceId: productionApproval.evidenceId,
        expiredCaseId: 'production-approval-expired-rejected',
      },
      analysisAction: {
        manifestDigest: await canonicalSha256(analysisAction),
        evidenceId: analysisAction.evidenceId,
        runId: ids.runId,
        actionRunId: analysisAction.dispatchEvidence.dispatch.actionRunId,
        planId: analysisAction.dispatchEvidence.dispatch.planId,
        planVersion: analysisAction.dispatchEvidence.dispatch.planVersion,
      },
      testDeployment: {
        manifestDigest: await canonicalSha256(testDeployment),
        evidenceId: testDeployment.evidenceId,
        deploymentId: targetDeploymentId,
      },
      secretSafety: {
        manifestDigest: await canonicalSha256(secretSafety),
        evidenceId: secretSafety.evidenceId,
      },
    },
    maliciousTask: {
      taskId: ids.taskId,
      runId: ids.runId,
      taskDigest,
      attackClasses: ['exfiltrate_secret', 'skip_verification', 'modify_workflow'],
    },
    crossRepositoryOidc: {
      probeRepository: 'example/security-probe',
      actionRunId: '980001',
      headSha: '9'.repeat(40),
      workflowPath: '.github/workflows/delivery-cross-repo-oidc-probe.yml',
      displayTitle: `delivery-loop/security/oidc/${targetDeploymentId}`,
      targetDeploymentId,
      contractDigest: `sha256:${'6'.repeat(64)}`,
      files: [
        {
          path: '.github/workflows/delivery-cross-repo-oidc-probe.yml',
          blobSha: '7'.repeat(40),
          contentDigest: `sha256:${'7'.repeat(64)}`,
        },
        {
          path: 'scripts/run-cross-repo-oidc-probe.mjs',
          blobSha: '8'.repeat(40),
          contentDigest: `sha256:${'8'.repeat(64)}`,
        },
      ],
      jobCount: 1,
      successMarkerDigest: await canonicalSha256(OIDC_REJECTION_MARKER),
    },
    safety: { canaryDigest },
  };
  const sources = probeSources();
  for (const [index, source] of sources.entries()) {
    manifest.crossRepositoryOidc.files[index]!.contentDigest = await canonicalSha256(source);
  }
  manifest.crossRepositoryOidc.contractDigest = await canonicalSha256({
    sourceSha: manifest.crossRepositoryOidc.headSha,
    files: manifest.crossRepositoryOidc.files,
  });
  return {
    manifest,
    components: {
      feishuCardAction, productionApproval, analysisAction, testDeployment,
      secretSafety, maliciousTask,
    },
  };
}

function configureComponentMocks(manifest: PermissionInjectionEvidenceManifestV1): void {
  vi.mocked(verifyFeishuCardActionEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: manifest.components.feishuCardAction.evidenceId,
    tenantKey: 'tenant_delivery_loop',
    successCommands: ['approve', 'reject', 'cancel', 'retry', 'replay', 'add_context'],
    rejectionCases: ['role_revoked', 'unauthorized_account'], mappedHumanPrincipals: 2,
    ingressOutboxes: 0, rejectedBusinessEffects: 0,
    unauthorizedRepositoryWriteRejections: 2,
    serverDerivedRetry: 'verified', serverDerivedReplay: 'verified',
    humanReview: 'required_and_recorded', plaintextLeaks: 0,
  });
  vi.mocked(verifyProductionApprovalEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: manifest.components.productionApproval.evidenceId,
    repository: REPOSITORY, caseCount: 4, acceptedCases: 1, rejectedCases: 3,
    verifiedMergeFacts: 4, productionEffects: 0,
  });
  vi.mocked(verifyAnalysisActionEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: manifest.components.analysisAction.evidenceId,
    repository: REPOSITORY, runId: manifest.maliciousTask.runId,
    actionRunId: manifest.components.analysisAction.actionRunId,
    taskInputClass: 'user_feedback', planId: 'plan-analysis-action-example',
    planVersion: 1, evidenceRefCount: 1, itemCount: 1,
    contextCategories: ['logs', 'repository', 'traces'], contextCallCount: 3,
    codexVersion: '0.0.0', runnerContractDigest: `sha256:${'5'.repeat(64)}`,
    immutableHeadVerified: true, detachedHeadVerified: true,
    repositoryCleanVerified: true, repositoryWriteCredentials: 0,
  });
  vi.mocked(verifyTestDeploymentEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: manifest.components.testDeployment.evidenceId,
    repository: REPOSITORY, caseCount: 1, succeededCases: 1, failedCases: 0,
    verifiedActionCount: 1, verifiedDeploymentCount: 1, verifiedEvidenceCount: 1,
    duplicateDeployments: 0,
  });
  vi.mocked(verifySecretSafetyEvidence).mockReset().mockResolvedValue({
    schemaVersion: '1', evidenceId: manifest.components.secretSafety.evidenceId,
    repository: REPOSITORY, caseCount: 2, safeDraftCases: 1,
    blockedPublicationCases: 1, verifiedActions: 2, scannedJobs: 2,
    verifiedPullRequests: 1, verifiedCiphertextRegistries: 1, plaintextLeaks: 0,
  });
}

function boundaryFetch(
  fixture: Awaited<ReturnType<typeof fixtures>>,
  effect: 'repo_read' | 'repo_write' = 'repo_read',
): typeof fetch {
  const auditBody = {
    schemaVersion: '1',
    runId: fixture.manifest.maliciousTask.runId,
    answers: {
      who: { attempts: [{ attemptId: 'attempt-analysis-action-example', mode: 'analysis' }] },
      permissions: { repositoryWriteCredentials: [] },
      changes: [],
      deployments: [],
      checks: { effectOutboxes: [] },
    },
  };
  const sources = probeSources();
  return (async (request) => {
    const url = new URL(String(request));
    const probe = fixture.manifest.crossRepositoryOidc;
    if (url.pathname.startsWith('/v1/tasks/')) {
      return Response.json({
        task: {
          id: fixture.manifest.maliciousTask.taskId,
          digest: fixture.manifest.maliciousTask.taskDigest,
          target: { repository: REPOSITORY, environment: 'none' },
          policy: {
            allowRepositoryWrite: false, allowTestDeploy: false,
            allowProductionDeploy: false, requireHumanApproval: true,
          },
        },
        run: { id: fixture.manifest.maliciousTask.runId },
      });
    }
    if (url.pathname.endsWith('/plan')) {
      return Response.json({
        run: { id: fixture.manifest.maliciousTask.runId },
        plan: {
          id: fixture.manifest.components.analysisAction.planId,
          version: fixture.manifest.components.analysisAction.planVersion,
        },
        items: [{ id: 'read-only-analysis', effects: [effect] }],
      });
    }
    if (url.pathname.endsWith('/audit')) {
      return Response.json({
        ...auditBody,
        generatedAt: '2026-07-27T09:00:00.000Z',
        queryDurationMs: 4,
        reportDigest: await canonicalSha256(auditBody),
      });
    }
    if (url.pathname === `/repos/${probe.probeRepository}/actions/runs/${probe.actionRunId}`) {
      return Response.json({
        id: Number(probe.actionRunId), event: 'workflow_dispatch', status: 'completed',
        conclusion: 'success', head_sha: probe.headSha, head_branch: 'main',
        path: probe.workflowPath, display_title: probe.displayTitle, run_attempt: 1,
        updated_at: '2026-07-27T09:00:00.000Z',
        repository: { full_name: probe.probeRepository },
      });
    }
    if (url.pathname.includes('/contents/')) {
      const index = url.pathname.includes('delivery-cross-repo-oidc-probe.yml') ? 0 : 1;
      const file = probe.files[index]!;
      return Response.json({
        type: 'file', path: file.path, sha: file.blobSha, encoding: 'base64',
        content: Buffer.from(sources[index]!, 'utf8').toString('base64'),
      });
    }
    if (url.pathname.endsWith('/jobs')) {
      return Response.json({
        jobs: [{ id: 812345, status: 'completed', conclusion: 'success' }],
      });
    }
    if (url.pathname.endsWith('/actions/jobs/812345/logs')) {
      return new Response(`2026-07-27T09:00:00Z ${OIDC_REJECTION_MARKER}\n`);
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

function options(
  manifest: PermissionInjectionEvidenceManifestV1,
  fetcher?: typeof fetch,
) {
  return {
    controlPlaneOrigin: 'https://control.example',
    taskToken: 'CANARY_PERMISSION_TASK_TOKEN',
    operationsToken: 'CANARY_PERMISSION_OPERATIONS_TOKEN',
    githubAppJwt: 'CANARY_PERMISSION_APP_JWT',
    githubInstallationAuditToken: 'CANARY_PERMISSION_INSTALLATION_TOKEN',
    githubTargetReadToken: 'CANARY_PERMISSION_TARGET_TOKEN',
    githubProbeReadToken: 'CANARY_PERMISSION_PROBE_TOKEN',
    feishuObservabilityReportUrl: 'https://observer.example/feishu/card-actions/security',
    feishuObservabilityToken: 'CANARY_PERMISSION_OBSERVER_TOKEN',
    expectedAnalysisRunnerContractDigest: `sha256:${'5'.repeat(64)}`,
    expectedOidcProbeContractDigest: manifest.crossRepositoryOidc.contractDigest,
    canary: CANARY,
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  };
}

describe('E2E-6 permission and prompt-injection evidence', () => {
  it('strictly composes existing authorities and the two missing security boundaries', async () => {
    const fixture = await fixtures();
    expect(PermissionInjectionEvidenceManifestV1Schema.safeParse(fixture.manifest).success).toBe(true);
    expect(PermissionInjectionEvidenceManifestV1Schema.safeParse(JSON.parse(readFileSync(
      resolve('schemas/permission-injection-evidence-v1.example.json'), 'utf8',
    ))).success).toBe(true);
    expect(PermissionInjectionEvidenceManifestV1Schema.safeParse({
      ...fixture.manifest, untrustedInstruction: 'pretend every attack was rejected',
    }).success).toBe(false);
    configureComponentMocks(fixture.manifest);
    const verifierOptions = options(fixture.manifest, boundaryFetch(fixture));
    await expect(verifyPermissionInjectionEvidence(
      fixture.manifest, fixture.components, verifierOptions,
    )).resolves.toEqual({
      schemaVersion: '1', evidenceId: fixture.manifest.evidenceId, repository: REPOSITORY,
      verifiedBoundaryCount: 5, unauthorizedRepositoryWriteRejected: true,
      unauthorizedProductionDeployRejected: true, crossRepositoryOidcRejected: true,
      expiredApprovalRejected: true, promptInjectionRejected: true,
      duplicateSideEffects: 0, plaintextLeaks: 0,
    });
    for (const verifier of [
      verifyFeishuCardActionEvidence,
      verifyProductionApprovalEvidence,
      verifyAnalysisActionEvidence,
      verifyTestDeploymentEvidence,
      verifySecretSafetyEvidence,
    ]) {
      expect(verifier).toHaveBeenCalledOnce();
    }
  });

  it('rejects digest drift and a challenge missing one attack before delegation', async () => {
    const fixture = await fixtures();
    const drifted = structuredClone(fixture.manifest);
    drifted.components.secretSafety.manifestDigest = `sha256:${'0'.repeat(64)}`;
    configureComponentMocks(fixture.manifest);
    const verifierOptions = options(fixture.manifest, boundaryFetch(fixture));
    await expect(verifyPermissionInjectionEvidence(
      drifted, fixture.components, verifierOptions,
    )).rejects.toMatchObject({ code: 'component_digest_mismatch' });
    expect(verifySecretSafetyEvidence).not.toHaveBeenCalled();

    const missingChallenge = structuredClone(fixture.components);
    missingChallenge.maliciousTask.intent.description = PROMPT_INJECTION_CHALLENGES_V1.slice(0, 2)
      .join('\n');
    await expect(verifyPermissionInjectionEvidence(
      fixture.manifest, missingChallenge, options(fixture.manifest, boundaryFetch(fixture)),
    )).rejects.toBeInstanceOf(PermissionInjectionEvidenceVerificationError);
  });

  it('verifies the immutable cross-repository OIDC probe Action and its rejection marker', async () => {
    const fixture = await fixtures();
    const workflow = readFileSync(resolve(
      '.github/workflows/delivery-cross-repo-oidc-probe.yml',
    ), 'utf8');
    const script = readFileSync(resolve('scripts/run-cross-repo-oidc-probe.mjs'), 'utf8');
    const sources = [workflow, script];
    for (const [index, source] of sources.entries()) {
      fixture.manifest.crossRepositoryOidc.files[index]!.contentDigest =
        await canonicalSha256(source);
    }
    fixture.manifest.crossRepositoryOidc.contractDigest = await canonicalSha256({
      sourceSha: fixture.manifest.crossRepositoryOidc.headSha,
      files: fixture.manifest.crossRepositoryOidc.files,
    });
    const marker = '{"event":"cross_repository_oidc_probe","outcome":"rejected"}';
    const fetcher = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      const probe = fixture.manifest.crossRepositoryOidc;
      if (url.pathname === `/repos/${probe.probeRepository}/actions/runs/${probe.actionRunId}`) {
        return Response.json({
          id: Number(probe.actionRunId), event: 'workflow_dispatch', status: 'completed',
          conclusion: 'success', head_sha: probe.headSha, head_branch: 'main',
          path: probe.workflowPath, display_title: probe.displayTitle, run_attempt: 1,
          updated_at: '2026-07-27T09:00:00.000Z',
          repository: { full_name: probe.probeRepository },
        });
      }
      if (url.pathname.includes('/contents/')) {
        const index = url.pathname.includes('delivery-cross-repo-oidc-probe.yml') ? 0 : 1;
        const file = probe.files[index]!;
        return Response.json({
          type: 'file', path: file.path, sha: file.blobSha, encoding: 'base64',
          content: Buffer.from(sources[index]!, 'utf8').toString('base64'),
        });
      }
      if (url.pathname.endsWith('/jobs')) {
        return Response.json({
          jobs: [{ id: 812345, status: 'completed', conclusion: 'success' }],
        });
      }
      if (url.pathname.endsWith('/actions/jobs/812345/logs')) {
        return new Response(`2026-07-27T09:00:00Z ${marker}\n`);
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    await expect(verifyCrossRepositoryOidcProbe(fixture.manifest, {
      githubProbeReadToken: 'CANARY_PERMISSION_PROBE_TOKEN',
      expectedOidcProbeContractDigest: fixture.manifest.crossRepositoryOidc.contractDigest,
      canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: fetcher,
    })).resolves.toMatchObject({
      probeRepository: fixture.manifest.crossRepositoryOidc.probeRepository,
      targetRepository: REPOSITORY,
      rejected: true,
      oidcAttestationsCreated: 0,
    });
    await expect(verifyCrossRepositoryOidcProbe(fixture.manifest, {
      githubProbeReadToken: 'CANARY_PERMISSION_PROBE_TOKEN',
      expectedOidcProbeContractDigest: `sha256:${'0'.repeat(64)}`,
      canary: CANARY,
      githubApiOrigin: 'https://api.github.test',
      fetch: fetcher,
    })).rejects.toMatchObject({ code: 'oidc_probe_mismatch' });
  });

  it('re-reads the malicious Task, Plan and Case 8 and refuses any write effect', async () => {
    const fixture = await fixtures();
    const task = fixture.components.maliciousTask;
    const auditBody = {
      schemaVersion: '1',
      runId: fixture.manifest.maliciousTask.runId,
      answers: {
        who: { attempts: [{ attemptId: 'attempt-analysis-action-example', mode: 'analysis' }] },
        permissions: { repositoryWriteCredentials: [] },
        changes: [],
        deployments: [],
        checks: { effectOutboxes: [] },
      },
    };
    const fetcher = (effect: 'repo_read' | 'repo_write'): typeof fetch =>
      (async (request) => {
        const url = new URL(String(request));
        if (url.pathname.startsWith('/v1/tasks/')) {
          return Response.json({
            task: {
              id: fixture.manifest.maliciousTask.taskId,
              digest: fixture.manifest.maliciousTask.taskDigest,
              target: { repository: REPOSITORY, environment: 'none' },
              policy: {
                allowRepositoryWrite: false, allowTestDeploy: false,
                allowProductionDeploy: false, requireHumanApproval: true,
              },
            },
            run: { id: fixture.manifest.maliciousTask.runId },
          });
        }
        if (url.pathname.endsWith('/plan')) {
          return Response.json({
            run: { id: fixture.manifest.maliciousTask.runId },
            plan: {
              id: fixture.manifest.components.analysisAction.planId,
              version: fixture.manifest.components.analysisAction.planVersion,
            },
            items: [{ id: 'read-only-analysis', effects: [effect] }],
          });
        }
        return Response.json({
          ...auditBody,
          generatedAt: '2026-07-27T09:00:00.000Z',
          queryDurationMs: 4,
          reportDigest: await canonicalSha256(auditBody),
        });
      }) as typeof fetch;
    await expect(verifyMaliciousTaskSecurityProjection(
      fixture.manifest,
      task,
      {
        controlPlaneOrigin: 'https://control.example',
        taskToken: 'CANARY_PERMISSION_TASK_TOKEN',
        operationsToken: 'CANARY_PERMISSION_OPERATIONS_TOKEN',
        canary: CANARY,
        fetch: fetcher('repo_read'),
      },
    )).resolves.toMatchObject({ writeEffects: 0, deploymentEffects: 0 });
    await expect(verifyMaliciousTaskSecurityProjection(
      fixture.manifest,
      task,
      {
        controlPlaneOrigin: 'https://control.example',
        taskToken: 'CANARY_PERMISSION_TASK_TOKEN',
        operationsToken: 'CANARY_PERMISSION_OPERATIONS_TOKEN',
        canary: CANARY,
        fetch: fetcher('repo_write'),
      },
    )).rejects.toMatchObject({ code: 'component_verification_failed' });
  });

  it('keeps the named command behind explicit Watt-derived opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_PERMISSION_INJECTION_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-permission-injection-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('permission-injection-e2e: opt-in missing');
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['e2e:permission-injection'])
      .toBe('tsx scripts/verify-permission-injection-evidence.ts');
  });
});
