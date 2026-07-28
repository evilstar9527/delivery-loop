import {
  ControlledReplayEvidenceManifestV1Schema,
  type ControlledReplayEvidenceManifestV1,
} from '../domain/controlled-replay-evidence.js';
import { canonicalSha256 } from '../domain/digest.js';
import { verificationPlanItemStep } from '../domain/workflow-replay.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type ControlledReplayEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'replay_snapshot_mismatch'
  | 'approval_snapshot_mismatch'
  | 'correlation_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_inventory_incomplete'
  | 'github_action_mismatch'
  | 'github_pull_request_mismatch'
  | 'duplicate_pull_request'
  | 'github_deployment_mismatch'
  | 'duplicate_deployment';

export class ControlledReplayEvidenceVerificationError extends Error {
  constructor(readonly code: ControlledReplayEvidenceVerificationErrorCode) {
    super(`Controlled replay evidence verification failed: ${code}`);
    this.name = 'ControlledReplayEvidenceVerificationError';
  }
}

export interface ControlledReplayEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  queryToken: string;
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface ControlledReplayEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  replay: 'verified';
  duplicateDispatchCount: 0;
  duplicatePullRequestCount: 0;
  duplicateDeploymentCount: 0;
  verifiedAgentActionCount: number;
  verifiedPullRequestCount: 1;
  verifiedDeploymentCount: number;
}

interface ResponseJson {
  body: unknown;
  headers: Headers;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlledReplayEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new ControlledReplayEvidenceVerificationError('configuration_invalid');
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
  key = 'id',
): Record<string, unknown> | null {
  const matches = values.filter((value) => value[key] === id);
  return matches.length === 1 ? matches[0]! : null;
}

function hasNext(headers: Headers): boolean {
  return /<[^>]+>;\s*rel="next"/.test(headers.get('link') ?? '');
}

// Directly reuses the bounded streaming reader used by tool-bridge and Round 81 E2E.
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
): Promise<ResponseJson> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new ControlledReplayEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ControlledReplayEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable',
    );
  }
  const invalidCode = source === 'control_plane'
    ? 'control_plane_response_invalid'
    : 'github_response_invalid';
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ControlledReplayEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new ControlledReplayEvidenceVerificationError(invalidCode);
  }
  if (text === null) throw new ControlledReplayEvidenceVerificationError(invalidCode);
  try {
    return { body: JSON.parse(text) as unknown, headers: response.headers };
  } catch {
    throw new ControlledReplayEvidenceVerificationError(invalidCode);
  }
}

