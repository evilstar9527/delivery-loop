import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApprovalLineageEvidenceManifestV1Schema } from
  '../src/domain/approval-lineage-evidence.js';
import {
  ApprovalLineageEvidenceVerificationError,
  verifyApprovalLineageEvidence,
} from '../src/pilot/approval-lineage-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's exit discipline:
  // 0=verified, 1=fact/assertion failure, 2=explicit prerequisite missing.
  if (process.env.DELIVERY_LOOP_APPROVAL_LINEAGE_E2E !== '1') {
    console.error(
      'approval-lineage-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_APPROVAL_LINEAGE_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('APPROVAL_LINEAGE_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('APPROVAL_LINEAGE_CONTROL_PLANE_URL');
  const operationsToken = prerequisite('APPROVAL_LINEAGE_OPERATIONS_TOKEN');
  const observabilityReportUrl = prerequisite('APPROVAL_LINEAGE_OBSERVABILITY_URL');
  const observabilityToken = prerequisite('APPROVAL_LINEAGE_OBSERVABILITY_TOKEN');
  const githubToken = prerequisite('APPROVAL_LINEAGE_GITHUB_READ_TOKEN');
  const githubApiOrigin = prerequisite('APPROVAL_LINEAGE_GITHUB_API_URL');
  const canary = prerequisite('APPROVAL_LINEAGE_CANARY_SECRET');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || operationsToken === '' ||
    observabilityReportUrl === '' || observabilityToken === '' || githubToken === '' ||
    githubApiOrigin === '' || canary === ''
  ) {
    console.error('approval-lineage-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('approval-lineage-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('approval-lineage-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('approval-lineage-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = ApprovalLineageEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('approval-lineage-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyApprovalLineageEvidence(parsed.data, {
      controlPlaneOrigin,
      operationsToken,
      observabilityReportUrl,
      observabilityToken,
      githubToken,
      githubApiOrigin,
      canary,
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof ApprovalLineageEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`approval-lineage-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
