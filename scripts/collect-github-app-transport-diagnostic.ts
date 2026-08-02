import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GitHubAppTransportDiagnosticCollectionRequestV1Schema,
  type GitHubAppTransportDiagnosticCollectionRequestV1,
} from '../src/domain/github-app-transport-diagnostic-evidence.js';
import {
  GitHubAppTransportDiagnosticCollectionError,
  collectGitHubAppTransportDiagnosticObservation,
} from '../src/pilot/github-app-transport-diagnostic-collector.js';

const MAX_REQUEST_BYTES = 64 * 1_024;

class RequestReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readRequest(
  file: string,
): Promise<GitHubAppTransportDiagnosticCollectionRequestV1> {
  let source: string;
  try { source = await readFile(resolve(file), 'utf8'); }
  catch { throw new RequestReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_REQUEST_BYTES) {
    throw new RequestReadError('invalid');
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch { throw new RequestReadError('invalid'); }
  const parsed = GitHubAppTransportDiagnosticCollectionRequestV1Schema.safeParse(raw);
  if (!parsed.success) throw new RequestReadError('invalid');
  return parsed.data;
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_GITHUB_APP_TRANSPORT_DIAGNOSTIC_COLLECTION !== '1') {
    console.error('github-app-transport-diagnostic-collection: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const required = {
    requestFile: env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_COLLECTION_REQUEST_FILE'),
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
      'github-app-transport-diagnostic-collection: required configuration is incomplete',
    );
    process.exitCode = 2;
    return;
  }
  let request: GitHubAppTransportDiagnosticCollectionRequestV1;
  try { request = await readRequest(required.requestFile); }
  catch (error) {
    const kind = error instanceof RequestReadError ? error.kind : 'invalid';
    console.error(`github-app-transport-diagnostic-collection: request is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const cloudflareApiOrigin = env('GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_API_URL');
  try {
    const observation = await collectGitHubAppTransportDiagnosticObservation(request, {
      githubToken: required.githubToken,
      cloudflareDeploymentReadToken: required.cloudflareDeploymentToken,
      cloudflareObservabilityToken: required.cloudflareObservabilityToken,
      cloudflareAccountId: required.cloudflareAccountId,
      canary: required.canary,
      ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
    });
    console.log(JSON.stringify(observation));
  } catch (error) {
    const code = error instanceof GitHubAppTransportDiagnosticCollectionError
      ? error.code
      : 'collection_failed';
    console.error(`github-app-transport-diagnostic-collection: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
