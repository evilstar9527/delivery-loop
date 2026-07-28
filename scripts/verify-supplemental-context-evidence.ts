import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SupplementalContextEvidenceManifestV1Schema } from
  '../src/domain/supplemental-context-evidence.js';
import {
  SupplementalContextEvidenceVerificationError,
  verifySupplementalContextEvidence,
} from '../src/pilot/supplemental-context-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's exit discipline:
  // 0=verified, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_SUPPLEMENTAL_CONTEXT_E2E !== '1') {
    console.error(
      'supplemental-context-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_SUPPLEMENTAL_CONTEXT_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('SUPPLEMENTAL_CONTEXT_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('SUPPLEMENTAL_CONTEXT_CONTROL_PLANE_URL');
  const operationsToken = prerequisite('SUPPLEMENTAL_CONTEXT_OPERATIONS_TOKEN');
  const observabilityReportUrl = prerequisite('SUPPLEMENTAL_CONTEXT_OBSERVABILITY_URL');
  const observabilityToken = prerequisite('SUPPLEMENTAL_CONTEXT_OBSERVABILITY_TOKEN');
  const feishuApiOrigin = prerequisite('SUPPLEMENTAL_CONTEXT_FEISHU_API_URL');
  const feishuAccessToken = prerequisite('SUPPLEMENTAL_CONTEXT_FEISHU_ACCESS_TOKEN');
  const canary = prerequisite('SUPPLEMENTAL_CONTEXT_CANARY_SECRET');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || operationsToken === '' ||
    observabilityReportUrl === '' || observabilityToken === '' || feishuApiOrigin === '' ||
    feishuAccessToken === '' || canary === ''
  ) {
    console.error('supplemental-context-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('supplemental-context-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('supplemental-context-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('supplemental-context-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = SupplementalContextEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('supplemental-context-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifySupplementalContextEvidence(parsed.data, {
      controlPlaneOrigin,
      operationsToken,
      observabilityReportUrl,
      observabilityToken,
      feishuApiOrigin,
      feishuAccessToken,
      canary,
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof SupplementalContextEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`supplemental-context-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
