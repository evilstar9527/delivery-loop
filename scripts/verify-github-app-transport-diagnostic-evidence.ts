import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GitHubAppTransportDiagnosticEvidenceManifestV1Schema,
  type GitHubAppTransportDiagnosticEvidenceManifestV1,
} from '../src/domain/github-app-transport-diagnostic-evidence.js';
import {
  GitHubAppTransportDiagnosticEvidenceVerificationError,
  verifyGitHubAppTransportDiagnosticEvidence,
} from '../src/pilot/github-app-transport-diagnostic-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

class ManifestReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readManifest(
  file: string,
): Promise<GitHubAppTransportDiagnosticEvidenceManifestV1> {
  let source: string;
  try { source = await readFile(resolve(file), 'utf8'); }
  catch { throw new ManifestReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestReadError('invalid');
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch { throw new ManifestReadError('invalid'); }
  const parsed = GitHubAppTransportDiagnosticEvidenceManifestV1Schema.safeParse(raw);
  if (!parsed.success) throw new ManifestReadError('invalid');
  return parsed.data;
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_GITHUB_APP_TRANSPORT_DIAGNOSTIC_E2E !== '1') {
    console.error('github-app-transport-diagnostic-e2e: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const required = {
    evidenceFile: env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_EVIDENCE_FILE'),
    githubToken: env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_GITHUB_READ_TOKEN'),
    cloudflareDeploymentToken:
      env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_DEPLOYMENT_READ_TOKEN'),
    cloudflareObservabilityToken:
      env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_OBSERVABILITY_TOKEN'),
    cloudflareAccountId:
      env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_ACCOUNT_ID'),
    canary: env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_CANARY_SECRET'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error(
      'github-app-transport-diagnostic-e2e: required evidence configuration is incomplete',
    );
    process.exitCode = 2;
    return;
  }
  let manifest: GitHubAppTransportDiagnosticEvidenceManifestV1;
  try { manifest = await readManifest(required.evidenceFile); }
  catch (error) {
    const kind = error instanceof ManifestReadError ? error.kind : 'invalid';
    console.error(`github-app-transport-diagnostic-e2e: evidence manifest is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const githubApiOrigin = env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_GITHUB_API_URL');
  const cloudflareApiOrigin = env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_API_URL');
  try {
    const summary = await verifyGitHubAppTransportDiagnosticEvidence(manifest, {
      githubToken: required.githubToken,
      cloudflareDeploymentReadToken: required.cloudflareDeploymentToken,
      cloudflareObservabilityToken: required.cloudflareObservabilityToken,
      cloudflareAccountId: required.cloudflareAccountId,
      canary: required.canary,
      ...(githubApiOrigin === '' ? {} : { githubApiOrigin }),
      ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof GitHubAppTransportDiagnosticEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`github-app-transport-diagnostic-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
