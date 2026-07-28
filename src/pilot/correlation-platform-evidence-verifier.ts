import { canonicalSha256 } from '../domain/digest.js';
import {
  CorrelationPlatformEvidenceManifestV1Schema,
  CorrelationPlatformLogRecordV1Schema,
  type CorrelationPlatformEvidenceManifestV1,
  type CorrelationPlatformLogRecordV1,
} from '../domain/correlation-platform-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

export type CorrelationPlatformEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_correlation_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_fact_mismatch'
  | 'cloudflare_api_unavailable'
  | 'cloudflare_response_invalid'
  | 'cloudflare_log_mismatch'
  | 'cloudflare_trace_mismatch'
  | 'secret_leak_detected';

export class CorrelationPlatformEvidenceVerificationError extends Error {
  constructor(readonly code: CorrelationPlatformEvidenceVerificationErrorCode) {
    super(`Correlation platform evidence verification failed: ${code}`);
    this.name = 'CorrelationPlatformEvidenceVerificationError';
  }
}

export interface CorrelationPlatformEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  cloudflareAccountId: string;
  cloudflareObservabilityToken: string;
  canary: string;
  githubApiOrigin?: string;
  cloudflareApiOrigin?: string;
  fetcher?: typeof fetch;
}

export interface CorrelationPlatformEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  verifiedLookups: 10;
  controlPlaneQueries: 10;
  githubFacts: 4;
  cloudflareLogQueries: 10;
  cloudflareTraces: 10;
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
}

type Source = 'control_plane' | 'github' | 'cloudflare';
type Lookup = CorrelationPlatformEvidenceManifestV1['lookups'][number];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = parent[key];
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new CorrelationPlatformEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new CorrelationPlatformEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return '';
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
  return new TextDecoder().decode(result);
}

function unavailable(source: Source): CorrelationPlatformEvidenceVerificationErrorCode {
  if (source === 'control_plane') return 'control_plane_unavailable';
  if (source === 'github') return 'github_api_unavailable';
  return 'cloudflare_api_unavailable';
}

function invalid(source: Source): CorrelationPlatformEvidenceVerificationErrorCode {
  if (source === 'control_plane') return 'control_plane_response_invalid';
  if (source === 'github') return 'github_response_invalid';
  return 'cloudflare_response_invalid';
}

async function externalJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  source: Source,
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CorrelationPlatformEvidenceVerificationError(unavailable(source));
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CorrelationPlatformEvidenceVerificationError(invalid(source));
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new CorrelationPlatformEvidenceVerificationError(invalid(source)); }
  if (text === null) {
    throw new CorrelationPlatformEvidenceVerificationError(invalid(source));
  }
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new CorrelationPlatformEvidenceVerificationError('secret_leak_detected');
  }
  if (!response.ok) {
    throw new CorrelationPlatformEvidenceVerificationError(unavailable(source));
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new CorrelationPlatformEvidenceVerificationError(invalid(source)); }
}

function uniqueMatch(
  values: Array<Record<string, unknown>>,
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0]! : null;
}

function lookupRepository(lookup: Lookup): string | undefined {
  return 'repository' in lookup && typeof lookup.repository === 'string'
    ? lookup.repository
    : undefined;
}

