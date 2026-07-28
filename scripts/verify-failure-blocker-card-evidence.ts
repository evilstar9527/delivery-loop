import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FailureBlockerCardEvidenceManifestV1Schema } from '../src/domain/failure-blocker-card-evidence.js';
import {
  FailureBlockerCardEvidenceVerificationError,
  verifyFailureBlockerCardEvidence,
} from '../src/pilot/failure-blocker-card-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's exit discipline:
  // 0=verified, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_FAILURE_BLOCKER_CARD_E2E !== '1') {
    console.error(
      'failure-blocker-card-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_FAILURE_BLOCKER_CARD_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('FAILURE_BLOCKER_CARD_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('FAILURE_BLOCKER_CARD_CONTROL_PLANE_URL');
  const operationsToken = prerequisite('FAILURE_BLOCKER_CARD_OPERATIONS_TOKEN');
  const queryToken = prerequisite('FAILURE_BLOCKER_CARD_QUERY_TOKEN');
  const feishuAccessToken = prerequisite('FAILURE_BLOCKER_CARD_FEISHU_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || operationsToken === '' ||
    queryToken === '' || feishuAccessToken === ''
  ) {
    console.error('failure-blocker-card-e2e: required card configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('failure-blocker-card-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('failure-blocker-card-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('failure-blocker-card-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = FailureBlockerCardEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('failure-blocker-card-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyFailureBlockerCardEvidence(parsed.data, {
      controlPlaneOrigin,
      operationsToken,
      queryToken,
      feishuAccessToken,
      ...(prerequisite('FAILURE_BLOCKER_CARD_FEISHU_API_URL') === ''
        ? {}
        : { feishuApiOrigin: prerequisite('FAILURE_BLOCKER_CARD_FEISHU_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof FailureBlockerCardEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`failure-blocker-card-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
