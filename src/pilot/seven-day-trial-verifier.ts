import { canonicalSha256 } from '../domain/digest.js';
import {
  SEVEN_DAY_TRIAL_MINUTE_BUCKETS,
  SevenDayTrialEvidenceManifestV1Schema,
  SevenDayTrialObservabilityReportV1Schema,
  type SevenDayTrialEvidenceManifestV1,
  type SevenDayTrialObservabilityReportV1,
} from '../domain/seven-day-trial-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type SevenDayTrialVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'observability_unavailable'
  | 'observability_response_invalid'
  | 'observability_digest_mismatch'
  | 'detector_inactive'
  | 'metrics_coverage_incomplete'
  | 'unknown_stuck_runs'
  | 'stuck_incidents_unresolved'
  | 'runtime_secret_alerts'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_inventory_incomplete'
  | 'github_pull_request_mismatch'
  | 'github_deployment_mismatch'
  | 'duplicate_pull_request'
  | 'duplicate_deployment';

export class SevenDayTrialVerificationError extends Error {
  constructor(readonly code: SevenDayTrialVerificationErrorCode) {
    super(`seven-day trial verification failed: ${code}`);
    this.name = 'SevenDayTrialVerificationError';
  }
}

export interface SevenDayTrialVerifierOptions {
  controlPlaneOrigin: string;
  observabilityReportUrl: string;
  operationsToken: string;
  githubToken: string;
  observabilityToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface SevenDayTrialVerificationSummary {
  schemaVersion: '1';
  trialId: string;
  repository: string;
  startedAt: string;
  endedAt: string;
  observedMinuteBuckets: 10080;
  verifiedRunCount: number;
  verifiedPullRequestCount: number;
  verifiedDeploymentCount: number;
  resolvedStuckIncidentCount: number;
  unknownStuckRunCount: 0;
  duplicatePullRequestCount: 0;
  duplicateDeploymentCount: 0;
  runtimeSecretAlertCount: 0;
  observabilityReportDigest: string;
}

interface ResponseJson {
  body: unknown;
  headers: Headers;
}

interface ExpectedPullRequest {
  publicationId: string;
  number: string;
  repository: string;
  headBranch: string;
  headSha: string;
}

interface ExpectedDeployment {
  kind: 'test' | 'production';
  deploymentId: string;
  githubDeploymentId: string;
  repository: string;
  environment: 'test' | 'production';
  sha: string;
}

interface GitHubPullRequest {
  number: string;
  headBranch: string;
  headSha: string;
}

interface GitHubDeployment {
  githubDeploymentId: string;
  deploymentId: string;
  kind: 'test' | 'production';
  sha: string;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SevenDayTrialVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new SevenDayTrialVerificationError('configuration_invalid');
  return url.origin;
}

function httpsEvidenceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SevenDayTrialVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) throw new SevenDayTrialVerificationError('configuration_invalid');
  return url.toString();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const result = value.map(record);
  return result.some((item) => item === null)
    ? null
    : result as Array<Record<string, unknown>>;
}

function withinWindow(raw: unknown, manifest: SevenDayTrialEvidenceManifestV1): boolean {
  if (typeof raw !== 'string') return false;
  const value = Date.parse(raw);
  return Number.isFinite(value) && value >= Date.parse(manifest.window.startedAt) &&
    value < Date.parse(manifest.window.endedAt);
}

function safeId(value: unknown): string | null {
  if (typeof value === 'string' && ID_PATTERN.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

async function readJsonResponse(
  response: Response,
  invalidCode: SevenDayTrialVerificationErrorCode,
): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new SevenDayTrialVerificationError(invalidCode);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SevenDayTrialVerificationError(invalidCode);
  }
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  unavailableCode: SevenDayTrialVerificationErrorCode,
  invalidCode: SevenDayTrialVerificationErrorCode,
): Promise<ResponseJson> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
  } catch {
    throw new SevenDayTrialVerificationError(unavailableCode);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SevenDayTrialVerificationError(unavailableCode);
  }
  return { body: await readJsonResponse(response, invalidCode), headers: response.headers };
}

async function inBatches<T, R>(
  values: readonly T[],
  size: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += size) {
    results.push(...await Promise.all(values.slice(index, index + size).map(operation)));
  }
  return results;
}

