import { canonicalSha256 } from '../domain/digest.js';
import {
  SecretSafetyEvidenceManifestV1Schema,
  type SecretSafetyEvidenceManifestV1,
} from '../domain/secret-safety-evidence.js';
import {
  GitHubActionsApiClient,
  type GitHubInstallationTokenProvider,
} from '../outbox/github-dispatcher.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_LOG_TOTAL_BYTES = 32 * 1024 * 1024;

export type SecretSafetyEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_log_leak_detected'
  | 'github_pull_request_mismatch'
  | 'case8_digest_mismatch'
  | 'secret_leak_detected'
  | 'artifact_projection_mismatch'
  | 'publication_effect_mismatch';

export class SecretSafetyEvidenceVerificationError extends Error {
  constructor(readonly code: SecretSafetyEvidenceVerificationErrorCode) {
    super(`Secret safety evidence verification failed: ${code}`);
    this.name = 'SecretSafetyEvidenceVerificationError';
  }
}

export interface SecretSafetyEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  canarySecret: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface SecretSafetyEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  safeDraftCases: number;
  blockedPublicationCases: number;
  verifiedActions: number;
  scannedJobs: number;
  verifiedPullRequests: number;
  verifiedCiphertextRegistries: number;
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
    ? value.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecretSafetyEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new SecretSafetyEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
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
  return bytes;
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: 'control_plane' | 'github',
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SecretSafetyEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (
    !response.ok ||
    /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    throw new SecretSafetyEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SecretSafetyEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
  const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
  if (bytes === null) {
    throw new SecretSafetyEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
  const text = new TextDecoder().decode(bytes);
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new SecretSafetyEvidenceVerificationError('secret_leak_detected');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SecretSafetyEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
}

async function readActionLog(
  fetcher: typeof fetch,
  url: string,
  token: string,
  scanner: SecretScanner,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'text/plain', authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SecretSafetyEvidenceVerificationError('github_api_unavailable');
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (location === null) {
      await response.body?.cancel();
      throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
    }
    let signed: URL;
    try {
      signed = new URL(location);
    } catch {
      throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
    }
    if (signed.protocol !== 'https:' || signed.username !== '' || signed.password !== '') {
      throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
    }
    try {
      response = await fetcher(signed.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new SecretSafetyEvidenceVerificationError('github_api_unavailable');
    }
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SecretSafetyEvidenceVerificationError('github_api_unavailable');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOG_BYTES) {
    await response.body?.cancel();
    throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
  }
  const bytes = await readBounded(response, MAX_LOG_BYTES);
  if (bytes === null) throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
  if (scanner.scanText(new TextDecoder().decode(bytes), '$.githubActionLog').length > 0) {
    throw new SecretSafetyEvidenceVerificationError('github_log_leak_detected');
  }
  return bytes;
}

async function scanActionLogs(
  fetcher: typeof fetch,
  apiOrigin: string,
  repository: string,
  actionRunId: string,
  token: string,
  scanner: SecretScanner,
): Promise<number> {
  const jobs = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/actions/runs/${actionRunId}/jobs?per_page=100`,
    token,
    'github',
    scanner,
  ));
  const jobRows = jobs === null || !Array.isArray(jobs.jobs)
    ? []
    : jobs.jobs.map(record).filter((row): row is Record<string, unknown> => row !== null);
  if (jobs === null || jobRows.length === 0 || jobRows.length > 100) {
    throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
  }
  let totalBytes = 0;
  for (const job of jobRows) {
    if (
      typeof job.id !== 'number' || !Number.isSafeInteger(job.id) || job.id <= 0 ||
      (typeof job.status !== 'string')
    ) throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
    const bytes = await readActionLog(
      fetcher,
      `${apiOrigin}/repos/${repository}/actions/jobs/${job.id}/logs`,
      token,
      scanner,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_LOG_TOTAL_BYTES) {
      throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
    }
  }
  return jobRows.length;
}

async function verifyCase8Digest(
  audit: Record<string, unknown>,
  item: SecretSafetyEvidenceManifestV1['cases'][number],
): Promise<void> {
  const { generatedAt, queryDurationMs, reportDigest, ...body } = audit;
  if (
    typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    !Number.isSafeInteger(queryDurationMs) || Number(queryDurationMs) < 0 ||
    reportDigest !== item.case8ReportDigest ||
    await canonicalSha256(body) !== reportDigest
  ) throw new SecretSafetyEvidenceVerificationError('case8_digest_mismatch');
}

function verifyProjection(
  audit: Record<string, unknown>,
  item: SecretSafetyEvidenceManifestV1['cases'][number],
): void {
  const run = record(audit.run);
  const task = record(audit.task);
  const answers = record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (
    audit.schemaVersion !== '1' || run === null || task === null || answers === null ||
    checks === null || audit.runId !== item.runId || run.state !== item.runState ||
    task.repository !== item.repository || task.revision !== item.taskRevision
  ) throw new SecretSafetyEvidenceVerificationError('control_plane_projection_mismatch');

  const plans = record(audit.digests);
  const planRows = plans === null ? [] : rows(plans, 'plans');
  if (!planRows.some((plan) =>
    plan.planId === item.planId && plan.version === item.planVersion && plan.digest === item.planDigest,
  )) throw new SecretSafetyEvidenceVerificationError('control_plane_projection_mismatch');

  const attempts = rows(record(answers.who) ?? {}, 'attempts').filter((attempt) =>
    attempt.attemptId === item.attemptId && attempt.mode === item.attemptMode,
  );
  if (attempts.length !== 1) {
    throw new SecretSafetyEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const changes = rows(answers, 'changes').filter((change) =>
    change.kind === 'pull_request' && change.publicationId === item.publication.publicationId,
  );
  if (changes.length !== 1) {
    throw new SecretSafetyEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const change = changes[0]!;
  if (
    change.status !== item.publication.status || change.approvalId !== item.publication.approvalId ||
    change.repository !== item.repository || change.baseBranch !== item.publication.baseBranch ||
    change.headBranch !== item.publication.headBranch || change.headSha !== item.headSha ||
    change.bodyDigest !== item.publication.bodyDigest ||
    (change.number ?? null) !== item.publication.number || (change.url ?? null) !== item.publication.url ||
    (change.evidenceId ?? null) !== item.publication.evidenceId
  ) throw new SecretSafetyEvidenceVerificationError('control_plane_projection_mismatch');

  const outboxes = rows(checks, 'effectOutboxes').filter((outbox) => outbox.id === item.outbox.id);
  if (
    outboxes.length !== 1 || outboxes[0]!.kind !== 'pull_request' ||
    outboxes[0]!.state !== 'settled' ||
    (outboxes[0]!.lastErrorCode ?? null) !== item.outbox.lastErrorCode
  ) throw new SecretSafetyEvidenceVerificationError('publication_effect_mismatch');

  const artifacts = rows(checks, 'secretArtifacts').filter((artifact) =>
    item.artifact !== null && artifact.objectId === item.artifact.objectId,
  );
  if (item.artifact === null) {
    if (artifacts.length !== 0) throw new SecretSafetyEvidenceVerificationError('artifact_projection_mismatch');
  } else if (
    artifacts.length !== 1 || artifacts[0]!.attemptId !== item.attemptId ||
    artifacts[0]!.category !== item.artifact.category ||
    artifacts[0]!.ciphertextDigest !== item.artifact.ciphertextDigest ||
    artifacts[0]!.sizeBytes !== item.artifact.sizeBytes ||
    artifacts[0]!.policyVersion !== item.artifact.policyVersion ||
    artifacts[0]!.deletionState !== item.artifact.deletionState ||
    artifacts[0]!.createdAt !== item.artifact.createdAt || artifacts[0]!.expiresAt !== item.artifact.expiresAt
  ) throw new SecretSafetyEvidenceVerificationError('artifact_projection_mismatch');
}

async function verifyPullRequest(
  fetcher: typeof fetch,
  apiOrigin: string,
  item: SecretSafetyEvidenceManifestV1['cases'][number],
  token: string,
  scanner: SecretScanner,
): Promise<void> {
  if (item.outcome !== 'safe_draft_pr') return;
  const number = item.publication.number;
  if (number === null || item.publication.url === null) {
    throw new SecretSafetyEvidenceVerificationError('github_pull_request_mismatch');
  }
  const raw = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${item.repository}/pulls/${number}`,
    token,
    'github',
    scanner,
  ));
  const head = raw === null ? null : record(raw.head);
  const base = raw === null ? null : record(raw.base);
  const headRepo = head === null ? null : record(head.repo);
  const baseRepo = base === null ? null : record(base.repo);
  if (
    raw === null || raw.number !== number || raw.state !== 'open' || raw.draft !== true ||
    raw.html_url !== item.publication.url || typeof raw.body !== 'string' ||
    await canonicalSha256(raw.body) !== item.publication.bodyDigest ||
    head?.ref !== item.publication.headBranch || head?.sha !== item.headSha ||
    headRepo?.full_name !== item.repository || base?.ref !== item.publication.baseBranch ||
    baseRepo?.full_name !== item.repository
  ) throw new SecretSafetyEvidenceVerificationError('github_pull_request_mismatch');
}

