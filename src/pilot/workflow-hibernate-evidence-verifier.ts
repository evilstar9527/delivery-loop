import { canonicalSha256 } from '../domain/digest.js';
import {
  WorkflowHibernateEvidenceManifestV1Schema,
  type WorkflowHibernateEvidenceManifestV1,
} from '../domain/workflow-hibernate-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const EXPECTED_STEP_NAMES = [
  'register-run',
  'dispatch-analysis-attempt',
  'await-analysis-result',
  'verify-analysis-result',
  'activate-analysis-plan',
  'observe-run-control-state',
  'await-run-terminal',
] as const;

export type WorkflowHibernateEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'cloudflare_account_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'control_plane_report_mismatch'
  | 'controlled_replay_detected'
  | 'cloudflare_api_unavailable'
  | 'cloudflare_response_invalid'
  | 'cloudflare_deployment_mismatch'
  | 'cloudflare_instance_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_action_mismatch'
  | 'github_inventory_mismatch'
  | 'secret_leak_detected';

export class WorkflowHibernateEvidenceVerificationError extends Error {
  constructor(readonly code: WorkflowHibernateEvidenceVerificationErrorCode) {
    super(`Workflow hibernate evidence verification failed: ${code}`);
    this.name = 'WorkflowHibernateEvidenceVerificationError';
  }
}

export interface WorkflowHibernateEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  operationsToken: string;
  githubToken: string;
  cloudflareToken: string;
  cloudflareAccountId: string;
  canary: string;
  githubApiOrigin?: string;
  cloudflareApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface WorkflowHibernateEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  runId: string;
  repository: string;
  workflowInstanceId: string;
  beforeVersionId: string;
  afterVersionId: string;
  verifiedStepCount: number;
  analysisAttemptCount: 1;
  analysisDispatchOutboxCount: 1;
  githubActionRunCount: 1;
  reusedCompletedSteps: true;
  duplicateDispatches: 0;
  controlledReplayCount: 0;
  plaintextLeaks: 0;
}

type Source = 'control_plane' | 'github' | 'cloudflare';

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

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new WorkflowHibernateEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new WorkflowHibernateEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function cloudflareBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new WorkflowHibernateEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || url.pathname.replace(/\/$/, '') === ''
  ) throw new WorkflowHibernateEvidenceVerificationError('configuration_invalid');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
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

function unavailableCode(source: Source): WorkflowHibernateEvidenceVerificationErrorCode {
  return source === 'control_plane' ? 'control_plane_unavailable' :
    source === 'github' ? 'github_api_unavailable' : 'cloudflare_api_unavailable';
}

function invalidResponseCode(source: Source): WorkflowHibernateEvidenceVerificationErrorCode {
  return source === 'control_plane' ? 'control_plane_response_invalid' :
    source === 'github' ? 'github_response_invalid' : 'cloudflare_response_invalid';
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: Source,
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new WorkflowHibernateEvidenceVerificationError(unavailableCode(source)); }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new WorkflowHibernateEvidenceVerificationError(unavailableCode(source));
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new WorkflowHibernateEvidenceVerificationError(invalidResponseCode(source));
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new WorkflowHibernateEvidenceVerificationError(invalidResponseCode(source));
  }
  let bytes: Uint8Array | null;
  try { bytes = await readBounded(response); }
  catch { throw new WorkflowHibernateEvidenceVerificationError(invalidResponseCode(source)); }
  if (bytes === null) {
    throw new WorkflowHibernateEvidenceVerificationError(invalidResponseCode(source));
  }
  const text = new TextDecoder().decode(bytes);
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new WorkflowHibernateEvidenceVerificationError('secret_leak_detected');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new WorkflowHibernateEvidenceVerificationError(invalidResponseCode(source)); }
}

function cloudflareResult(input: unknown): unknown {
  const envelope = record(input);
  if (
    envelope === null || envelope.success !== true || !Array.isArray(envelope.errors) ||
    !Array.isArray(envelope.messages) || !Object.hasOwn(envelope, 'result')
  ) throw new WorkflowHibernateEvidenceVerificationError('cloudflare_response_invalid');
  return envelope.result;
}