async function observabilityReport(
  manifest: SevenDayTrialEvidenceManifestV1,
  options: SevenDayTrialVerifierOptions,
  fetcher: typeof fetch,
): Promise<SevenDayTrialObservabilityReportV1> {
  const configuredReportUrl = httpsEvidenceUrl(options.observabilityReportUrl);
  if (configuredReportUrl !== manifest.observabilityReportUrl) {
    throw new SevenDayTrialVerificationError('configuration_invalid');
  }
  const response = await getJson(
    fetcher,
    configuredReportUrl,
    options.observabilityToken,
    'observability_unavailable',
    'observability_response_invalid',
  );
  const parsed = SevenDayTrialObservabilityReportV1Schema.safeParse(response.body);
  if (!parsed.success) {
    throw new SevenDayTrialVerificationError('observability_response_invalid');
  }
  const { reportDigest, ...body } = parsed.data;
  if (
    reportDigest !== manifest.observabilityReportDigest ||
    await canonicalSha256(body) !== reportDigest || parsed.data.trialId !== manifest.trialId ||
    parsed.data.repository !== manifest.repository ||
    parsed.data.window.startedAt !== manifest.window.startedAt ||
    parsed.data.window.endedAt !== manifest.window.endedAt
  ) throw new SevenDayTrialVerificationError('observability_digest_mismatch');
  if (parsed.data.detectors.stuckRun !== 'active' || parsed.data.detectors.runtimeSecret !== 'active') {
    throw new SevenDayTrialVerificationError('detector_inactive');
  }
  if (
    parsed.data.minuteBuckets.expected !== SEVEN_DAY_TRIAL_MINUTE_BUCKETS ||
    parsed.data.minuteBuckets.observed !== SEVEN_DAY_TRIAL_MINUTE_BUCKETS ||
    parsed.data.minuteBuckets.missing !== 0
  ) throw new SevenDayTrialVerificationError('metrics_coverage_incomplete');
  if (parsed.data.unknownStuckRunIds.length > 0) {
    throw new SevenDayTrialVerificationError('unknown_stuck_runs');
  }
  if (
    parsed.data.unresolvedKnownStuckRunIds.length > 0 ||
    parsed.data.resolvedStuckIncidentIds.length !== parsed.data.detectedStuckIncidentIds.length ||
    parsed.data.detectedStuckIncidentIds.some((id) =>
      !parsed.data.resolvedStuckIncidentIds.includes(id))
  ) throw new SevenDayTrialVerificationError('stuck_incidents_unresolved');
  if (parsed.data.runtimeSecretAlertIds.length > 0) {
    throw new SevenDayTrialVerificationError('runtime_secret_alerts');
  }
  return parsed.data;
}

function auditInventory(
  raw: unknown,
  runId: string,
  manifest: SevenDayTrialEvidenceManifestV1,
): { pullRequests: ExpectedPullRequest[]; deployments: ExpectedDeployment[] } {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const task = root === null ? null : record(root.task);
  const answers = root === null ? null : record(root.answers);
  const changes = answers === null ? null : records(answers.changes);
  const deployments = answers === null ? null : records(answers.deployments);
  if (
    root === null || root.schemaVersion !== '1' || root.runId !== runId ||
    typeof root.reportDigest !== 'string' || !DIGEST_PATTERN.test(root.reportDigest) ||
    run === null || !withinWindow(run.createdAt, manifest) ||
    task === null || task.repository !== manifest.repository ||
    changes === null || deployments === null
  ) throw new SevenDayTrialVerificationError('control_plane_projection_mismatch');

  const pullRequests: ExpectedPullRequest[] = [];
  for (const change of changes) {
    if (change.kind !== 'pull_request' || change.number === undefined) continue;
    const number = safeId(change.number);
    if (
      number === null || change.repository !== manifest.repository ||
      change.status !== 'verified' || typeof change.publicationId !== 'string' ||
      !ID_PATTERN.test(change.publicationId) || typeof change.headBranch !== 'string' ||
      change.headBranch.length < 1 || change.headBranch.length > 255 ||
      typeof change.headSha !== 'string' || !SHA_PATTERN.test(change.headSha) ||
      typeof change.evidenceId !== 'string' || !ID_PATTERN.test(change.evidenceId)
    ) throw new SevenDayTrialVerificationError('control_plane_projection_mismatch');
    pullRequests.push({
      publicationId: change.publicationId,
      number,
      repository: manifest.repository,
      headBranch: change.headBranch,
      headSha: change.headSha,
    });
  }

  const expectedDeployments: ExpectedDeployment[] = [];
  for (const deployment of deployments) {
    if (deployment.githubDeploymentId === undefined) continue;
    const githubDeploymentId = safeId(deployment.githubDeploymentId);
    const kind = deployment.kind;
    if (
      githubDeploymentId === null || (kind !== 'test' && kind !== 'production') ||
      deployment.repository !== manifest.repository || deployment.environment !== kind ||
      typeof deployment.deploymentId !== 'string' || !ID_PATTERN.test(deployment.deploymentId) ||
      typeof deployment.sha !== 'string' || !SHA_PATTERN.test(deployment.sha) ||
      typeof deployment.evidenceId !== 'string' || !ID_PATTERN.test(deployment.evidenceId)
    ) throw new SevenDayTrialVerificationError('control_plane_projection_mismatch');
    expectedDeployments.push({
      kind,
      deploymentId: deployment.deploymentId,
      githubDeploymentId,
      repository: manifest.repository,
      environment: kind,
      sha: deployment.sha,
    });
  }
  return { pullRequests, deployments: expectedDeployments };
}

