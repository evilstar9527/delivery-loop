import { canonicalSha256 } from '../domain/digest.js';
import {
  ControlledReplayEvidenceManifestV1Schema,
  type ControlledReplayEvidenceManifestV1,
} from '../domain/controlled-replay-evidence.js';
import {
  FeishuIngressEvidenceManifestV1Schema,
  type FeishuIngressEvidenceManifestV1,
} from '../domain/feishu-ingress-evidence.js';
import {
  FeishuRetryEvidenceManifestV1Schema,
  type FeishuRetryEvidenceManifestV1,
} from '../domain/feishu-retry-evidence.js';
import {
  GitHubPullRequestEvidenceManifestV1Schema,
  type GitHubPullRequestEvidenceManifestV1,
} from '../domain/github-pull-request-evidence.js';
import {
  ReplayFailureE2EEvidenceManifestV1Schema,
  ReplayFailureObservabilityReportV1Schema,
  type ReplayFailureE2EEvidenceManifestV1,
  type ReplayFailureObservabilityReportV1,
} from '../domain/replay-failure-e2e-evidence.js';
import { SecretScanner } from '../security/redaction.js';
import { verifyControlledReplayEvidence } from './controlled-replay-evidence-verifier.js';
import { verifyFeishuIngressEvidence } from './feishu-ingress-evidence-verifier.js';
import { verifyFeishuRetryEvidence } from './feishu-retry-evidence-verifier.js';
import { verifyGitHubPullRequestEvidence } from './github-pull-request-evidence-verifier.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,20000}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export type ReplayFailureE2EEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'component_manifest_invalid'
  | 'configuration_invalid'
  | 'component_digest_mismatch'
  | 'composition_mismatch'
  | 'observability_report_unavailable'
  | 'observability_response_invalid'
  | 'observability_digest_mismatch'
  | 'github_replay_mismatch'
  | 'callback_recovery_mismatch'
  | 'queue_replay_mismatch'
  | 'duplicate_pull_request'
  | 'component_verification_failed'
  | 'external_response_invalid'
  | 'secret_leak_detected';

export class ReplayFailureE2EEvidenceVerificationError extends Error {
  constructor(readonly code: ReplayFailureE2EEvidenceVerificationErrorCode) {
    super(`Replay/failure E2E evidence verification failed: ${code}`);
    this.name = 'ReplayFailureE2EEvidenceVerificationError';
  }
}

export interface ReplayFailureE2EEvidenceComponents {
  feishuIngress: FeishuIngressEvidenceManifestV1;
  feishuRetry: FeishuRetryEvidenceManifestV1;
  githubPullRequest: GitHubPullRequestEvidenceManifestV1;
  controlledReplay: ControlledReplayEvidenceManifestV1;
}

export interface ReplayFailureE2EEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  queryToken: string;
  githubToken: string;
  feishuAccessToken: string;
  feishuIngressObservabilityReportUrl: string;
  feishuIngressObservabilityToken: string;
  replayObservabilityReportUrl: string;
  replayObservabilityToken: string;
  cloudflareAccountId: string;
  cloudflareToken: string;
  canary: string;
  githubApiOrigin?: string;
  feishuApiOrigin?: string;
  cloudflareApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface ReplayFailureE2EEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  verifiedComponentCount: 4;
  distinctRunCount: 3;
  feishuReplayCount: 3;
  githubReplayCount: 3;
  queueReplayCount: 3;
  recoveredCallbackCount: 1;
  rateLimitRecovery: 'verified';
  finalRunState: 'succeeded';
  duplicateTasks: 0;
  duplicateRuns: 0;
  duplicateDispatches: 0;
  duplicatePullRequests: 0;
  duplicateDeployments: 0;
  plaintextLeaks: 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = parent[key];
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new ReplayFailureE2EEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new ReplayFailureE2EEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function safeBoundUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new ReplayFailureE2EEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) throw new ReplayFailureE2EEvidenceVerificationError('configuration_invalid');
  return url.toString();
}

