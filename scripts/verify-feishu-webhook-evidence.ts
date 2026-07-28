import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FeishuWebhookEvidenceManifestV1Schema } from
  '../src/domain/feishu-webhook-evidence.js';
import {
  FeishuWebhookEvidenceVerificationError,
  verifyFeishuWebhookEvidence,
} from '../src/pilot/feishu-webhook-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Reuses Watt scripts/e2e/lib.ts@476e3cd's 0/1/2 discipline:
  // 0=live facts pass, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_FEISHU_WEBHOOK_E2E !== '1') {
    console.error(
      'feishu-webhook-e2e: opt-in missing (set DELIVERY_LOOP_FEISHU_WEBHOOK_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('FEISHU_WEBHOOK_EVIDENCE_FILE');
  const controlPlaneOrigin = env('FEISHU_WEBHOOK_CONTROL_PLANE_URL');
  const operationsToken = env('FEISHU_WEBHOOK_OPERATIONS_TOKEN');
  const observabilityReportUrl = env('FEISHU_WEBHOOK_OBSERVABILITY_REPORT_URL');
  const observabilityToken = env('FEISHU_WEBHOOK_OBSERVABILITY_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || operationsToken === '' ||
    observabilityReportUrl === '' || observabilityToken === ''
  ) {
    console.error('feishu-webhook-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('feishu-webhook-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('feishu-webhook-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch {
    console.error('feishu-webhook-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = FeishuWebhookEvidenceManifestV1Schema.safeParse(raw);
  if (!parsed.success) {
    console.error('feishu-webhook-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyFeishuWebhookEvidence(parsed.data, {
      controlPlaneOrigin,
      operationsToken,
      observabilityReportUrl,
      observabilityToken,
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof FeishuWebhookEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`feishu-webhook-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