async function controlPlaneInventory(
  report: SevenDayTrialObservabilityReportV1,
  manifest: SevenDayTrialEvidenceManifestV1,
  options: SevenDayTrialVerifierOptions,
  fetcher: typeof fetch,
): Promise<{ pullRequests: ExpectedPullRequest[]; deployments: ExpectedDeployment[] }> {
  const origin = httpsOrigin(options.controlPlaneOrigin);
  const rows = await inBatches(report.runIds, 10, async (runId) => {
    const response = await getJson(
      fetcher,
      `${origin}/v1/runs/${runId}/audit`,
      options.operationsToken,
      'control_plane_unavailable',
      'control_plane_response_invalid',
    );
    return auditInventory(response.body, runId, manifest);
  });
  const pullRequests = rows.flatMap((row) => row.pullRequests);
  const deployments = rows.flatMap((row) => row.deployments);
  if (
    new Set(pullRequests.map((item) => item.publicationId)).size !== pullRequests.length ||
    new Set(pullRequests.map((item) => item.number)).size !== pullRequests.length ||
    new Set(pullRequests.map((item) => item.headBranch)).size !== pullRequests.length
  ) throw new SevenDayTrialVerificationError('duplicate_pull_request');
  if (
    new Set(deployments.map((item) => item.deploymentId)).size !== deployments.length ||
    new Set(deployments.map((item) => item.githubDeploymentId)).size !== deployments.length
  ) throw new SevenDayTrialVerificationError('duplicate_deployment');
  return { pullRequests, deployments };
}

function githubPullRequests(
  raw: unknown,
  manifest: SevenDayTrialEvidenceManifestV1,
): GitHubPullRequest[] {
  const rows = records(raw);
  if (rows === null || rows.length > 100) {
    throw new SevenDayTrialVerificationError('github_response_invalid');
  }
  const results: GitHubPullRequest[] = [];
  for (const row of rows) {
    const user = record(row.user);
    if (!withinWindow(row.created_at, manifest) || user?.login !== manifest.githubActorLogin) {
      continue;
    }
    const head = record(row.head);
    const headRepo = head === null ? null : record(head.repo);
    const number = safeId(row.number);
    if (
      number === null || row.draft !== true || typeof head?.ref !== 'string' ||
      typeof head.sha !== 'string' || !SHA_PATTERN.test(head.sha) ||
      headRepo?.full_name !== manifest.repository
    ) throw new SevenDayTrialVerificationError('github_response_invalid');
    results.push({ number, headBranch: head.ref, headSha: head.sha });
  }
  return results;
}

function githubDeployments(
  raw: unknown,
  manifest: SevenDayTrialEvidenceManifestV1,
): GitHubDeployment[] {
  const rows = records(raw);
  if (rows === null || rows.length > 100) {
    throw new SevenDayTrialVerificationError('github_response_invalid');
  }
  const results: GitHubDeployment[] = [];
  for (const row of rows) {
    if (!withinWindow(row.created_at, manifest)) continue;
    const payload = record(row.payload);
    if (payload === null) continue;
    const testId = safeId(payload.delivery_deployment_id);
    const productionId = safeId(payload.delivery_production_deployment_id);
    if (testId === null && productionId === null) continue;
    if (testId !== null && productionId !== null) {
      throw new SevenDayTrialVerificationError('github_response_invalid');
    }
    const kind = testId === null ? 'production' : 'test';
    const githubDeploymentId = safeId(row.id);
    if (
      githubDeploymentId === null || row.task !== `delivery-loop:${kind}` ||
      row.environment !== kind || typeof row.sha !== 'string' || !SHA_PATTERN.test(row.sha)
    ) throw new SevenDayTrialVerificationError('github_response_invalid');
    results.push({
      githubDeploymentId,
      deploymentId: (testId ?? productionId)!,
      kind,
      sha: row.sha,
    });
  }
  return results;
}

