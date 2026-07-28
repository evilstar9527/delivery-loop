import { canonicalSha256 } from '../domain/digest.js';
import {
  TestRollbackEvidenceManifestV1Schema,
  type TestRollbackEvidenceManifestV1,
} from '../domain/test-rollback-evidence.js';
import {
  GitHubActionsApiClient,
  type GitHubInstallationTokenProvider,
} from '../outbox/github-dispatcher.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const ROLLBACK_WORKFLOW = '.github/workflows/delivery-test-rollback.yml';

export type TestRollbackEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'unexpected_rollback_action'
  | 'rollback_effect_mismatch'
  | 'secret_leak_detected';

export class TestRollbackEvidenceVerificationError extends Error {
  constructor(readonly code: TestRollbackEvidenceVerificationErrorCode) {
    super(`test rollback evidence verification failed: ${code}`);
    this.name = 'TestRollbackEvidenceVerificationError';
  }
}

export interface TestRollbackEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  canary: string;
  githubApiOrigin?: string;
  fetcher?: typeof fetch;
}

export interface TestRollbackEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  successfulRollbackCases: 2;
  deploymentFailureRollbacks: 1;
  acceptanceFailureRollbacks: 1;
  negativeCases: 2;
  verifiedActions: 2;
  zeroUnexpectedActions: 2;
  verifiedEvidence: 2;
  duplicateRollbacks: 0;
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
}

type SuccessfulRollback = TestRollbackEvidenceManifestV1['successfulRollbacks'][number];
type NegativeCase = TestRollbackEvidenceManifestV1['negativeCases'][number];
type Source = 'control_plane' | 'github';

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

function unique(
  values: Array<Record<string, unknown>>,
  predicate: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0]! : null;
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new TestRollbackEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new TestRollbackEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function unavailable(source: Source): TestRollbackEvidenceVerificationErrorCode {
  return source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable';
}

function invalid(source: Source): TestRollbackEvidenceVerificationErrorCode {
  return source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
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

async function guardedResponse(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  source: Source,
  scanner: SecretScanner,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TestRollbackEvidenceVerificationError(unavailable(source));
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new TestRollbackEvidenceVerificationError(invalid(source));
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new TestRollbackEvidenceVerificationError(invalid(source)); }
  if (text === null) throw new TestRollbackEvidenceVerificationError(invalid(source));
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new TestRollbackEvidenceVerificationError('secret_leak_detected');
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function externalJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  source: Source,
  scanner: SecretScanner,
  rejectPagination = false,
): Promise<unknown> {
  const response = await guardedResponse(fetcher, url, init, source, scanner);
  if (
    !response.ok ||
    (rejectPagination && /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? ''))
  ) throw new TestRollbackEvidenceVerificationError(unavailable(source));
  try { return JSON.parse(await response.text()) as unknown; }
  catch { throw new TestRollbackEvidenceVerificationError(invalid(source)); }
}

function reportSections(raw: unknown, item: { runId: string; currentRunVersion: number;
  runState: string; repository: string }): {
  who: Record<string, unknown>;
  checks: Record<string, unknown>;
  answers: Record<string, unknown>;
} {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const task = root === null ? null : record(root.task);
  const target = task === null ? null : record(task.target);
  const answers = root === null ? null : record(root.answers);
  const who = answers === null ? null : record(answers.who);
  const checks = answers === null ? null : record(answers.checks);
  if (
    root === null || run === null || answers === null || who === null || checks === null ||
    root.schemaVersion !== '1' || run.id !== item.runId ||
    run.version !== item.currentRunVersion || run.state !== item.runState ||
    target?.repository !== item.repository
  ) throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');
  return { who, checks, answers };
}

function verifySourceFailure(
  item: SuccessfulRollback,
  sections: ReturnType<typeof reportSections>,
): void {
  const deployments = records(sections.answers, 'deployments');
  const deployment = unique(deployments, (candidate) =>
    candidate.kind === 'test' && candidate.deploymentId === item.source.deploymentId);
  const evidence = records(sections.checks, 'evidence');
  const sourceEvidence = unique(evidence, (candidate) =>
    candidate.evidenceId === item.source.evidenceId);
  const deploymentFailed = item.source.kind === 'deployment_failure';
  if (
    deployment === null || deployment.sha !== item.refSha ||
    deployment.status !== (deploymentFailed ? 'failed' : 'succeeded') ||
    deployment.evidenceId !== item.source.deploymentEvidenceId ||
    sourceEvidence === null || sourceEvidence.status !== 'failed' ||
    sourceEvidence.verificationStatus !== 'verified' || sourceEvidence.sha !== item.refSha
  ) throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');

  const acceptances = records(sections.checks, 'testAcceptances');
  if (item.source.kind === 'deployment_failure') {
    if (acceptances.some((candidate) => candidate.evidenceId === item.source.evidenceId)) {
      throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');
    }
  } else {
    const acceptance = unique(acceptances, (candidate) =>
      candidate.acceptanceId === item.source.acceptanceId);
    if (
      acceptance === null || acceptance.deploymentId !== item.source.deploymentId ||
      acceptance.attemptId !== item.source.failedAttemptId || acceptance.status !== 'failed' ||
      acceptance.refSha !== item.refSha || acceptance.evidenceId !== item.source.evidenceId
    ) throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');
  }
}

