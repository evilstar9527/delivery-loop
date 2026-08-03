import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubAppTransportDiagnosticEvidenceManifestV2Schema,
  GitHubAppTransportDiagnosticLogRecordV1Schema,
  GitHubAppTransportDiagnosticPublicSummaryV1Schema,
  type GitHubAppTransportDiagnosticEvidenceManifestV2,
} from '../domain/github-app-transport-diagnostic-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{8,2000}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const HTTP_TIMEOUT_MS = 10_000;

export type GitHubAppTransportDiagnosticEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_fact_mismatch'
  | 'github_log_mismatch'
  | 'cloudflare_api_unavailable'
  | 'cloudflare_response_invalid'
  | 'cloudflare_deployment_mismatch'
  | 'cloudflare_log_mismatch'
  | 'cloudflare_invocation_mismatch'
  | 'secret_leak_detected';

export class GitHubAppTransportDiagnosticEvidenceVerificationError extends Error {
  constructor(readonly code: GitHubAppTransportDiagnosticEvidenceVerificationErrorCode) {
    super(`GitHub App transport diagnostic evidence verification failed: ${code}`);
    this.name = 'GitHubAppTransportDiagnosticEvidenceVerificationError';
  }
}

export interface GitHubAppTransportDiagnosticEvidenceVerifierOptions {
  githubToken: string;
  cloudflareDeploymentReadToken: string;
  cloudflareObservabilityToken: string;
  cloudflareAccountId: string;
  canary: string;
  githubApiOrigin?: string;
  cloudflareApiOrigin?: string;
  fetcher?: typeof fetch;
}

export interface GitHubAppTransportDiagnosticEvidenceVerificationSummary {
  schemaVersion: '2';
  evidenceId: string;
  repository: string;
  githubRunId: string;
  readinessJobId: string;
  deploymentId: string;
  versionId: string;
  failureKind: GitHubAppTransportDiagnosticEvidenceManifestV2['diagnostic']['failureKind'];
  requestAttempts: 1;
  githubLogQueries: 1;
  cloudflareDeploymentQueries: 1;
  cloudflareLogQueries: 1;
  cloudflareInvocationQueries: 1;
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
}

type Source = 'github' | 'cloudflare';

