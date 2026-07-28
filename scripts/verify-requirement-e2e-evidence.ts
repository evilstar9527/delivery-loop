import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import {
  RequirementE2EEvidenceManifestV1Schema,
  type RequirementE2EEvidenceManifestV1,
} from '../src/domain/requirement-e2e-evidence.js';
import {
  MeegleWorkItemEvidenceManifestV1Schema,
  type MeegleWorkItemEvidenceManifestV1,
} from '../src/domain/meegle-work-item-evidence.js';
import {
  AnalysisActionEvidenceManifestV1Schema,
  type AnalysisActionEvidenceManifestV1,
} from '../src/domain/analysis-action-evidence.js';
import {
  FeishuCardActionEvidenceManifestV1Schema,
  type FeishuCardActionEvidenceManifestV1,
} from '../src/domain/feishu-card-action-evidence.js';
import {
  RequirementE2EEvidenceVerificationError,
  verifyRequirementE2EEvidence,
} from '../src/pilot/requirement-e2e-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

class EvidenceReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readEvidence<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let source: string;
  try { source = await readFile(resolve(file), 'utf8'); }
  catch { throw new EvidenceReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new EvidenceReadError('invalid');
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch { throw new EvidenceReadError('invalid'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new EvidenceReadError('invalid');
  return parsed.data;
}

async function main(): Promise<void> {
  // Reuses Watt@476e3cd's explicit opt-in, bounded manifests, and 0/1/2 exits.
  if (process.env.DELIVERY_LOOP_REQUIREMENT_E2E !== '1') {
    console.error(
      'requirement-e2e: opt-in missing (set DELIVERY_LOOP_REQUIREMENT_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const required = {
    evidenceFile: env('REQUIREMENT_E2E_EVIDENCE_FILE'),
    meegleEvidenceFile: env('REQUIREMENT_E2E_MEEGLE_EVIDENCE_FILE'),
    analysisEvidenceFile: env('REQUIREMENT_E2E_ANALYSIS_EVIDENCE_FILE'),
    feishuCardActionEvidenceFile: env('REQUIREMENT_E2E_FEISHU_CARD_ACTION_EVIDENCE_FILE'),
    controlPlaneOrigin: env('REQUIREMENT_E2E_CONTROL_PLANE_URL'),
    controlPlaneToken: env('REQUIREMENT_E2E_CONTROL_PLANE_TOKEN'),
    operationsToken: env('REQUIREMENT_E2E_OPERATIONS_TOKEN'),
    meegleProfile: env('REQUIREMENT_E2E_MEEGLE_CLI_PROFILE'),
    tenantKey: env('REQUIREMENT_E2E_MEEGLE_TENANT_KEY'),
    projectKey: env('REQUIREMENT_E2E_MEEGLE_PROJECT_KEY'),
    workItemTypeKey: env('REQUIREMENT_E2E_MEEGLE_WORK_ITEM_TYPE_KEY'),
    githubAppJwt: env('REQUIREMENT_E2E_GITHUB_APP_JWT'),
    githubInstallationToken: env('REQUIREMENT_E2E_GITHUB_INSTALLATION_AUDIT_TOKEN'),
    runnerContractDigest: env('REQUIREMENT_E2E_RUNNER_CONTRACT_DIGEST'),
    feishuObservabilityUrl: env('REQUIREMENT_E2E_FEISHU_OBSERVABILITY_URL'),
    feishuObservabilityToken: env('REQUIREMENT_E2E_FEISHU_OBSERVABILITY_TOKEN'),
    canary: env('REQUIREMENT_E2E_CANARY_SECRET'),
    cloudflareAccountId: env('REQUIREMENT_E2E_CLOUDFLARE_ACCOUNT_ID'),
    cloudflareToken: env('REQUIREMENT_E2E_CLOUDFLARE_READ_TOKEN'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error('requirement-e2e: required evidence configuration is incomplete');
    process.exitCode = 2;
    return;
  }

  let manifest: RequirementE2EEvidenceManifestV1;
  let meegleWorkItem: MeegleWorkItemEvidenceManifestV1;
  let analysisAction: AnalysisActionEvidenceManifestV1;
  let feishuCardAction: FeishuCardActionEvidenceManifestV1;
  try {
    [manifest, meegleWorkItem, analysisAction, feishuCardAction] = await Promise.all([
      readEvidence(required.evidenceFile, RequirementE2EEvidenceManifestV1Schema),
      readEvidence(required.meegleEvidenceFile, MeegleWorkItemEvidenceManifestV1Schema),
      readEvidence(required.analysisEvidenceFile, AnalysisActionEvidenceManifestV1Schema),
      readEvidence(
        required.feishuCardActionEvidenceFile,
        FeishuCardActionEvidenceManifestV1Schema,
      ),
    ]);
  } catch (error) {
    const kind = error instanceof EvidenceReadError ? error.kind : 'invalid';
    console.error(`requirement-e2e: evidence manifest is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }

  const meegleBinary = env('REQUIREMENT_E2E_MEEGLE_CLI_BINARY');
  const githubApiOrigin = env('REQUIREMENT_E2E_GITHUB_API_URL');
  const cloudflareApiOrigin = env('REQUIREMENT_E2E_CLOUDFLARE_API_URL');
  try {
    const summary = await verifyRequirementE2EEvidence(
      manifest,
      { meegleWorkItem, analysisAction, feishuCardAction },
      {
        controlPlaneOrigin: required.controlPlaneOrigin,
        controlPlaneToken: required.controlPlaneToken,
        operationsToken: required.operationsToken,
        meegleProfile: required.meegleProfile,
        tenantKey: required.tenantKey,
        projectKey: required.projectKey,
        workItemTypeKey: required.workItemTypeKey,
        githubAppJwt: required.githubAppJwt,
        githubInstallationToken: required.githubInstallationToken,
        expectedRunnerContractDigest: required.runnerContractDigest,
        feishuObservabilityReportUrl: required.feishuObservabilityUrl,
        feishuObservabilityToken: required.feishuObservabilityToken,
        canarySecret: required.canary,
        cloudflareAccountId: required.cloudflareAccountId,
        cloudflareToken: required.cloudflareToken,
        ...(meegleBinary === '' ? {} : { meegleBinary }),
        ...(githubApiOrigin === '' ? {} : { githubApiOrigin }),
        ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
      },
    );
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof RequirementE2EEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`requirement-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
