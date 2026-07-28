import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProductionDeploymentEvidenceManifestV1Schema } from '../src/domain/production-deployment-evidence.js';
import {
  ProductionDeploymentEvidenceVerificationError,
  verifyProductionDeploymentEvidence,
} from '../src/pilot/production-deployment-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Reuses Watt@476e3cd's explicit opt-in and 0/1/2 exit boundary.
  if (process.env.DELIVERY_LOOP_PRODUCTION_DEPLOYMENT_E2E !== '1') {
    console.error(
      'production-deployment-e2e: opt-in missing (set DELIVERY_LOOP_PRODUCTION_DEPLOYMENT_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('PRODUCTION_DEPLOYMENT_EVIDENCE_FILE');
  const controlPlaneOrigin = env('PRODUCTION_DEPLOYMENT_CONTROL_PLANE_URL');
  const controlPlaneToken = env('PRODUCTION_DEPLOYMENT_CONTROL_PLANE_TOKEN');
  const githubToken = env('PRODUCTION_DEPLOYMENT_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error(
      'production-deployment-e2e: required production deployment configuration is incomplete',
    );
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('production-deployment-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('production-deployment-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('production-deployment-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = ProductionDeploymentEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('production-deployment-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyProductionDeploymentEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(env('PRODUCTION_DEPLOYMENT_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('PRODUCTION_DEPLOYMENT_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof ProductionDeploymentEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`production-deployment-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
