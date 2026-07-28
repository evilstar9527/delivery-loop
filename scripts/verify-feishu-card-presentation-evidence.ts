import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FeishuCardPresentationEvidenceManifestV1Schema } from '../src/domain/feishu-card-presentation-evidence.js';
import {
  FeishuCardPresentationEvidenceVerificationError,
  verifyFeishuCardPresentationEvidence,
} from '../src/pilot/feishu-card-presentation-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's exit discipline:
  // 0=verified, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_FEISHU_CARD_PRESENTATION_E2E !== '1') {
    console.error(
      'feishu-card-presentation-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_FEISHU_CARD_PRESENTATION_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('FEISHU_CARD_PRESENTATION_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('FEISHU_CARD_PRESENTATION_CONTROL_PLANE_URL');
  const operationsToken = prerequisite('FEISHU_CARD_PRESENTATION_OPERATIONS_TOKEN');
  const feishuAccessToken = prerequisite('FEISHU_CARD_PRESENTATION_FEISHU_TOKEN');
  const canarySecret = prerequisite('FEISHU_CARD_PRESENTATION_CANARY_SECRET');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || operationsToken === '' ||
    feishuAccessToken === '' || canarySecret === ''
  ) {
    console.error('feishu-card-presentation-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('feishu-card-presentation-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('feishu-card-presentation-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('feishu-card-presentation-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = FeishuCardPresentationEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('feishu-card-presentation-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyFeishuCardPresentationEvidence(parsed.data, {
      controlPlaneOrigin,
      operationsToken,
      feishuAccessToken,
      canarySecret,
      ...(prerequisite('FEISHU_CARD_PRESENTATION_FEISHU_API_URL') === ''
        ? {}
        : { feishuApiOrigin: prerequisite('FEISHU_CARD_PRESENTATION_FEISHU_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof FeishuCardPresentationEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`feishu-card-presentation-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
