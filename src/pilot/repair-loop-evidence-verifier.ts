import {
  RepairLoopEvidenceManifestV1Schema,
  type RepairLoopEvidenceManifestV1,
} from '../domain/repair-loop-evidence.js';
import { GitHubActionsApiClient, type GitHubInstallationTokenProvider } from '../outbox/github-dispatcher.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type RepairLoopEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'blocker_projection_mismatch'
  | 'repair_effect_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_job_mismatch'
  | 'github_commit_mismatch'
  | 'github_git_relationship_mismatch';

export class RepairLoopEvidenceVerificationError extends Error {
  constructor(readonly code: RepairLoopEvidenceVerificationErrorCode) {
    super(`Repair loop evidence verification failed: ${code}`);
    this.name = 'RepairLoopEvidenceVerificationError';
  }
}

export interface RepairLoopEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface RepairLoopEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  repairedCases: number;
  repeatedFingerprintBlockedCases: number;
  attemptLimitBlockedCases: number;
  verifiedActionRunCount: number;
  verifiedJobCount: number;
  verifiedCommitCount: number;
  verifiedGitRelationshipCount: number;
  duplicateRepairEffects: 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = parent[key];
  return Array.isArray(value)
    ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RepairLoopEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new RepairLoopEvidenceVerificationError('configuration_invalid');
  return url.origin;
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
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new RepairLoopEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (
    !response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    throw new RepairLoopEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  const length = Number(response.headers.get('content-length'));
  const invalid = source === 'control_plane'
    ? 'control_plane_response_invalid' : 'github_response_invalid';
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RepairLoopEvidenceVerificationError(invalid);
  }
  const bytes = await readBounded(response);
  if (bytes === null) throw new RepairLoopEvidenceVerificationError(invalid);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RepairLoopEvidenceVerificationError(invalid);
  }
}

function exactRow(values: Array<Record<string, unknown>>, id: string): Record<string, unknown> | null {
  const matches = values.filter((value) => value.id === id || value.attemptId === id);
  return matches.length === 1 ? matches[0]! : null;
}

