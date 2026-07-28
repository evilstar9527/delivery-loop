import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CiEvidenceManifestV1Schema } from '../src/domain/ci-evidence.js';
import {
  CiEvidenceVerificationError,
  verifyCiEvidence,
} from '../src/pilot/ci-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_CI_E2E !== '1') {
    console.error('ci-e2e: opt-in missing (set DELIVERY_LOOP_CI_E2E=1)');
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('CI_EVIDENCE_FILE');
  const githubToken = env('CI_GITHUB_TOKEN');
  const canarySecret = env('CI_INVALID_TASK_CANARY');
  if (manifestFile === '' || githubToken === '' || canarySecret === '') {
    console.error('ci-e2e: required CI configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('ci-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('ci-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('ci-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = CiEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('ci-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyCiEvidence(parsed.data, {
      githubToken,
      canarySecret,
      ...(env('CI_GITHUB_API_URL') === ''
        ? {} : { githubApiOrigin: env('CI_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof CiEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`ci-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