async function readBounded(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Watt-derived bounded HTTPS boundary, shared by every composed verifier. */
function secureFetch(base: typeof fetch, scanner: SecretScanner): typeof fetch {
  return (async (input, init) => {
    const response = await base(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
    if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
      await response.body?.cancel();
      throw new ReplayFailureE2EEvidenceVerificationError('external_response_invalid');
    }
    const clone = response.clone();
    const bytes = await readBounded(clone);
    if (bytes === null) {
      await response.body?.cancel();
      throw new ReplayFailureE2EEvidenceVerificationError('external_response_invalid');
    }
    if (scanner.scanText(new TextDecoder().decode(bytes), '$.externalResponse').length > 0) {
      await response.body?.cancel();
      throw new ReplayFailureE2EEvidenceVerificationError('secret_leak_detected');
    }
    return response;
  }) as typeof fetch;
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  unavailableCode: ReplayFailureE2EEvidenceVerificationErrorCode,
): Promise<{ body: unknown; headers: Headers }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof ReplayFailureE2EEvidenceVerificationError) throw error;
    throw new ReplayFailureE2EEvidenceVerificationError(unavailableCode);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReplayFailureE2EEvidenceVerificationError(unavailableCode);
  }
  try {
    return { body: await response.json() as unknown, headers: response.headers };
  } catch {
    throw new ReplayFailureE2EEvidenceVerificationError('external_response_invalid');
  }
}

function inWindow(value: string, manifest: ReplayFailureE2EEvidenceManifestV1): boolean {
  const timestamp = Date.parse(value);
  return timestamp >= Date.parse(manifest.observedWindow.startedAt) &&
    timestamp <= Date.parse(manifest.observedWindow.endedAt);
}

async function verifyObservability(
  manifest: ReplayFailureE2EEvidenceManifestV1,
  options: ReplayFailureE2EEvidenceVerifierOptions,
  fetcher: typeof fetch,
): Promise<ReplayFailureObservabilityReportV1> {
  const raw = await getJson(
    fetcher,
    manifest.observability.reportUrl,
    options.replayObservabilityToken,
    'observability_report_unavailable',
  );
  const parsed = ReplayFailureObservabilityReportV1Schema.safeParse(raw.body);
  if (!parsed.success) {
    throw new ReplayFailureE2EEvidenceVerificationError('observability_response_invalid');
  }
  const { reportDigest, ...body } = parsed.data;
  if (
    parsed.data.evidenceId !== manifest.evidenceId ||
    reportDigest !== manifest.observability.reportDigest ||
    await canonicalSha256(body) !== reportDigest || !inWindow(parsed.data.generatedAt, manifest)
  ) throw new ReplayFailureE2EEvidenceVerificationError('observability_digest_mismatch');
  return parsed.data;
}

function verifyReportBindings(
  report: ReplayFailureObservabilityReportV1,
  manifest: ReplayFailureE2EEvidenceManifestV1,
  github: GitHubPullRequestEvidenceManifestV1,
): void {
  const githubRequests = report.githubRequests;
  const queueRequests = report.queueReplayRequests;
  if (
    githubRequests.some((request) =>
      request.deliveryId !== manifest.components.githubPullRequest.deliveryId ||
      request.deliveryId !== github.publication.webhook.deliveryId ||
      request.payloadDigest !== github.publication.webhook.payloadDigest) ||
    queueRequests.some((request) =>
      request.deadLetterId !== manifest.queueReplay.deadLetterId ||
      request.outboxId !== manifest.queueReplay.outboxId ||
      request.replayId !== manifest.queueReplay.replayId ||
      request.expectedOutboxAttemptCount !== manifest.queueReplay.expectedOutboxAttemptCount ||
      request.reasonCode !== manifest.queueReplay.reasonCode) ||
    [...githubRequests, ...queueRequests].some((request) => !inWindow(request.completedAt, manifest))
  ) throw new ReplayFailureE2EEvidenceVerificationError('github_replay_mismatch');
}