function assertPullRequestInventory(
  expected: ExpectedPullRequest[],
  actual: GitHubPullRequest[],
): void {
  if (new Set(actual.map((item) => item.headBranch)).size !== actual.length) {
    throw new SevenDayTrialVerificationError('duplicate_pull_request');
  }
  if (expected.length !== actual.length) {
    throw new SevenDayTrialVerificationError('github_pull_request_mismatch');
  }
  for (const item of expected) {
    const matches = actual.filter((fact) => fact.number === item.number);
    if (
      matches.length !== 1 || matches[0]?.headBranch !== item.headBranch ||
      matches[0]?.headSha !== item.headSha
    ) throw new SevenDayTrialVerificationError('github_pull_request_mismatch');
  }
}

function assertDeploymentInventory(
  expected: ExpectedDeployment[],
  actual: GitHubDeployment[],
): void {
  if (new Set(actual.map((item) => item.deploymentId)).size !== actual.length) {
    throw new SevenDayTrialVerificationError('duplicate_deployment');
  }
  if (expected.length !== actual.length) {
    throw new SevenDayTrialVerificationError('github_deployment_mismatch');
  }
  for (const item of expected) {
    const matches = actual.filter((fact) => fact.deploymentId === item.deploymentId);
    if (
      matches.length !== 1 || matches[0]?.githubDeploymentId !== item.githubDeploymentId ||
      matches[0]?.kind !== item.kind || matches[0]?.sha !== item.sha
    ) throw new SevenDayTrialVerificationError('github_deployment_mismatch');
  }
}

/**
 * Verifies a complete seven-day window against three independent read-only
 * sources. The 0/1/2 CLI layering and bounded live-fact style directly reuse
 * the Watt-derived PilotEvidence verifier discipline.
 */
export async function verifySevenDayTrialEvidence(
  rawManifest: unknown,
  options: SevenDayTrialVerifierOptions,
): Promise<SevenDayTrialVerificationSummary> {
  const parsed = SevenDayTrialEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsed.success) throw new SevenDayTrialVerificationError('manifest_invalid');
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.githubToken) ||
    !TOKEN_PATTERN.test(options.observabilityToken)
  ) throw new SevenDayTrialVerificationError('configuration_invalid');
  const manifest = parsed.data;
  const githubOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const report = await observabilityReport(manifest, options, fetcher);
  const expected = await controlPlaneInventory(report, manifest, options, fetcher);
  const [pullResponse, deploymentResponse] = await Promise.all([
    getJson(
      fetcher,
      `${githubOrigin}/repos/${manifest.repository}/pulls?state=all&sort=created&direction=asc&per_page=100`,
      options.githubToken,
      'github_api_unavailable',
      'github_response_invalid',
    ),
    getJson(
      fetcher,
      `${githubOrigin}/repos/${manifest.repository}/deployments?per_page=100`,
      options.githubToken,
      'github_api_unavailable',
      'github_response_invalid',
    ),
  ]);
  if (
    pullResponse.headers.get('link')?.includes('rel="next"') === true ||
    deploymentResponse.headers.get('link')?.includes('rel="next"') === true
  ) throw new SevenDayTrialVerificationError('github_inventory_incomplete');
  const pullRequests = githubPullRequests(pullResponse.body, manifest);
  const deployments = githubDeployments(deploymentResponse.body, manifest);
  assertPullRequestInventory(expected.pullRequests, pullRequests);
  assertDeploymentInventory(expected.deployments, deployments);
  return {
    schemaVersion: '1',
    trialId: manifest.trialId,
    repository: manifest.repository,
    startedAt: manifest.window.startedAt,
    endedAt: manifest.window.endedAt,
    observedMinuteBuckets: SEVEN_DAY_TRIAL_MINUTE_BUCKETS,
    verifiedRunCount: report.runIds.length,
    verifiedPullRequestCount: pullRequests.length,
    verifiedDeploymentCount: deployments.length,
    resolvedStuckIncidentCount: report.resolvedStuckIncidentIds.length,
    unknownStuckRunCount: 0,
    duplicatePullRequestCount: 0,
    duplicateDeploymentCount: 0,
    runtimeSecretAlertCount: 0,
    observabilityReportDigest: report.reportDigest,
  };
}
