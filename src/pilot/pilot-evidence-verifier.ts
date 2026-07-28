import {
  PilotEvidenceManifestV1Schema,
  type PilotEvidenceManifestV1,
} from '../domain/pilot-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;

export type PilotEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_deployment_mismatch'
  | 'github_deployment_status_mismatch';

export class PilotEvidenceVerificationError extends Error {
  constructor(readonly code: PilotEvidenceVerificationErrorCode) {
    super(`pilot evidence verification failed: ${code}`);
    this.name = 'PilotEvidenceVerificationError';
  }
}

export interface PilotEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface PilotEvidenceVerificationSummary {
  schemaVersion: '1';
  pilotId: string;
  repository: string;
  verifiedRunCount: 3;
  verifiedActionRunCount: 5;
  verifiedDeploymentCount: 3;
  testDeployment: 'succeeded';
  testAcceptance: 'succeeded';
  productionSuccess: 'succeeded';
  productionFailure: 'failed';
  productionRollback: 'recorded';
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PilotEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new PilotEvidenceVerificationError('configuration_invalid');
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
    ? value.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

function exactRow(
  values: Array<Record<string, unknown>>,
  id: string,
): Record<string, unknown> | null {
  const matches = values.filter((value) => value.id === id);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Cross-checks a human-curated manifest against live, read-only GitHub and
 * control-plane facts. It never returns tokens or upstream response bodies.
 */
export async function verifyPilotEvidence(
  rawManifest: unknown,
  options: PilotEvidenceVerifierOptions,
): Promise<PilotEvidenceVerificationSummary> {
  const parsed = PilotEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsed.success) throw new PilotEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  if (!TOKEN_PATTERN.test(options.controlPlaneToken) || !TOKEN_PATTERN.test(options.githubToken)) {
    throw new PilotEvidenceVerificationError('configuration_invalid');
  }
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubApiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;

  const [testView, productionSuccessView, productionFailureView] = await Promise.all([
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.test.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
    ),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.productionDemo.success.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
    ),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.productionDemo.failure.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
    ),
  ]);
  verifyTestProjection(testView, manifest);
  verifyProductionProjection(productionSuccessView, manifest, 'success');
  verifyProductionProjection(productionFailureView, manifest, 'failure');

  await Promise.all([
    verifyAction(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      runId: manifest.test.deploymentActionRunId,
      sha: manifest.test.refSha,
      conclusion: 'success',
    }),
    verifyAction(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      runId: manifest.test.acceptanceActionRunId,
      sha: manifest.test.refSha,
      conclusion: 'success',
    }),
    verifyAction(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      runId: manifest.productionDemo.success.actionRunId,
      sha: manifest.productionDemo.success.refSha,
      conclusion: 'success',
    }),
    verifyAction(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      runId: manifest.productionDemo.failure.actionRunId,
      sha: manifest.productionDemo.failure.refSha,
      conclusion: 'failure',
    }),
    verifyAction(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      runId: manifest.productionDemo.rollback.actionRunId,
      sha: manifest.productionDemo.rollback.failedRefSha,
      conclusion: 'success',
    }),
    verifyDeployment(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      id: manifest.test.githubDeploymentId,
      sha: manifest.test.refSha,
      task: 'delivery-loop:test',
      environment: 'test',
      state: 'success',
    }),
    verifyDeployment(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      id: manifest.productionDemo.success.githubDeploymentId,
      sha: manifest.productionDemo.success.refSha,
      task: 'delivery-loop:production',
      environment: 'production',
      state: 'success',
    }),
    verifyDeployment(fetcher, githubApiOrigin, options.githubToken, manifest.repository, {
      id: manifest.productionDemo.failure.githubDeploymentId,
      sha: manifest.productionDemo.failure.refSha,
      task: 'delivery-loop:production',
      environment: 'production',
      state: manifest.productionDemo.failure.externalState,
    }),
  ]);

  return {
    schemaVersion: '1',
    pilotId: manifest.pilotId,
    repository: manifest.repository,
    verifiedRunCount: 3,
    verifiedActionRunCount: 5,
    verifiedDeploymentCount: 3,
    testDeployment: 'succeeded',
    testAcceptance: 'succeeded',
    productionSuccess: 'succeeded',
    productionFailure: 'failed',
    productionRollback: 'recorded',
  };
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
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new PilotEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PilotEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  try {
    return await response.json();
  } catch {
    throw new PilotEvidenceVerificationError(
      source === 'control_plane'
        ? 'control_plane_response_invalid'
        : 'github_response_invalid',
    );
  }
}