function date(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

function normalizePlatformSteps(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input) || input.length !== EXPECTED_STEP_NAMES.length) {
    throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');
  }
  const normalized: Array<Record<string, unknown>> = [];
  input.forEach((value, index) => {
    const step = record(value);
    const name = step?.name;
    const type = step?.type;
    const start = date(step?.start);
    const end = step?.end === undefined ? undefined : date(step.end);
    if (step === null || name !== EXPECTED_STEP_NAMES[index] || start === null) {
      throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');
    }
    if (type === 'waitForEvent') {
      if ((name === 'await-analysis-result') !== (end !== undefined && end !== null)) {
        throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');
      }
      normalized.push({ name, type, start, ...(end === undefined ? {} : { end }) });
      return;
    }
    if (type !== 'step' || end === undefined || end === null || step.success !== true) {
      throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');
    }
    const attemptsRaw = step.attempts;
    if (!Array.isArray(attemptsRaw) || attemptsRaw.length < 1 || attemptsRaw.length > 20) {
      throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');
    }
    const attempts = attemptsRaw.map((attemptValue) => {
      const attempt = record(attemptValue);
      const attemptStart = date(attempt?.start);
      const attemptEnd = date(attempt?.end);
      if (attempt === null || attemptStart === null || attemptEnd === null || attempt.success !== true) {
        throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');
      }
      return { start: attemptStart, end: attemptEnd, success: true };
    });
    normalized.push({ name, type, start, end, success: true, attempts });
  });
  return normalized;
}

function deploymentFact(
  deployments: Array<Record<string, unknown>>,
  expected: WorkflowHibernateEvidenceManifestV1['cloudflare']['beforeDeployment'],
): boolean {
  const matches = deployments.filter((deployment) => deployment.id === expected.deploymentId);
  if (matches.length !== 1) return false;
  const deployment = matches[0]!;
  const versions = rows(deployment, 'versions');
  return date(deployment.created_on) === new Date(expected.createdAt).toISOString() &&
    versions.length === 1 && versions[0]!.version_id === expected.versionId &&
    versions[0]!.percentage === 100;
}

function deploymentCreatedAt(deployment: Record<string, unknown>): number | null {
  const createdAt = date(deployment.created_on);
  if (createdAt === null) return null;
  return Date.parse(createdAt);
}

function deploymentTimelineMatches(
  deployments: Array<Record<string, unknown>>,
  manifest: WorkflowHibernateEvidenceManifestV1,
): boolean {
  const waitStartedAt = Date.parse(manifest.cloudflare.hibernateWait.startedAt);
  const waitEndedAt = Date.parse(manifest.cloudflare.hibernateWait.endedAt);
  const normalized = deployments.map((deployment) => ({
    deployment,
    createdAt: deploymentCreatedAt(deployment),
  }));
  if (normalized.some(({ createdAt }) => createdAt === null)) return false;
  const beforeOrAtWait = normalized
    .filter(({ createdAt }) => createdAt! <= waitStartedAt)
    .sort((left, right) => right.createdAt! - left.createdAt!);
  const duringWait = normalized.filter(
    ({ createdAt }) => createdAt! > waitStartedAt && createdAt! < waitEndedAt,
  );
  return beforeOrAtWait[0]?.deployment.id === manifest.cloudflare.beforeDeployment.deploymentId &&
    duringWait.length === 1 &&
    duringWait[0]!.deployment.id === manifest.cloudflare.afterDeployment.deploymentId;
}

function platformStepTimelineMatches(
  steps: Array<Record<string, unknown>>,
  manifest: WorkflowHibernateEvidenceManifestV1,
): boolean {
  const instanceStartedAt = Date.parse(manifest.cloudflare.instanceStartedAt);
  const waitStartedAt = Date.parse(manifest.cloudflare.hibernateWait.startedAt);
  const waitEndedAt = Date.parse(manifest.cloudflare.hibernateWait.endedAt);
  let previousEnd = instanceStartedAt;
  for (const [index, step] of steps.entries()) {
    const start = typeof step.start === 'string' ? Date.parse(step.start) : Number.NaN;
    const end = typeof step.end === 'string' ? Date.parse(step.end) : undefined;
    if (!Number.isFinite(start) || start < previousEnd) return false;
    if (end !== undefined) {
      if (!Number.isFinite(end) || end < start) return false;
      previousEnd = end;
    } else if (index !== steps.length - 1) {
      return false;
    }
    for (const attempt of rows(step, 'attempts')) {
      const attemptStart = typeof attempt.start === 'string'
        ? Date.parse(attempt.start) : Number.NaN;
      const attemptEnd = typeof attempt.end === 'string'
        ? Date.parse(attempt.end) : Number.NaN;
      if (
        !Number.isFinite(attemptStart) || !Number.isFinite(attemptEnd) ||
        attemptStart < start || attemptEnd < attemptStart ||
        end === undefined || attemptEnd > end
      ) return false;
    }
  }
  const dispatchEnd = steps[1]?.end;
  const resumedStarts = steps.slice(3, 6).map((step) => step.start);
  return typeof dispatchEnd === 'string' && Date.parse(dispatchEnd) < waitStartedAt &&
    resumedStarts.every(
      (start) => typeof start === 'string' && Date.parse(start) > waitEndedAt,
    );
}

