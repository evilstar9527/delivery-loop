import {
  GitHubActionsApiClient,
  type GitHubInstallationTokenProvider,
} from '../outbox/github-dispatcher.js';
import {
  TestAcceptanceEvidenceManifestV1Schema,
  type TestAcceptanceEvidenceManifestV1,
} from '../domain/test-acceptance-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type TestAcceptanceEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'acceptance_effect_mismatch';

export class TestAcceptanceEvidenceVerificationError extends Error {
  constructor(readonly code: TestAcceptanceEvidenceVerificationErrorCode) {
    super(`test acceptance evidence verification failed: ${code}`);
    this.name = 'TestAcceptanceEvidenceVerificationError';
  }
}

export interface TestAcceptanceEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface TestAcceptanceEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  runningCases: number;
  passedCases: number;
  failedCases: number;
  verifiedActionCount: number;
  verifiedEvidenceCount: number;
  prematureSucceededRuns: 0;
  duplicateAcceptances: 0;
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
    throw new TestAcceptanceEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new TestAcceptanceEvidenceVerificationError('configuration_invalid');
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
    throw new TestAcceptanceEvidenceVerificationError('control_plane_unavailable');
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new TestAcceptanceEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new TestAcceptanceEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    throw new TestAcceptanceEvidenceVerificationError('control_plane_response_invalid');
  }
  if (text === null) throw new TestAcceptanceEvidenceVerificationError('control_plane_response_invalid');
  try {
    const body = record(JSON.parse(text) as unknown);
    if (body === null) throw new Error('invalid');
    return body;
  } catch {
    throw new TestAcceptanceEvidenceVerificationError('control_plane_response_invalid');
  }
}