function verifyControlPlane(
  planView: unknown,
  auditView: unknown,
  item: RepairLoopEvidenceManifestV1['cases'][number],
): void {
  const planRoot = record(planView);
  const run = planRoot === null ? null : record(planRoot.run);
  const plan = planRoot === null ? null : record(planRoot.plan);
  if (
    planRoot === null || run === null || plan === null || run.id !== item.runId ||
    run.state !== item.runState || plan.id !== item.planId || plan.version !== item.planVersion ||
    plan.digest !== item.planDigest || plan.baseSha !== item.baseSha
  ) throw new RepairLoopEvidenceVerificationError('control_plane_projection_mismatch');
  const items = rows(planRoot, 'items').filter((candidate) => candidate.id === item.planItemId);
  if (
    items.length !== 1 || items[0]!.status !== (item.outcome === 'repair_succeeded' ? 'passed' : 'blocked')
  ) throw new RepairLoopEvidenceVerificationError('control_plane_projection_mismatch');

  const audit = record(auditView);
  const auditRun = audit === null ? null : record(audit.run);
  const answers = audit === null ? null : record(audit.answers);
  const who = answers === null ? null : record(answers.who);
  const checks = answers === null ? null : record(answers.checks);
  if (
    audit === null || audit.runId !== item.runId || auditRun === null ||
    auditRun.state !== item.runState || answers === null || who === null || checks === null
  ) throw new RepairLoopEvidenceVerificationError('control_plane_projection_mismatch');
  const attempts = rows(who, 'attempts');
  const planAttempts = rows(planRoot, 'attempts');
  for (const expected of item.attempts) {
    const actual = exactRow(attempts, expected.attemptId);
    const planActual = exactRow(planAttempts, expected.attemptId);
    if (
      actual === null || planActual === null || actual.ordinal !== expected.ordinal || actual.mode !== expected.mode ||
      actual.githubRunId !== expected.actionRunId || actual.githubStatus !== 'completed' ||
      actual.githubConclusion !== expected.actionConclusion || actual.headSha !== expected.workflowHeadSha ||
      planActual.baseSha !== expected.checkoutSha || planActual.headBranch !== expected.branch ||
      planActual.headSha !== expected.workflowHeadSha
    ) throw new RepairLoopEvidenceVerificationError('control_plane_projection_mismatch');
  }
  if (attempts.length !== item.attempts.length) {
    throw new RepairLoopEvidenceVerificationError('repair_effect_mismatch');
  }
  const evidence = rows(checks, 'evidence');
  for (const expected of item.evidence) {
    const matches = evidence.filter((candidate) =>
      candidate.evidenceId === expected.evidenceId && candidate.attemptId === expected.attemptId &&
      candidate.kind === expected.kind && candidate.status === expected.status &&
      candidate.verificationStatus === expected.verificationStatus && candidate.sha === expected.sha,
    );
    if (matches.length !== 1) throw new RepairLoopEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const commitCount = item.evidence.filter((entry) => entry.kind === 'commit').length;
  if (evidence.filter((entry) => entry.kind === 'commit').length !== commitCount) {
    throw new RepairLoopEvidenceVerificationError('repair_effect_mismatch');
  }
  const outboxes = rows(checks, 'effectOutboxes').filter((outbox) =>
    outbox.kind === 'execution_dispatch',
  );
  if (outboxes.length !== item.noDuplicate.executionDispatches) {
    throw new RepairLoopEvidenceVerificationError('repair_effect_mismatch');
  }
  const blocker = record(run.blocker);
  if (item.blocker === null) {
    if (blocker !== null) throw new RepairLoopEvidenceVerificationError('blocker_projection_mismatch');
  } else if (
    blocker === null || blocker.id !== item.blocker.id || blocker.reason !== item.blocker.reason ||
    blocker.fingerprintDigest !== item.attempts.at(-1)!.failureFingerprint ||
    blocker.attemptCount !== item.blocker.attemptCount ||
    blocker.consecutiveFingerprintCount !== item.blocker.consecutiveFingerprintCount ||
    record(blocker.neededHumanInput)?.code !== item.blocker.neededHumanInputCode ||
    !Array.isArray(blocker.attemptedPaths) ||
    (blocker.attemptedPaths as unknown[]).length !== item.blocker.attemptedPaths.length
  ) throw new RepairLoopEvidenceVerificationError('blocker_projection_mismatch');
}

async function verifyAction(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  item: RepairLoopEvidenceManifestV1['cases'][number],
  attempt: RepairLoopEvidenceManifestV1['cases'][number]['attempts'][number],
): Promise<void> {
  const provider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => token,
  };
  let fact;
  try {
    fact = await new GitHubActionsApiClient(provider, { apiBaseUrl: apiOrigin, fetch: fetcher })
      .getWorkflowRun(item.repository, attempt.actionRunId);
  } catch {
    throw new RepairLoopEvidenceVerificationError('github_api_unavailable');
  }
  if (
    fact.repository !== item.repository || fact.event !== 'workflow_dispatch' ||
    fact.workflowPath !== item.workflowPath || fact.status !== 'completed' ||
    fact.conclusion !== attempt.actionConclusion || fact.headSha !== attempt.workflowHeadSha ||
    fact.displayTitle !== `delivery-loop/${attempt.attemptId}`
  ) throw new RepairLoopEvidenceVerificationError('github_action_mismatch');
  const jobsRoot = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${item.repository}/actions/runs/${attempt.actionRunId}/jobs?filter=all&per_page=100`,
    token,
    'github',
  ));
  const jobs = jobsRoot === null ? [] : rows(jobsRoot, 'jobs');
  if (jobsRoot === null || jobsRoot.total_count !== 1 || jobs.length !== 1) {
    throw new RepairLoopEvidenceVerificationError('github_job_mismatch');
  }
  const job = jobs[0]!;
  const steps = rows(job, 'steps');
  const checkout = steps.filter((step) => step.name === 'Checkout trusted execution snapshot');
  const runner = steps.filter((step) => step.name === 'Run approved execution attempt');
  if (
    job.name !== 'attempt' || job.status !== 'completed' || job.conclusion !== attempt.actionConclusion ||
    checkout.length !== 1 || checkout[0]!.conclusion !== 'success' || runner.length !== 1 ||
    runner[0]!.conclusion !== attempt.actionConclusion
  ) throw new RepairLoopEvidenceVerificationError('github_job_mismatch');
}

async function verifyGit(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  item: RepairLoopEvidenceManifestV1['cases'][number],
  attempt: RepairLoopEvidenceManifestV1['cases'][number]['attempts'][number],
): Promise<'commit' | 'relationship' | null> {
  if (attempt.resultHeadSha === null) return null;
  const commit = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${item.repository}/commits/${attempt.resultHeadSha}`,
    token,
    'github',
  ));
  if (commit === null || commit.sha !== attempt.resultHeadSha) {
    throw new RepairLoopEvidenceVerificationError('github_commit_mismatch');
  }
  const branchPath = encodeURIComponent(`heads/${attempt.branch}`);
  const ref = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${item.repository}/git/ref/${branchPath}`,
    token,
    'github',
  ));
  const object = ref === null ? null : record(ref.object);
  if (object === null || object.sha !== attempt.resultHeadSha) {
    throw new RepairLoopEvidenceVerificationError('github_commit_mismatch');
  }
  const compare = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${item.repository}/compare/${attempt.checkoutSha}...${attempt.resultHeadSha}`,
    token,
    'github',
  ));
  const base = compare === null ? null : record(compare.base_commit);
  if (
    compare === null || compare.status !== 'ahead' || compare.behind_by !== 0 ||
    typeof compare.ahead_by !== 'number' || compare.ahead_by < 1 || base?.sha !== attempt.checkoutSha
  ) throw new RepairLoopEvidenceVerificationError('github_git_relationship_mismatch');
  return 'relationship';
}