function validateControlProjection(
  raw: unknown,
  manifest: CorrelationPlatformEvidenceManifestV1,
  lookup: Lookup,
): void {
  const root = record(raw);
  const matchedBy = root === null ? null : record(root.matchedBy);
  const task = root === null ? null : record(root.task);
  const run = root === null ? null : record(root.run);
  const truncated = root === null ? null : record(root.truncated);
  const repository = lookupRepository(lookup);
  if (
    root === null || matchedBy === null || task === null || run === null ||
    truncated === null || root.schemaVersion !== '1' ||
    root.correlationId !== manifest.runId || task.id !== manifest.lineage.taskId ||
    run.id !== manifest.runId || run.state !== 'succeeded' ||
    matchedBy.kind !== lookup.kind || matchedBy.id !== lookup.id ||
    matchedBy.repository !== repository ||
    ['attempts', 'githubRuns', 'pullRequests', 'deployments', 'traces']
      .some((key) => truncated[key] !== false)
  ) throw new CorrelationPlatformEvidenceVerificationError(
    'control_plane_correlation_mismatch',
  );

  const attempt = uniqueMatch(records(root, 'attempts'),
    (item) => item.id === manifest.lineage.attemptId);
  const githubRun = uniqueMatch(records(root, 'githubRuns'),
    (item) => item.id === manifest.lineage.githubRun.id);
  const pullRequest = uniqueMatch(records(root, 'pullRequests'),
    (item) => item.number === manifest.lineage.pullRequest.number);
  const testDeployment = uniqueMatch(records(root, 'deployments'),
    (item) => item.kind === 'test' && item.id === manifest.lineage.testDeployment.deploymentId);
  const productionDeployment = uniqueMatch(records(root, 'deployments'),
    (item) => item.kind === 'production' &&
      item.id === manifest.lineage.productionDeployment.deploymentId);
  const trace = uniqueMatch(records(root, 'traces'),
    (item) => item.id === manifest.lineage.toolTraceId);
  if (
    attempt === null || attempt.mode !== 'implement' || attempt.status !== 'completed' ||
    attempt.githubRunId !== manifest.lineage.githubRun.id ||
    attempt.githubStatus !== 'completed' || attempt.githubConclusion !== 'success' ||
    githubRun === null || githubRun.kind !== 'agent' ||
    githubRun.attemptId !== manifest.lineage.attemptId ||
    githubRun.status !== 'completed' || githubRun.conclusion !== 'success' ||
    pullRequest === null || pullRequest.status !== 'verified' ||
    pullRequest.url !==
      `https://github.com/${manifest.repository}/pull/${manifest.lineage.pullRequest.number}` ||
    testDeployment === null || testDeployment.status !== 'succeeded' ||
    testDeployment.sha !== manifest.lineage.testDeployment.sha ||
    testDeployment.githubDeploymentId !==
      manifest.lineage.testDeployment.githubDeploymentId ||
    productionDeployment === null || productionDeployment.status !== 'succeeded' ||
    productionDeployment.sha !== manifest.lineage.productionDeployment.sha ||
    productionDeployment.githubDeploymentId !==
      manifest.lineage.productionDeployment.githubDeploymentId ||
    trace === null || trace.attemptId !== manifest.lineage.attemptId ||
    trace.resultCategory !== 'success'
  ) throw new CorrelationPlatformEvidenceVerificationError(
    'control_plane_correlation_mismatch',
  );
}

async function verifyControlPlane(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  scanner: SecretScanner,
  manifest: CorrelationPlatformEvidenceManifestV1,
): Promise<void> {
  for (const lookup of manifest.lookups) {
    const params = new URLSearchParams({ kind: lookup.kind, id: lookup.id });
    const repository = lookupRepository(lookup);
    if (repository !== undefined) params.set('repository', repository);
    const raw = await externalJson(
      fetcher,
      `${origin}/v1/correlations?${params.toString()}`,
      {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      },
      'control_plane',
      scanner,
    );
    validateControlProjection(raw, manifest, lookup);
  }
}

async function verifyGitHub(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  scanner: SecretScanner,
  manifest: CorrelationPlatformEvidenceManifestV1,
): Promise<void> {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const repositoryPath = `/repos/${manifest.repository}`;
  const [actionRaw, pullRequestRaw, testDeploymentRaw, productionDeploymentRaw] =
    await Promise.all([
      externalJson(fetcher,
        `${origin}${repositoryPath}/actions/runs/${manifest.lineage.githubRun.id}`,
        { method: 'GET', headers }, 'github', scanner),
      externalJson(fetcher,
        `${origin}${repositoryPath}/pulls/${manifest.lineage.pullRequest.number}`,
        { method: 'GET', headers }, 'github', scanner),
      externalJson(fetcher,
        `${origin}${repositoryPath}/deployments/` +
          manifest.lineage.testDeployment.githubDeploymentId,
        { method: 'GET', headers }, 'github', scanner),
      externalJson(fetcher,
        `${origin}${repositoryPath}/deployments/` +
          manifest.lineage.productionDeployment.githubDeploymentId,
        { method: 'GET', headers }, 'github', scanner),
    ]);
  const action = record(actionRaw);
  const actionRepository = action === null ? null : record(action.repository);
  const pullRequest = record(pullRequestRaw);
  const head = pullRequest === null ? null : record(pullRequest.head);
  const headRepository = head === null ? null : record(head.repo);
  const base = pullRequest === null ? null : record(pullRequest.base);
  const baseRepository = base === null ? null : record(base.repo);
  const expectedPullRequestUrl =
    `https://github.com/${manifest.repository}/pull/${manifest.lineage.pullRequest.number}`;
  if (
    action === null || actionRepository === null ||
    String(action.id) !== manifest.lineage.githubRun.id ||
    action.status !== 'completed' || action.conclusion !== 'success' ||
    action.head_sha !== manifest.lineage.githubRun.headSha ||
    actionRepository.full_name !== manifest.repository ||
    pullRequest === null || head === null || headRepository === null ||
    base === null || baseRepository === null ||
    pullRequest.number !== manifest.lineage.pullRequest.number ||
    pullRequest.state !== manifest.lineage.pullRequest.state ||
    pullRequest.draft !== manifest.lineage.pullRequest.draft ||
    pullRequest.html_url !== expectedPullRequestUrl ||
    head.sha !== manifest.lineage.pullRequest.headSha ||
    headRepository.full_name !== manifest.repository ||
    baseRepository.full_name !== manifest.repository
  ) throw new CorrelationPlatformEvidenceVerificationError('github_fact_mismatch');

  for (const [raw, expected] of [
    [testDeploymentRaw, manifest.lineage.testDeployment],
    [productionDeploymentRaw, manifest.lineage.productionDeployment],
  ] as const) {
    const deployment = record(raw);
    if (
      deployment === null || String(deployment.id) !== expected.githubDeploymentId ||
      deployment.sha !== expected.sha || deployment.environment !== expected.environment ||
      deployment.repository_url !== `${origin}/repos/${manifest.repository}`
    ) throw new CorrelationPlatformEvidenceVerificationError('github_fact_mismatch');
  }
}

