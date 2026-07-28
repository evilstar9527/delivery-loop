import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHubPullRequestEvidenceManifestV1Schema } from '../src/domain/github-pull-request-evidence.js';
import {
  GitHubPullRequestEvidenceVerificationError,
  verifyGitHubPullRequestEvidence,
} from '../src/pilot/github-pull-request-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's 0/1/2 exit discipline.
  if (process.env.DELIVERY_LOOP_GITHUB_PR_E2E !== '1') {
    console.error(
      'github-pr-e2e: opt-in missing (set DELIVERY_LOOP_GITHUB_PR_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('GITHUB_PR_EVIDENCE_FILE');
  const controlPlaneOrigin = env('GITHUB_PR_CONTROL_PLANE_URL');
  const controlPlaneToken = env('GITHUB_PR_CONTROL_PLANE_TOKEN');
  const githubToken = env('GITHUB_PR_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error('github-pr-e2e: required PR configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('github-pr-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('github-pr-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('github-pr-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = GitHubPullRequestEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('github-pr-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyGitHubPullRequestEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(env('GITHUB_PR_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('GITHUB_PR_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof GitHubPullRequestEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`github-pr-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
