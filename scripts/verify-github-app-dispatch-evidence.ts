import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHubAppDispatchEvidenceManifestV1Schema } from
  '../src/domain/github-app-dispatch-evidence.js';
import {
  GitHubAppDispatchEvidenceVerificationError,
  verifyGitHubAppDispatchEvidence,
} from '../src/pilot/github-app-dispatch-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_GITHUB_APP_DISPATCH_E2E !== '1') {
    console.error(
      'github-app-dispatch-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_GITHUB_APP_DISPATCH_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('GITHUB_APP_DISPATCH_EVIDENCE_FILE');
  const controlPlaneOrigin = env('GITHUB_APP_DISPATCH_CONTROL_PLANE_URL');
  const controlPlaneToken = env('GITHUB_APP_DISPATCH_CONTROL_PLANE_TOKEN');
  const operationsToken = env('GITHUB_APP_DISPATCH_OPERATIONS_TOKEN');
  const githubAppJwt = env('GITHUB_APP_DISPATCH_APP_JWT');
  const githubInstallationToken = env('GITHUB_APP_DISPATCH_INSTALLATION_AUDIT_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || controlPlaneToken === '' ||
    operationsToken === '' || githubAppJwt === '' || githubInstallationToken === ''
  ) {
    console.error('github-app-dispatch-e2e: required GitHub App configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('github-app-dispatch-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('github-app-dispatch-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('github-app-dispatch-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = GitHubAppDispatchEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('github-app-dispatch-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyGitHubAppDispatchEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      operationsToken,
      githubAppJwt,
      githubInstallationToken,
      ...(env('GITHUB_APP_DISPATCH_GITHUB_API_URL') === ''
        ? {} : { githubApiOrigin: env('GITHUB_APP_DISPATCH_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof GitHubAppDispatchEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`github-app-dispatch-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
