import {
  GitHubActionsApiClient,
  type GitHubInstallationTokenProvider,
} from '../outbox/github-dispatcher.js';
import {
  GitHubProductionDeploymentStatusApiClient,
} from '../reconciliation/github-production-deployment-status-reconciler.js';
import {
  ProductionDeploymentEvidenceManifestV1Schema,
  type ProductionDeploymentEvidenceManifestV1,
} from '../domain/production-deployment-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type ProductionDeploymentEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_action_mismatch'
  | 'github_deployment_mismatch'
  | 'deployment_effect_mismatch';

export class ProductionDeploymentEvidenceVerificationError extends Error {
  constructor(readonly code: ProductionDeploymentEvidenceVerificationErrorCode) {
    super(`production deployment evidence verification failed: ${code}`);
    this.name = 'ProductionDeploymentEvidenceVerificationError';
  }
}

export interface ProductionDeploymentEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface ProductionDeploymentEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  inProgressCases: number;
  succeededCases: number;
  failedCases: number;
  verifiedActionCount: number;
  verifiedDeploymentCount: number;
  verifiedEvidenceCount: number;
  duplicateDeployments: 0;
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
    throw new ProductionDeploymentEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new ProductionDeploymentEvidenceVerificationError('configuration_invalid');
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
    throw new ProductionDeploymentEvidenceVerificationError('control_plane_unavailable');
  }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new ProductionDeploymentEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ProductionDeploymentEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try {
    text = await readBounded(response);
  } catch {
    throw new ProductionDeploymentEvidenceVerificationError('control_plane_response_invalid');
  }
  if (text === null) throw new ProductionDeploymentEvidenceVerificationError('control_plane_response_invalid');
  try {
    const body = record(JSON.parse(text) as unknown);
    if (body === null) throw new Error('invalid');
    return body;
  } catch {
    throw new ProductionDeploymentEvidenceVerificationError('control_plane_response_invalid');
  }
}