async function verifyNoPullRequestEffect(
  fetcher: typeof fetch,
  apiOrigin: string,
  item: SecretSafetyEvidenceManifestV1['cases'][number],
  token: string,
  scanner: SecretScanner,
): Promise<void> {
  if (item.outcome !== 'blocked_secret_publication') return;
  const owner = item.repository.split('/')[0]!;
  const query = new URLSearchParams({
    state: 'all',
    head: `${owner}:${item.publication.headBranch}`,
    base: item.publication.baseBranch,
    per_page: '100',
  });
  const raw = await getJson(
    fetcher,
    `${apiOrigin}/repos/${item.repository}/pulls?${query.toString()}`,
    token,
    'github',
    scanner,
  );
  if (!Array.isArray(raw) || raw.length !== 0) {
    throw new SecretSafetyEvidenceVerificationError('github_pull_request_mismatch');
  }
}

export async function verifySecretSafetyEvidence(
  input: SecretSafetyEvidenceManifestV1,
  options: SecretSafetyEvidenceVerifierOptions,
): Promise<SecretSafetyEvidenceVerificationSummary> {
  const parsed = SecretSafetyEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new SecretSafetyEvidenceVerificationError('manifest_invalid');
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken) ||
    !CANARY_PATTERN.test(options.canarySecret)
  ) throw new SecretSafetyEvidenceVerificationError('configuration_invalid');
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const expectedCanaryDigest = await canonicalSha256(options.canarySecret);
  const scanner = new SecretScanner({
    secrets: [options.controlPlaneToken, options.githubToken, options.canarySecret],
  });
  const actionFetch: typeof fetch = (async (input, init) => {
    const response = await fetcher(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
    const clone = response.clone();
    const bytes = await readBounded(clone, MAX_RESPONSE_BYTES);
    if (bytes === null) {
      await response.body?.cancel();
      throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
    }
    if (scanner.scanText(new TextDecoder().decode(bytes), '$.github').length > 0) {
      await response.body?.cancel();
      throw new SecretSafetyEvidenceVerificationError('secret_leak_detected');
    }
    return response;
  }) as typeof fetch;
  const tokenProvider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => options.githubToken,
  };
  const actionClient = new GitHubActionsApiClient(tokenProvider, {
    apiBaseUrl: githubApiOrigin,
    fetch: actionFetch,
  });
  const audits = new Map<string, Record<string, unknown>>();
  let scannedJobs = 0;
  let verifiedPullRequests = 0;
  let verifiedCiphertextRegistries = 0;
  for (const item of parsed.data.cases) {
    if (item.logScan.canaryDigest !== expectedCanaryDigest) {
      throw new SecretSafetyEvidenceVerificationError('manifest_invalid');
    }
    const audit = audits.get(item.runId) ?? record(await getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${item.runId}/audit`,
      options.controlPlaneToken,
      'control_plane',
      scanner,
    ));
    if (audit === null) throw new SecretSafetyEvidenceVerificationError('control_plane_response_invalid');
    audits.set(item.runId, audit);
    verifyProjection(audit, item);
    await verifyCase8Digest(audit, item);
    let action;
    try {
      action = await actionClient.getWorkflowRun(item.repository, item.action.runId);
    } catch (error) {
      if (error instanceof SecretSafetyEvidenceVerificationError) throw error;
      throw new SecretSafetyEvidenceVerificationError('github_api_unavailable');
    }
    if (
      action.repository !== item.repository || action.githubRunId !== item.action.runId ||
      action.event !== 'workflow_dispatch' || action.workflowPath !== item.action.workflowPath ||
      action.status !== item.action.status || action.conclusion !== item.action.conclusion ||
      action.headSha !== item.action.headSha || action.displayTitle !== item.action.displayTitle ||
      action.displayTitle !== `delivery-loop/${item.attemptId}` ||
      action.runAttempt < 1 ||
      `https://github.com/${item.repository}/actions/runs/${action.githubRunId}` !== item.action.url
    ) throw new SecretSafetyEvidenceVerificationError('github_action_mismatch');
    const caseJobCount = await scanActionLogs(
      fetcher, githubApiOrigin, item.repository, item.action.runId,
      options.githubToken, scanner,
    );
    if (item.logScan.jobCount !== caseJobCount) {
      throw new SecretSafetyEvidenceVerificationError('github_response_invalid');
    }
    scannedJobs += caseJobCount;
    await verifyPullRequest(fetcher, githubApiOrigin, item, options.githubToken, scanner);
    await verifyNoPullRequestEffect(fetcher, githubApiOrigin, item, options.githubToken, scanner);
    if (item.outcome === 'safe_draft_pr') verifiedPullRequests += 1;
    if (item.artifact !== null) verifiedCiphertextRegistries += 1;
  }
  return {
    schemaVersion: '1',
    evidenceId: parsed.data.evidenceId,
    repository: parsed.data.repository,
    caseCount: parsed.data.cases.length,
    safeDraftCases: parsed.data.cases.filter((item) => item.outcome === 'safe_draft_pr').length,
    blockedPublicationCases: parsed.data.cases.filter((item) => item.outcome === 'blocked_secret_publication').length,
    verifiedActions: parsed.data.cases.length,
    scannedJobs,
    verifiedPullRequests,
    verifiedCiphertextRegistries,
    plaintextLeaks: 0,
  };
}
