import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SecretSafetyEvidenceManifestV1Schema } from '../src/domain/secret-safety-evidence.js';
import {
  SecretSafetyEvidenceVerificationError,
  verifySecretSafetyEvidence,
} from '../src/pilot/secret-safety-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Reuses Watt@476e3cd's explicit opt-in and 0/1/2 exit boundary.
  if (process.env.DELIVERY_LOOP_SECRET_SAFETY_E2E !== '1') {
    console.error(
      'secret-safety-e2e: opt-in missing (set DELIVERY_LOOP_SECRET_SAFETY_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('SECRET_SAFETY_EVIDENCE_FILE');
  const controlPlaneOrigin = env('SECRET_SAFETY_CONTROL_PLANE_URL');
  const controlPlaneToken = env('SECRET_SAFETY_CONTROL_PLANE_TOKEN');
  const githubToken = env('SECRET_SAFETY_GITHUB_TOKEN');
  const canarySecret = env('SECRET_SAFETY_CANARY');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || controlPlaneToken === '' ||
    githubToken === '' || canarySecret === ''
  ) {
    console.error('secret-safety-e2e: required Secret safety configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('secret-safety-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('secret-safety-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('secret-safety-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = SecretSafetyEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('secret-safety-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifySecretSafetyEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      canarySecret,
      ...(env('SECRET_SAFETY_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('SECRET_SAFETY_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof SecretSafetyEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`secret-safety-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
