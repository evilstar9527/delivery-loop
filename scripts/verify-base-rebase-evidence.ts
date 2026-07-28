import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BaseRebaseEvidenceManifestV1Schema } from '../src/domain/base-rebase-evidence.js';
import {
  BaseRebaseEvidenceVerificationError,
  verifyBaseRebaseEvidence,
} from '../src/pilot/base-rebase-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt@476e3cd scripts/e2e/lib.ts's explicit opt-in and 0/1/2 boundary.
  if (process.env.DELIVERY_LOOP_BASE_REBASE_E2E !== '1') {
    console.error('base-rebase-e2e: opt-in missing (set DELIVERY_LOOP_BASE_REBASE_E2E=1)');
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('BASE_REBASE_EVIDENCE_FILE');
  const controlPlaneOrigin = env('BASE_REBASE_CONTROL_PLANE_URL');
  const controlPlaneToken = env('BASE_REBASE_CONTROL_PLANE_TOKEN');
  const githubToken = env('BASE_REBASE_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error('base-rebase-e2e: required rebase configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('base-rebase-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('base-rebase-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('base-rebase-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = BaseRebaseEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('base-rebase-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyBaseRebaseEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(env('BASE_REBASE_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('BASE_REBASE_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof BaseRebaseEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`base-rebase-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