function cloudflareRunValid(root: Record<string, unknown>, accountId: string): boolean {
  const result = record(root.result);
  const run = result === null ? null : record(result.run);
  return root.success === true && Array.isArray(root.errors) && root.errors.length === 0 &&
    result !== null && run !== null && run.accountId === accountId && run.dry === true;
}

function telemetryFilters(
  manifest: CorrelationPlatformEvidenceManifestV1,
  lookup: Lookup,
): Array<Record<string, unknown>> {
  return [
    { key: '$metadata.service', operation: 'eq', type: 'string',
      value: manifest.cloudflare.scriptName },
    { key: 'event', operation: 'eq', type: 'string', value: 'correlation_lookup' },
    { key: 'matchedByKind', operation: 'eq', type: 'string', value: lookup.kind },
    { key: 'matchedById', operation: 'eq', type: 'string', value: lookup.id },
    ...('repository' in lookup
      ? [{ key: 'matchedByRepository', operation: 'eq', type: 'string',
          value: lookup.repository }]
      : []),
  ];
}

function telemetryBody(
  manifest: CorrelationPlatformEvidenceManifestV1,
  view: 'events' | 'traces',
  filters: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    view,
    dry: true,
    timeframe: {
      from: manifest.cloudflare.window.from,
      to: manifest.cloudflare.window.to,
    },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters,
      groupBys: [],
      calculations: [],
      limit: 10,
    },
  };
}

function expectedLogFields(
  recordValue: CorrelationPlatformLogRecordV1,
  manifest: CorrelationPlatformEvidenceManifestV1,
  lookup: Lookup,
): boolean {
  const expectedDeploymentIds = [
    manifest.lineage.productionDeployment.deploymentId,
    manifest.lineage.testDeployment.deploymentId,
  ].sort();
  const expectedGitHubDeploymentIds = [
    manifest.lineage.testDeployment.githubDeploymentId,
    manifest.lineage.productionDeployment.githubDeploymentId,
  ].sort();
  return recordValue.correlationId === manifest.runId &&
    recordValue.taskId === manifest.lineage.taskId && recordValue.runId === manifest.runId &&
    JSON.stringify(recordValue.attemptIds) === JSON.stringify([manifest.lineage.attemptId]) &&
    JSON.stringify(recordValue.githubRunIds) ===
      JSON.stringify([manifest.lineage.githubRun.id]) &&
    JSON.stringify(recordValue.pullRequestNumbers) ===
      JSON.stringify([manifest.lineage.pullRequest.number]) &&
    JSON.stringify(recordValue.deploymentIds) === JSON.stringify(expectedDeploymentIds) &&
    JSON.stringify(recordValue.githubDeploymentIds) ===
      JSON.stringify(expectedGitHubDeploymentIds) &&
    JSON.stringify(recordValue.traceIds) === JSON.stringify([manifest.lineage.toolTraceId]) &&
    recordValue.matchedByKind === lookup.kind && recordValue.matchedById === lookup.id &&
    recordValue.matchedByRepository === lookupRepository(lookup) &&
    recordValue.observedAt === lookup.observedAt;
}

async function validateLogResponse(
  raw: unknown,
  accountId: string,
  manifest: CorrelationPlatformEvidenceManifestV1,
  lookup: Lookup,
): Promise<void> {
  const root = record(raw);
  const result = root === null ? null : record(root.result);
  const eventsGroup = result === null ? null : record(result.events);
  const events = eventsGroup === null ? [] : records(eventsGroup, 'events');
  const event = events.length === 1 ? events[0]! : null;
  const metadata = event === null ? null : record(event.$metadata);
  const parsedSource = CorrelationPlatformLogRecordV1Schema.safeParse(event?.source);
  if (
    root === null || !cloudflareRunValid(root, accountId) || eventsGroup === null ||
    eventsGroup.count !== 1 || event === null || metadata === null ||
    metadata.account !== accountId || metadata.service !== manifest.cloudflare.scriptName ||
    metadata.traceId !== lookup.workerTraceId || metadata.type !== 'cf-worker-log' ||
    metadata.truncated !== false || event.dataset !== 'cloudflare-workers' ||
    event.timestamp !== Date.parse(lookup.observedAt) || !parsedSource.success ||
    !expectedLogFields(parsedSource.success ? parsedSource.data : {} as never, manifest, lookup) ||
    await canonicalSha256(parsedSource.success ? parsedSource.data : null) !==
      lookup.logRecordDigest
  ) throw new CorrelationPlatformEvidenceVerificationError('cloudflare_log_mismatch');
}