function exactEffects(
  raw: Array<Record<string, unknown>>,
  manifest: ControlledReplayEvidenceManifestV1,
): boolean {
  const actual = raw.map((effect) => ({
    effect: effect.effect,
    ...(effect.approvalId === undefined ? {} : { approvalId: effect.approvalId }),
  })).sort((left, right) => String(left.effect).localeCompare(String(right.effect)));
  const expected = manifest.replay.effects.map((effect) => ({ ...effect }))
    .sort((left, right) => left.effect.localeCompare(right.effect));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function verifyAudit(
  raw: unknown,
  manifest: ControlledReplayEvidenceManifestV1,
): Promise<void> {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const task = root === null ? null : record(root.task);
  const answers = root === null ? null : record(root.answers);
  const checks = answers === null ? null : record(answers.checks);
  if (
    root === null || run === null || task === null || answers === null || checks === null ||
    root.schemaVersion !== '1' || root.runId !== manifest.runId ||
    run.state !== manifest.expectedRunState || run.version !== manifest.postReplayRunVersion ||
    task.repository !== manifest.repository
  ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');

  const replay = exactRow(rows(checks, 'replays'), manifest.replay.replayId, 'replayId');
  const target = replay === null ? null : record(replay.target);
  const outbox = replay === null ? null : record(replay.outbox);
  const expectedTarget = verificationPlanItemStep(
    manifest.planVersion,
    manifest.replay.planItemId,
  );
  if (
    replay === null || target === null || outbox === null ||
    replay.expectedRunVersion !== manifest.replay.expectedRunVersion ||
    replay.planId !== manifest.planId || replay.planVersion !== manifest.planVersion ||
    replay.itemId !== manifest.replay.planItemId || target.kind !== 'plan_item' ||
    target.name !== expectedTarget.name || target.type !== expectedTarget.type ||
    target.count !== expectedTarget.count ||
    replay.effectSnapshotDigest !== manifest.replay.effectSnapshotDigest ||
    replay.createdAt !== manifest.replay.createdAt ||
    replay.restartObservedAt !== manifest.replay.restartObservedAt ||
    outbox.id !== manifest.replay.outboxId || outbox.state !== 'settled' ||
    typeof outbox.attemptCount !== 'number' || !Number.isSafeInteger(outbox.attemptCount) ||
    outbox.attemptCount < 1 || outbox.lastErrorCode !== undefined
  ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');

  const effects = rows(replay, 'effects');
  const reconciliations = rows(replay, 'reconciliations');
  if (!exactEffects(effects, manifest)) {
    throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  }
  const digest = await canonicalSha256({
    target: expectedTarget,
    effects: effects.map((effect) => ({
      effect: effect.effect,
      ...(effect.approvalId === undefined ? {} : { approvalId: effect.approvalId }),
    })),
    reconciliations: reconciliations.map((source) => ({
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      sourceDigest: source.sourceDigest,
    })),
  });
  if (digest !== manifest.replay.effectSnapshotDigest) {
    throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  }
  const actualDispatchIds = reconciliations.filter((source) =>
    typeof source.outboxKind === 'string' && source.outboxKind.endsWith('_dispatch'))
    .map((source) => source.outboxId)
    .filter((id): id is string => typeof id === 'string')
    .sort();
  const expectedDispatchIds = [...manifest.replay.dispatchOutboxIds].sort();
  if (JSON.stringify(actualDispatchIds) !== JSON.stringify(expectedDispatchIds)) {
    throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  }
  const snapshotOutboxIds = reconciliations.filter((source) => source.sourceKind === 'outbox')
    .map((source) => source.outboxId)
    .filter((id): id is string => typeof id === 'string')
    .sort();
  const effectOutboxes = rows(checks, 'effectOutboxes');
  const currentOutboxIds = effectOutboxes.map((effectOutbox) => effectOutbox.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
  if (
    JSON.stringify(snapshotOutboxIds) !== JSON.stringify(currentOutboxIds) ||
    effectOutboxes.some((effectOutbox) =>
      effectOutbox.state !== 'settled' || typeof effectOutbox.createdAt !== 'string' ||
      Date.parse(effectOutbox.createdAt) > Date.parse(manifest.replay.createdAt))
  ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  for (const outboxId of manifest.replay.dispatchOutboxIds) {
    const source = exactRow(reconciliations, outboxId, 'outboxId');
    if (
      source === null || source.sourceKind !== 'outbox' ||
      typeof source.outboxKind !== 'string' || !source.outboxKind.endsWith('_dispatch') ||
      source.deliveryState !== 'settled'
    ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  }
  const prEvidence = exactRow(reconciliations, manifest.pullRequest.evidenceId, 'evidenceId');
  if (
    prEvidence === null || prEvidence.sourceKind !== 'evidence' ||
    prEvidence.evidenceKind !== 'pull_request' || prEvidence.status !== 'passed' ||
    prEvidence.verificationStatus !== 'verified' ||
    prEvidence.sha !== manifest.pullRequest.headSha
  ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  for (const deployment of manifest.deployments) {
    const source = exactRow(reconciliations, deployment.evidenceId, 'evidenceId');
    if (
      source === null || source.sourceKind !== 'evidence' ||
      source.evidenceKind !== 'deployment' || source.status !== 'passed' ||
      source.verificationStatus !== 'verified' || source.sha !== deployment.sha
    ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  }

  const approvals = rows(answers, 'approvals');
  const restartTime = Date.parse(manifest.replay.restartObservedAt);
  for (const effect of manifest.replay.effects) {
    if (effect.approvalId === undefined) continue;
    const approval = exactRow(approvals, effect.approvalId, 'approvalId');
    const expiresAt = typeof approval?.expiresAt === 'string'
      ? Date.parse(approval.expiresAt)
      : Number.NaN;
    if (
      approval === null || approval.effect !== effect.effect || approval.decision !== 'approve' ||
      approval.planId !== manifest.planId || approval.planVersion !== manifest.planVersion ||
      approval.baseSha !== run.baseSha || approval.invalidated !== false ||
      !Number.isFinite(expiresAt) || expiresAt <= restartTime ||
      ((effect.effect === 'merge' || effect.effect === 'production_deploy') &&
        approval.separationVerified !== true)
    ) throw new ControlledReplayEvidenceVerificationError('approval_snapshot_mismatch');
  }

  const pullRequests = rows(answers, 'changes').filter((change) =>
    change.kind === 'pull_request');
  const pull = exactRow(pullRequests, manifest.pullRequest.publicationId, 'publicationId');
  if (
    pullRequests.length !== 1 || pull === null || pull.repository !== manifest.repository ||
    pull.headBranch !== manifest.pullRequest.headBranch ||
    pull.headSha !== manifest.pullRequest.headSha || pull.status !== 'verified' ||
    pull.number !== manifest.pullRequest.number ||
    pull.evidenceId !== manifest.pullRequest.evidenceId
  ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');

  const deployments = rows(answers, 'deployments');
  if (deployments.length !== manifest.deployments.length) {
    throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  }
  for (const expected of manifest.deployments) {
    const deployment = exactRow(deployments, expected.deploymentId, 'deploymentId');
    if (
      deployment === null || deployment.kind !== expected.kind ||
      deployment.repository !== manifest.repository ||
      deployment.environment !== expected.environment || deployment.status !== 'succeeded' ||
      deployment.sha !== expected.sha ||
      deployment.githubDeploymentId !== expected.githubDeploymentId ||
      deployment.evidenceId !== expected.evidenceId
    ) throw new ControlledReplayEvidenceVerificationError('replay_snapshot_mismatch');
  }
}

function verifyCorrelation(
  raw: unknown,
  manifest: ControlledReplayEvidenceManifestV1,
): void {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const truncated = root === null ? null : record(root.truncated);
  if (
    root === null || run === null || truncated === null ||
    root.correlationId !== manifest.runId || run.id !== manifest.runId ||
    run.state !== manifest.expectedRunState || run.version !== manifest.postReplayRunVersion ||
    truncated.attempts !== false || truncated.githubRuns !== false ||
    truncated.pullRequests !== false || truncated.deployments !== false
  ) throw new ControlledReplayEvidenceVerificationError('correlation_mismatch');
  const attempts = rows(root, 'attempts');
  const agentRuns = rows(root, 'githubRuns').filter((run) => run.kind === 'agent');
  if (agentRuns.length !== manifest.agentActions.length) {
    throw new ControlledReplayEvidenceVerificationError('correlation_mismatch');
  }
  for (const expected of manifest.agentActions) {
    const action = exactRow(agentRuns, expected.actionRunId);
    const attempt = exactRow(attempts, expected.attemptId);
    if (
      action === null || attempt === null || action.attemptId !== expected.attemptId ||
      action.status !== 'completed' || action.conclusion !== 'success' ||
      attempt.status !== 'completed' || attempt.githubRunId !== expected.actionRunId ||
      attempt.githubStatus !== 'completed' || attempt.githubConclusion !== 'success'
    ) throw new ControlledReplayEvidenceVerificationError('correlation_mismatch');
  }
  const pulls = rows(root, 'pullRequests');
  const pull = exactRow(pulls, manifest.pullRequest.publicationId, 'publicationId');
  if (
    pulls.length !== 1 || pull === null || pull.status !== 'verified' ||
    pull.number !== manifest.pullRequest.number ||
    pull.evidenceId !== manifest.pullRequest.evidenceId
  ) throw new ControlledReplayEvidenceVerificationError('correlation_mismatch');
  const deployments = rows(root, 'deployments');
  if (deployments.length !== manifest.deployments.length) {
    throw new ControlledReplayEvidenceVerificationError('correlation_mismatch');
  }
  for (const expected of manifest.deployments) {
    const deployment = exactRow(deployments, expected.deploymentId);
    if (
      deployment === null || deployment.kind !== expected.kind ||
      deployment.status !== 'succeeded' || deployment.sha !== expected.sha ||
      deployment.githubDeploymentId !== expected.githubDeploymentId ||
      deployment.evidenceId !== expected.evidenceId
    ) throw new ControlledReplayEvidenceVerificationError('correlation_mismatch');
  }
}

function inWindow(value: unknown, manifest: ControlledReplayEvidenceManifestV1): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return time >= Date.parse(manifest.window.startedAt) &&
    time <= Date.parse(manifest.window.endedAt);
}

async function verifyGitHub(
  fetcher: typeof fetch,
  githubOrigin: string,
  token: string,
  manifest: ControlledReplayEvidenceManifestV1,
): Promise<void> {
  const encodedWindow = encodeURIComponent(
    `${manifest.window.startedAt}..${manifest.window.endedAt}`,
  );
  const inventory = await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/actions/workflows/` +
      `delivery-agent.yml/runs?event=workflow_dispatch&created=${encodedWindow}&per_page=100`,
    token,
    'github',
  );
  const inventoryRoot = record(inventory.body);
  const workflowRuns = inventoryRoot === null ? [] : rows(inventoryRoot, 'workflow_runs');
  if (
    inventoryRoot === null || hasNext(inventory.headers) ||
    inventoryRoot.total_count !== workflowRuns.length
  ) {
    throw new ControlledReplayEvidenceVerificationError('github_inventory_incomplete');
  }
  for (const expected of manifest.agentActions) {
    const title = `delivery-loop/${expected.attemptId}`;
    const matches = workflowRuns.filter((run) => run.display_title === title);
    if (matches.length !== 1 || String(matches[0]!.id) !== expected.actionRunId) {
      throw new ControlledReplayEvidenceVerificationError('github_action_mismatch');
    }
    const run = record((await getJson(
      fetcher,
      `${githubOrigin}/repos/${manifest.repository}/actions/runs/${expected.actionRunId}`,
      token,
      'github',
    )).body);
    const repository = run === null ? null : record(run.repository);
    if (
      run === null || repository === null || String(run.id) !== expected.actionRunId ||
      repository.full_name !== manifest.repository || run.status !== 'completed' ||
      run.conclusion !== 'success' || run.head_sha !== expected.workflowHeadSha ||
      run.event !== 'workflow_dispatch' ||
      run.path !== '.github/workflows/delivery-agent.yml' || run.display_title !== title ||
      !inWindow(run.created_at, manifest) ||
      Date.parse(String(run.created_at)) >= Date.parse(manifest.replay.createdAt)
    ) throw new ControlledReplayEvidenceVerificationError('github_action_mismatch');
  }

  const pull = record((await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/pulls/${manifest.pullRequest.number}`,
    token,
    'github',
  )).body);
  const pullHead = pull === null ? null : record(pull.head);
  const pullHeadRepo = pullHead === null ? null : record(pullHead.repo);
  const pullBase = pull === null ? null : record(pull.base);
  const pullBaseRepo = pullBase === null ? null : record(pullBase.repo);
  if (
    pull === null || pullHead === null || pullHeadRepo === null ||
    pullBase === null || pullBaseRepo === null || pull.number !== manifest.pullRequest.number ||
    pullHead.ref !== manifest.pullRequest.headBranch ||
    pullHead.sha !== manifest.pullRequest.headSha ||
    pullHeadRepo.full_name !== manifest.repository || pullBaseRepo.full_name !== manifest.repository ||
    !inWindow(pull.created_at, manifest) ||
    Date.parse(String(pull.created_at)) >= Date.parse(manifest.replay.createdAt)
  ) throw new ControlledReplayEvidenceVerificationError('github_pull_request_mismatch');
  const owner = manifest.repository.split('/', 1)[0]!;
  const pullInventory = await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/pulls?state=all&head=` +
      `${encodeURIComponent(`${owner}:${manifest.pullRequest.headBranch}`)}&per_page=100`,
    token,
    'github',
  );
  if (!Array.isArray(pullInventory.body) || hasNext(pullInventory.headers)) {
    throw new ControlledReplayEvidenceVerificationError('github_inventory_incomplete');
  }
  const matchingPulls = pullInventory.body.map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const listedPull = matchingPulls[0];
  const listedHead = listedPull === undefined ? null : record(listedPull.head);
  const listedHeadRepo = listedHead === null ? null : record(listedHead.repo);
  if (
    matchingPulls.length !== 1 || listedPull?.number !== manifest.pullRequest.number ||
    listedHead === null || listedHeadRepo === null ||
    listedHead.ref !== manifest.pullRequest.headBranch ||
    listedHead.sha !== manifest.pullRequest.headSha ||
    listedHeadRepo.full_name !== manifest.repository
  ) throw new ControlledReplayEvidenceVerificationError('duplicate_pull_request');

  const deploymentsBySha = new Map<string, Array<Record<string, unknown>>>();
  for (const sha of new Set(manifest.deployments.map((deployment) => deployment.sha))) {
    const response = await getJson(
      fetcher,
      `${githubOrigin}/repos/${manifest.repository}/deployments?sha=${sha}&per_page=100`,
      token,
      'github',
    );
    if (!Array.isArray(response.body) || hasNext(response.headers)) {
      throw new ControlledReplayEvidenceVerificationError('github_inventory_incomplete');
    }
    deploymentsBySha.set(sha, response.body.map(record)
      .filter((entry): entry is Record<string, unknown> => entry !== null));
  }
  for (const expected of manifest.deployments) {
    const stableKey = expected.kind === 'test'
      ? 'delivery_deployment_id'
      : 'delivery_production_deployment_id';
    const matches = (deploymentsBySha.get(expected.sha) ?? []).filter((deployment) => {
      const payload = record(deployment.payload);
      return payload?.[stableKey] === expected.deploymentId;
    });
    if (matches.length !== 1) {
      throw new ControlledReplayEvidenceVerificationError('duplicate_deployment');
    }
    const deployment = matches[0]!;
    if (
      String(deployment.id) !== expected.githubDeploymentId || deployment.sha !== expected.sha ||
      deployment.task !== `delivery-loop:${expected.kind}` ||
      deployment.environment !== expected.environment ||
      !inWindow(deployment.created_at, manifest) ||
      Date.parse(String(deployment.created_at)) >= Date.parse(manifest.replay.createdAt)
    ) throw new ControlledReplayEvidenceVerificationError('github_deployment_mismatch');
    const statusResponse = await getJson(
      fetcher,
      `${githubOrigin}/repos/${manifest.repository}/deployments/` +
        `${expected.githubDeploymentId}/statuses?per_page=100`,
      token,
      'github',
    );
    const statuses = statusResponse.body;
    const statusRows = Array.isArray(statuses)
      ? statuses.map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    if (
      hasNext(statusResponse.headers) || statusRows.length < 1 ||
      statusRows[0]!.state !== 'success'
    ) {
      throw new ControlledReplayEvidenceVerificationError('github_deployment_mismatch');
    }
  }
}

/** Verifies that a real verification replay reused, rather than recreated, external effects. */
export async function verifyControlledReplayEvidence(
  rawManifest: unknown,
  options: ControlledReplayEvidenceVerifierOptions,
): Promise<ControlledReplayEvidenceVerificationSummary> {
  const parsed = ControlledReplayEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsed.success) throw new ControlledReplayEvidenceVerificationError('manifest_invalid');
  if (
    !TOKEN_PATTERN.test(options.operationsToken) || !TOKEN_PATTERN.test(options.queryToken) ||
    !TOKEN_PATTERN.test(options.githubToken)
  ) throw new ControlledReplayEvidenceVerificationError('configuration_invalid');
  const manifest = parsed.data;
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const githubOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const [audit, correlation] = await Promise.all([
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/runs/${manifest.runId}/audit`,
      options.operationsToken,
      'control_plane',
    ),
    getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/correlations?kind=run&id=${encodeURIComponent(manifest.runId)}`,
      options.queryToken,
      'control_plane',
    ),
  ]);
  await verifyAudit(audit.body, manifest);
  verifyCorrelation(correlation.body, manifest);
  await verifyGitHub(fetcher, githubOrigin, options.githubToken, manifest);
  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    runId: manifest.runId,
    replay: 'verified',
    duplicateDispatchCount: 0,
    duplicatePullRequestCount: 0,
    duplicateDeploymentCount: 0,
    verifiedAgentActionCount: manifest.agentActions.length,
    verifiedPullRequestCount: 1,
    verifiedDeploymentCount: manifest.deployments.length,
  };
}
