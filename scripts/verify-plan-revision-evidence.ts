import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PlanRevisionEvidenceManifestV1Schema } from '../src/domain/plan-revision-evidence.js';
import {
  PlanRevisionEvidenceVerificationError,
  verifyPlanRevisionEvidence,
} from '../src/pilot/plan-revision-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  // Directly reuses Watt scripts/e2e/lib.ts@476e3cd's 0/1/2 discipline.
  if (process.env.DELIVERY_LOOP_PLAN_REVISION_E2E !== '1') {
    console.error(
      'plan-revision-e2e: opt-in missing (set DELIVERY_LOOP_PLAN_REVISION_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('PLAN_REVISION_EVIDENCE_FILE');
  const controlPlaneOrigin = env('PLAN_REVISION_CONTROL_PLANE_URL');
  const controlPlaneToken = env('PLAN_REVISION_CONTROL_PLANE_TOKEN');
  const githubToken = env('PLAN_REVISION_GITHUB_TOKEN');
  if (
    manifestFile === '' || controlPlaneOrigin === '' ||
    controlPlaneToken === '' || githubToken === ''
  ) {
    console.error('plan-revision-e2e: required revision configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try {
    source = await readFile(resolve(manifestFile), 'utf8');
  } catch {
    console.error('plan-revision-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('plan-revision-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    console.error('plan-revision-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = PlanRevisionEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('plan-revision-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyPlanRevisionEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      githubToken,
      ...(env('PLAN_REVISION_GITHUB_API_URL') === ''
        ? {}
        : { githubApiOrigin: env('PLAN_REVISION_GITHUB_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof PlanRevisionEvidenceVerificationError
      ? error.code
      : 'verification_failed';
    console.error(`plan-revision-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
