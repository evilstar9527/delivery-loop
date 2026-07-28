import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MergeGateEvidenceManifestV1Schema } from '../src/domain/merge-gate-evidence.js';
import {
  MergeGateEvidenceVerificationError,
  verifyMergeGateEvidence,
} from '../src/pilot/merge-gate-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Reuses Watt@476e3cd's explicit opt-in and 0/1/2 exit boundary.
  if (process.env.DELIVERY_LOOP_MERGE_GATE_E2E !== '1') {
    console.error('merge-gate-e2e: opt-in missing (set DELIVERY_LOOP_MERGE_GATE_E2E=1)');
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('MERGE_GATE_EVIDENCE_FILE');
  const controlPlaneOrigin = env('MERGE_GATE_CONTROL_PLANE_URL');
  const controlPlaneToken = env('MERGE_GATE_CONTROL_PLANE_TOKEN');
  const githubToken = env('MERGE_GATE_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error('merge-gate-e2e: required merge gate configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('merge-gate-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('merge-gate-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('merge-gate-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = MergeGateEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('merge-gate-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyMergeGateEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(env('MERGE_GATE_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('MERGE_GATE_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof MergeGateEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`merge-gate-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
