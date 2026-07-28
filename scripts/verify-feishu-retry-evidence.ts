import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FeishuRetryEvidenceManifestV1Schema } from '../src/domain/feishu-retry-evidence.js';
import {
  FeishuRetryEvidenceVerificationError,
  verifyFeishuRetryEvidence,
} from '../src/pilot/feishu-retry-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's 0/1/2 discipline:
  // 0=live facts pass, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_FEISHU_RETRY_E2E !== '1') {
    console.error(
      'feishu-retry-e2e: opt-in missing (set DELIVERY_LOOP_FEISHU_RETRY_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('FEISHU_RETRY_EVIDENCE_FILE');
  const controlPlaneOrigin = env('FEISHU_RETRY_CONTROL_PLANE_URL');
  const operationsToken = env('FEISHU_RETRY_OPERATIONS_TOKEN');
  const feishuAccessToken = env('FEISHU_RETRY_FEISHU_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || operationsToken === '' ||
    feishuAccessToken === ''
  ) {
    console.error('feishu-retry-e2e: required retry configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('feishu-retry-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('feishu-retry-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('feishu-retry-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = FeishuRetryEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('feishu-retry-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyFeishuRetryEvidence(parsed.data, {
      controlPlaneOrigin,
      operationsToken,
      feishuAccessToken,
      ...(env('FEISHU_RETRY_FEISHU_API_URL') === ''
        ? {}
        : { feishuApiOrigin: env('FEISHU_RETRY_FEISHU_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof FeishuRetryEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`feishu-retry-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
