import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHubReviewFeedbackEvidenceManifestV1Schema } from '../src/domain/github-review-feedback-evidence.js';
import {
  GitHubReviewFeedbackEvidenceVerificationError,
  verifyGitHubReviewFeedbackEvidence,
} from '../src/pilot/github-review-feedback-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's 0/1/2 discipline.
  if (process.env.DELIVERY_LOOP_GITHUB_REVIEW_E2E !== '1') {
    console.error(
      'github-review-e2e: opt-in missing (set DELIVERY_LOOP_GITHUB_REVIEW_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('GITHUB_REVIEW_EVIDENCE_FILE');
  const controlPlaneOrigin = env('GITHUB_REVIEW_CONTROL_PLANE_URL');
  const controlPlaneToken = env('GITHUB_REVIEW_CONTROL_PLANE_TOKEN');
  const githubToken = env('GITHUB_REVIEW_TOKEN');
  const canary = env('GITHUB_REVIEW_CANARY');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === '' || canary === ''
  ) {
    console.error('github-review-e2e: required review configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('github-review-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('github-review-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('github-review-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = GitHubReviewFeedbackEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('github-review-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyGitHubReviewFeedbackEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      canary,
      ...(env('GITHUB_REVIEW_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('GITHUB_REVIEW_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof GitHubReviewFeedbackEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`github-review-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
