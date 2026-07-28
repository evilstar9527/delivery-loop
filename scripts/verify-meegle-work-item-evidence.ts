import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MeegleWorkItemEvidenceManifestV1Schema } from
  '../src/domain/meegle-work-item-evidence.js';
import {
  MeegleWorkItemEvidenceVerificationError,
  verifyMeegleWorkItemEvidence,
} from '../src/pilot/meegle-work-item-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Watt scripts/e2e/lib.ts@476e3cd convention: 0=verified, 1=fact mismatch,
  // 2=explicit live prerequisite missing. The verifier itself remains read-only.
  if (process.env.DELIVERY_LOOP_MEEGLE_WORK_ITEM_E2E !== '1') {
    console.error(
      'meegle-work-item-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_MEEGLE_WORK_ITEM_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const required = {
    manifestFile: env('MEEGLE_WORK_ITEM_EVIDENCE_FILE'),
    controlPlaneOrigin: env('MEEGLE_WORK_ITEM_CONTROL_PLANE_URL'),
    operationsToken: env('MEEGLE_WORK_ITEM_OPERATIONS_TOKEN'),
    meegleProfile: env('MEEGLE_WORK_ITEM_CLI_PROFILE'),
    tenantKey: env('MEEGLE_WORK_ITEM_TENANT_KEY'),
    projectKey: env('MEEGLE_WORK_ITEM_PROJECT_KEY'),
    workItemTypeKey: env('MEEGLE_WORK_ITEM_TYPE_KEY'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error('meegle-work-item-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(required.manifestFile), 'utf8'); }
  catch {
    console.error('meegle-work-item-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('meegle-work-item-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch {
    console.error('meegle-work-item-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = MeegleWorkItemEvidenceManifestV1Schema.safeParse(raw);
  if (!parsed.success) {
    console.error('meegle-work-item-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const meegleBinary = env('MEEGLE_WORK_ITEM_CLI_BINARY');
  try {
    const summary = await verifyMeegleWorkItemEvidence(parsed.data, {
      controlPlaneOrigin: required.controlPlaneOrigin,
      operationsToken: required.operationsToken,
      meegleProfile: required.meegleProfile,
      tenantKey: required.tenantKey,
      projectKey: required.projectKey,
      workItemTypeKey: required.workItemTypeKey,
      ...(meegleBinary === '' ? {} : { meegleBinary }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof MeegleWorkItemEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`meegle-work-item-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
