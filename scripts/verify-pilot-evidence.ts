import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PilotEvidenceManifestV1Schema } from '../src/domain/pilot-evidence.js';
import {
  PilotEvidenceVerificationError,
  verifyPilotEvidence,
} from '../src/pilot/pilot-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Exit layering is directly derived from Watt scripts/e2e/lib.ts:
  // 0=verified, 1=assertion/fact failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_PILOT_E2E !== '1') {
    console.error('pilot-e2e: opt-in missing (set DELIVERY_LOOP_PILOT_E2E=1)');
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('PILOT_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('PILOT_CONTROL_PLANE_URL');
  const controlPlaneToken = prerequisite('PILOT_CONTROL_PLANE_TOKEN');
  const githubToken = prerequisite('PILOT_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error('pilot-e2e: required pilot configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('pilot-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('pilot-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    console.error('pilot-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = PilotEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('pilot-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyPilotEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(prerequisite('PILOT_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: prerequisite('PILOT_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof PilotEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`pilot-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