function verifyProjection(
  audit: Record<string, unknown>,
  item: TestAcceptanceEvidenceManifestV1['cases'][number],
): void {
  const run = record(audit.run);
  const task = record(audit.task);
  const target = task === null ? null : record(task.target);
  const answers = record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  const who = answers === null ? null : record(answers.who);
  if (
    run === null || answers === null || checks === null ||
    audit.schemaVersion !== '1' || run.id !== item.runId ||
    run.version !== item.currentRunVersion || run.state !== item.runState ||
    target?.repository !== item.repository
  ) throw new TestAcceptanceEvidenceVerificationError('control_plane_projection_mismatch');

  const deployments = rows(answers, 'deployments').filter((deployment) =>
    deployment.kind === 'test' && deployment.deploymentId === item.deploymentId,
  );
  if (
    deployments.length !== 1 || deployments[0]!.status !== 'succeeded' ||
    deployments[0]!.sha !== item.refSha || deployments[0]!.evidenceId !== item.deploymentEvidenceId ||
    deployments[0]!.url !== item.environmentUrl
  ) throw new TestAcceptanceEvidenceVerificationError('control_plane_projection_mismatch');

  const acceptances = rows(checks, 'testAcceptances').filter((acceptance) =>
    acceptance.acceptanceId === item.acceptanceId,
  );
  if (acceptances.length !== 1) {
    throw new TestAcceptanceEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const acceptance = acceptances[0]!;
  const expectedStatus = item.outcome === 'running'
    ? item.acceptanceStatus
    : item.outcome;
  if (
    acceptance.deploymentId !== item.deploymentId || acceptance.runVersion !== item.runVersion ||
    acceptance.planId !== item.planId || acceptance.planVersion !== item.planVersion ||
    acceptance.planDigest !== item.planDigest || acceptance.itemId !== item.planItemId ||
    acceptance.attemptId !== item.attemptId || acceptance.approvalId !== item.approvalId ||
    acceptance.repository !== item.repository || acceptance.environment !== 'test' ||
    acceptance.workflowPath !== item.workflowPath || acceptance.oidcAudience !== item.oidcAudience ||
    acceptance.commandRef !== item.commandRef || acceptance.environmentUrl !== item.environmentUrl ||
    acceptance.status !== expectedStatus || acceptance.refSha !== item.refSha ||
    acceptance.githubRunId !== item.actionRunId || acceptance.oidcAttestationId !== item.oidcAttestationId ||
    acceptance.oidcGithubRunId !== item.oidcGithubRunId || acceptance.oidcSubject !== item.oidcSubject ||
    acceptance.runnerResultDigest !== item.runner.digest || acceptance.runnerStatus !== item.runner.status ||
    acceptance.runnerExitCode !== item.runner.exitCode || acceptance.runnerDurationMs !== item.runner.durationMs ||
    acceptance.externalState !== item.actionStatus || acceptance.externalConclusion !== item.actionConclusion ||
    acceptance.evidenceId !== item.acceptanceEvidenceId
  ) throw new TestAcceptanceEvidenceVerificationError('control_plane_projection_mismatch');

  const evidence = rows(checks, 'evidence').filter((candidate) =>
    candidate.evidenceId === item.acceptanceEvidenceId,
  );
  if (item.acceptanceEvidenceId === null) {
    if (evidence.length !== 0) {
      throw new TestAcceptanceEvidenceVerificationError('control_plane_projection_mismatch');
    }
  } else if (
    evidence.length !== 1 || evidence[0]!.kind !== 'test' ||
    evidence[0]!.status !== item.acceptanceEvidenceStatus ||
    evidence[0]!.verificationStatus !== 'verified' || evidence[0]!.sha !== item.refSha ||
    evidence[0]!.url !== item.actionUrl
  ) throw new TestAcceptanceEvidenceVerificationError('control_plane_projection_mismatch');

  const observations = rows(checks, 'testAcceptanceObservations');
  for (const expected of [item.webhook, item.apiObservation]) {
    const matches = observations.filter((observation) =>
      observation.observationId === expected.id && observation.factDigest === expected.digest &&
      observation.processingState === expected.state && observation.acceptanceId === item.acceptanceId &&
      observation.githubRunId === item.actionRunId && observation.observedAt === expected.observedAt,
    );
    if (matches.length !== 1) {
      throw new TestAcceptanceEvidenceVerificationError('control_plane_projection_mismatch');
    }
  }

  const attemptRows = rows(who ?? {}, 'attempts').filter((attempt) =>
    attempt.attemptId === item.attemptId && attempt.mode === 'deploy',
  );
  const effectOutboxes = rows(checks, 'effectOutboxes').filter((outbox) =>
    outbox.kind === 'test_acceptance_dispatch',
  );
  if (
    attemptRows.length !== 1 || effectOutboxes.length !== 1 ||
    item.noDuplicate.attempts !== 1 || item.noDuplicate.acceptances !== 1 ||
    item.noDuplicate.dispatchOutboxes !== 1 ||
    item.noDuplicate.evidence !== (item.acceptanceEvidenceId === null ? 0 : 1)
  ) throw new TestAcceptanceEvidenceVerificationError('acceptance_effect_mismatch');

  if (item.outcome === 'running' && (acceptance.status === 'passed' || acceptance.evidenceId !== null)) {
    throw new TestAcceptanceEvidenceVerificationError('acceptance_effect_mismatch');
  }
}

async function verifyAction(
  item: TestAcceptanceEvidenceManifestV1['cases'][number],
  client: GitHubActionsApiClient,
): Promise<void> {
  let action;
  try {
    action = await client.getAcceptanceWorkflowRun(item.repository, item.actionRunId);
  } catch {
    throw new TestAcceptanceEvidenceVerificationError('github_api_unavailable');
  }
  if (
    action.repository !== item.repository || action.event !== 'workflow_dispatch' ||
    action.status !== item.actionStatus || action.conclusion !== item.actionConclusion ||
    action.headSha !== item.refSha ||
    !(action.workflowPath === item.workflowPath || action.workflowPath.startsWith(`${item.workflowPath}@`)) ||
    action.displayTitle !== `delivery-loop/acceptance/${item.acceptanceId}` ||
    action.runAttempt !== 1
  ) throw new TestAcceptanceEvidenceVerificationError('github_action_mismatch');
}

export async function verifyTestAcceptanceEvidence(
  input: TestAcceptanceEvidenceManifestV1,
  options: TestAcceptanceEvidenceVerifierOptions,
): Promise<TestAcceptanceEvidenceVerificationSummary> {
  const parsed = TestAcceptanceEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new TestAcceptanceEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new TestAcceptanceEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const tokenProvider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => options.githubToken,
    getAcceptanceToken: async () => options.githubToken,
  };
  const actionClient = new GitHubActionsApiClient(tokenProvider, {
    apiBaseUrl: githubApiOrigin,
    fetch: fetcher,
  });
  const audits = new Map<string, Record<string, unknown>>();
  for (const item of parsed.data.cases) {
    const audit = audits.get(item.runId) ?? await controlPlaneJson(
      fetcher, controlPlaneOrigin, options.controlPlaneToken, item.runId,
    );
    audits.set(item.runId, audit);
    verifyProjection(audit, item);
    await verifyAction(item, actionClient);
  }
  return {
    schemaVersion: '1',
    evidenceId: parsed.data.evidenceId,
    repository: parsed.data.repository,
    caseCount: parsed.data.cases.length,
    runningCases: parsed.data.cases.filter((item) => item.outcome === 'running').length,
    passedCases: parsed.data.cases.filter((item) => item.outcome === 'passed').length,
    failedCases: parsed.data.cases.filter((item) => item.outcome === 'failed').length,
    verifiedActionCount: parsed.data.cases.length,
    verifiedEvidenceCount: parsed.data.cases.filter((item) => item.acceptanceEvidenceId !== null).length,
    prematureSucceededRuns: 0,
    duplicateAcceptances: 0,
  };
}
