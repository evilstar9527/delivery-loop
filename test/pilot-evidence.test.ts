import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PilotEvidenceManifestV1Schema,
  type PilotEvidenceManifestV1,
} from '../src/domain/pilot-evidence.js';
import {
  verifyPilotEvidence,
  type PilotEvidenceVerificationError,
} from '../src/pilot/pilot-evidence-verifier.js';

const TEST_SHA = 'a'.repeat(40);
const PRODUCTION_SUCCESS_SHA = 'b'.repeat(40);
const PRODUCTION_FAILURE_SHA = 'c'.repeat(40);

const MANIFEST: PilotEvidenceManifestV1 = {
  schemaVersion: '1',
  pilotId: 'pilot-20260726',
  repository: 'example/delivery-pilot',
  recordedAt: '2026-07-26T07:00:00.000Z',
  test: {
    runId: 'run-pilot-test',
    refSha: TEST_SHA,
    deploymentId: 'deployment-pilot-test',
    githubDeploymentId: '101',
    deploymentActionRunId: '1001',
    deploymentEvidenceId: 'evidence-pilot-test-deployment',
    acceptanceId: 'acceptance-pilot-test',
    acceptanceActionRunId: '1002',
    acceptanceEvidenceId: 'evidence-pilot-test-acceptance',
    environmentUrl: 'https://test.demo.example/status',
    oidcAuditUrl: 'https://audit.demo.example/oidc/test',
    productionSecretIsolationEvidenceUrl: 'https://audit.demo.example/isolation/test',
  },
  productionDemo: {
    environment: 'production',
    isolationEvidenceUrl: 'https://audit.demo.example/isolation/production',
    reviewerEvidenceUrl: 'https://github.com/example/delivery-pilot/deployments/activity_log',
    success: {
      runId: 'run-pilot-production-success',
      refSha: PRODUCTION_SUCCESS_SHA,
      deploymentId: 'deployment-pilot-production-success',
      githubDeploymentId: '201',
      actionRunId: '2001',
      approvalId: 'approval-pilot-production-success',
      deploymentEvidenceId: 'evidence-pilot-production-success',
      environmentUrl: 'https://production-demo.example/releases/success',
    },
    failure: {
      runId: 'run-pilot-production-failure',
      refSha: PRODUCTION_FAILURE_SHA,
      deploymentId: 'deployment-pilot-production-failure',
      githubDeploymentId: '202',
      actionRunId: '2002',
      approvalId: 'approval-pilot-production-failure',
      deploymentEvidenceId: 'evidence-pilot-production-failure',
      externalState: 'failure',
      environmentUrl: 'https://production-demo.example/releases/failure',
    },
    rollback: {
      mode: 'manual',
      failedRefSha: PRODUCTION_FAILURE_SHA,
      restoredRefSha: PRODUCTION_SUCCESS_SHA,
      actionRunId: '2003',
      auditUrl: 'https://audit.demo.example/rollback/production',
      environmentResultUrl: 'https://production-demo.example/releases/restored',
    },
  },
};

function action(runId: string, sha: string, conclusion: 'success' | 'failure') {
  return {
    id: Number(runId),
    status: 'completed',
    conclusion,
    head_sha: sha,
    repository: { full_name: MANIFEST.repository },
    html_url: `https://github.com/${MANIFEST.repository}/actions/runs/${runId}`,
  };
}

function deployment(
  id: string,
  sha: string,
  task: 'delivery-loop:test' | 'delivery-loop:production',
  environment: 'test' | 'production',
) {
  return { id: Number(id), sha, task, environment };
}

function controlPlaneRun(kind: 'test' | 'success' | 'failure') {
  if (kind === 'test') {
    return {
      run: {
        id: MANIFEST.test.runId,
        testDeployments: [{
          id: MANIFEST.test.deploymentId,
          status: 'succeeded',
          environment: 'test',
          refSha: MANIFEST.test.refSha,
          githubDeploymentId: MANIFEST.test.githubDeploymentId,
          evidenceId: MANIFEST.test.deploymentEvidenceId,
          url: MANIFEST.test.environmentUrl,
        }],
        testAcceptances: [{
          id: MANIFEST.test.acceptanceId,
          status: 'succeeded',
          refSha: MANIFEST.test.refSha,
          githubRunId: MANIFEST.test.acceptanceActionRunId,
          externalState: 'completed',
          externalConclusion: 'success',
          evidenceId: MANIFEST.test.acceptanceEvidenceId,
        }],
      },
    };
  }
  const record = kind === 'success'
    ? MANIFEST.productionDemo.success
    : MANIFEST.productionDemo.failure;
  return {
    run: {
      id: record.runId,
      productionDeployments: [{
        id: record.deploymentId,
        status: kind === 'success' ? 'succeeded' : 'failed',
        environment: 'production',
        mergeSha: record.refSha,
        externalState: kind === 'success' ? 'success' : 'failure',
        githubDeploymentId: record.githubDeploymentId,
        evidenceId: record.deploymentEvidenceId,
        approvalId: record.approvalId,
        url: record.environmentUrl,
      }],
    },
  };
}