function verifySuccessfulProjection(raw: unknown, item: SuccessfulRollback): void {
  const sections = reportSections(raw, item);
  verifySourceFailure(item, sections);
  const contracts = records(sections.checks, 'testRollbackContracts');
  const contract = unique(contracts, (candidate) =>
    candidate.observationId === item.contractObservationId);
  if (
    contract === null || contract.sourceKind !== item.source.kind ||
    contract.sourceId !== item.source.id || contract.sourceEvidenceId !== item.source.evidenceId ||
    contract.repository !== item.repository || contract.refSha !== item.refSha ||
    contract.disposition !== 'declared' || contract.policyDigest !== item.policyDigest ||
    contract.contractDigest !== item.contractDigest || contract.workflowPath !== item.workflowPath ||
    contract.environment !== 'test' || contract.oidcAudience !== item.oidcAudience ||
    contract.roleRef !== item.roleRef
  ) throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');

  const rollbacks = records(sections.checks, 'testRollbacks');
  const rollback = unique(rollbacks, (candidate) => candidate.rollbackId === item.rollbackId);
  if (
    rollback === null || rollback.sourceKind !== item.source.kind ||
    rollback.sourceId !== item.source.id || rollback.sourceEvidenceId !== item.source.evidenceId ||
    rollback.failedAttemptId !== item.source.failedAttemptId ||
    rollback.deploymentId !== item.source.deploymentId || rollback.approvalId !== item.approvalId ||
    rollback.contractObservationId !== item.contractObservationId ||
    rollback.runVersion !== item.runVersion || rollback.planId !== item.planId ||
    rollback.planVersion !== item.planVersion || rollback.planDigest !== item.planDigest ||
    rollback.itemId !== item.planItemId || rollback.attemptId !== item.rollbackAttemptId ||
    rollback.repository !== item.repository || rollback.baseBranch !== item.baseBranch ||
    rollback.baseSha !== item.baseSha || rollback.refSha !== item.refSha ||
    rollback.policyDigest !== item.policyDigest || rollback.contractDigest !== item.contractDigest ||
    rollback.workflowPath !== item.workflowPath || rollback.environment !== 'test' ||
    rollback.oidcAudience !== item.oidcAudience || rollback.roleRef !== item.roleRef ||
    rollback.status !== 'succeeded' || rollback.githubRunId !== item.actionRunId ||
    rollback.runnerResultDigest !== item.runner.digest || rollback.runnerStatus !== 'passed' ||
    rollback.runnerExitCode !== 0 || rollback.runnerDurationMs !== item.runner.durationMs ||
    rollback.externalState !== 'completed' || rollback.externalConclusion !== 'success' ||
    rollback.evidenceId !== item.rollbackEvidenceId ||
    rollback.oidcAttestationId !== item.oidc.attestationId ||
    rollback.oidcGithubRunId !== item.oidc.githubRunId ||
    rollback.oidcWorkflowRef !== item.oidc.workflowRef || rollback.oidcSubject !== item.oidc.subject
  ) throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');

  const observations = records(sections.checks, 'testRollbackObservations');
  for (const expected of [item.observations.webhook, item.observations.api]) {
    const observation = unique(observations, (candidate) =>
      candidate.observationId === expected.id && candidate.factDigest === expected.digest &&
      candidate.rollbackId === item.rollbackId && candidate.githubRunId === item.actionRunId &&
      candidate.processingState === expected.state && candidate.observedAt === expected.observedAt);
    if (observation === null) {
      throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');
    }
  }

  const attempts = records(sections.who, 'attempts');
  const sourceAttempt = unique(attempts, (candidate) =>
    candidate.attemptId === item.source.failedAttemptId && candidate.status === 'failed');
  const rollbackAttempt = unique(attempts, (candidate) =>
    candidate.attemptId === item.rollbackAttemptId && candidate.mode === 'deploy' &&
    candidate.status === 'completed' && candidate.githubRunId === item.actionRunId &&
    candidate.workflowRef === item.oidc.workflowRef);
  const outboxes = records(sections.checks, 'effectOutboxes').filter((candidate) =>
    candidate.kind === 'test_rollback_dispatch');
  const evidence = records(sections.checks, 'evidence');
  const rollbackEvidence = unique(evidence, (candidate) =>
    candidate.evidenceId === item.rollbackEvidenceId && candidate.kind === 'deployment' &&
    candidate.status === 'passed' && candidate.verificationStatus === 'verified' &&
    candidate.sha === item.refSha && candidate.url === item.actionUrl);
  if (
    sourceAttempt === null || rollbackAttempt === null || outboxes.length !== 1 ||
    rollbackEvidence === null || contracts.length !== item.noDuplicate.contracts ||
    rollbacks.length !== item.noDuplicate.rollbacks ||
    outboxes.length !== item.noDuplicate.dispatchOutboxes ||
    item.noDuplicate.attempts !== 1 || item.noDuplicate.evidence !== 1
  ) throw new TestRollbackEvidenceVerificationError('rollback_effect_mismatch');
}