export async function verifyRepairLoopEvidence(
  input: RepairLoopEvidenceManifestV1,
  options: RepairLoopEvidenceVerifierOptions,
): Promise<RepairLoopEvidenceVerificationSummary> {
  const parsed = RepairLoopEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new RepairLoopEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new RepairLoopEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  let verifiedActionRunCount = 0;
  let verifiedJobCount = 0;
  let verifiedCommitCount = 0;
  let verifiedGitRelationshipCount = 0;
  for (const item of parsed.data.cases) {
    const [planView, auditView] = await Promise.all([
      getJson(fetcher, `${controlPlaneOrigin}/v1/runs/${item.runId}/plan`, options.controlPlaneToken, 'control_plane'),
      getJson(fetcher, `${controlPlaneOrigin}/v1/runs/${item.runId}/audit`, options.controlPlaneToken, 'control_plane'),
    ]);
    verifyControlPlane(planView, auditView, item);
    for (const attempt of item.attempts) {
      await verifyAction(fetcher, githubApiOrigin, options.githubToken, item, attempt);
      verifiedActionRunCount += 1;
      verifiedJobCount += 1;
      const git = await verifyGit(fetcher, githubApiOrigin, options.githubToken, item, attempt);
      if (git === 'commit') verifiedCommitCount += 1;
      if (git === 'relationship') {
        verifiedCommitCount += 1;
        verifiedGitRelationshipCount += 1;
      }
    }
  }
  return {
    schemaVersion: '1',
    evidenceId: parsed.data.evidenceId,
    repository: parsed.data.repository,
    caseCount: parsed.data.cases.length,
    repairedCases: parsed.data.cases.filter((item) => item.outcome === 'repair_succeeded').length,
    repeatedFingerprintBlockedCases: parsed.data.cases.filter((item) => item.outcome === 'repeated_fingerprint_blocked').length,
    attemptLimitBlockedCases: parsed.data.cases.filter((item) => item.outcome === 'attempt_limit_blocked').length,
    verifiedActionRunCount,
    verifiedJobCount,
    verifiedCommitCount,
    verifiedGitRelationshipCount,
    duplicateRepairEffects: 0,
  };
}
