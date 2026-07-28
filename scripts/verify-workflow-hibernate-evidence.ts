import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkflowHibernateEvidenceManifestV1Schema } from '../src/domain/workflow-hibernate-evidence.js';
import {
  WorkflowHibernateEvidenceVerificationError,
  verifyWorkflowHibernateEvidence,
} from '../src/pilot/workflow-hibernate-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E !== '1') {
    console.error(
      'workflow-hibernate-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const manifestFile = env('WORKFLOW_HIBERNATE_EVIDENCE_FILE');
  const controlPlaneOrigin = env('WORKFLOW_HIBERNATE_CONTROL_PLANE_URL');
  const controlPlaneToken = env('WORKFLOW_HIBERNATE_CONTROL_PLANE_TOKEN');
  const operationsToken = env('WORKFLOW_HIBERNATE_OPERATIONS_TOKEN');
  const githubToken = env('WORKFLOW_HIBERNATE_GITHUB_TOKEN');
  const cloudflareToken = env('WORKFLOW_HIBERNATE_CLOUDFLARE_TOKEN');
  const cloudflareAccountId = env('WORKFLOW_HIBERNATE_CLOUDFLARE_ACCOUNT_ID');
  const canary = env('WORKFLOW_HIBERNATE_SECURITY_CANARY');
  if (
    manifestFile === '' || controlPlaneOrigin === '' || controlPlaneToken === '' ||
    operationsToken === '' || githubToken === '' || cloudflareToken === '' ||
    cloudflareAccountId === '' || canary === ''
  ) {
    console.error('workflow-hibernate-e2e: required hibernate configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let source: string;
  try { source = await readFile(resolve(manifestFile), 'utf8'); }
  catch {
    console.error('workflow-hibernate-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    console.error('workflow-hibernate-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  let input: unknown;
  try { input = JSON.parse(source) as unknown; }
  catch {
    console.error('workflow-hibernate-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  const parsed = WorkflowHibernateEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    console.error('workflow-hibernate-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyWorkflowHibernateEvidence(parsed.data, {
      controlPlaneOrigin,
      controlPlaneToken,
      operationsToken,
      githubToken,
      cloudflareToken,
      cloudflareAccountId,
      canary,
      ...(env('WORKFLOW_HIBERNATE_GITHUB_API_URL') === ''
        ? {} : { githubApiOrigin: env('WORKFLOW_HIBERNATE_GITHUB_API_URL') }),
      ...(env('WORKFLOW_HIBERNATE_CLOUDFLARE_API_URL') === ''
        ? {} : { cloudflareApiOrigin: env('WORKFLOW_HIBERNATE_CLOUDFLARE_API_URL') }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof WorkflowHibernateEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`workflow-hibernate-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