async function verifyControlPlane(
  planRaw: unknown,
  auditRaw: unknown,
  manifest: WorkflowHibernateEvidenceManifestV1,
): Promise<void> {
  const planRoot = record(planRaw);
  const run = planRoot === null ? null : record(planRoot.run);
  const plan = planRoot === null ? null : record(planRoot.plan);
  const workflow = run === null ? null : record(run.workflowInstance);
  const attempts = planRoot === null ? [] : rows(planRoot, 'attempts');
  const factDigest = await canonicalSha256({
    workflowInstanceId: manifest.run.runId,
    status: manifest.cloudflare.instanceStatus,
  });
  const checkedAt = typeof workflow?.checkedAt === 'string' ? Date.parse(workflow.checkedAt) : Number.NaN;
  if (
    planRoot === null || run === null || plan === null || workflow === null ||
    run.id !== manifest.run.runId || run.state !== manifest.run.state ||
    run.version !== manifest.run.version || run.taskRevision !== manifest.run.taskRevision ||
    run.baseSha !== manifest.run.baseSha ||
    plan.id !== manifest.run.planId || plan.version !== manifest.run.planVersion ||
    plan.taskRevision !== manifest.run.taskRevision || plan.baseSha !== manifest.run.baseSha ||
    plan.digest !== manifest.run.planDigest || plan.status !== 'active' ||
    plan.createdByAttemptId !== manifest.analysis.attemptId ||
    workflow.id !== manifest.run.runId || workflow.runVersion !== manifest.run.version ||
    workflow.d1State !== manifest.run.state ||
    workflow.platformStatus !== manifest.cloudflare.instanceStatus ||
    workflow.factDigest !== factDigest || !Array.isArray(workflow.reconciliations) ||
    workflow.reconciliations.length !== 0 ||
    !Number.isFinite(checkedAt) ||
    checkedAt < Date.parse(manifest.cloudflare.afterDeployment.createdAt) ||
    checkedAt > Date.parse(manifest.recordedAt)
  ) throw new WorkflowHibernateEvidenceVerificationError('control_plane_projection_mismatch');
  const analysisAttempts = attempts.filter((attempt) => attempt.mode === 'analysis');
  if (
    analysisAttempts.length !== 1 || analysisAttempts[0]!.id !== manifest.analysis.attemptId ||
    analysisAttempts[0]!.ordinal !== 1 ||
    analysisAttempts[0]!.status !== manifest.analysis.attemptStatus ||
    analysisAttempts[0]!.baseSha !== manifest.run.baseSha
  ) throw new WorkflowHibernateEvidenceVerificationError('control_plane_projection_mismatch');

  const auditRoot = record(auditRaw);
  if (auditRoot === null) {
    throw new WorkflowHibernateEvidenceVerificationError('control_plane_report_mismatch');
  }
  const { generatedAt, queryDurationMs, reportDigest, ...reportBody } = auditRoot;
  if (
    reportDigest !== manifest.case8ReportDigest ||
    await canonicalSha256(reportBody) !== reportDigest ||
    typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    Date.parse(generatedAt) > Date.parse(manifest.recordedAt) ||
    typeof queryDurationMs !== 'number' || !Number.isSafeInteger(queryDurationMs) ||
    queryDurationMs < 0
  ) throw new WorkflowHibernateEvidenceVerificationError('control_plane_report_mismatch');
  const auditRun = auditRoot === null ? null : record(auditRoot.run);
  const task = auditRoot === null ? null : record(auditRoot.task);
  const answers = auditRoot === null ? null : record(auditRoot.answers);
  const who = answers === null ? null : record(answers.who);
  const checks = answers === null ? null : record(answers.checks);
  if (
    auditRoot === null || auditRun === null || task === null || who === null || checks === null ||
    auditRoot.schemaVersion !== '1' || auditRoot.runId !== manifest.run.runId ||
    auditRun.state !== manifest.run.state || auditRun.version !== manifest.run.version ||
    task.repository !== manifest.repository || task.revision !== manifest.run.taskRevision
  ) throw new WorkflowHibernateEvidenceVerificationError('control_plane_projection_mismatch');
  const replayValues = checks.replays;
  const replays = rows(checks, 'replays');
  if (!Array.isArray(replayValues) || replayValues.length !== replays.length) {
    throw new WorkflowHibernateEvidenceVerificationError('control_plane_projection_mismatch');
  }
  if (replays.length !== 0) {
    throw new WorkflowHibernateEvidenceVerificationError('controlled_replay_detected');
  }
  const auditAttempts = rows(who, 'attempts').filter((attempt) => attempt.mode === 'analysis');
  const dispatches = rows(checks, 'effectOutboxes').filter(
    (outbox) => outbox.kind === 'analysis_dispatch',
  );
  if (
    auditAttempts.length !== 1 || auditAttempts[0]!.attemptId !== manifest.analysis.attemptId ||
    auditAttempts[0]!.ordinal !== 1 ||
    auditAttempts[0]!.status !== manifest.analysis.attemptStatus ||
    auditAttempts[0]!.githubRunId !== manifest.analysis.actionRunId ||
    auditAttempts[0]!.githubStatus !== 'completed' ||
    auditAttempts[0]!.githubConclusion !== manifest.analysis.actionConclusion ||
    auditAttempts[0]!.baseSha !== manifest.run.baseSha || dispatches.length !== 1 ||
    dispatches[0]!.id !== manifest.analysis.dispatchOutboxId ||
    dispatches[0]!.state !== 'settled' || dispatches[0]!.lastErrorCode !== undefined
  ) throw new WorkflowHibernateEvidenceVerificationError('control_plane_projection_mismatch');
}