function validateTraceResponse(
  raw: unknown,
  accountId: string,
  manifest: CorrelationPlatformEvidenceManifestV1,
  lookup: Lookup,
): void {
  const root = record(raw);
  const result = root === null ? null : record(root.result);
  const traces = result === null ? [] : records(result, 'traces');
  const trace = uniqueMatch(traces, (item) => item.traceId === lookup.workerTraceId);
  const observedAt = Date.parse(lookup.observedAt);
  if (
    root === null || !cloudflareRunValid(root, accountId) || traces.length !== 1 ||
    trace === null || !Array.isArray(trace.service) || trace.service.length !== 1 ||
    trace.service[0] !== manifest.cloudflare.scriptName ||
    !Number.isSafeInteger(trace.spans) || Number(trace.spans) < 1 ||
    !Number.isFinite(trace.traceStartMs) || !Number.isFinite(trace.traceEndMs) ||
    !Number.isFinite(trace.traceDurationMs) ||
    Number(trace.traceStartMs) > observedAt || Number(trace.traceEndMs) < observedAt ||
    Number(trace.traceEndMs) - Number(trace.traceStartMs) !== Number(trace.traceDurationMs) ||
    !Array.isArray(trace.errors) || trace.errors.length !== 0
  ) throw new CorrelationPlatformEvidenceVerificationError('cloudflare_trace_mismatch');
}

async function verifyCloudflare(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  accountId: string,
  scanner: SecretScanner,
  manifest: CorrelationPlatformEvidenceManifestV1,
): Promise<void> {
  const url = `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}` +
    '/workers/observability/telemetry/query';
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  for (const lookup of manifest.lookups) {
    const logRaw = await externalJson(fetcher, url, {
      method: 'POST', headers,
      body: JSON.stringify(telemetryBody(manifest, 'events', telemetryFilters(manifest, lookup))),
    }, 'cloudflare', scanner);
    await validateLogResponse(logRaw, accountId, manifest, lookup);
    const traceRaw = await externalJson(fetcher, url, {
      method: 'POST', headers,
      body: JSON.stringify(telemetryBody(manifest, 'traces', [
        { key: '$metadata.traceId', operation: 'eq', type: 'string',
          value: lookup.workerTraceId },
        { key: '$metadata.service', operation: 'eq', type: 'string',
          value: manifest.cloudflare.scriptName },
      ])),
    }, 'cloudflare', scanner);
    validateTraceResponse(traceRaw, accountId, manifest, lookup);
  }
}

export async function verifyCorrelationPlatformEvidence(
  input: CorrelationPlatformEvidenceManifestV1,
  options: CorrelationPlatformEvidenceVerifierOptions,
): Promise<CorrelationPlatformEvidenceVerificationSummary> {
  const parsed = CorrelationPlatformEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new CorrelationPlatformEvidenceVerificationError('manifest_invalid');
  }
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.githubToken) ||
    !TOKEN_PATTERN.test(options.cloudflareObservabilityToken) ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    manifest.cloudflare.accountIdDigest !== await canonicalSha256(options.cloudflareAccountId) ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canary)
  ) throw new CorrelationPlatformEvidenceVerificationError('configuration_invalid');

  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const cloudflareOrigin = safeOrigin(options.cloudflareApiOrigin ?? 'https://api.cloudflare.com');
  const fetcher = options.fetcher ?? fetch;
  const scanner = new SecretScanner({ secrets: [
    options.controlPlaneToken,
    options.githubToken,
    options.cloudflareObservabilityToken,
    options.canary,
  ] });

  await verifyControlPlane(
    fetcher, controlOrigin, options.controlPlaneToken, scanner, manifest,
  );
  await verifyGitHub(fetcher, githubOrigin, options.githubToken, scanner, manifest);
  await verifyCloudflare(
    fetcher,
    cloudflareOrigin,
    options.cloudflareObservabilityToken,
    options.cloudflareAccountId,
    scanner,
    manifest,
  );

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    runId: manifest.runId,
    verifiedLookups: 10,
    controlPlaneQueries: 10,
    githubFacts: 4,
    cloudflareLogQueries: 10,
    cloudflareTraces: 10,
    plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
