import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FeishuIngressEvidenceManifestV1Schema } from
  '../src/domain/feishu-ingress-evidence.js';
import {
  FeishuIngressEvidenceVerificationError,
  verifyFeishuIngressEvidence,
} from '../src/pilot/feishu-ingress-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Reuses Watt scripts/e2e/lib.ts@476e3cd's stable 0/1/2 discipline:
  // 0=live facts pass, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_FEISHU_INGRESS_E2E !== '1') {
    console.error(
      'feishu-ingress-e2e: opt-in missing (set DELIVERY_LOOP_FEISHU_INGRESS_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const required = {
    manifestFile: env('FEISHU_INGRESS_EVIDENCE_FILE'),
    controlPlaneOrigin: env('FEISHU_INGRESS_CONTROL_PLANE_URL'),
    operationsToken: env('FEISHU_INGRESS_OPERATIONS_TOKEN'),
    observabilityReportUrl: env('FEISHU_INGRESS_OBSERVABILITY_REPORT_URL'),
    observabilityToken: env('FEISHU_INGRESS_OBSERVABILITY_TOKEN'),
    cloudflareAccountId: env('FEISHU_INGRESS_CLOUDFLARE_ACCOUNT_ID'),
    cloudflareToken: env('FEISHU_INGRESS_CLOUDFLARE_TOKEN'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error('feishu-ingress-e2e: required Feishu ingress configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(required.manifestFile), 'utf8'); }
  catch {
    console.error('feishu-ingress-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('feishu-ingress-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch {
    console.error('feishu-ingress-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = FeishuIngressEvidenceManifestV1Schema.safeParse(raw);
  if (!parsed.success) {
    console.error('feishu-ingress-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const cloudflareApiOrigin = env('FEISHU_INGRESS_CLOUDFLARE_API_URL');
  try {
    const summary = await verifyFeishuIngressEvidence(parsed.data, {
      controlPlaneOrigin: required.controlPlaneOrigin,
      operationsToken: required.operationsToken,
      observabilityReportUrl: required.observabilityReportUrl,
      observabilityToken: required.observabilityToken,
      cloudflareAccountId: required.cloudflareAccountId,
      cloudflareToken: required.cloudflareToken,
      ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof FeishuIngressEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`feishu-ingress-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
