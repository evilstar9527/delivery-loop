import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CorrelationPlatformEvidenceManifestV1Schema,
  type CorrelationPlatformEvidenceManifestV1,
} from '../src/domain/correlation-platform-evidence.js';
import {
  CorrelationPlatformEvidenceVerificationError,
  verifyCorrelationPlatformEvidence,
} from '../src/pilot/correlation-platform-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

class ManifestReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readManifest(file: string): Promise<CorrelationPlatformEvidenceManifestV1> {
  let source: string;
  try { source = await readFile(resolve(file), 'utf8'); }
  catch { throw new ManifestReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestReadError('invalid');
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch { throw new ManifestReadError('invalid'); }
  const parsed = CorrelationPlatformEvidenceManifestV1Schema.safeParse(raw);
  if (!parsed.success) throw new ManifestReadError('invalid');
  return parsed.data;
}

async function main(): Promise<void> {
  // Reuse Watt's explicit opt-in, bounded manifest, and stable 0/1/2 exit discipline.
  if (process.env.DELIVERY_LOOP_CORRELATION_PLATFORM_E2E !== '1') {
    console.error(
      'correlation-platform-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_CORRELATION_PLATFORM_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const required = {
    evidenceFile: env('CORRELATION_PLATFORM_EVIDENCE_FILE'),
    controlPlaneOrigin: env('CORRELATION_PLATFORM_CONTROL_PLANE_URL'),
    controlPlaneToken: env('CORRELATION_PLATFORM_CONTROL_PLANE_TOKEN'),
    githubToken: env('CORRELATION_PLATFORM_GITHUB_READ_TOKEN'),
    cloudflareAccountId: env('CORRELATION_PLATFORM_CLOUDFLARE_ACCOUNT_ID'),
    cloudflareToken: env('CORRELATION_PLATFORM_CLOUDFLARE_OBSERVABILITY_TOKEN'),
    canary: env('CORRELATION_PLATFORM_CANARY_SECRET'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error(
      'correlation-platform-e2e: required evidence configuration is incomplete',
    );
    process.exitCode = 2;
    return;
  }
  let manifest: CorrelationPlatformEvidenceManifestV1;
  try { manifest = await readManifest(required.evidenceFile); }
  catch (error) {
    const kind = error instanceof ManifestReadError ? error.kind : 'invalid';
    console.error(`correlation-platform-e2e: evidence manifest is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const githubApiOrigin = env('CORRELATION_PLATFORM_GITHUB_API_URL');
  const cloudflareApiOrigin = env('CORRELATION_PLATFORM_CLOUDFLARE_API_URL');
  try {
    const summary = await verifyCorrelationPlatformEvidence(manifest, {
      controlPlaneOrigin: required.controlPlaneOrigin,
      controlPlaneToken: required.controlPlaneToken,
      githubToken: required.githubToken,
      cloudflareAccountId: required.cloudflareAccountId,
      cloudflareObservabilityToken: required.cloudflareToken,
      canary: required.canary,
      ...(githubApiOrigin === '' ? {} : { githubApiOrigin }),
      ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof CorrelationPlatformEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`correlation-platform-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
