import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubPullRequestEvidenceManifestV1Schema,
  type GitHubPullRequestEvidenceManifestV1,
} from '../domain/github-pull-request-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type GitHubPullRequestEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_pull_request_mismatch';

export class GitHubPullRequestEvidenceVerificationError extends Error {
  constructor(readonly code: GitHubPullRequestEvidenceVerificationErrorCode) {
    super(`GitHub pull request evidence verification failed: ${code}`);
    this.name = 'GitHubPullRequestEvidenceVerificationError';
  }
}

export interface GitHubPullRequestEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface GitHubPullRequestEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  publication: 'verified';
  webhook: 'applied';
  apiObservation: 'applied';
  githubPullRequest: 'verified';
  pullRequestNumber: number;
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
    throw new GitHubPullRequestEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new GitHubPullRequestEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBoundedResponse(response: Response): Promise<string | null> {
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

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: 'control_plane' | 'github',
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new GitHubPullRequestEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubPullRequestEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  const invalidCode = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GitHubPullRequestEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new GitHubPullRequestEvidenceVerificationError(invalidCode);
  }
  if (text === null) throw new GitHubPullRequestEvidenceVerificationError(invalidCode);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubPullRequestEvidenceVerificationError(invalidCode);
  }
}

export async function verifyGitHubPullRequestEvidence(
  input: GitHubPullRequestEvidenceManifestV1,
  options: GitHubPullRequestEvidenceVerifierOptions,
): Promise<GitHubPullRequestEvidenceVerificationSummary> {
  const parsed = GitHubPullRequestEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new GitHubPullRequestEvidenceVerificationError('manifest_invalid');
  }
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new GitHubPullRequestEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const audit = record(await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/runs/${input.runId}/audit`,
    options.controlPlaneToken,
    'control_plane',
  ));
  const run = audit === null ? null : record(audit.run);
  const task = audit === null ? null : record(audit.task);
  const answers = audit === null ? null : record(audit.answers);
  const changes = answers === null ? [] : rows(answers, 'changes');
  const checks = answers === null ? null : record(answers.checks);
  const observations = checks === null ? [] : rows(checks, 'pullRequestObservations');
  const publication = changes.filter((change) =>
    change.kind === 'pull_request' && change.publicationId === input.publication.publicationId,
  );
  const webhook = observations.filter((observation) =>
    observation.sourceKind === 'webhook' &&
    observation.sourceId === input.publication.webhook.deliveryId &&
    observation.publicationId === input.publication.publicationId,
  );
  const apiObservation = observations.filter((observation) =>
    observation.sourceKind === 'api' &&
    observation.sourceId === input.publication.apiObservation.observationId &&
    observation.publicationId === input.publication.publicationId,
  );
  if (
    audit === null || audit.schemaVersion !== '1' || audit.runId !== input.runId ||
    run?.state !== 'pull_request_open' || task?.repository !== input.repository ||
    publication.length !== 1 || webhook.length !== 1 || apiObservation.length !== 1
  ) throw new GitHubPullRequestEvidenceVerificationError('control_plane_projection_mismatch');
  const change = publication[0]!;
  const webhookFact = webhook[0]!;
  const apiFact = apiObservation[0]!;
  if (
    change.status !== input.publication.status ||
    change.approvalId !== input.publication.approvalId ||
    change.repository !== input.publication.repository ||
    change.baseBranch !== input.publication.baseBranch ||
    change.headBranch !== input.publication.headBranch ||
    change.headSha !== input.publication.headSha ||
    change.bodyDigest !== input.publication.bodyDigest ||
    change.number !== input.publication.number || change.url !== input.publication.url ||
    change.evidenceId !== input.publication.evidenceId ||
    webhookFact.processingState !== 'applied' ||
    webhookFact.factDigest !== input.publication.webhook.payloadDigest ||
    webhookFact.externalUpdatedAt !== input.publication.webhook.externalUpdatedAt ||
    webhookFact.observedAt !== input.publication.webhook.receivedAt ||
    apiFact.processingState !== 'applied' ||
    apiFact.factDigest !== input.publication.apiObservation.factDigest ||
    apiFact.externalUpdatedAt !== input.publication.apiObservation.externalUpdatedAt ||
    apiFact.observedAt !== input.publication.apiObservation.observedAt
  ) throw new GitHubPullRequestEvidenceVerificationError('control_plane_projection_mismatch');

  const pr = record(await getJson(
    fetcher,
    `${githubApiOrigin}/repos/${input.repository}/pulls/${input.publication.number}`,
    options.githubToken,
    'github',
  ));
  const head = pr === null ? null : record(pr.head);
  const base = pr === null ? null : record(pr.base);
  const headRepo = head === null ? null : record(head.repo);
  const baseRepo = base === null ? null : record(base.repo);
  if (
    pr === null || pr.number !== input.publication.number || pr.state !== 'open' ||
    pr.draft !== true || pr.html_url !== input.publication.url ||
    typeof pr.body !== 'string' || await canonicalSha256(pr.body) !== input.publication.bodyDigest ||
    head?.ref !== input.publication.headBranch || head?.sha !== input.publication.headSha ||
    headRepo?.full_name !== input.repository || base?.ref !== input.publication.baseBranch ||
    baseRepo?.full_name !== input.repository
  ) throw new GitHubPullRequestEvidenceVerificationError('github_pull_request_mismatch');
  return {
    schemaVersion: '1',
    evidenceId: input.evidenceId,
    repository: input.repository,
    runId: input.runId,
    publication: 'verified',
    webhook: 'applied',
    apiObservation: 'applied',
    githubPullRequest: 'verified',
    pullRequestNumber: input.publication.number,
  };
}
