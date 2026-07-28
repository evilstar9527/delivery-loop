import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BugTriageE2EEvidenceManifestV1Schema } from
  '../src/domain/bug-triage-e2e-evidence.js';
import { AnalysisActionEvidenceManifestV1Schema } from
  '../src/domain/analysis-action-evidence.js';
import {
  BugTriageE2EEvidenceVerificationError,
  verifyBugTriageE2EEvidence,
} from '../src/pilot/bug-triage-e2e-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

function required(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? null : value;
}

async function manifest(path: string): Promise<unknown> {
  const file = await readFile(resolve(path));
  if (file.byteLength > MAX_MANIFEST_BYTES) throw new Error('manifest_too_large');
  return JSON.parse(file.toString('utf8')) as unknown;
}

async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_BUG_TRIAGE_E2E !== '1') {
    console.error('bug-triage-e2e: opt-in missing');
    process.exitCode = 2;
    return;
  }
  const values = {
    evidenceFile: required('BUG_TRIAGE_E2E_EVIDENCE_FILE'),
    analysisFile: required('BUG_TRIAGE_E2E_ANALYSIS_EVIDENCE_FILE'),
    controlPlaneOrigin: required('BUG_TRIAGE_E2E_CONTROL_PLANE_URL'),
    controlPlaneToken: required('BUG_TRIAGE_E2E_CONTROL_PLANE_TOKEN'),
    operationsToken: required('BUG_TRIAGE_E2E_OPERATIONS_TOKEN'),
    githubAppJwt: required('BUG_TRIAGE_E2E_GITHUB_APP_JWT'),
    githubInstallationToken: required('BUG_TRIAGE_E2E_GITHUB_INSTALLATION_AUDIT_TOKEN'),
    expectedRunnerContractDigest: required('BUG_TRIAGE_E2E_RUNNER_CONTRACT_DIGEST'),
    canarySecret: required('BUG_TRIAGE_E2E_CANARY_SECRET'),
  };
  if (Object.values(values).some((value) => value === null)) {
    console.error('bug-triage-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  try {
    const mainRaw = await manifest(values.evidenceFile!);
    const analysisRaw = await manifest(values.analysisFile!);
    const input = BugTriageE2EEvidenceManifestV1Schema.parse(mainRaw);
    const analysisAction = AnalysisActionEvidenceManifestV1Schema.parse(analysisRaw);
    const summary = await verifyBugTriageE2EEvidence(input, { analysisAction }, {
      controlPlaneOrigin: values.controlPlaneOrigin!,
      controlPlaneToken: values.controlPlaneToken!,
      operationsToken: values.operationsToken!,
      githubAppJwt: values.githubAppJwt!,
      githubInstallationToken: values.githubInstallationToken!,
      expectedRunnerContractDigest: values.expectedRunnerContractDigest!,
      canarySecret: values.canarySecret!,
      ...(required('BUG_TRIAGE_E2E_GITHUB_API_URL') === null
        ? {} : { githubApiOrigin: required('BUG_TRIAGE_E2E_GITHUB_API_URL')! }),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    if (error instanceof BugTriageE2EEvidenceVerificationError) {
      console.error(`bug-triage-e2e: verification failed (${error.code})`);
    } else {
      console.error('bug-triage-e2e: evidence prerequisite is unreadable or invalid');
    }
    process.exitCode = 1;
  }
}

await main();
