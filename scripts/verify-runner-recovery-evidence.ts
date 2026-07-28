import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RunnerRecoveryEvidenceManifestV1Schema } from '../src/domain/runner-recovery-evidence.js';
import {
  RunnerRecoveryEvidenceVerificationError,
  verifyRunnerRecoveryEvidence,
} from '../src/pilot/runner-recovery-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses the Watt-derived E2E command discipline already used by Pilot:
  // 0=verified, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_RUNNER_RECOVERY_E2E !== '1') {
    console.error(
      'runner-recovery-e2e: opt-in missing (set DELIVERY_LOOP_RUNNER_RECOVERY_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('RUNNER_RECOVERY_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('RECOVERY_CONTROL_PLANE_URL');
  const controlPlaneToken = prerequisite('RECOVERY_CONTROL_PLANE_TOKEN');
  const operationsToken = prerequisite('RECOVERY_OPERATIONS_TOKEN');
  const githubToken = prerequisite('RECOVERY_GITHUB_TOKEN');
  const canary = prerequisite('RECOVERY_SECURITY_CANARY');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || operationsToken === '' || githubToken === '' || canary === ''
  ) {
    console.error('runner-recovery-e2e: required recovery configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('runner-recovery-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('runner-recovery-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('runner-recovery-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = RunnerRecoveryEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('runner-recovery-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyRunnerRecoveryEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      operationsToken,
      githubToken,
      canary,
      ...(prerequisite('RECOVERY_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: prerequisite('RECOVERY_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof RunnerRecoveryEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`runner-recovery-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