function fail(code: GitHubAppTransportDiagnosticEvidenceVerificationErrorCode): never {
  throw new GitHubAppTransportDiagnosticEvidenceVerificationError(code);
}

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
  catch { fail('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) fail('configuration_invalid');
  return url.origin;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
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
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function unavailable(source: Source): GitHubAppTransportDiagnosticEvidenceVerificationErrorCode {
  return source === 'github' ? 'github_api_unavailable' : 'cloudflare_api_unavailable';
}

function invalid(source: Source): GitHubAppTransportDiagnosticEvidenceVerificationErrorCode {
  return source === 'github' ? 'github_response_invalid' : 'cloudflare_response_invalid';
}

function responseSizeValid(response: Response): boolean {
  const header = response.headers.get('content-length');
  if (header === null) return true;
  const declared = Number(header);
  return Number.isSafeInteger(declared) && declared >= 0 && declared <= MAX_RESPONSE_BYTES;
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
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch { fail(unavailable(source)); }
  if (!response.ok) {
    await response.body?.cancel();
    fail(unavailable(source));
  }
  if (
    !responseSizeValid(response) ||
    /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    fail(invalid(source));
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { fail(invalid(source)); }
  if (text === null) fail(invalid(source));
  if (scanner.scanText(text, `$.${source}`).length > 0) fail('secret_leak_detected');
  try { return JSON.parse(text) as unknown; }
  catch { fail(invalid(source)); }
}

async function githubJobLog(
  fetcher: typeof fetch,
  url: string,
  token: string,
  scanner: SecretScanner,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch { fail('github_api_unavailable'); }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    let signed: URL;
    try { signed = new URL(location ?? ''); }
    catch { fail('github_response_invalid'); }
    if (signed.protocol !== 'https:' || signed.username !== '' || signed.password !== '') {
      fail('github_response_invalid');
    }
    try {
      response = await fetcher(signed.toString(), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch { fail('github_api_unavailable'); }
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail('github_api_unavailable');
  }
  if (!responseSizeValid(response)) {
    await response.body?.cancel();
    fail('github_response_invalid');
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { fail('github_response_invalid'); }
  if (text === null) fail('github_response_invalid');
  if (scanner.scanText(text, '$.githubActionLog').length > 0) fail('secret_leak_detected');
  return text;
}

async function validatePublicSummary(
  text: string,
  manifest: GitHubAppTransportDiagnosticEvidenceManifestV2,
): Promise<void> {
  const candidates: Array<GitHubAppTransportDiagnosticEvidenceManifestV2['github']['publicSummary']>
    = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = GitHubAppTransportDiagnosticPublicSummaryV1Schema.safeParse(
        JSON.parse(line.slice(start, end + 1)) as unknown,
      );
      if (parsed.success) candidates.push(parsed.data);
    } catch { /* unrelated log line */ }
  }
  const summary = candidates.length === 1 ? candidates[0] : null;
  if (
    summary === null || await canonicalSha256(summary) !== manifest.github.publicSummaryDigest
  ) fail('github_log_mismatch');
}

async function verifyGitHub(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  scanner: SecretScanner,
  manifest: GitHubAppTransportDiagnosticEvidenceManifestV2,
): Promise<void> {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const path = `/repos/${manifest.repository}`;
  const runRaw = await externalJson(
    fetcher,
    `${origin}${path}/actions/runs/${manifest.github.runId}`,
    { method: 'GET', headers },
    'github',
    scanner,
  );
  const run = record(runRaw);
  const actor = run === null ? null : record(run.actor);
  const repository = run === null ? null : record(run.repository);
  if (
    run === null || actor === null || repository === null ||
    String(run.id) !== manifest.github.runId || run.event !== 'workflow_dispatch' ||
    run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'failure' ||
    run.head_sha !== manifest.github.headSha || actor.login !== manifest.github.actor ||
    run.head_branch !== 'main' || run.path !== '.github/workflows/github-base-readiness.yml' ||
    repository.full_name !== manifest.repository
  ) fail('github_fact_mismatch');

  const jobsRaw = await externalJson(
    fetcher,
    `${origin}${path}/actions/runs/${manifest.github.runId}/jobs?filter=latest&per_page=100`,
    { method: 'GET', headers },
    'github',
    scanner,
  );
  const jobsRoot = record(jobsRaw);
  const jobs = jobsRoot === null ? [] : records(jobsRoot, 'jobs');
  const preflight = jobs.find((job) => job.name === 'preflight');
  const readiness = jobs.find((job) => job.name === 'readiness');
  const readinessStartedAt = isoDate(readiness?.started_at);
  const readinessCompletedAt = isoDate(readiness?.completed_at);
  if (
    jobsRoot === null || jobsRoot.total_count !== 2 || jobs.length !== 2 ||
    preflight === undefined || readiness === undefined ||
    String(preflight.id) !== manifest.github.preflightJobId ||
    preflight.status !== 'completed' || preflight.conclusion !== 'success' ||
    String(readiness.id) !== manifest.github.readinessJobId ||
    readiness.status !== 'completed' || readiness.conclusion !== 'failure' ||
    readinessStartedAt !== new Date(manifest.github.readinessStartedAt).toISOString() ||
    readinessCompletedAt !== new Date(manifest.github.readinessCompletedAt).toISOString() ||
    isoDate(preflight.completed_at) === null ||
    Date.parse(String(preflight.completed_at)) > Date.parse(manifest.github.readinessStartedAt)
  ) fail('github_fact_mismatch');

  const log = await githubJobLog(
    fetcher,
    `${origin}${path}/actions/jobs/${manifest.github.readinessJobId}/logs`,
    token,
    scanner,
  );
  await validatePublicSummary(log, manifest);
}

function cloudflareEnvelope(raw: unknown, accountId: string): Record<string, unknown> {
  const root = record(raw);
  const result = root === null ? null : record(root.result);
  if (
    root === null || result === null || root.success !== true ||
    !Array.isArray(root.errors) || root.errors.length !== 0 || !Array.isArray(root.messages)
  ) fail('cloudflare_response_invalid');
  const run = record(result.run);
  if (run !== null && (run.accountId !== accountId || run.dry !== true)) {
    fail('cloudflare_response_invalid');
  }
  return result;
}

async function verifyDeployment(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  accountId: string,
  scanner: SecretScanner,
  manifest: GitHubAppTransportDiagnosticEvidenceManifestV2,
): Promise<void> {
  const raw = await externalJson(
    fetcher,
    `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}` +
      `/workers/scripts/${encodeURIComponent(manifest.cloudflare.scriptName)}/deployments`,
    {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    },
    'cloudflare',
    scanner,
  );
  const result = cloudflareEnvelope(raw, accountId);
  const deployments = records(result, 'deployments').map((deployment) => {
    const versions = records(deployment, 'versions');
    return {
      deploymentId: deployment.id,
      createdAt: isoDate(deployment.created_on),
      versionId: versions.length === 1 ? versions[0]?.version_id : null,
      percentage: versions.length === 1 ? versions[0]?.percentage : null,
    };
  });
  if (deployments.length < 1 || deployments.length > 100 || deployments.some((item) =>
    typeof item.deploymentId !== 'string' || item.createdAt === null ||
    typeof item.versionId !== 'string' || typeof item.percentage !== 'number')) {
    fail('cloudflare_response_invalid');
  }
  const startedAt = Date.parse(manifest.github.readinessStartedAt);
  const completedAt = Date.parse(manifest.github.readinessCompletedAt);
  const prior = deployments
    .filter((deployment) => Date.parse(deployment.createdAt!) < startedAt)
    .sort((left, right) => Date.parse(right.createdAt!) - Date.parse(left.createdAt!));
  const during = deployments.filter((deployment) => {
    const createdAt = Date.parse(deployment.createdAt!);
    return createdAt >= startedAt && createdAt <= completedAt;
  });
  const target = deployments.filter((deployment) =>
    deployment.deploymentId === manifest.cloudflare.deploymentId);
  if (
    target.length !== 1 || prior[0]?.deploymentId !== manifest.cloudflare.deploymentId ||
    during.length !== 0 || target[0]?.versionId !== manifest.cloudflare.versionId ||
    target[0]?.percentage !== 100 ||
    target[0]?.createdAt !== new Date(manifest.cloudflare.deploymentCreatedAt).toISOString()
  ) fail('cloudflare_deployment_mismatch');
}

function telemetryBody(
  manifest: GitHubAppTransportDiagnosticEvidenceManifestV2,
  view: 'events' | 'invocations',
  filters: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    queryId: `${manifest.evidenceId}-${view}`,
    view,
    dry: true,
    timeframe: {
      from: Date.parse(manifest.cloudflare.window.from),
      to: Date.parse(manifest.cloudflare.window.to),
    },
    limit: 2,
    parameters: {
      datasets: ['cloudflare-workers'],
      filters,
      groupBys: [],
      calculations: [],
    },
  };
}

function telemetryRunValid(root: Record<string, unknown>, accountId: string): boolean {
  const result = record(root.result);
  const run = result === null ? null : record(result.run);
  return root.success === true && Array.isArray(root.errors) && root.errors.length === 0 &&
    result !== null && run !== null && run.accountId === accountId && run.dry === true;
}

async function validateLog(
  raw: unknown,
  accountId: string,
  manifest: GitHubAppTransportDiagnosticEvidenceManifestV2,
): Promise<void> {
  const root = record(raw);
  const result = root === null ? null : record(root.result);
  const group = result === null ? null : record(result.events);
  const events = group === null ? [] : records(group, 'events');
  const event = events.length === 1 ? events[0]! : null;
  const metadata = event === null ? null : record(event.$metadata);
  const workers = event === null ? null : record(event.$workers);
  const parsed = GitHubAppTransportDiagnosticLogRecordV1Schema.safeParse(event?.source);
  if (
    root === null || !telemetryRunValid(root, accountId) || group === null ||
    group.count !== 1 || event === null || metadata === null || workers === null ||
    metadata.account !== accountId || metadata.service !== manifest.cloudflare.scriptName ||
    metadata.requestId !== manifest.diagnostic.workerInvocationId ||
    metadata.rayId !== manifest.diagnostic.workerInvocationId ||
    metadata.type !== 'cf-worker' || workers.truncated !== false ||
    workers.requestId !== manifest.diagnostic.workerInvocationId ||
    event.dataset !== 'cloudflare-workers' ||
    event.timestamp !== Date.parse(manifest.diagnostic.observedAt) || !parsed.success ||
    parsed.data.failureKind !== manifest.diagnostic.failureKind ||
    parsed.data.observedAt !== new Date(manifest.diagnostic.observedAt).toISOString() ||
    await canonicalSha256(parsed.success ? parsed.data : null) !==
      manifest.diagnostic.logRecordDigest
  ) fail('cloudflare_log_mismatch');
}

async function validateInvocation(
  raw: unknown,
  accountId: string,
  manifest: GitHubAppTransportDiagnosticEvidenceManifestV2,
): Promise<void> {
  const root = record(raw);
  const result = root === null ? null : record(root.result);
  const invocations = result === null ? null : record(result.invocations);
  const invocationEntries = invocations === null ? [] : Object.entries(invocations);
  const rawInvocation = invocationEntries.length === 1 &&
      invocationEntries[0]?.[0] === manifest.diagnostic.workerInvocationId &&
      Array.isArray(invocationEntries[0][1])
    ? invocationEntries[0][1]
    : null;
  const invocation = rawInvocation?.map(record) ?? null;
  const events = invocation?.filter(
    (item): item is Record<string, unknown> => item !== null,
  ) ?? [];
  const matches = events.filter((event) => {
    const metadata = record(event.$metadata);
    const workers = record(event.$workers);
    const parsed = GitHubAppTransportDiagnosticLogRecordV1Schema.safeParse(event.source);
    return metadata !== null && workers !== null && parsed.success &&
      metadata.account === accountId && metadata.service === manifest.cloudflare.scriptName &&
      metadata.requestId === manifest.diagnostic.workerInvocationId &&
      metadata.rayId === manifest.diagnostic.workerInvocationId &&
      metadata.type === 'cf-worker' && workers.truncated === false &&
      workers.requestId === manifest.diagnostic.workerInvocationId &&
      event.dataset === 'cloudflare-workers' &&
      event.timestamp === Date.parse(manifest.diagnostic.observedAt) &&
      parsed.data.failureKind === manifest.diagnostic.failureKind &&
      parsed.data.observedAt === new Date(manifest.diagnostic.observedAt).toISOString();
  });
  if (
    root === null || !telemetryRunValid(root, accountId) || invocation === null ||
    invocation.length < 1 || invocation.length > 100 || events.length !== invocation.length ||
    matches.length !== 1 ||
    await canonicalSha256(
      GitHubAppTransportDiagnosticLogRecordV1Schema.parse(matches[0]!.source),
    ) !== manifest.diagnostic.logRecordDigest
  ) fail('cloudflare_invocation_mismatch');
}

async function verifyTelemetry(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  accountId: string,
  scanner: SecretScanner,
  manifest: GitHubAppTransportDiagnosticEvidenceManifestV2,
): Promise<void> {
  const url = `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}` +
    '/workers/observability/telemetry/query';
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const eventFilters: Array<Record<string, unknown>> = [
    { key: '$metadata.service', operation: 'eq', type: 'string',
      value: manifest.cloudflare.scriptName },
    { key: '$metadata.requestId', operation: 'eq', type: 'string',
      value: manifest.diagnostic.workerInvocationId },
    { key: 'event', operation: 'eq', type: 'string',
      value: 'github_app_installation_token_transport_failed' },
    { key: 'component', operation: 'eq', type: 'string', value: 'github_app_credential' },
    { key: 'operation', operation: 'eq', type: 'string',
      value: 'installation_token_exchange' },
    { key: 'requestAttempts', operation: 'eq', type: 'number', value: 1 },
  ];
  const logRaw = await externalJson(fetcher, url, {
    method: 'POST', headers, body: JSON.stringify(telemetryBody(manifest, 'events', eventFilters)),
  }, 'cloudflare', scanner);
  await validateLog(logRaw, accountId, manifest);
  const invocationRaw = await externalJson(fetcher, url, {
    method: 'POST',
    headers,
    body: JSON.stringify(telemetryBody(manifest, 'invocations', [
      { key: '$metadata.requestId', operation: 'eq', type: 'string',
        value: manifest.diagnostic.workerInvocationId },
      { key: '$metadata.service', operation: 'eq', type: 'string',
        value: manifest.cloudflare.scriptName },
      { key: 'event', operation: 'eq', type: 'string',
        value: 'github_app_installation_token_transport_failed' },
      { key: 'component', operation: 'eq', type: 'string',
        value: 'github_app_credential' },
      { key: 'operation', operation: 'eq', type: 'string',
        value: 'installation_token_exchange' },
      { key: 'requestAttempts', operation: 'eq', type: 'number', value: 1 },
    ])),
  }, 'cloudflare', scanner);
  await validateInvocation(invocationRaw, accountId, manifest);
}

export async function verifyGitHubAppTransportDiagnosticEvidence(
  input: GitHubAppTransportDiagnosticEvidenceManifestV2,
  options: GitHubAppTransportDiagnosticEvidenceVerifierOptions,
): Promise<GitHubAppTransportDiagnosticEvidenceVerificationSummary> {
  const parsed = GitHubAppTransportDiagnosticEvidenceManifestV2Schema.safeParse(input);
  if (!parsed.success) fail('manifest_invalid');
  const manifest = parsed.data;
  const tokens = [
    options.githubToken,
    options.cloudflareDeploymentReadToken,
    options.cloudflareObservabilityToken,
  ];
  if (
    tokens.some((token) => !TOKEN_PATTERN.test(token)) || new Set(tokens).size !== tokens.length ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    manifest.cloudflare.accountIdDigest !== await canonicalSha256(options.cloudflareAccountId) ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canary) ||
    manifest.github.publicSummaryDigest !== await canonicalSha256(manifest.github.publicSummary)
  ) fail('configuration_invalid');

  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const cloudflareOrigin = safeOrigin(
    options.cloudflareApiOrigin ?? 'https://api.cloudflare.com',
  );
  const fetcher = options.fetcher ?? fetch;
  const scanner = new SecretScanner({ secrets: [...tokens, options.canary] });

  await verifyGitHub(fetcher, githubOrigin, options.githubToken, scanner, manifest);
  await verifyDeployment(
    fetcher,
    cloudflareOrigin,
    options.cloudflareDeploymentReadToken,
    options.cloudflareAccountId,
    scanner,
    manifest,
  );
  await verifyTelemetry(
    fetcher,
    cloudflareOrigin,
    options.cloudflareObservabilityToken,
    options.cloudflareAccountId,
    scanner,
    manifest,
  );

  return {
    schemaVersion: '2',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    githubRunId: manifest.github.runId,
    readinessJobId: manifest.github.readinessJobId,
    deploymentId: manifest.cloudflare.deploymentId,
    versionId: manifest.cloudflare.versionId,
    failureKind: manifest.diagnostic.failureKind,
    requestAttempts: 1,
    githubLogQueries: 1,
    cloudflareDeploymentQueries: 1,
    cloudflareLogQueries: 1,
    cloudflareInvocationQueries: 1,
    plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