export async function verifyWorkflowHibernateEvidence(
  input: WorkflowHibernateEvidenceManifestV1,
  options: WorkflowHibernateEvidenceVerifierOptions,
): Promise<WorkflowHibernateEvidenceVerificationSummary> {
  const parsed = WorkflowHibernateEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new WorkflowHibernateEvidenceVerificationError('manifest_invalid');
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.githubToken) ||
    !TOKEN_PATTERN.test(options.cloudflareToken) ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    await canonicalSha256(options.canary) !== parsed.data.safety.canaryDigest
  ) throw new WorkflowHibernateEvidenceVerificationError('configuration_invalid');
  const manifest = parsed.data;
  if (await canonicalSha256(options.cloudflareAccountId) !== manifest.cloudflare.accountIdDigest) {
    throw new WorkflowHibernateEvidenceVerificationError('cloudflare_account_mismatch');
  }
  const fetcher = options.fetch ?? fetch;
  const scanner = new SecretScanner({ secrets: [
    options.controlPlaneToken,
    options.operationsToken,
    options.githubToken,
    options.cloudflareToken,
    options.canary,
  ] });
  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const cloudflareOrigin = cloudflareBaseUrl(
    options.cloudflareApiOrigin ?? 'https://api.cloudflare.com/client/v4',
  );
  const [planRaw, auditRaw] = await Promise.all([
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${manifest.run.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
      scanner,
    ),
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${manifest.run.runId}/audit`,
      options.operationsToken,
      'control_plane',
      scanner,
    ),
  ]);
  await verifyControlPlane(planRaw, auditRaw, manifest);

  const cloudflarePath = `${cloudflareOrigin}/accounts/${options.cloudflareAccountId}`;
  const [instanceEnvelope, deploymentsEnvelope] = await Promise.all([
    getJson(
      fetcher,
      `${cloudflarePath}/workflows/${manifest.cloudflare.workflowName}/instances/${manifest.run.runId}`,
      options.cloudflareToken,
      'cloudflare',
      scanner,
    ),
    getJson(
      fetcher,
      `${cloudflarePath}/workers/scripts/${manifest.cloudflare.workerScriptName}/deployments`,
      options.cloudflareToken,
      'cloudflare',
      scanner,
    ),
  ]);
  const deploymentsRoot = record(cloudflareResult(deploymentsEnvelope));
  const deployments = deploymentsRoot === null ? [] : rows(deploymentsRoot, 'deployments');
  if (
    deploymentsRoot === null || deployments.length < 2 || deployments.length > 100 ||
    !deploymentFact(deployments, manifest.cloudflare.beforeDeployment) ||
    !deploymentFact(deployments, manifest.cloudflare.afterDeployment) ||
    !deploymentTimelineMatches(deployments, manifest)
  ) throw new WorkflowHibernateEvidenceVerificationError('cloudflare_deployment_mismatch');

  const instance = record(cloudflareResult(instanceEnvelope));
  if (
    instance === null || safeUuid(instance.versionId) !== manifest.cloudflare.instanceVersionId ||
    instance.status !== manifest.cloudflare.instanceStatus ||
    date(instance.start) !== new Date(manifest.cloudflare.instanceStartedAt).toISOString()
  ) throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');
  const safeSteps = normalizePlatformSteps(instance.steps);
  const wait = safeSteps[2]!;
  const afterDeploymentTime = Date.parse(manifest.cloudflare.afterDeployment.createdAt);
  const beforeStepsEndBeforeRedeploy = [safeSteps[0]!, safeSteps[1]!].every(
    (step) => typeof step.end === 'string' && Date.parse(step.end) < afterDeploymentTime,
  );
  const resumedStepsStartAfterRedeploy = safeSteps.slice(3, 6).every(
    (step) => typeof step.start === 'string' && Date.parse(step.start) > afterDeploymentTime,
  );
  if (
    wait.start !== new Date(manifest.cloudflare.hibernateWait.startedAt).toISOString() ||
    wait.end !== new Date(manifest.cloudflare.hibernateWait.endedAt).toISOString() ||
    !beforeStepsEndBeforeRedeploy || !resumedStepsStartAfterRedeploy ||
    !platformStepTimelineMatches(safeSteps, manifest) ||
    await canonicalSha256(safeSteps) !== manifest.cloudflare.platformStepsDigest
  ) throw new WorkflowHibernateEvidenceVerificationError('cloudflare_instance_mismatch');

  const action = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/actions/runs/${manifest.analysis.actionRunId}`,
    options.githubToken,
    'github',
    scanner,
  ));
  const actionRepository = action === null ? null : record(action.repository);
  if (
    action === null || actionRepository === null ||
    String(action.id) !== manifest.analysis.actionRunId ||
    actionRepository.full_name !== manifest.repository || action.event !== 'workflow_dispatch' ||
    action.status !== 'completed' || action.conclusion !== manifest.analysis.actionConclusion ||
    action.path !== manifest.analysis.workflowPath ||
    action.head_sha !== manifest.analysis.workflowHeadSha ||
    action.head_branch !== manifest.analysis.headBranch ||
    action.display_title !== `delivery-loop/${manifest.analysis.attemptId}` ||
    action.run_attempt !== 1 || date(action.updated_at) === null
  ) throw new WorkflowHibernateEvidenceVerificationError('github_action_mismatch');
  const workflowFile = encodeURIComponent(manifest.analysis.workflowPath);
  const inventoryRaw = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository}/actions/workflows/${workflowFile}/runs?` +
      `event=workflow_dispatch&branch=${encodeURIComponent(manifest.analysis.headBranch)}&per_page=100`,
    options.githubToken,
    'github',
    scanner,
  ));
  const workflowRuns = inventoryRaw === null ? [] : rows(inventoryRaw, 'workflow_runs');
  const totalCount = inventoryRaw?.total_count;
  const stableRuns = workflowRuns.filter((run) =>
    run.event === 'workflow_dispatch' &&
    run.display_title === `delivery-loop/${manifest.analysis.attemptId}` &&
    run.head_branch === manifest.analysis.headBranch &&
    run.head_sha === manifest.analysis.workflowHeadSha &&
    run.path === manifest.analysis.workflowPath);
  if (
    inventoryRaw === null || !Number.isSafeInteger(totalCount) ||
    Number(totalCount) !== workflowRuns.length || stableRuns.length !== 1 ||
    String(stableRuns[0]!.id) !== manifest.analysis.actionRunId
  ) throw new WorkflowHibernateEvidenceVerificationError('github_inventory_mismatch');

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    runId: manifest.run.runId,
    repository: manifest.repository,
    workflowInstanceId: manifest.run.runId,
    beforeVersionId: manifest.cloudflare.beforeDeployment.versionId,
    afterVersionId: manifest.cloudflare.afterDeployment.versionId,
    verifiedStepCount: safeSteps.length,
    analysisAttemptCount: 1,
    analysisDispatchOutboxCount: 1,
    githubActionRunCount: 1,
    reusedCompletedSteps: true,
    duplicateDispatches: 0,
    controlledReplayCount: 0,
    plaintextLeaks: 0,
  };
}