function rollbackAttemptCount(sections: ReturnType<typeof reportSections>): number {
  return records(sections.who, 'attempts').filter((candidate) =>
    candidate.workflowRef === undefined
      ? false
      : String(candidate.workflowRef).includes(`/${ROLLBACK_WORKFLOW}@refs/heads/`)).length;
}

function verifyNegativeProjection(raw: unknown, item: NegativeCase): void {
  const sections = reportSections(raw, item);
  const rollbacks = records(sections.checks, 'testRollbacks');
  const rollbackObservations = records(sections.checks, 'testRollbackObservations');
  const rollbackOutboxes = records(sections.checks, 'effectOutboxes').filter((candidate) =>
    candidate.kind === 'test_rollback_dispatch');
  const rollbackEvidence = records(sections.checks, 'evidence').filter((candidate) =>
    candidate.status === 'passed' && candidate.kind === 'deployment' &&
    typeof candidate.url === 'string' && candidate.url.includes('/actions/runs/'));
  if (
    rollbacks.length !== 0 || rollbackObservations.length !== 0 || rollbackOutboxes.length !== 0 ||
    rollbackAttemptCount(sections) !== 0 || rollbackEvidence.length !== item.noEffect.evidence
  ) throw new TestRollbackEvidenceVerificationError('rollback_effect_mismatch');

  const deployments = records(sections.answers, 'deployments');
  const evidence = records(sections.checks, 'evidence');
  if (item.caseKind === 'contract_absent') {
    const sourceDeployment = unique(deployments, (candidate) =>
      candidate.kind === 'test' && candidate.deploymentId === item.source.deploymentId &&
      candidate.status === 'failed' && candidate.sha === item.refSha &&
      candidate.evidenceId === item.source.evidenceId);
    const sourceEvidence = unique(evidence, (candidate) =>
      candidate.evidenceId === item.source.evidenceId && candidate.status === 'failed' &&
      candidate.verificationStatus === 'verified' && candidate.sha === item.refSha);
    const contracts = records(sections.checks, 'testRollbackContracts');
    const contract = unique(contracts, (candidate) =>
      candidate.observationId === item.contractObservation.id);
    if (
      sourceDeployment === null || sourceEvidence === null || contracts.length !== 1 ||
      contract === null || contract.sourceKind !== item.source.kind ||
      contract.sourceId !== item.source.id || contract.sourceEvidenceId !== item.source.evidenceId ||
      contract.repository !== item.repository || contract.refSha !== item.refSha ||
      contract.disposition !== item.contractObservation.disposition ||
      contract.policyDigest !== item.contractObservation.policyDigest ||
      contract.contractDigest !== undefined || contract.workflowPath !== undefined ||
      contract.environment !== undefined || contract.oidcAudience !== undefined ||
      contract.roleRef !== undefined || contract.observedAt !== item.contractObservation.observedAt
    ) throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');
  } else {
    const productionDeployment = unique(deployments, (candidate) =>
      candidate.kind === 'production' && candidate.deploymentId === item.deploymentId &&
      candidate.status === 'failed' && candidate.sha === item.refSha &&
      candidate.evidenceId === item.sourceEvidenceId);
    const sourceEvidence = unique(evidence, (candidate) =>
      candidate.evidenceId === item.sourceEvidenceId && candidate.status === 'failed' &&
      candidate.verificationStatus === 'verified' && candidate.sha === item.refSha);
    if (
      productionDeployment === null || sourceEvidence === null ||
      records(sections.checks, 'testRollbackContracts').length !== 0
    ) throw new TestRollbackEvidenceVerificationError('control_plane_projection_mismatch');
  }
}

