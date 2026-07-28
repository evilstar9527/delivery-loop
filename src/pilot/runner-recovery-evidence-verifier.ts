import {
  RunnerRecoveryEvidenceManifestV1Schema,
  type RunnerRecoveryEvidenceManifestV1,
} from '../domain/runner-recovery-evidence.js';
import { canonicalSha256 } from '../domain/digest.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;

export type RunnerRecoveryEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'control_plane_correlation_mismatch'
  | 'control_plane_report_mismatch'
  | 'control_plane_recovery_mismatch'
  | 'control_plane_side_effect_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_job_mismatch'
  | 'github_commit_mismatch'
  | 'github_git_relationship_mismatch'
  | 'secret_leak_detected';

export class RunnerRecoveryEvidenceVerificationError extends Error {
  constructor(readonly code: RunnerRecoveryEvidenceVerificationErrorCode) {
    super(`Runner recovery evidence verification failed: ${code}`);
    this.name = 'RunnerRecoveryEvidenceVerificationError';
  }
}

export interface RunnerRecoveryEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  operationsToken: string;
  githubToken: string;
  canary: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface RunnerRecoveryEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  recovery: 'verified';
  lostAction: 'cancelled';
  replacementAction: 'succeeded';
  checkpointSequence: number;
  previouslyPassedItemCount: 1;
  verifiedActionRunCount: 2;
  verifiedCommitCount: 2;
  verifiedBranchRefCount: 1;
  gitRelationship: 'fast_forward';
  oldLeaseGenerationRevoked: true;
  oldTokenRevoked: true;
  workflowCancelSettled: true;
  replacementCommitCount: 1;
  verifiedEffectOutboxCount: number;
  verifiedPullRequestCount: number;
  verifiedDeploymentCount: number;
  controlledReplayCount: 0;
  plaintextLeaks: 0;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RunnerRecoveryEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new RunnerRecoveryEvidenceVerificationError('configuration_invalid');
  return url.origin;
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

function exactRow(
  values: Array<Record<string, unknown>>,
  id: string,
): Record<string, unknown> | null {
  const matches = values.filter((value) => value.id === id);
  return matches.length === 1 ? matches[0]! : null;
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') &&
    value.length === expected.length &&
    new Set(value).size === value.length && expected.every((entry) => value.includes(entry));
}

// Directly reuses the bounded streaming reader from tools/tool-bridge-client.ts.
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
    throw new RunnerRecoveryEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RunnerRecoveryEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new RunnerRecoveryEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
  const invalidResponse = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RunnerRecoveryEvidenceVerificationError(invalidResponse);
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new RunnerRecoveryEvidenceVerificationError(invalidResponse);
  }
  if (text === null) throw new RunnerRecoveryEvidenceVerificationError(invalidResponse);
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new RunnerRecoveryEvidenceVerificationError('secret_leak_detected');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RunnerRecoveryEvidenceVerificationError(invalidResponse);
  }
}

