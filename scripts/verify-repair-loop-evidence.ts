import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RepairLoopEvidenceManifestV1Schema } from '../src/domain/repair-loop-evidence.js';
import {
  RepairLoopEvidenceVerificationError,
  verifyRepairLoopEvidence,
} from '../src/pilot/repair-loop-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_REPAIR_LOOP_E2E !== '1') {
    console.error(
      'repair-loop-e2e: opt-in missing (set DELIVERY_LOOP_REPAIR_LOOP_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('REPAIR_LOOP_EVIDENCE_FILE');
  const controlPlaneOrigin = env('REPAIR_LOOP_CONTROL_PLANE_URL');
  const controlPlaneToken = env('REPAIR_LOOP_CONTROL_PLANE_TOKEN');
  const githubToken = env('REPAIR_LOOP_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error('repair-loop-e2e: required repair loop configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('repair-loop-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('repair-loop-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('repair-loop-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = RepairLoopEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('repair-loop-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyRepairLoopEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(env('REPAIR_LOOP_GITHUB_API_URL') === ''
        ? {} : { githubApiOrigin: env('REPAIR_LOOP_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof RepairLoopEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`repair-loop-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
