import { canonicalSha256 } from '../domain/digest.js';
import {
  MergeEvidenceManifestV1Schema,
  type MergeEvidenceCase,
  type MergeEvidenceManifestV1,
} from '../domain/merge-evidence.js';
import {
  GitHubMergeStatusApiClient,
  type GitHubMergeStatusExternalFactClient,
} from '../reconciliation/github-merge-status-reconciler.js';
import type { GitHubPullRequestMergeFact } from '../domain/github-merge-status.js';

type MergedCase = Exclude<MergeEvidenceCase, { outcome: 'not_merged' }>;
type MergeObservation = MergedCase['webhook'] | MergedCase['apiObservation'];

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type MergeEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_fact_mismatch'
  | 'merge_observation_mismatch'
  | 'merge_effect_mismatch';

export class MergeEvidenceVerificationError extends Error {
  constructor(readonly code: MergeEvidenceVerificationErrorCode) {
    super(`merge evidence verification failed: ${code}`);
    this.name = 'MergeEvidenceVerificationError';
  }
}

export interface MergeEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface MergeEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  mergedCases: number;
  noDeploySucceededCases: number;
  completedAtMergeCases: number;
  deploymentPendingCases: number;
  notMergedCases: number;
  verifiedMergeCount: number;
  duplicateMergeEffects: 0;
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
    throw new MergeEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new MergeEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBounded(response: Response): Promise<string | null> {
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

async function controlPlaneJson(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  runId: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/v1/runs/${runId}/audit`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
    });
  } catch {
    throw new MergeEvidenceVerificationError('control_plane_unavailable');
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new MergeEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new MergeEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    throw new MergeEvidenceVerificationError('control_plane_response_invalid');
  }
  if (text === null) throw new MergeEvidenceVerificationError('control_plane_response_invalid');
  try {
    const body = record(JSON.parse(text) as unknown);
    if (body === null) throw new Error('invalid');
    return body;
  } catch {
    throw new MergeEvidenceVerificationError('control_plane_response_invalid');
  }
}

async function equalFact(
  actual: GitHubPullRequestMergeFact,
  expected: GitHubPullRequestMergeFact,
): Promise<boolean> {
  return await canonicalSha256(actual) === await canonicalSha256(expected);
}

function projection(audit: Record<string, unknown>): {
  run: Record<string, unknown>;
  task: Record<string, unknown>;
  answers: Record<string, unknown>;
  checks: Record<string, unknown>;
} {
  const run = record(audit.run);
  const task = record(audit.task);
  const answers = record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (run === null || task === null || answers === null || checks === null) {
    throw new MergeEvidenceVerificationError('control_plane_projection_mismatch');
  }
  return { run, task, answers, checks };
}

function matchesObservation(
  row: Record<string, unknown>,
  observation: MergeObservation,
  repository: string,
  number: number,
): boolean {
  return row.sourceKind === observation.sourceKind && row.observationId === observation.id &&
    row.factDigest === observation.digest && row.processingState === observation.processingState &&
    row.ignoreReason === observation.ignoreReason && row.repository === repository &&
    row.githubPrNumber === number && row.externalUpdatedAt === observation.externalUpdatedAt &&
    row.observedAt === observation.observedAt && row.processedAt === observation.processedAt;
}

async function verifyMergedCase(
  item: MergedCase,
  audit: Record<string, unknown>,
): Promise<void> {
  const { run, task, answers, checks } = projection(audit);
  if (
    run.id !== item.runId || run.version !== item.currentRunVersion || run.state !== item.runState ||
    task.repository !== item.repository
  ) throw new MergeEvidenceVerificationError('control_plane_projection_mismatch');

  const changes = rows(answers, 'changes').filter((change) => change.kind === 'merge');
  if (changes.length !== 1) throw new MergeEvidenceVerificationError('control_plane_projection_mismatch');
  const merge = changes[0]!;
  if (
    merge.mergeId !== item.mergeId || merge.publicationId !== item.publicationId ||
    merge.planId !== item.planId || merge.planVersion !== item.planVersion ||
    merge.planDigest !== item.planDigest || merge.repository !== item.repository ||
    merge.pullRequestNumber !== item.pullRequest.number || merge.headSha !== item.merge.headSha ||
    merge.baseSha !== item.baseSha || merge.mergeSha !== item.merge.mergeSha ||
    merge.mergedBy !== item.merge.mergedByLogin || merge.mergedAt !== item.merge.mergedAt ||
    merge.deploymentDisposition !== item.deploymentDisposition || merge.evidenceId !== item.mergeEvidenceId
  ) throw new MergeEvidenceVerificationError('control_plane_projection_mismatch');
  const evidence = rows(checks, 'evidence').filter((row) => row.evidenceId === item.mergeEvidenceId);
  if (
    evidence.length !== 1 || evidence[0]!.kind !== 'pull_request' || evidence[0]!.status !== 'passed' ||
    evidence[0]!.verificationStatus !== 'verified' || evidence[0]!.sha !== item.merge.mergeSha ||
    evidence[0]!.url !== item.merge.url
  ) throw new MergeEvidenceVerificationError('control_plane_projection_mismatch');

  const observations = rows(checks, 'mergeObservations');
  const expected = [item.webhook, item.apiObservation];
  for (const observation of expected) {
    const matches = observations.filter((row) => matchesObservation(
      row, observation, item.repository, item.pullRequest.number,
    ));
    if (matches.length !== 1) throw new MergeEvidenceVerificationError('merge_observation_mismatch');
  }
  if (observations.filter((row) => row.githubPrNumber === item.pullRequest.number).length !== 2) {
    throw new MergeEvidenceVerificationError('merge_observation_mismatch');
  }
  const effectOutboxes = rows(checks, 'effectOutboxes').filter((row) => row.kind === 'merge');
  if (
    effectOutboxes.length !== 0 || item.noDuplicate.merges !== 1 ||
    item.noDuplicate.observations !== 2 || item.noDuplicate.mergeEvidence !== 1 ||
    item.noDuplicate.mergeOutboxes !== 0
  ) throw new MergeEvidenceVerificationError('merge_effect_mismatch');
}

async function verifyNotMergedCase(
  item: Extract<MergeEvidenceCase, { outcome: 'not_merged' }>,
  audit: Record<string, unknown>,
): Promise<void> {
  const { run, task, answers, checks } = projection(audit);
  if (
    run.id !== item.runId || run.version !== item.currentRunVersion || run.state !== item.runState ||
    task.repository !== item.repository ||
    rows(answers, 'changes').some((change) => change.kind === 'merge') ||
    rows(checks, 'evidence').some((row) => row.evidenceId === item.mergeEvidenceId) ||
    rows(checks, 'mergeObservations').some((row) => row.githubPrNumber === item.pullRequest.number) ||
    rows(checks, 'effectOutboxes').some((row) => row.kind === 'merge') ||
    item.noDuplicate.merges !== 0 || item.noDuplicate.observations !== 0 ||
    item.noDuplicate.mergeEvidence !== 0 || item.noDuplicate.mergeOutboxes !== 0
  ) throw new MergeEvidenceVerificationError('merge_effect_mismatch');
}

async function verifyExternalFact(
  item: MergeEvidenceCase,
  github: GitHubMergeStatusExternalFactClient,
): Promise<void> {
  let actual: GitHubPullRequestMergeFact | null;
  try {
    actual = await github.getMergeStatus(item.pullRequest);
  } catch {
    throw new MergeEvidenceVerificationError('github_api_unavailable');
  }
  if (item.outcome === 'not_merged') {
    if (actual !== null) throw new MergeEvidenceVerificationError('github_fact_mismatch');
    return;
  }
  if (actual === null || !(await equalFact(actual, item.merge))) {
    throw new MergeEvidenceVerificationError('github_fact_mismatch');
  }
  if (await canonicalSha256(item.merge) !== item.apiObservation.digest) {
    throw new MergeEvidenceVerificationError('merge_observation_mismatch');
  }
}

export async function verifyMergeEvidence(
  input: MergeEvidenceManifestV1,
  options: MergeEvidenceVerifierOptions,
): Promise<MergeEvidenceVerificationSummary> {
  const parsed = MergeEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new MergeEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new MergeEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const github = new GitHubMergeStatusApiClient(
    { getMergeObservationToken: async () => options.githubToken },
    { apiBaseUrl: githubApiOrigin, fetch: fetcher },
  );
  const audits = new Map<string, Record<string, unknown>>();
  for (const item of parsed.data.cases) {
    const audit = audits.get(item.runId) ?? await controlPlaneJson(
      fetcher, controlPlaneOrigin, options.controlPlaneToken, item.runId,
    );
    audits.set(item.runId, audit);
    if (item.outcome === 'not_merged') await verifyNotMergedCase(item, audit);
    else await verifyMergedCase(item, audit);
    await verifyExternalFact(item, github);
  }
  return {
    schemaVersion: '1', evidenceId: parsed.data.evidenceId, repository: parsed.data.repository,
    caseCount: parsed.data.cases.length,
    mergedCases: parsed.data.cases.filter((item) => item.outcome !== 'not_merged').length,
    noDeploySucceededCases: parsed.data.cases.filter((item) => item.outcome === 'merged_none').length,
    completedAtMergeCases: parsed.data.cases.filter((item) =>
      item.outcome === 'merged_none' || item.outcome === 'merged_test').length,
    deploymentPendingCases: parsed.data.cases.filter((item) =>
      item.outcome === 'merged_production').length,
    notMergedCases: parsed.data.cases.filter((item) => item.outcome === 'not_merged').length,
    verifiedMergeCount: parsed.data.cases.filter((item) => item.outcome !== 'not_merged').length,
    duplicateMergeEffects: 0,
  };
}
