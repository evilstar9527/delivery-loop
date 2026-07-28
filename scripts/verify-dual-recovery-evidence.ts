import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DualRecoveryEvidenceManifestV1Schema } from '../src/domain/dual-recovery-evidence.js';
import { RunnerRecoveryEvidenceManifestV1Schema } from '../src/domain/runner-recovery-evidence.js';
import { WorkflowHibernateEvidenceManifestV1Schema } from '../src/domain/workflow-hibernate-evidence.js';
import {
  DualRecoveryEvidenceVerificationError,
  verifyDualRecoveryEvidence,
} from '../src/pilot/dual-recovery-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

class ManifestReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function jsonFile(path: string): Promise<unknown> {
  let source: string;
  try { source = await readFile(resolve(path), 'utf8'); }
  catch { throw new ManifestReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestReadError('invalid');
  }
  try { return JSON.parse(source) as unknown; }
  catch { throw new ManifestReadError('invalid'); }
}

async function main(): Promise<void> {
  // Preserves Watt-derived discipline: explicit opt-in, bounded external manifests, 0/1/2 exits.
  if (process.env.DELIVERY_LOOP_DUAL_RECOVERY_E2E !== '1') {
    console.error('dual-recovery-e2e: opt-in missing (set DELIVERY_LOOP_DUAL_RECOVERY_E2E=1)');
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('DUAL_RECOVERY_EVIDENCE_FILE');
  const workflowFile = env('DUAL_RECOVERY_WORKFLOW_HIBERNATE_FILE');
  const runnerFile = env('DUAL_RECOVERY_RUNNER_RECOVERY_FILE');
  const controlPlaneOrigin = env('DUAL_RECOVERY_CONTROL_PLANE_URL');
  const controlPlaneToken = env('DUAL_RECOVERY_CONTROL_PLANE_TOKEN');
  const operationsToken = env('DUAL_RECOVERY_OPERATIONS_TOKEN');
  const githubToken = env('DUAL_RECOVERY_GITHUB_TOKEN');
  const cloudflareToken = env('DUAL_RECOVERY_CLOUDFLARE_TOKEN');
  const cloudflareAccountId = env('DUAL_RECOVERY_CLOUDFLARE_ACCOUNT_ID');
  const canary = env('DUAL_RECOVERY_SECURITY_CANARY');
  if ([
    manifestFile, workflowFile, runnerFile, controlPlaneOrigin, controlPlaneToken,
    operationsToken, githubToken, cloudflareToken, cloudflareAccountId, canary,
  ].some((value) => value === '')) {
    console.error('dual-recovery-e2e: required recovery configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let rawManifest: unknown;
  let rawWorkflow: unknown;
  let rawRunner: unknown;
  try {
    [rawManifest, rawWorkflow, rawRunner] = await Promise.all([
      jsonFile(manifestFile), jsonFile(workflowFile), jsonFile(runnerFile),
    ]);
  } catch (error) {
    const kind = error instanceof ManifestReadError ? error.kind : 'invalid';
    console.error(`dual-recovery-e2e: evidence manifest is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const manifest = DualRecoveryEvidenceManifestV1Schema.safeParse(rawManifest);
  const workflow = WorkflowHibernateEvidenceManifestV1Schema.safeParse(rawWorkflow);
  const runner = RunnerRecoveryEvidenceManifestV1Schema.safeParse(rawRunner);
  if (!manifest.success || !workflow.success || !runner.success) {
    console.error('dual-recovery-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyDualRecoveryEvidence(
      manifest.data,
      { workflowHibernate: workflow.data, runnerRecovery: runner.data },
      {
        controlPlaneOrigin,
        controlPlaneToken,
        operationsToken,
        githubToken,
        cloudflareToken,
        cloudflareAccountId,
        canary,
        ...(env('DUAL_RECOVERY_GITHUB_API_URL') === ''
          ? {} : { githubApiOrigin: env('DUAL_RECOVERY_GITHUB_API_URL') }),
        ...(env('DUAL_RECOVERY_CLOUDFLARE_API_URL') === ''
          ? {} : { cloudflareApiOrigin: env('DUAL_RECOVERY_CLOUDFLARE_API_URL') }),
      },
    );
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof DualRecoveryEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`dual-recovery-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
