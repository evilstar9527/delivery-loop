import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ControlledReplayEvidenceManifestV1Schema } from
  '../src/domain/controlled-replay-evidence.js';
import { FeishuIngressEvidenceManifestV1Schema } from
  '../src/domain/feishu-ingress-evidence.js';
import { FeishuRetryEvidenceManifestV1Schema } from
  '../src/domain/feishu-retry-evidence.js';
import { GitHubPullRequestEvidenceManifestV1Schema } from
  '../src/domain/github-pull-request-evidence.js';
import { ReplayFailureE2EEvidenceManifestV1Schema } from
  '../src/domain/replay-failure-e2e-evidence.js';
import {
  ReplayFailureE2EEvidenceVerificationError,
  verifyReplayFailureE2EEvidence,
} from '../src/pilot/replay-failure-e2e-evidence-verifier.js';

const MAX_FILE_BYTES = 64 * 1_024;

class EvidenceReadError extends Error {
  constructor(readonly kind: 'unavailable' | 'invalid') { super(kind); }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

async function jsonFile(path: string): Promise<unknown> {
  let source: string;
  try { source = await readFile(resolve(path), 'utf8'); }
  catch { throw new EvidenceReadError('unavailable'); }
  if (Buffer.byteLength(source, 'utf8') > MAX_FILE_BYTES) {
    throw new EvidenceReadError('invalid');
  }
  try { return JSON.parse(source) as unknown; }
  catch { throw new EvidenceReadError('invalid'); }
}

async function main(): Promise<void> {
  // Watt-derived boundary: explicit opt-in, repository-external 64 KiB files, fixed 0/1/2 exits.
  if (process.env.DELIVERY_LOOP_REPLAY_FAILURE_E2E !== '1') {
    console.error(
      'replay-failure-e2e: opt-in missing (set DELIVERY_LOOP_REPLAY_FAILURE_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const values = {
    manifestFile: env('REPLAY_FAILURE_EVIDENCE_FILE'),
    feishuIngressFile: env('REPLAY_FAILURE_FEISHU_INGRESS_FILE'),
    feishuRetryFile: env('REPLAY_FAILURE_FEISHU_RETRY_FILE'),
    githubPullRequestFile: env('REPLAY_FAILURE_GITHUB_PULL_REQUEST_FILE'),
    controlledReplayFile: env('REPLAY_FAILURE_CONTROLLED_REPLAY_FILE'),
    controlPlaneOrigin: env('REPLAY_FAILURE_CONTROL_PLANE_URL'),
    operationsToken: env('REPLAY_FAILURE_OPERATIONS_TOKEN'),
    queryToken: env('REPLAY_FAILURE_QUERY_TOKEN'),
    githubToken: env('REPLAY_FAILURE_GITHUB_TOKEN'),
    feishuAccessToken: env('REPLAY_FAILURE_FEISHU_ACCESS_TOKEN'),
    feishuIngressObservabilityReportUrl:
      env('REPLAY_FAILURE_FEISHU_INGRESS_OBSERVABILITY_REPORT_URL'),
    feishuIngressObservabilityToken:
      env('REPLAY_FAILURE_FEISHU_INGRESS_OBSERVABILITY_TOKEN'),
    replayObservabilityReportUrl: env('REPLAY_FAILURE_OBSERVABILITY_REPORT_URL'),
    replayObservabilityToken: env('REPLAY_FAILURE_OBSERVABILITY_TOKEN'),
    cloudflareAccountId: env('REPLAY_FAILURE_CLOUDFLARE_ACCOUNT_ID'),
    cloudflareToken: env('REPLAY_FAILURE_CLOUDFLARE_TOKEN'),
    canary: env('REPLAY_FAILURE_SECURITY_CANARY'),
  };
  if (Object.values(values).some((value) => value === '')) {
    console.error('replay-failure-e2e: required external configuration is incomplete');
    process.exitCode = 2;
    return;
  }
  let raw: unknown[];
  try {
    raw = await Promise.all([
      jsonFile(values.manifestFile),
      jsonFile(values.feishuIngressFile),
      jsonFile(values.feishuRetryFile),
      jsonFile(values.githubPullRequestFile),
      jsonFile(values.controlledReplayFile),
    ]);
  } catch (error) {
    const kind = error instanceof EvidenceReadError ? error.kind : 'invalid';
    console.error(`replay-failure-e2e: evidence input is ${kind}`);
    process.exitCode = kind === 'unavailable' ? 2 : 1;
    return;
  }
  const manifest = ReplayFailureE2EEvidenceManifestV1Schema.safeParse(raw[0]);
  const ingress = FeishuIngressEvidenceManifestV1Schema.safeParse(raw[1]);
  const retry = FeishuRetryEvidenceManifestV1Schema.safeParse(raw[2]);
  const github = GitHubPullRequestEvidenceManifestV1Schema.safeParse(raw[3]);
  const controlled = ControlledReplayEvidenceManifestV1Schema.safeParse(raw[4]);
  if ([manifest, ingress, retry, github, controlled].some((item) => !item.success)) {
    console.error('replay-failure-e2e: evidence input is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await verifyReplayFailureE2EEvidence(
      manifest.data!,
      {
        feishuIngress: ingress.data!,
        feishuRetry: retry.data!,
        githubPullRequest: github.data!,
        controlledReplay: controlled.data!,
      },
      {
        controlPlaneOrigin: values.controlPlaneOrigin,
        operationsToken: values.operationsToken,
        queryToken: values.queryToken,
        githubToken: values.githubToken,
        feishuAccessToken: values.feishuAccessToken,
        feishuIngressObservabilityReportUrl: values.feishuIngressObservabilityReportUrl,
        feishuIngressObservabilityToken: values.feishuIngressObservabilityToken,
        replayObservabilityReportUrl: values.replayObservabilityReportUrl,
        replayObservabilityToken: values.replayObservabilityToken,
        cloudflareAccountId: values.cloudflareAccountId,
        cloudflareToken: values.cloudflareToken,
        canary: values.canary,
        ...(env('REPLAY_FAILURE_GITHUB_API_URL') === ''
          ? {} : { githubApiOrigin: env('REPLAY_FAILURE_GITHUB_API_URL') }),
        ...(env('REPLAY_FAILURE_FEISHU_API_URL') === ''
          ? {} : { feishuApiOrigin: env('REPLAY_FAILURE_FEISHU_API_URL') }),
        ...(env('REPLAY_FAILURE_CLOUDFLARE_API_URL') === ''
          ? {} : { cloudflareApiOrigin: env('REPLAY_FAILURE_CLOUDFLARE_API_URL') }),
      },
    );
    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof ReplayFailureE2EEvidenceVerificationError
      ? error.code : 'verification_failed';
    console.error(`replay-failure-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
