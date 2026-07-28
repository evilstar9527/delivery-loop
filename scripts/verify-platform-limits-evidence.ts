import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PlatformLimitsEvidenceManifestV1Schema,
  type PlatformLimitsEvidenceManifestV1,
} from '../src/domain/platform-limits-evidence.js';
import {
  RunnerHeartbeatEvidenceManifestV1Schema,
  type RunnerHeartbeatEvidenceManifestV1,
} from '../src/domain/runner-heartbeat-evidence.js';
import {
  WorkflowHibernateEvidenceManifestV1Schema,
  type WorkflowHibernateEvidenceManifestV1,
} from '../src/domain/workflow-hibernate-evidence.js';
import {
  ControlledReplayEvidenceManifestV1Schema,
  type ControlledReplayEvidenceManifestV1,
} from '../src/domain/controlled-replay-evidence.js';
import {
  PlatformLimitsEvidenceVerificationError,
  verifyPlatformLimitsEvidence,
} from '../src/pilot/platform-limits-evidence-verifier.js';

const MAX_MANIFEST_BYTES = 64 * 1_024;

interface SafeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

class ManifestReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function readManifest<T>(file: string, schema: SafeSchema<T>): Promise<T> {
  let source: string;
  try { source = await readFile(resolve(file), 'utf8'); }
  catch { throw new ManifestReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestReadError('invalid');
  }
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch { throw new ManifestReadError('invalid'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ManifestReadError('invalid');
  return parsed.data;
}

async function main(): Promise<void> {
  // Directly reuse Watt's explicit opt-in and stable 0/1/2 E2E exit discipline.
  if (process.env.DELIVERY_LOOP_PLATFORM_LIMITS_E2E !== '1') {
    console.error(
      'platform-limits-e2e: opt-in missing ' +
      '(set DELIVERY_LOOP_PLATFORM_LIMITS_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const required = {
    platformFile: env('PLATFORM_LIMITS_EVIDENCE_FILE'),
    githubOrgToken: env('PLATFORM_LIMITS_GITHUB_ORG_TOKEN'),
    heartbeatFile: env('RUNNER_HEARTBEAT_EVIDENCE_FILE'),
    controlPlaneOrigin: env('RUNNER_HEARTBEAT_CONTROL_PLANE_URL'),
    controlPlaneToken: env('RUNNER_HEARTBEAT_CONTROL_PLANE_TOKEN'),
    operationsToken: env('RUNNER_HEARTBEAT_OPERATIONS_TOKEN'),
    githubAppJwt: env('RUNNER_HEARTBEAT_APP_JWT'),
    githubInstallationToken: env('RUNNER_HEARTBEAT_INSTALLATION_AUDIT_TOKEN'),
    runnerContractDigest: env('RUNNER_HEARTBEAT_RUNNER_CONTRACT_DIGEST'),
    hibernateFile: env('WORKFLOW_HIBERNATE_EVIDENCE_FILE'),
    hibernateControlPlaneOrigin: env('WORKFLOW_HIBERNATE_CONTROL_PLANE_URL'),
    hibernateControlPlaneToken: env('WORKFLOW_HIBERNATE_CONTROL_PLANE_TOKEN'),
    hibernateOperationsToken: env('WORKFLOW_HIBERNATE_OPERATIONS_TOKEN'),
    hibernateGithubToken: env('WORKFLOW_HIBERNATE_GITHUB_TOKEN'),
    cloudflareToken: env('WORKFLOW_HIBERNATE_CLOUDFLARE_TOKEN'),
    cloudflareAccountId: env('WORKFLOW_HIBERNATE_CLOUDFLARE_ACCOUNT_ID'),
    hibernateCanary: env('WORKFLOW_HIBERNATE_SECURITY_CANARY'),
    replayFile: env('CONTROLLED_REPLAY_EVIDENCE_FILE'),
    replayControlPlaneOrigin: env('CONTROLLED_REPLAY_CONTROL_PLANE_URL'),
    replayOperationsToken: env('CONTROLLED_REPLAY_OPERATIONS_TOKEN'),
    replayQueryToken: env('CONTROLLED_REPLAY_QUERY_TOKEN'),
    replayGithubToken: env('CONTROLLED_REPLAY_GITHUB_TOKEN'),
  };
  if (Object.values(required).some((value) => value === '')) {
    console.error('platform-limits-e2e: required platform limits configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let platform: PlatformLimitsEvidenceManifestV1;
  let heartbeat: RunnerHeartbeatEvidenceManifestV1;
  let hibernate: WorkflowHibernateEvidenceManifestV1;
  let replay: ControlledReplayEvidenceManifestV1;
  try {
    [platform, heartbeat, hibernate, replay] = await Promise.all([
      readManifest(required.platformFile, PlatformLimitsEvidenceManifestV1Schema),
      readManifest(required.heartbeatFile, RunnerHeartbeatEvidenceManifestV1Schema),
      readManifest(required.hibernateFile, WorkflowHibernateEvidenceManifestV1Schema),
      readManifest(required.replayFile, ControlledReplayEvidenceManifestV1Schema),
    ]);
  } catch (error) {
    const kind = error instanceof ManifestReadError ? error.kind : 'invalid';
    console.error(`platform-limits-e2e: evidence manifest is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const githubApiOrigin = env('PLATFORM_LIMITS_GITHUB_API_URL');
  const heartbeatGithubApiOrigin = env('RUNNER_HEARTBEAT_GITHUB_API_URL');
  const hibernateGithubApiOrigin = env('WORKFLOW_HIBERNATE_GITHUB_API_URL');
  const cloudflareApiOrigin = env('WORKFLOW_HIBERNATE_CLOUDFLARE_API_URL');
  const replayGithubApiOrigin = env('CONTROLLED_REPLAY_GITHUB_API_URL');
  try {
    const summary = await verifyPlatformLimitsEvidence(platform, {
      githubToken: required.githubOrgToken,
      ...(githubApiOrigin === '' ? {} : { githubApiOrigin }),
      runnerHeartbeat: {
        manifest: heartbeat,
        options: {
          controlPlaneOrigin: required.hibernateControlPlaneOrigin,
          controlPlaneToken: required.hibernateControlPlaneToken,
          operationsToken: required.hibernateOperationsToken,
          githubAppJwt: required.githubAppJwt,
          githubInstallationToken: required.githubInstallationToken,
          expectedRunnerContractDigest: required.runnerContractDigest,
          ...(heartbeatGithubApiOrigin === '' ? {} : {
            githubApiOrigin: heartbeatGithubApiOrigin,
          }),
        },
      },
      workflowHibernate: {
        manifest: hibernate,
        options: {
          controlPlaneOrigin: required.controlPlaneOrigin,
          controlPlaneToken: required.controlPlaneToken,
          operationsToken: required.operationsToken,
          githubToken: required.hibernateGithubToken,
          cloudflareToken: required.cloudflareToken,
          cloudflareAccountId: required.cloudflareAccountId,
          canary: required.hibernateCanary,
          ...(hibernateGithubApiOrigin === '' ? {} : {
            githubApiOrigin: hibernateGithubApiOrigin,
          }),
          ...(cloudflareApiOrigin === '' ? {} : { cloudflareApiOrigin }),
        },
      },
      controlledReplay: {
        manifest: replay,
        options: {
          controlPlaneOrigin: required.replayControlPlaneOrigin,
          operationsToken: required.replayOperationsToken,
          queryToken: required.replayQueryToken,
          githubToken: required.replayGithubToken,
          ...(replayGithubApiOrigin === '' ? {} : {
            githubApiOrigin: replayGithubApiOrigin,
          }),
        },
      },
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof PlatformLimitsEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`platform-limits-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
