import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TestAcceptanceEvidenceManifestV1Schema } from '../src/domain/test-acceptance-evidence.js';
import {
  TestAcceptanceEvidenceVerificationError,
  verifyTestAcceptanceEvidence,
} from '../src/pilot/test-acceptance-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt@476e3cd's explicit opt-in and 0/1/2 E2E boundary.
  if (process.env.DELIVERY_LOOP_TEST_ACCEPTANCE_E2E !== '1') {
    console.error(
      'test-acceptance-e2e: opt-in missing (set DELIVERY_LOOP_TEST_ACCEPTANCE_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('TEST_ACCEPTANCE_EVIDENCE_FILE');
  const controlPlaneOrigin = env('TEST_ACCEPTANCE_CONTROL_PLANE_URL');
  const controlPlaneToken = env('TEST_ACCEPTANCE_CONTROL_PLANE_TOKEN');
  const githubToken = env('TEST_ACCEPTANCE_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error('test-acceptance-e2e: required test acceptance configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('test-acceptance-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('test-acceptance-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('test-acceptance-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = TestAcceptanceEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('test-acceptance-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyTestAcceptanceEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(env('TEST_ACCEPTANCE_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('TEST_ACCEPTANCE_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof TestAcceptanceEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`test-acceptance-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