function verifyPlanProjection(
  view: unknown,
  manifest: RunnerRecoveryEvidenceManifestV1,
): void {
  const root = record(view);
  const run = root === null ? null : record(root.run);
  const plan = root === null ? null : record(root.plan);
  if (
    root === null || run === null || plan === null || run.id !== manifest.runId ||
    run.state !== manifest.expectedRunState || plan.id !== manifest.planId ||
    plan.version !== manifest.planVersion ||
    (plan.status !== 'active' && plan.status !== 'completed')
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_projection_mismatch');

  const attempts = rows(root, 'attempts');
  const lost = exactRow(attempts, manifest.lost.attemptId);
  const replacement = exactRow(attempts, manifest.replacement.attemptId);
  const recovery = replacement === null ? null : record(replacement.recovery);
  if (
    lost === null || replacement === null || recovery === null ||
    lost.ordinal !== manifest.lost.ordinal || lost.status !== 'lost' ||
    lost.leaseGeneration !== manifest.lost.fencedLeaseGeneration ||
    lost.planId !== manifest.planId || lost.planVersion !== manifest.planVersion ||
    lost.planItemId !== manifest.recoveredPlanItemId ||
    lost.headBranch !== manifest.checkpoint.headBranch ||
    lost.headSha !== manifest.checkpoint.headSha ||
    replacement.ordinal !== manifest.replacement.ordinal ||
    replacement.status !== 'completed' ||
    replacement.leaseGeneration !== manifest.replacement.leaseGeneration ||
    replacement.planId !== manifest.planId ||
    replacement.planVersion !== manifest.planVersion ||
    replacement.planItemId !== manifest.recoveredPlanItemId ||
    replacement.headBranch !== manifest.checkpoint.headBranch ||
    replacement.headSha !== manifest.replacement.resultHeadSha ||
    recovery.recoveredFromAttemptId !== manifest.lost.attemptId ||
    recovery.checkpointId !== manifest.checkpoint.checkpointId
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_projection_mismatch');

  const checkpoint = exactRow(rows(root, 'checkpoints'), manifest.checkpoint.checkpointId);
  if (
    checkpoint === null || checkpoint.attemptId !== manifest.lost.attemptId ||
    checkpoint.sequence !== manifest.checkpoint.sequence ||
    checkpoint.payloadDigest !== manifest.checkpoint.digest ||
    checkpoint.planId !== manifest.planId ||
    checkpoint.planVersion !== manifest.planVersion ||
    checkpoint.planItemId !== manifest.recoveredPlanItemId ||
    checkpoint.headSha !== manifest.checkpoint.headSha
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_projection_mismatch');

  const items = rows(root, 'items');
  const recoveredItem = exactRow(items, manifest.recoveredPlanItemId);
  const passedItem = exactRow(items, manifest.previouslyPassed.planItemId);
  const recoveredDecision = recoveredItem === null ? null : record(recoveredItem.verificationDecision);
  const passedDecision = passedItem === null ? null : record(passedItem.verificationDecision);
  if (
    recoveredItem === null || passedItem === null ||
    recoveredItem.status !== 'passed' || passedItem.status !== 'passed' ||
    recoveredDecision === null || passedDecision === null ||
    recoveredDecision.id !== manifest.replacement.verificationId ||
    !exactStrings(recoveredDecision.evidenceIds, [manifest.replacement.evidenceId]) ||
    passedDecision.id !== manifest.previouslyPassed.verificationId ||
    !exactStrings(passedDecision.evidenceIds, manifest.previouslyPassed.evidenceIds)
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_projection_mismatch');

  const evidence = rows(root, 'evidence');
  const recoveredEvidence = exactRow(evidence, manifest.replacement.evidenceId);
  if (
    recoveredEvidence === null ||
    recoveredEvidence.attemptId !== manifest.replacement.attemptId ||
    recoveredEvidence.planId !== manifest.planId ||
    recoveredEvidence.planVersion !== manifest.planVersion ||
    recoveredEvidence.planItemId !== manifest.recoveredPlanItemId ||
    recoveredEvidence.status !== 'passed' ||
    recoveredEvidence.verificationStatus !== 'verified' ||
    recoveredEvidence.sha !== manifest.replacement.resultHeadSha
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_projection_mismatch');
  for (const evidenceId of manifest.previouslyPassed.evidenceIds) {
    const row = exactRow(evidence, evidenceId);
    if (
      row === null || row.planItemId !== manifest.previouslyPassed.planItemId ||
      row.status !== 'passed' || row.verificationStatus !== 'verified' ||
      row.attemptId === manifest.replacement.attemptId
    ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_projection_mismatch');
  }
  if (attempts.some((attempt) =>
    attempt.planItemId === manifest.previouslyPassed.planItemId &&
    typeof attempt.ordinal === 'number' && attempt.ordinal >= manifest.lost.ordinal)) {
    throw new RunnerRecoveryEvidenceVerificationError('control_plane_projection_mismatch');
  }
}

async function verifyCase8Report(
  raw: unknown,
  manifest: RunnerRecoveryEvidenceManifestV1,
): Promise<void> {
  const root = record(raw);
  if (root === null) {
    throw new RunnerRecoveryEvidenceVerificationError('control_plane_report_mismatch');
  }
  const { generatedAt, queryDurationMs, reportDigest, ...body } = root;
  if (
    root.schemaVersion !== '1' || root.runId !== manifest.runId ||
    reportDigest !== manifest.case8ReportDigest ||
    await canonicalSha256(body) !== reportDigest ||
    typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    Date.parse(generatedAt) > Date.parse(manifest.recordedAt) ||
    typeof queryDurationMs !== 'number' || !Number.isSafeInteger(queryDurationMs) ||
    queryDurationMs < 0
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_report_mismatch');

  const answers = record(root.answers);
  const permissions = answers === null ? null : record(answers.permissions);
  const checks = answers === null ? null : record(answers.checks);
  if (answers === null || permissions === null || checks === null) {
    throw new RunnerRecoveryEvidenceVerificationError('control_plane_recovery_mismatch');
  }
  const grants = rows(permissions, 'grants');
  const lostGrantMatches = grants.filter((grant) => grant.tokenId === manifest.lost.tokenId);
  const lostGrant = lostGrantMatches.length === 1 ? lostGrantMatches[0]! : null;
  const lostAttemptGrants = grants.filter((grant) => grant.attemptId === manifest.lost.attemptId);
  if (
    lostGrant === null || lostGrant.attemptId !== manifest.lost.attemptId ||
    lostGrant.leaseGeneration !== manifest.lost.activeLeaseGenerationBeforeKill ||
    lostGrant.revokedAt !== manifest.lost.tokenRevokedAt ||
    lostAttemptGrants.length < 1 ||
    lostAttemptGrants.some((grant) => typeof grant.revokedAt !== 'string')
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_recovery_mismatch');

  const effectOutboxValues = checks.effectOutboxes;
  const replayValues = checks.replays;
  const effectOutboxes = rows(checks, 'effectOutboxes');
  const replays = rows(checks, 'replays');
  const lostDispatch = exactRow(effectOutboxes, manifest.lost.dispatchOutboxId);
  const replacementDispatch = exactRow(effectOutboxes, manifest.replacement.dispatchOutboxId);
  const cancellation = exactRow(effectOutboxes, manifest.lost.workflowCancelOutboxId);
  if (
    !Array.isArray(effectOutboxValues) || effectOutboxes.length !== effectOutboxValues.length ||
    !Array.isArray(replayValues) || replays.length !== replayValues.length || replays.length !== 0 ||
    !exactStrings(
      effectOutboxes.map((outbox) => outbox.id),
      manifest.sideEffects.effectOutboxIds,
    ) ||
    effectOutboxes.some((outbox) => outbox.state !== 'settled' || outbox.lastErrorCode !== undefined) ||
    lostDispatch?.kind !== 'execution_dispatch' ||
    replacementDispatch?.kind !== 'execution_dispatch' || cancellation?.kind !== 'workflow_cancel'
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_side_effect_mismatch');
}

function verifyCorrelation(
  view: unknown,
  manifest: RunnerRecoveryEvidenceManifestV1,
): void {
  const root = record(view);
  const truncated = root === null ? null : record(root.truncated);
  if (
    root === null || truncated === null || root.correlationId !== manifest.runId ||
    truncated.attempts !== false || truncated.githubRuns !== false ||
    truncated.pullRequests !== false || truncated.deployments !== false ||
    truncated.traces !== false
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_correlation_mismatch');
  const attempts = rows(root, 'attempts');
  const lostAttempt = exactRow(attempts, manifest.lost.attemptId);
  const replacementAttempt = exactRow(attempts, manifest.replacement.attemptId);
  const githubRuns = rows(root, 'githubRuns');
  const lostRun = exactRow(githubRuns, manifest.lost.actionRunId);
  const replacementRun = exactRow(githubRuns, manifest.replacement.actionRunId);
  if (
    lostAttempt === null || replacementAttempt === null || lostRun === null ||
    replacementRun === null || lostAttempt.status !== 'lost' ||
    lostAttempt.githubRunId !== manifest.lost.actionRunId ||
    lostAttempt.githubStatus !== 'completed' || lostAttempt.githubConclusion !== 'cancelled' ||
    replacementAttempt.status !== 'completed' ||
    replacementAttempt.githubRunId !== manifest.replacement.actionRunId ||
    replacementAttempt.githubStatus !== 'completed' ||
    replacementAttempt.githubConclusion !== 'success' || lostRun.kind !== 'agent' ||
    lostRun.attemptId !== manifest.lost.attemptId || lostRun.status !== 'completed' ||
    lostRun.conclusion !== 'cancelled' || replacementRun.kind !== 'agent' ||
    replacementRun.attemptId !== manifest.replacement.attemptId ||
    replacementRun.status !== 'completed' || replacementRun.conclusion !== 'success'
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_correlation_mismatch');
  const pullRequests = rows(root, 'pullRequests');
  const deployments = rows(root, 'deployments');
  if (
    !exactStrings(
      pullRequests.map((publication) => publication.publicationId),
      manifest.sideEffects.pullRequestPublicationIds,
    ) ||
    !exactStrings(
      deployments.map((deployment) => deployment.id),
      manifest.sideEffects.deploymentIds,
    )
  ) throw new RunnerRecoveryEvidenceVerificationError('control_plane_side_effect_mismatch');
}

async function verifyAction(
  fetcher: typeof fetch,
  githubOrigin: string,
  token: string,
  manifest: RunnerRecoveryEvidenceManifestV1,
  kind: 'lost' | 'replacement',
  scanner: SecretScanner,
): Promise<void> {
  const expected = kind === 'lost' ? manifest.lost : manifest.replacement;
  const conclusion = kind === 'lost' ? 'cancelled' : 'success';
  const attemptId = kind === 'lost' ? manifest.lost.attemptId : manifest.replacement.attemptId;
  const run = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/actions/runs/${expected.actionRunId}`,
    token,
    'github',
    scanner,
  ));
  const repository = run === null ? null : record(run.repository);
  if (
    run === null || repository === null || String(run.id) !== expected.actionRunId ||
    run.status !== 'completed' || run.conclusion !== conclusion ||
    run.head_sha !== expected.workflowHeadSha || repository.full_name !== manifest.repository ||
    run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/delivery-agent.yml' ||
    run.display_title !== `delivery-loop/${attemptId}`
  ) throw new RunnerRecoveryEvidenceVerificationError('github_action_mismatch');

  const jobsRoot = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/actions/runs/${expected.actionRunId}/jobs?filter=all&per_page=100`,
    token,
    'github',
    scanner,
  ));
  const jobs = jobsRoot === null ? [] : rows(jobsRoot, 'jobs');
  if (jobsRoot === null || jobsRoot.total_count !== 1 || jobs.length !== 1) {
    throw new RunnerRecoveryEvidenceVerificationError('github_job_mismatch');
  }
  const job = jobs[0]!;
  const steps = rows(job, 'steps');
  const checkout = steps.filter((step) => step.name === 'Checkout trusted execution snapshot');
  const runner = steps.filter((step) => step.name === 'Run approved execution attempt');
  if (
    job.name !== 'attempt' || job.status !== 'completed' || job.conclusion !== conclusion ||
    checkout.length !== 1 || checkout[0]!.status !== 'completed' ||
    checkout[0]!.conclusion !== 'success' || runner.length !== 1 ||
    runner[0]!.status !== 'completed' || runner[0]!.conclusion !== conclusion
  ) throw new RunnerRecoveryEvidenceVerificationError('github_job_mismatch');
}

async function verifyCommit(
  fetcher: typeof fetch,
  githubOrigin: string,
  token: string,
  repository: string,
  sha: string,
  scanner: SecretScanner,
): Promise<void> {
  const commit = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${repository}/commits/${sha}`,
    token,
    'github',
    scanner,
  ));
  if (commit === null || commit.sha !== sha) {
    throw new RunnerRecoveryEvidenceVerificationError('github_commit_mismatch');
  }
}

async function verifyRecoveryGitRelationship(
  fetcher: typeof fetch,
  githubOrigin: string,
  token: string,
  manifest: RunnerRecoveryEvidenceManifestV1,
  scanner: SecretScanner,
): Promise<void> {
  const branchPath = manifest.checkpoint.headBranch
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const branch = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/git/ref/heads/${branchPath}`,
    token,
    'github',
    scanner,
  ));
  const branchObject = branch === null ? null : record(branch.object);
  if (
    branch === null || branchObject === null ||
    branch.ref !== `refs/heads/${manifest.checkpoint.headBranch}` ||
    branchObject.type !== 'commit' || branchObject.sha !== manifest.replacement.resultHeadSha
  ) throw new RunnerRecoveryEvidenceVerificationError('github_git_relationship_mismatch');

  const comparison = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/compare/` +
      `${manifest.checkpoint.headSha}...${manifest.replacement.resultHeadSha}`,
    token,
    'github',
    scanner,
  ));
  const baseCommit = comparison === null ? null : record(comparison.base_commit);
  const mergeBase = comparison === null ? null : record(comparison.merge_base_commit);
  const commits = comparison === null ? [] : rows(comparison, 'commits');
  if (
    comparison === null || baseCommit === null || mergeBase === null ||
    comparison.status !== 'ahead' || comparison.behind_by !== 0 ||
    comparison.ahead_by !== manifest.sideEffects.replacementCommitCount ||
    comparison.total_commits !== manifest.sideEffects.replacementCommitCount ||
    commits.length !== manifest.sideEffects.replacementCommitCount ||
    commits[0]?.sha !== manifest.replacement.resultHeadSha ||
    baseCommit.sha !== manifest.checkpoint.headSha || mergeBase.sha !== manifest.checkpoint.headSha
  ) throw new RunnerRecoveryEvidenceVerificationError('github_git_relationship_mismatch');
}

/** Cross-checks D1 recovery lineage against two live Actions runs and Git commits. */
export async function verifyRunnerRecoveryEvidence(
  rawManifest: unknown,
  options: RunnerRecoveryEvidenceVerifierOptions,
): Promise<RunnerRecoveryEvidenceVerificationSummary> {
  const parsed = RunnerRecoveryEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsed.success) throw new RunnerRecoveryEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.githubToken) || !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    await canonicalSha256(options.canary) !== manifest.safety.canaryDigest
  ) {
    throw new RunnerRecoveryEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const scanner = new SecretScanner({ secrets: [
    options.controlPlaneToken,
    options.operationsToken,
    options.githubToken,
    options.canary,
  ] });
  const [planView, correlationView, auditView] = await Promise.all([
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
      scanner,
    ),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/correlations?kind=run&id=${encodeURIComponent(manifest.runId)}`,
      options.controlPlaneToken,
      'control_plane',
      scanner,
    ),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.runId}/audit`,
      options.operationsToken,
      'control_plane',
      scanner,
    ),
  ]);
  verifyPlanProjection(planView, manifest);
  verifyCorrelation(correlationView, manifest);
  await verifyCase8Report(auditView, manifest);
  await Promise.all([
    verifyAction(fetcher, githubOrigin, options.githubToken, manifest, 'lost', scanner),
    verifyAction(fetcher, githubOrigin, options.githubToken, manifest, 'replacement', scanner),
    verifyCommit(
      fetcher,
      githubOrigin,
      options.githubToken,
      manifest.repository,
      manifest.checkpoint.headSha,
      scanner,
    ),
    verifyCommit(
      fetcher,
      githubOrigin,
      options.githubToken,
      manifest.repository,
      manifest.replacement.resultHeadSha,
      scanner,
    ),
    verifyRecoveryGitRelationship(
      fetcher,
      githubOrigin,
      options.githubToken,
      manifest,
      scanner,
    ),
  ]);
  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    runId: manifest.runId,
    recovery: 'verified',
    lostAction: 'cancelled',
    replacementAction: 'succeeded',
    checkpointSequence: manifest.checkpoint.sequence,
    previouslyPassedItemCount: 1,
    verifiedActionRunCount: 2,
    verifiedCommitCount: 2,
    verifiedBranchRefCount: 1,
    gitRelationship: 'fast_forward',
    oldLeaseGenerationRevoked: true,
    oldTokenRevoked: true,
    workflowCancelSettled: true,
    replacementCommitCount: 1,
    verifiedEffectOutboxCount: manifest.sideEffects.effectOutboxIds.length,
    verifiedPullRequestCount: manifest.sideEffects.pullRequestPublicationIds.length,
    verifiedDeploymentCount: manifest.sideEffects.deploymentIds.length,
    controlledReplayCount: 0,
    plaintextLeaks: 0,
  };
}