function verifyCallbackRecovery(
  raw: unknown,
  manifest: ReplayFailureE2EEvidenceManifestV1,
  controlled: ControlledReplayEvidenceManifestV1,
): void {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const answers = root === null ? null : record(root.answers);
  const checks = answers === null ? null : record(answers.checks);
  const expected = manifest.callbackRecovery;
  if (
    root === null || run === null || checks === null || root.schemaVersion !== '1' ||
    root.runId !== controlled.runId || run.state !== 'succeeded' ||
    expected.publicationId !== controlled.pullRequest.publicationId
  ) throw new ReplayFailureE2EEvidenceVerificationError('callback_recovery_mismatch');
  const observations = rows(checks, 'pullRequestObservations').filter((observation) =>
    observation.publicationId === expected.publicationId);
  const api = observations.filter((observation) => observation.sourceKind === 'api');
  const webhook = observations.filter((observation) => observation.sourceKind === 'webhook');
  const observation = api[0];
  if (
    api.length !== expected.apiObservationCount ||
    webhook.length !== expected.webhookObservationCount || observation === undefined ||
    observation.sourceId !== expected.apiObservationId ||
    observation.factDigest !== expected.factDigest ||
    observation.repository !== manifest.repository ||
    observation.githubPrNumber !== controlled.pullRequest.number ||
    observation.processingState !== 'applied' || observation.ignoreReason !== null ||
    observation.externalUpdatedAt !== expected.externalUpdatedAt ||
    observation.observedAt !== expected.observedAt ||
    observation.processedAt !== expected.processedAt ||
    !inWindow(expected.processedAt, manifest)
  ) throw new ReplayFailureE2EEvidenceVerificationError('callback_recovery_mismatch');
}

function verifyResolvedDeadLetter(
  raw: unknown,
  manifest: ReplayFailureE2EEvidenceManifestV1,
  controlled: ControlledReplayEvidenceManifestV1,
): void {
  const root = record(raw);
  const deadLetters = root === null ? [] : rows(root, 'deadLetters');
  const expected = manifest.queueReplay;
  const matches = deadLetters.filter((deadLetter) => deadLetter.id === expected.deadLetterId);
  const deadLetter = matches[0];
  if (
    root === null || root.schemaVersion !== '1' || matches.length !== 1 || deadLetter === undefined ||
    !controlled.replay.dispatchOutboxIds.includes(expected.outboxId) ||
    deadLetter.outboxId !== expected.outboxId || deadLetter.runId !== expected.runId ||
    deadLetter.sourceQueue !== expected.sourceQueue ||
    deadLetter.sourceAttempts !== expected.sourceAttempts ||
    deadLetter.outboxKind !== expected.outboxKind ||
    deadLetter.destination !== expected.destination ||
    deadLetter.outboxAttemptCount !== expected.expectedOutboxAttemptCount ||
    deadLetter.status !== 'resolved' || deadLetter.capturedAt !== expected.capturedAt ||
    deadLetter.replayRequestedAt !== expected.replayRequestedAt ||
    deadLetter.resolvedAt !== expected.resolvedAt ||
    deadLetter.resolutionCode !== expected.resolutionCode ||
    !inWindow(expected.capturedAt, manifest) || !inWindow(expected.resolvedAt, manifest)
  ) throw new ReplayFailureE2EEvidenceVerificationError('queue_replay_mismatch');
}

async function verifyPullRequestInventory(
  fetcher: typeof fetch,
  githubOrigin: string,
  token: string,
  github: GitHubPullRequestEvidenceManifestV1,
): Promise<void> {
  const owner = github.repository.split('/')[0]!;
  const query = new URLSearchParams({
    state: 'all',
    head: `${owner}:${github.publication.headBranch}`,
    base: github.publication.baseBranch,
    per_page: '100',
  });
  const response = await getJson(
    fetcher,
    `${githubOrigin}/repos/${github.repository}/pulls?${query.toString()}`,
    token,
    'external_response_invalid',
  );
  if (!Array.isArray(response.body) || response.headers.has('link')) {
    throw new ReplayFailureE2EEvidenceVerificationError('duplicate_pull_request');
  }
  const matches = response.body.map(record).filter((item): item is Record<string, unknown> =>
    item !== null && item.number === github.publication.number);
  if (response.body.length !== 1 || matches.length !== 1) {
    throw new ReplayFailureE2EEvidenceVerificationError('duplicate_pull_request');
  }
}

