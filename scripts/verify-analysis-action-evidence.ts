import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AnalysisActionEvidenceManifestV1Schema } from
  '../src/domain/analysis-action-evidence.js';
import {
  AnalysisActionEvidenceVerificationError,
  verifyAnalysisActionEvidence,
} from '../src/pilot/analysis-action-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_ANALYSIS_ACTION_E2E !== '1') {
    console.error(
      'analysis-action-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_ANALYSIS_ACTION_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('ANALYSIS_ACTION_EVIDENCE_FILE');
  const controlPlaneOrigin = env('ANALYSIS_ACTION_CONTROL_PLANE_URL');
  const controlPlaneToken = env('ANALYSIS_ACTION_CONTROL_PLANE_TOKEN');
  const operationsToken = env('ANALYSIS_ACTION_OPERATIONS_TOKEN');
  const githubAppJwt = env('ANALYSIS_ACTION_APP_JWT');
  const githubInstallationToken = env('ANALYSIS_ACTION_INSTALLATION_AUDIT_TOKEN');
  const expectedRunnerContractDigest = env('ANALYSIS_ACTION_RUNNER_CONTRACT_DIGEST');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || controlPlaneToken === '' ||
    operationsToken === '' || githubAppJwt === '' || githubInstallationToken === '' ||
    expectedRunnerContractDigest === ''
  ) {
    console.error('analysis-action-e2e: required analysis Action configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('analysis-action-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('analysis-action-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('analysis-action-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = AnalysisActionEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('analysis-action-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyAnalysisActionEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      operationsToken,
      githubAppJwt,
      githubInstallationToken,
      expectedRunnerContractDigest,
      ...(env('ANALYSIS_ACTION_GITHUB_API_URL') === ''
        ? {} : { githubApiOrigin: env('ANALYSIS_ACTION_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof AnalysisActionEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`analysis-action-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