async function verifyAction(
  item: SuccessfulRollback,
  client: GitHubActionsApiClient,
): Promise<void> {
  let fact;
  try { fact = await client.getRollbackWorkflowRun(item.repository, item.actionRunId); }
  catch (error) {
    if (error instanceof TestRollbackEvidenceVerificationError) throw error;
    throw new TestRollbackEvidenceVerificationError('github_api_unavailable');
  }
  if (
    fact.repository !== item.repository || fact.event !== 'workflow_dispatch' ||
    fact.status !== 'completed' || fact.conclusion !== 'success' ||
    fact.headSha !== item.refSha || fact.headBranch !== item.baseBranch ||
    !(fact.workflowPath === item.workflowPath || fact.workflowPath.startsWith(`${item.workflowPath}@`)) ||
    fact.displayTitle !== `delivery-loop/rollback/${item.rollbackId}` || fact.runAttempt !== 1
  ) throw new TestRollbackEvidenceVerificationError('github_action_mismatch');
}

async function verifyNoAction(
  item: NegativeCase,
  origin: string,
  token: string,
  fetcher: typeof fetch,
  scanner: SecretScanner,
): Promise<void> {
  const created = `${item.actionAbsence.from}..${item.actionAbsence.to}`;
  const params = new URLSearchParams({
    event: 'workflow_dispatch',
    head_sha: item.refSha,
    created,
    per_page: '100',
  });
  const url = `${origin}/repos/${item.repository}/actions/workflows/` +
    `${encodeURIComponent(ROLLBACK_WORKFLOW)}/runs?${params.toString()}`;
  const raw = await externalJson(fetcher, url, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  }, 'github', scanner, true);
  const root = record(raw);
  if (
    root === null || root.total_count !== 0 ||
    !Array.isArray(root.workflow_runs) || root.workflow_runs.length !== 0
  ) throw new TestRollbackEvidenceVerificationError('unexpected_rollback_action');
}

export async function verifyTestRollbackEvidence(
  input: TestRollbackEvidenceManifestV1,
  options: TestRollbackEvidenceVerifierOptions,
): Promise<TestRollbackEvidenceVerificationSummary> {
  const parsed = TestRollbackEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new TestRollbackEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canary)
  ) throw new TestRollbackEvidenceVerificationError('configuration_invalid');
  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetcher ?? fetch;
  const scanner = new SecretScanner({
    secrets: [options.controlPlaneToken, options.githubToken, options.canary],
  });
  if (scanner.scan(manifest, '$.manifest').length > 0) {
    throw new TestRollbackEvidenceVerificationError('secret_leak_detected');
  }
  const scannedGitHubFetch = (async (request, init) => await guardedResponse(
    fetcher, String(request), init ?? {}, 'github', scanner,
  )) as typeof fetch;
  const tokenProvider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => options.githubToken,
    getRollbackObservationToken: async () => options.githubToken,
  };
  const actionClient = new GitHubActionsApiClient(tokenProvider, {
    apiBaseUrl: githubOrigin,
    fetch: scannedGitHubFetch,
  });

  for (const item of manifest.successfulRollbacks) {
    const raw = await externalJson(fetcher, `${controlOrigin}/v1/runs/${item.runId}/audit`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${options.controlPlaneToken}` },
    }, 'control_plane', scanner);
    verifySuccessfulProjection(raw, item);
    await verifyAction(item, actionClient);
  }
  for (const item of manifest.negativeCases) {
    const raw = await externalJson(fetcher, `${controlOrigin}/v1/runs/${item.runId}/audit`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${options.controlPlaneToken}` },
    }, 'control_plane', scanner);
    verifyNegativeProjection(raw, item);
    await verifyNoAction(item, githubOrigin, options.githubToken, fetcher, scanner);
  }

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    successfulRollbackCases: 2,
    deploymentFailureRollbacks: 1,
    acceptanceFailureRollbacks: 1,
    negativeCases: 2,
    verifiedActions: 2,
    zeroUnexpectedActions: 2,
    verifiedEvidence: 2,
    duplicateRollbacks: 0,
    plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