function controlPlaneRun(view: unknown, runId: string): Record<string, unknown> {
  const root = record(view);
  const run = root === null ? null : record(root.run);
  if (run === null || run.id !== runId) {
    throw new PilotEvidenceVerificationError('control_plane_projection_mismatch');
  }
  return run;
}

function verifyTestProjection(view: unknown, manifest: PilotEvidenceManifestV1): void {
  const run = controlPlaneRun(view, manifest.test.runId);
  const deployment = exactRow(rows(run, 'testDeployments'), manifest.test.deploymentId);
  const acceptance = exactRow(rows(run, 'testAcceptances'), manifest.test.acceptanceId);
  if (
    deployment === null || deployment.status !== 'succeeded' ||
    deployment.environment !== 'test' || deployment.refSha !== manifest.test.refSha ||
    deployment.githubDeploymentId !== manifest.test.githubDeploymentId ||
    deployment.evidenceId !== manifest.test.deploymentEvidenceId ||
    deployment.url !== manifest.test.environmentUrl ||
    acceptance === null || acceptance.status !== 'succeeded' ||
    acceptance.refSha !== manifest.test.refSha ||
    acceptance.githubRunId !== manifest.test.acceptanceActionRunId ||
    acceptance.externalState !== 'completed' || acceptance.externalConclusion !== 'success' ||
    acceptance.evidenceId !== manifest.test.acceptanceEvidenceId
  ) throw new PilotEvidenceVerificationError('control_plane_projection_mismatch');
}

function verifyProductionProjection(
  view: unknown,
  manifest: PilotEvidenceManifestV1,
  kind: 'success' | 'failure',
): void {
  const expected = kind === 'success'
    ? manifest.productionDemo.success
    : manifest.productionDemo.failure;
  const run = controlPlaneRun(view, expected.runId);
  const deployment = exactRow(rows(run, 'productionDeployments'), expected.deploymentId);
  const expectedStatus = kind === 'success' ? 'succeeded' : 'failed';
  const expectedState = kind === 'success'
    ? 'success'
    : manifest.productionDemo.failure.externalState;
  if (
    deployment === null || deployment.status !== expectedStatus ||
    deployment.environment !== 'production' || deployment.mergeSha !== expected.refSha ||
    deployment.githubDeploymentId !== expected.githubDeploymentId ||
    deployment.approvalId !== expected.approvalId ||
    deployment.evidenceId !== expected.deploymentEvidenceId ||
    deployment.externalState !== expectedState || deployment.url !== expected.environmentUrl
  ) throw new PilotEvidenceVerificationError('control_plane_projection_mismatch');
}

async function verifyAction(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  repository: string,
  expected: { runId: string; sha: string; conclusion: 'success' | 'failure' },
): Promise<void> {
  const body = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/actions/runs/${expected.runId}`,
    token,
    'github',
  ));
  const repo = body === null ? null : record(body.repository);
  if (
    body === null || String(body.id) !== expected.runId || body.status !== 'completed' ||
    body.conclusion !== expected.conclusion || body.head_sha !== expected.sha ||
    repo?.full_name !== repository ||
    body.html_url !== `https://github.com/${repository}/actions/runs/${expected.runId}`
  ) throw new PilotEvidenceVerificationError('github_action_mismatch');
}

async function verifyDeployment(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  repository: string,
  expected: {
    id: string;
    sha: string;
    task: 'delivery-loop:test' | 'delivery-loop:production';
    environment: 'test' | 'production';
    state: 'success' | 'failure' | 'error';
  },
): Promise<void> {
  const deployment = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/deployments/${expected.id}`,
    token,
    'github',
  ));
  if (
    deployment === null || String(deployment.id) !== expected.id ||
    deployment.sha !== expected.sha || deployment.task !== expected.task ||
    deployment.environment !== expected.environment
  ) throw new PilotEvidenceVerificationError('github_deployment_mismatch');
  const statuses = await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/deployments/${expected.id}/statuses?per_page=100`,
    token,
    'github',
  );
  const latest = Array.isArray(statuses) ? record(statuses[0]) : null;
  if (latest === null) {
    throw new PilotEvidenceVerificationError('github_response_invalid');
  }
  if (latest.state !== expected.state) {
    throw new PilotEvidenceVerificationError('github_deployment_status_mismatch');
  }
}
