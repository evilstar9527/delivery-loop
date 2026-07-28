import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FeishuCardCompletionEvidenceManifestV1Schema } from '../src/domain/feishu-card-completion-evidence.js';
import { MergeDeploymentE2EEvidenceManifestV1Schema } from '../src/domain/merge-deployment-e2e-evidence.js';
import { MergeEvidenceManifestV1Schema } from '../src/domain/merge-evidence.js';
import { MergeGateEvidenceManifestV1Schema } from '../src/domain/merge-gate-evidence.js';
import { ProductionApprovalEvidenceManifestV1Schema } from '../src/domain/production-approval-evidence.js';
import { ProductionDeploymentEvidenceManifestV1Schema } from '../src/domain/production-deployment-evidence.js';
import { TestAcceptanceEvidenceManifestV1Schema } from '../src/domain/test-acceptance-evidence.js';
import { TestDeploymentEvidenceManifestV1Schema } from '../src/domain/test-deployment-evidence.js';
import {
  MergeDeploymentE2EEvidenceVerificationError,
  verifyMergeDeploymentE2EEvidence,
} from '../src/pilot/merge-deployment-e2e-evidence-verifier.js';

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
  if (process.env.DELIVERY_LOOP_MERGE_DEPLOYMENT_E2E !== '1') {
    console.error(
      'merge-deployment-e2e: opt-in missing (set DELIVERY_LOOP_MERGE_DEPLOYMENT_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const values = {
    manifestFile: env('MERGE_DEPLOYMENT_EVIDENCE_FILE'),
    testGateFile: env('MERGE_DEPLOYMENT_TEST_GATE_FILE'),
    productionGateFile: env('MERGE_DEPLOYMENT_PRODUCTION_GATE_FILE'),
    mergeFile: env('MERGE_DEPLOYMENT_MERGE_FILE'),
    testDeploymentFile: env('MERGE_DEPLOYMENT_TEST_DEPLOYMENT_FILE'),
    testAcceptanceFile: env('MERGE_DEPLOYMENT_TEST_ACCEPTANCE_FILE'),
    productionApprovalFile: env('MERGE_DEPLOYMENT_PRODUCTION_APPROVAL_FILE'),
    productionDeploymentFile: env('MERGE_DEPLOYMENT_PRODUCTION_DEPLOYMENT_FILE'),
    completionFile: env('MERGE_DEPLOYMENT_FEISHU_COMPLETION_FILE'),
    controlPlaneOrigin: env('MERGE_DEPLOYMENT_CONTROL_PLANE_URL'),
    operationsToken: env('MERGE_DEPLOYMENT_OPERATIONS_TOKEN'),
    githubToken: env('MERGE_DEPLOYMENT_GITHUB_TOKEN'),
    feishuAccessToken: env('MERGE_DEPLOYMENT_FEISHU_ACCESS_TOKEN'),
    canary: env('MERGE_DEPLOYMENT_SECURITY_CANARY'),
  };
  if (Object.values(values).some((value) => value === '')) {
    console.error('merge-deployment-e2e: required external configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let raw: unknown[];
  try {
    raw = await Promise.all([
      jsonFile(values.manifestFile), jsonFile(values.testGateFile),
      jsonFile(values.productionGateFile), jsonFile(values.mergeFile),
      jsonFile(values.testDeploymentFile), jsonFile(values.testAcceptanceFile),
      jsonFile(values.productionApprovalFile), jsonFile(values.productionDeploymentFile),
      jsonFile(values.completionFile),
    ]);
  } catch (error) {
    const kind = error instanceof EvidenceReadError ? error.kind : 'invalid';
    console.error(`merge-deployment-e2e: evidence input is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const manifest = MergeDeploymentE2EEvidenceManifestV1Schema.safeParse(raw[0]);
  const testGate = MergeGateEvidenceManifestV1Schema.safeParse(raw[1]);
  const productionGate = MergeGateEvidenceManifestV1Schema.safeParse(raw[2]);
  const merge = MergeEvidenceManifestV1Schema.safeParse(raw[3]);
  const testDeployment = TestDeploymentEvidenceManifestV1Schema.safeParse(raw[4]);
  const testAcceptance = TestAcceptanceEvidenceManifestV1Schema.safeParse(raw[5]);
  const productionApproval = ProductionApprovalEvidenceManifestV1Schema.safeParse(raw[6]);
  const productionDeployment = ProductionDeploymentEvidenceManifestV1Schema.safeParse(raw[7]);
  const completion = FeishuCardCompletionEvidenceManifestV1Schema.safeParse(raw[8]);
  if ([
    manifest, testGate, productionGate, merge, testDeployment, testAcceptance,
    productionApproval, productionDeployment, completion,
  ].some((item) => !item.success)) {
    console.error('merge-deployment-e2e: evidence input is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyMergeDeploymentE2EEvidence(
      manifest.data!,
      {
        testMergeGate: testGate.data!,
        productionMergeGate: productionGate.data!,
        merge: merge.data!,
        testDeployment: testDeployment.data!,
        testAcceptance: testAcceptance.data!,
        productionApproval: productionApproval.data!,
        productionDeployment: productionDeployment.data!,
        feishuCompletion: completion.data!,
      },
      {
        controlPlaneOrigin: values.controlPlaneOrigin,
        operationsToken: values.operationsToken,
        githubToken: values.githubToken,
        feishuAccessToken: values.feishuAccessToken,
        canary: values.canary,
        ...(env('MERGE_DEPLOYMENT_GITHUB_API_URL') === ''
          ? {} : { githubApiOrigin: env('MERGE_DEPLOYMENT_GITHUB_API_URL') }),
        ...(env('MERGE_DEPLOYMENT_FEISHU_API_URL') === ''
          ? {} : { feishuApiOrigin: env('MERGE_DEPLOYMENT_FEISHU_API_URL') }),
      },
    );
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof MergeDeploymentE2EEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`merge-deployment-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
