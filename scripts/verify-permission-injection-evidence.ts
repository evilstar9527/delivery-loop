import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AnalysisActionEvidenceManifestV1Schema } from '../src/domain/analysis-action-evidence.js';
import { FeishuCardActionEvidenceManifestV1Schema } from '../src/domain/feishu-card-action-evidence.js';
import { PermissionInjectionEvidenceManifestV1Schema } from '../src/domain/permission-injection-evidence.js';
import { ProductionApprovalEvidenceManifestV1Schema } from '../src/domain/production-approval-evidence.js';
import { SecretSafetyEvidenceManifestV1Schema } from '../src/domain/secret-safety-evidence.js';
import { TaskEnvelopeSchema } from '../src/domain/task.js';
import { TestDeploymentEvidenceManifestV1Schema } from '../src/domain/test-deployment-evidence.js';
import {
  PermissionInjectionEvidenceVerificationError,
  verifyPermissionInjectionEvidence,
} from '../src/pilot/permission-injection-evidence-verifier.js';

const MAX_FILE_BYTES = 64 * 1_024;

class EvidenceReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function jsonFile(path: string): Promise<unknown> {
  let source: string;
  try { source = await readFile(resolve(path), 'utf8'); }
  catch { throw new EvidenceReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_BYTES) {
    throw new EvidenceReadError('invalid');
  }
  try { return JSON.parse(source) as unknown; }
  catch { throw new EvidenceReadError('invalid'); }
}

async function main(): Promise<void> {
  // Watt-derived boundary: explicit opt-in, repository-external 64 KiB files, fixed 0/1/2 exits.
  if (process.env.DELIVERY_LOOP_PERMISSION_INJECTION_E2E !== '1') {
    console.error(
      'permission-injection-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_PERMISSION_INJECTION_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const values = {
    manifestFile: env('PERMISSION_INJECTION_EVIDENCE_FILE'),
    feishuFile: env('PERMISSION_INJECTION_FEISHU_ACTION_FILE'),
    productionFile: env('PERMISSION_INJECTION_PRODUCTION_APPROVAL_FILE'),
    analysisFile: env('PERMISSION_INJECTION_ANALYSIS_ACTION_FILE'),
    deploymentFile: env('PERMISSION_INJECTION_TEST_DEPLOYMENT_FILE'),
    secretFile: env('PERMISSION_INJECTION_SECRET_SAFETY_FILE'),
    taskFile: env('PERMISSION_INJECTION_MALICIOUS_TASK_FILE'),
    controlPlaneOrigin: env('PERMISSION_INJECTION_CONTROL_PLANE_URL'),
    taskToken: env('PERMISSION_INJECTION_TASK_TOKEN'),
    operationsToken: env('PERMISSION_INJECTION_OPERATIONS_TOKEN'),
    githubAppJwt: env('PERMISSION_INJECTION_GITHUB_APP_JWT'),
    githubInstallationAuditToken: env('PERMISSION_INJECTION_INSTALLATION_AUDIT_TOKEN'),
    githubTargetReadToken: env('PERMISSION_INJECTION_TARGET_GITHUB_TOKEN'),
    githubProbeReadToken: env('PERMISSION_INJECTION_PROBE_GITHUB_TOKEN'),
    feishuObservabilityReportUrl: env('PERMISSION_INJECTION_FEISHU_OBSERVABILITY_URL'),
    feishuObservabilityToken: env('PERMISSION_INJECTION_FEISHU_OBSERVABILITY_TOKEN'),
    expectedAnalysisRunnerContractDigest: env('PERMISSION_INJECTION_ANALYSIS_RUNNER_CONTRACT_DIGEST'),
    expectedOidcProbeContractDigest: env('PERMISSION_INJECTION_OIDC_PROBE_CONTRACT_DIGEST'),
    canary: env('PERMISSION_INJECTION_SECURITY_CANARY'),
  };
  if (Object.values(values).some((value) => value === '')) {
    console.error('permission-injection-e2e: required security configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let raw: unknown[];
  try {
    raw = await Promise.all([
      jsonFile(values.manifestFile),
      jsonFile(values.feishuFile),
      jsonFile(values.productionFile),
      jsonFile(values.analysisFile),
      jsonFile(values.deploymentFile),
      jsonFile(values.secretFile),
      jsonFile(values.taskFile),
    ]);
  } catch (error) {
    const kind = error instanceof EvidenceReadError ? error.kind : 'invalid';
    console.error(`permission-injection-e2e: evidence input is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const [manifest, feishu, production, analysis, deployment, secret, task] = [
    PermissionInjectionEvidenceManifestV1Schema.safeParse(raw[0]),
    FeishuCardActionEvidenceManifestV1Schema.safeParse(raw[1]),
    ProductionApprovalEvidenceManifestV1Schema.safeParse(raw[2]),
    AnalysisActionEvidenceManifestV1Schema.safeParse(raw[3]),
    TestDeploymentEvidenceManifestV1Schema.safeParse(raw[4]),
    SecretSafetyEvidenceManifestV1Schema.safeParse(raw[5]),
    TaskEnvelopeSchema.safeParse(raw[6]),
  ];
  if ([manifest, feishu, production, analysis, deployment, secret, task]
    .some((item) => !item.success)) {
    console.error('permission-injection-e2e: evidence input is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyPermissionInjectionEvidence(
      manifest.data!,
      {
        feishuCardAction: feishu.data!,
        productionApproval: production.data!,
        analysisAction: analysis.data!,
        testDeployment: deployment.data!,
        secretSafety: secret.data!,
        maliciousTask: task.data!,
      },
      {
        controlPlaneOrigin: values.controlPlaneOrigin,
        taskToken: values.taskToken,
        operationsToken: values.operationsToken,
        githubAppJwt: values.githubAppJwt,
        githubInstallationAuditToken: values.githubInstallationAuditToken,
        githubTargetReadToken: values.githubTargetReadToken,
        githubProbeReadToken: values.githubProbeReadToken,
        feishuObservabilityReportUrl: values.feishuObservabilityReportUrl,
        feishuObservabilityToken: values.feishuObservabilityToken,
        expectedAnalysisRunnerContractDigest: values.expectedAnalysisRunnerContractDigest,
        expectedOidcProbeContractDigest: values.expectedOidcProbeContractDigest,
        canary: values.canary,
        ...(env('PERMISSION_INJECTION_GITHUB_API_URL') === ''
          ? {} : { githubApiOrigin: env('PERMISSION_INJECTION_GITHUB_API_URL') }),
      },
    );
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof PermissionInjectionEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`permission-injection-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
