import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RunnerHeartbeatEvidenceManifestV1Schema } from
  '../src/domain/runner-heartbeat-evidence.js';
import {
  RunnerHeartbeatEvidenceVerificationError,
  verifyRunnerHeartbeatEvidence,
} from '../src/pilot/runner-heartbeat-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_RUNNER_HEARTBEAT_E2E !== '1') {
    console.error(
      'runner-heartbeat-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_RUNNER_HEARTBEAT_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('RUNNER_HEARTBEAT_EVIDENCE_FILE');
  const controlPlaneOrigin = env('RUNNER_HEARTBEAT_CONTROL_PLANE_URL');
  const controlPlaneToken = env('RUNNER_HEARTBEAT_CONTROL_PLANE_TOKEN');
  const operationsToken = env('RUNNER_HEARTBEAT_OPERATIONS_TOKEN');
  const githubAppJwt = env('RUNNER_HEARTBEAT_APP_JWT');
  const githubInstallationToken = env('RUNNER_HEARTBEAT_INSTALLATION_AUDIT_TOKEN');
  const expectedRunnerContractDigest = env('RUNNER_HEARTBEAT_RUNNER_CONTRACT_DIGEST');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || controlPlaneToken === '' ||
    operationsToken === '' || githubAppJwt === '' || githubInstallationToken === '' ||
    expectedRunnerContractDigest === ''
  ) {
    console.error('runner-heartbeat-e2e: required Runner heartbeat configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('runner-heartbeat-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('runner-heartbeat-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('runner-heartbeat-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = RunnerHeartbeatEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('runner-heartbeat-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyRunnerHeartbeatEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      operationsToken,
      githubAppJwt,
      githubInstallationToken,
      expectedRunnerContractDigest,
      ...(env('RUNNER_HEARTBEAT_GITHUB_API_URL') === ''
        ? {} : { githubApiOrigin: env('RUNNER_HEARTBEAT_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof RunnerHeartbeatEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`runner-heartbeat-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
