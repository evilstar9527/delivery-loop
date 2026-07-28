import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DraftPrCasesEvidenceManifestV1Schema } from
  '../src/domain/draft-pr-cases-evidence.js';
import {
  DraftPrCasesEvidenceVerificationError,
  verifyDraftPrCasesEvidence,
} from '../src/pilot/draft-pr-cases-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function prerequisite(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Reuses Watt scripts/e2e/lib.ts@476e3cd's explicit 0/1/2 exit discipline.
  if (process.env.DELIVERY_LOOP_DRAFT_PR_CASES_E2E !== '1') {
    console.error(
      'draft-pr-cases-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_DRAFT_PR_CASES_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = prerequisite('DRAFT_PR_CASES_EVIDENCE_FILE');
  const controlPlaneOrigin = prerequisite('DRAFT_PR_CASES_CONTROL_PLANE_URL');
  const controlPlaneToken = prerequisite('DRAFT_PR_CASES_CONTROL_PLANE_TOKEN');
  const githubApiOrigin = prerequisite('DRAFT_PR_CASES_GITHUB_API_URL');
  const githubToken = prerequisite('DRAFT_PR_CASES_GITHUB_READ_TOKEN');
  const canary = prerequisite('DRAFT_PR_CASES_CANARY_SECRET');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || controlPlaneToken === '' ||
    githubApiOrigin === '' || githubToken === '' || canary === ''
  ) {
    console.error('draft-pr-cases-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('draft-pr-cases-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('draft-pr-cases-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch {
    console.error('draft-pr-cases-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = DraftPrCasesEvidenceManifestV1Schema.safeParse(raw);
  if (!parsed.success) {
    console.error('draft-pr-cases-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyDraftPrCasesEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubApiOrigin,
      githubToken,
      canary,
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof DraftPrCasesEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`draft-pr-cases-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