function fakeFetch(rawCanary = ''): typeof fetch {
  const implementation = async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.demo.example') {
      if (url.pathname.includes(MANIFEST.test.runId)) return Response.json(controlPlaneRun('test'));
      if (url.pathname.includes(MANIFEST.productionDemo.success.runId)) {
        return Response.json(controlPlaneRun('success'));
      }
      return Response.json(controlPlaneRun('failure'));
    }
    const actionMatch = url.pathname.match(/\/actions\/runs\/(\d+)$/);
    if (actionMatch !== null) {
      const runId = actionMatch[1]!;
      const table: Record<string, [string, 'success' | 'failure']> = {
        '1001': [TEST_SHA, 'success'],
        '1002': [TEST_SHA, 'success'],
        '2001': [PRODUCTION_SUCCESS_SHA, 'success'],
        '2002': [PRODUCTION_FAILURE_SHA, 'failure'],
        '2003': [PRODUCTION_FAILURE_SHA, 'success'],
      };
      const fact = table[runId];
      if (fact === undefined) return Response.json({ message: rawCanary }, { status: 404 });
      return Response.json(action(runId, fact[0], fact[1]));
    }
    const deploymentMatch = url.pathname.match(/\/deployments\/(\d+)$/);
    if (deploymentMatch !== null) {
      const id = deploymentMatch[1]!;
      if (id === '101') return Response.json(deployment(id, TEST_SHA, 'delivery-loop:test', 'test'));
      if (id === '201') {
        return Response.json(deployment(
          id,
          PRODUCTION_SUCCESS_SHA,
          'delivery-loop:production',
          'production',
        ));
      }
      return Response.json(deployment(
        id,
        PRODUCTION_FAILURE_SHA,
        'delivery-loop:production',
        'production',
      ));
    }
    if (url.pathname.endsWith('/deployments/101/statuses')) {
      return Response.json([{ state: 'success', updated_at: '2026-07-26T06:00:00Z' }]);
    }
    if (url.pathname.endsWith('/deployments/201/statuses')) {
      return Response.json([{ state: 'success', updated_at: '2026-07-26T06:10:00Z' }]);
    }
    if (url.pathname.endsWith('/deployments/202/statuses')) {
      return Response.json([{ state: 'failure', updated_at: '2026-07-26T06:20:00Z' }]);
    }
    return Response.json({ message: rawCanary }, { status: 404 });
  };
  return implementation as typeof fetch;
}

describe('real pilot evidence manifest', () => {
  it('keeps the repository example schema-valid but does not treat it as live evidence', async () => {
    const source = await readFile(
      new URL('../schemas/pilot-evidence-v1.example.json', import.meta.url),
      'utf8',
    );
    expect(PilotEvidenceManifestV1Schema.safeParse(JSON.parse(source)).success).toBe(true);
  });

  it('requires complete test and isolated production success/failure/rollback evidence', () => {
    expect(PilotEvidenceManifestV1Schema.safeParse(MANIFEST).success).toBe(true);
    expect(PilotEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      test: { ...MANIFEST.test, oidcAuditUrl: 'https://user:secret@audit.demo.example/test' },
    }).success).toBe(false);
    expect(PilotEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      productionDemo: {
        ...MANIFEST.productionDemo,
        failure: { ...MANIFEST.productionDemo.failure, runId: MANIFEST.productionDemo.success.runId },
      },
    }).success).toBe(false);
  });

  it('cross-checks GitHub Actions/Deployments and control-plane projections without returning tokens', async () => {
    const summary = await verifyPilotEvidence(MANIFEST, {
      controlPlaneOrigin: 'https://control.demo.example',
      controlPlaneToken: 'CANARY_CONTROL_PLANE_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(),
    });
    expect(summary).toEqual({
      schemaVersion: '1',
      pilotId: MANIFEST.pilotId,
      repository: MANIFEST.repository,
      verifiedRunCount: 3,
      verifiedActionRunCount: 5,
      verifiedDeploymentCount: 3,
      testDeployment: 'succeeded',
      testAcceptance: 'succeeded',
      productionSuccess: 'succeeded',
      productionFailure: 'failed',
      productionRollback: 'recorded',
    });
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('fails closed with a fixed error when a live fact disagrees and never propagates raw API text', async () => {
    const rawCanary = 'CANARY_RAW_PILOT_API_RESPONSE';
    const operation = verifyPilotEvidence(MANIFEST, {
      controlPlaneOrigin: 'https://control.demo.example',
      controlPlaneToken: 'CANARY_CONTROL_PLANE_TOKEN',
      githubToken: 'CANARY_GITHUB_TOKEN',
      githubApiOrigin: 'https://api.github.test',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/deployments/202/statuses')) {
          return Response.json([{ state: 'success', detail: rawCanary }]);
        }
        return await fakeFetch(rawCanary)(input, init);
      },
    });
    await expect(operation).rejects.toMatchObject({
      code: 'github_deployment_status_mismatch',
    } satisfies Partial<PilotEvidenceVerificationError>);
    await expect(operation).rejects.not.toThrow(rawCanary);
  });
});