function verifyProjection(
  audit: Record<string, unknown>,
  item: ProductionDeploymentEvidenceManifestV1['cases'][number],
): void {
  const run = record(audit.run);
  const task = record(audit.task);
  const answers = record(audit.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (
    audit.schemaVersion !== '1' || run === null || task === null || answers === null ||
    checks === null || run.id !== item.runId || run.version !== item.currentRunVersion ||
    run.state !== item.runState || task.repository !== item.repository ||
    task.revision !== item.taskRevision
  ) throw new ProductionDeploymentEvidenceVerificationError('control_plane_projection_mismatch');

  const deployments = rows(answers, 'deployments').filter((deployment) =>
    deployment.kind === 'production' && deployment.deploymentId === item.deploymentId,
  );
  if (deployments.length !== 1) {
    throw new ProductionDeploymentEvidenceVerificationError('control_plane_projection_mismatch');
  }
  const deployment = deployments[0]!;
  const expectedStatus = item.externalState === 'in_progress'
    ? 'in_progress'
    : item.externalState === 'success' ? 'succeeded' : 'failed';
  if (
    deployment.runVersion !== item.runVersion || deployment.planId !== item.planId ||
    deployment.planVersion !== item.planVersion || deployment.planDigest !== item.planDigest ||
    deployment.attemptId !== item.attemptId || deployment.approvalId !== item.approvalId ||
    deployment.repository !== item.repository || deployment.environment !== 'production' ||
    deployment.roleRef !== item.roleRef || deployment.status !== expectedStatus ||
    deployment.sha !== item.mergeSha || deployment.githubDeploymentId !== item.githubDeploymentId ||
    deployment.workflowPath !== item.workflowPath || deployment.oidcAudience !== item.oidcAudience ||
    (deployment.oidcAttestationId ?? null) !== item.oidcAttestationId ||
    (deployment.oidcGithubRunId ?? null) !== item.oidcGithubRunId ||
    (deployment.oidcSubject ?? null) !== item.oidcSubject ||
    (deployment.evidenceId ?? null) !== item.deploymentEvidenceId ||
    (deployment.externalState ?? null) !== item.externalState ||
    (deployment.url ?? null) !== item.environmentUrl
  ) throw new ProductionDeploymentEvidenceVerificationError('control_plane_projection_mismatch');

  const expectedEvidenceStatus = item.deploymentEvidenceStatus;
  const evidence = rows(checks, 'evidence').filter((candidate) =>
    candidate.evidenceId === item.deploymentEvidenceId,
  );
  if (expectedEvidenceStatus === null) {
    if (evidence.length !== 0) {
      throw new ProductionDeploymentEvidenceVerificationError('control_plane_projection_mismatch');
    }
  } else if (
    evidence.length !== 1 || evidence[0]!.kind !== 'deployment' ||
    evidence[0]!.status !== expectedEvidenceStatus ||
    evidence[0]!.verificationStatus !== 'verified' || evidence[0]!.sha !== item.mergeSha ||
    (evidence[0]!.url ?? null) !== item.environmentUrl
  ) throw new ProductionDeploymentEvidenceVerificationError('control_plane_projection_mismatch');

  const observations = rows(checks, 'productionDeploymentObservations');
  for (const expected of [item.webhook, item.apiObservation]) {
    const matches = observations.filter((observation) =>
      observation.observationId === expected.id && observation.sourceKind === expected.sourceKind &&
      observation.factDigest === expected.digest && observation.processingState === expected.state &&
      observation.deploymentId === item.deploymentId && observation.observedAt === expected.observedAt,
    );
    if (matches.length !== 1) {
      throw new ProductionDeploymentEvidenceVerificationError('control_plane_projection_mismatch');
    }
  }

  const effectOutboxes = rows(checks, 'effectOutboxes').filter((outbox) =>
    outbox.kind === 'production_deploy',
  );
  const who = record(answers.who);
  const attempts = rows(who ?? {}, 'attempts').filter((attempt) =>
    attempt.attemptId === item.attemptId && attempt.mode === 'deploy',
  );
  if (
    effectOutboxes.length !== 1 || attempts.length !== 1 ||
    item.noDuplicate.attempts !== 1 || item.noDuplicate.deployments !== 1 ||
    item.noDuplicate.deployOutboxes !== 1 ||
    item.noDuplicate.deploymentEvidence !== (item.deploymentEvidenceId === null ? 0 : 1)
  ) throw new ProductionDeploymentEvidenceVerificationError('deployment_effect_mismatch');
}

async function verifyCase(
  item: ProductionDeploymentEvidenceManifestV1['cases'][number],
  audit: Record<string, unknown>,
  statusClient: GitHubProductionDeploymentStatusApiClient,
  actionClient: GitHubActionsApiClient,
): Promise<void> {
  verifyProjection(audit, item);
  let status;
  let action;
  try {
    [status, action] = await Promise.all([
      statusClient.getProductionDeploymentStatus({
        deploymentId: item.deploymentId,
        repository: item.repository,
        githubDeploymentId: item.githubDeploymentId,
        mergeSha: item.mergeSha,
      }),
      actionClient.getProductionDeploymentWorkflowRun(item.repository, item.actionRunId),
    ]);
  } catch {
    throw new ProductionDeploymentEvidenceVerificationError('github_api_unavailable');
  }
  if (
    status === null || status.repository !== item.repository ||
    status.githubDeploymentId !== item.githubDeploymentId || status.deploymentId !== item.deploymentId ||
    status.sha !== item.mergeSha || status.environment !== 'production' ||
    status.state !== item.externalState || status.environmentUrl !== item.environmentUrl ||
    status.externalUpdatedAt !== item.externalUpdatedAt
  ) throw new ProductionDeploymentEvidenceVerificationError('github_deployment_mismatch');
  if (
    action.repository !== item.repository || action.event !== 'deployment' ||
    action.status !== item.actionStatus || action.conclusion !== item.actionConclusion ||
    action.headSha !== item.mergeSha ||
    !(action.workflowPath === item.workflowPath || action.workflowPath.startsWith(`${item.workflowPath}@`)) ||
    action.displayTitle !== `delivery-loop/production/${item.githubDeploymentId}`
  ) throw new ProductionDeploymentEvidenceVerificationError('github_action_mismatch');
}

export async function verifyProductionDeploymentEvidence(
  input: ProductionDeploymentEvidenceManifestV1,
  options: ProductionDeploymentEvidenceVerifierOptions,
): Promise<ProductionDeploymentEvidenceVerificationSummary> {
  const parsed = ProductionDeploymentEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new ProductionDeploymentEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new ProductionDeploymentEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const statusClient = new GitHubProductionDeploymentStatusApiClient(
    { getProductionDeploymentObservationToken: async () => options.githubToken },
    { apiBaseUrl: githubApiOrigin, fetch: fetcher },
  );
  const tokenProvider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => options.githubToken,
    getProductionDeploymentObservationToken: async () => options.githubToken,
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
    await verifyCase(item, audit, statusClient, actionClient);
  }
  return {
    schemaVersion: '1',
    evidenceId: parsed.data.evidenceId,
    repository: parsed.data.repository,
    caseCount: parsed.data.cases.length,
    inProgressCases: parsed.data.cases.filter((item) => item.externalState === 'in_progress').length,
    succeededCases: parsed.data.cases.filter((item) => item.externalState === 'success').length,
    failedCases: parsed.data.cases.filter((item) => item.externalState === 'failure' || item.externalState === 'error').length,
    verifiedActionCount: parsed.data.cases.length,
    verifiedDeploymentCount: parsed.data.cases.length,
    verifiedEvidenceCount: parsed.data.cases.filter((item) => item.deploymentEvidenceId !== null).length,
    duplicateDeployments: 0,
  };
}
