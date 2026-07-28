import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  TestRollbackEvidenceManifestV1Schema,
  type TestRollbackEvidenceManifestV1,
} from '../src/domain/test-rollback-evidence.js';
import {
  TestRollbackEvidenceVerificationError,
  verifyTestRollbackEvidence,
} from '../src/pilot/test-rollback-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

class ManifestReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readManifest(file: string): Promise<TestRollbackEvidenceManifestV1> {
  let source: string;
  try { source = await readFile(resolve(file), 'utf8'); }
  catch { throw new ManifestReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestReadError('invalid');
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch { throw new ManifestReadError('invalid'); }
  const parsed = TestRollbackEvidenceManifestV1Schema.safeParse(raw);
  if (!parsed.success) throw new ManifestReadError('invalid');
  return parsed.data;
}

async function main(): Promise<void> {
  // Reuses Watt@476e3cd's explicit opt-in, bounded manifest, and 0/1/2 exits.
  if (process.env.DELIVERY_LOOP_TEST_ROLLBACK_E2E !== '1') {
    console.error(
      'test-rollback-e2e: opt-in missing (set DELIVERY_LOOP_TEST_ROLLBACK_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const required = {
    evidenceFile: env('TEST_ROLLBACK_EVIDENCE_FILE'),
    controlPlaneOrigin: env('TEST_ROLLBACK_CONTROL_PLANE_URL'),
    controlPlaneToken: env('TEST_ROLLBACK_CONTROL_PLANE_TOKEN'),
    githubToken: env('TEST_ROLLBACK_GITHUB_READ_TOKEN'),
    canary: env('TEST_ROLLBACK_CANARY_SECRET'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error('test-rollback-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let manifest: TestRollbackEvidenceManifestV1;
  try { manifest = await readManifest(required.evidenceFile); }
  catch (error) {
    const kind = error instanceof ManifestReadError ? error.kind : 'invalid';
    console.error(`test-rollback-e2e: evidence manifest is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const githubApiOrigin = env('TEST_ROLLBACK_GITHUB_API_URL');
  try {
    const summary = await verifyTestRollbackEvidence(manifest, {
      controlPlaneOrigin: required.controlPlaneOrigin,
      controlPlaneToken: required.controlPlaneToken,
      githubToken: required.githubToken,
      canary: required.canary,
      ...(githubApiOrigin === '' ? {} : { githubApiOrigin }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof TestRollbackEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`test-rollback-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