/** Composes existing authorities; caller-supplied component verifiers are intentionally unsupported. */
export async function verifyReplayFailureE2EEvidence(
  rawManifest: unknown,
  rawComponents: ReplayFailureE2EEvidenceComponents,
  options: ReplayFailureE2EEvidenceVerifierOptions,
): Promise<ReplayFailureE2EEvidenceVerificationSummary> {
  const parsedManifest = ReplayFailureE2EEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    throw new ReplayFailureE2EEvidenceVerificationError('manifest_invalid');
  }
  const components = {
    feishuIngress: FeishuIngressEvidenceManifestV1Schema.safeParse(rawComponents.feishuIngress),
    feishuRetry: FeishuRetryEvidenceManifestV1Schema.safeParse(rawComponents.feishuRetry),
    githubPullRequest: GitHubPullRequestEvidenceManifestV1Schema.safeParse(
      rawComponents.githubPullRequest,
    ),
    controlledReplay: ControlledReplayEvidenceManifestV1Schema.safeParse(
      rawComponents.controlledReplay,
    ),
  };
  if (Object.values(components).some((component) => !component.success)) {
    throw new ReplayFailureE2EEvidenceVerificationError('component_manifest_invalid');
  }
  const manifest = parsedManifest.data;
  const ingress = components.feishuIngress.data!;
  const retry = components.feishuRetry.data!;
  const github = components.githubPullRequest.data!;
  const controlled = components.controlledReplay.data!;
  const tokens = [
    options.operationsToken, options.queryToken, options.githubToken,
    options.feishuAccessToken, options.feishuIngressObservabilityToken,
    options.replayObservabilityToken, options.cloudflareToken,
  ];
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const configuredReplayReportUrl = safeBoundUrl(options.replayObservabilityReportUrl);
  if (
    tokens.some((token) => !TOKEN_PATTERN.test(token)) ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    configuredReplayReportUrl !== manifest.observability.reportUrl ||
    await canonicalSha256(options.canary) !== manifest.safety.canaryDigest
  ) throw new ReplayFailureE2EEvidenceVerificationError('configuration_invalid');

  const componentPairs = [
    [manifest.components.feishuIngress, ingress],
    [manifest.components.feishuRetry, retry],
    [manifest.components.githubPullRequest, github],
    [manifest.components.controlledReplay, controlled],
  ] as const;
  const digests = await Promise.all(componentPairs.map(async ([identity, component]) =>
    await canonicalSha256(component) === identity.manifestDigest));
  if (digests.some((matches) => !matches)) {
    throw new ReplayFailureE2EEvidenceVerificationError('component_digest_mismatch');
  }
  if (
    componentPairs.some(([identity, component]) => identity.evidenceId !== component.evidenceId) ||
    manifest.components.feishuIngress.runId !== ingress.task.runId ||
    manifest.components.feishuRetry.runId !== retry.runId ||
    manifest.components.githubPullRequest.runId !== github.runId ||
    manifest.components.githubPullRequest.publicationId !== github.publication.publicationId ||
    manifest.components.githubPullRequest.deliveryId !== github.publication.webhook.deliveryId ||
    manifest.components.controlledReplay.runId !== controlled.runId ||
    retry.repository !== manifest.repository || github.repository !== manifest.repository ||
    controlled.repository !== manifest.repository || ingress.tenantKey !== retry.card.tenantKey ||
    manifest.callbackRecovery.publicationId !== controlled.pullRequest.publicationId ||
    manifest.queueReplay.outboxId === controlled.replay.outboxId ||
    !controlled.replay.dispatchOutboxIds.includes(manifest.queueReplay.outboxId) ||
    componentPairs.some(([, component]) => !inWindow(component.recordedAt, manifest))
  ) throw new ReplayFailureE2EEvidenceVerificationError('composition_mismatch');

  const scanner = new SecretScanner({ secrets: [...tokens, options.canary] });
  const fetcher = secureFetch(options.fetch ?? fetch, scanner);
  const [report, controlledAudit, deadLetters] = await Promise.all([
    verifyObservability(manifest, options, fetcher),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${controlled.runId}/audit`,
      options.operationsToken,
      'external_response_invalid',
    ),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/dead-letters?status=resolved&limit=100`,
      options.operationsToken,
      'external_response_invalid',
    ),
  ]);
  verifyReportBindings(report, manifest, github);
  verifyCallbackRecovery(controlledAudit.body, manifest, controlled);
  verifyResolvedDeadLetter(deadLetters.body, manifest, controlled);
  await verifyPullRequestInventory(fetcher, githubOrigin, options.githubToken, github);

  try {
    const summaries = await Promise.all([
      verifyFeishuIngressEvidence(ingress, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        operationsToken: options.operationsToken,
        observabilityReportUrl: options.feishuIngressObservabilityReportUrl,
        observabilityToken: options.feishuIngressObservabilityToken,
        cloudflareAccountId: options.cloudflareAccountId,
        cloudflareToken: options.cloudflareToken,
        ...(options.cloudflareApiOrigin === undefined
          ? {} : { cloudflareApiOrigin: options.cloudflareApiOrigin }),
        fetch: fetcher,
      }),
      verifyFeishuRetryEvidence(retry, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        operationsToken: options.operationsToken,
        feishuAccessToken: options.feishuAccessToken,
        ...(options.feishuApiOrigin === undefined
          ? {} : { feishuApiOrigin: options.feishuApiOrigin }),
        fetch: fetcher,
      }),
      verifyGitHubPullRequestEvidence(github, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        controlPlaneToken: options.operationsToken,
        githubToken: options.githubToken,
        ...(options.githubApiOrigin === undefined
          ? {} : { githubApiOrigin: options.githubApiOrigin }),
        fetch: fetcher,
      }),
      verifyControlledReplayEvidence(controlled, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        operationsToken: options.operationsToken,
        queryToken: options.queryToken,
        githubToken: options.githubToken,
        ...(options.githubApiOrigin === undefined
          ? {} : { githubApiOrigin: options.githubApiOrigin }),
        fetch: fetcher,
      }),
    ]);
    const [ingressSummary, retrySummary, githubSummary, controlledSummary] = summaries;
    if (
      ingressSummary.evidenceId !== ingress.evidenceId ||
      ingressSummary.replayTransportReceiptCount !== 3 ||
      ingressSummary.duplicateTasks !== 0 || ingressSummary.duplicateRuns !== 0 ||
      retrySummary.evidenceId !== retry.evidenceId ||
      !retrySummary.retryCodes.includes('feishu_rate_limited') ||
      retrySummary.refresh !== 'verified' ||
      githubSummary.evidenceId !== github.evidenceId || githubSummary.webhook !== 'applied' ||
      githubSummary.apiObservation !== 'applied' ||
      controlledSummary.evidenceId !== controlled.evidenceId ||
      controlledSummary.replay !== 'verified' ||
      controlledSummary.duplicateDispatchCount !== 0 ||
      controlledSummary.duplicatePullRequestCount !== 0 ||
      controlledSummary.duplicateDeploymentCount !== 0
    ) throw new ReplayFailureE2EEvidenceVerificationError('component_verification_failed');
  } catch (error) {
    if (error instanceof ReplayFailureE2EEvidenceVerificationError) throw error;
    throw new ReplayFailureE2EEvidenceVerificationError('component_verification_failed');
  }

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    verifiedComponentCount: 4,
    distinctRunCount: 3,
    feishuReplayCount: 3,
    githubReplayCount: 3,
    queueReplayCount: 3,
    recoveredCallbackCount: 1,
    rateLimitRecovery: 'verified',
    finalRunState: 'succeeded',
    duplicateTasks: 0,
    duplicateRuns: 0,
    duplicateDispatches: 0,
    duplicatePullRequests: 0,
    duplicateDeployments: 0,
    plaintextLeaks: 0,
  };
}
