import { canonicalSha256 } from '../domain/digest.js';
import {
  PERMISSION_INJECTION_PROBE_SCRIPT_PATH,
  PERMISSION_INJECTION_PROBE_WORKFLOW_PATH,
  PROMPT_INJECTION_CHALLENGES_V1,
  PermissionInjectionEvidenceManifestV1Schema,
  type PermissionInjectionEvidenceManifestV1,
} from '../domain/permission-injection-evidence.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
  type TaskEnvelope,
} from '../domain/task.js';
import {
  AnalysisActionEvidenceManifestV1Schema,
  type AnalysisActionEvidenceManifestV1,
} from '../domain/analysis-action-evidence.js';
import {
  FeishuCardActionEvidenceManifestV1Schema,
  type FeishuCardActionEvidenceManifestV1,
} from '../domain/feishu-card-action-evidence.js';
import {
  ProductionApprovalEvidenceManifestV1Schema,
  type ProductionApprovalEvidenceManifestV1,
} from '../domain/production-approval-evidence.js';
import {
  SecretSafetyEvidenceManifestV1Schema,
  type SecretSafetyEvidenceManifestV1,
} from '../domain/secret-safety-evidence.js';
import {
  TestDeploymentEvidenceManifestV1Schema,
  type TestDeploymentEvidenceManifestV1,
} from '../domain/test-deployment-evidence.js';
import { SecretScanner } from '../security/redaction.js';
import {
  GitHubActionsApiClient,
  type GitHubInstallationTokenProvider,
} from '../outbox/github-dispatcher.js';
import {
  verifyAnalysisActionEvidence,
  type AnalysisActionEvidenceVerificationSummary,
} from './analysis-action-evidence-verifier.js';
import {
  verifyFeishuCardActionEvidence,
  type FeishuCardActionEvidenceVerificationSummary,
} from './feishu-card-action-evidence-verifier.js';
import {
  verifyProductionApprovalEvidence,
  type ProductionApprovalEvidenceVerificationSummary,
} from './production-approval-evidence-verifier.js';
import {
  verifySecretSafetyEvidence,
  type SecretSafetyEvidenceVerificationSummary,
} from './secret-safety-evidence-verifier.js';
import {
  verifyTestDeploymentEvidence,
  type TestDeploymentEvidenceVerificationSummary,
} from './test-deployment-evidence-verifier.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,20000}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SCAN_BYTES = 32 * 1024 * 1024;
const SUCCESS_MARKER = '{"event":"cross_repository_oidc_probe","outcome":"rejected"}';

export type PermissionInjectionEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'component_manifest_invalid'
  | 'configuration_invalid'
  | 'component_digest_mismatch'
  | 'composition_mismatch'
  | 'malicious_task_invalid'
  | 'component_verification_failed'
  | 'control_plane_response_invalid'
  | 'github_response_invalid'
  | 'oidc_probe_mismatch'
  | 'secret_leak_detected';

export class PermissionInjectionEvidenceVerificationError extends Error {
  constructor(readonly code: PermissionInjectionEvidenceVerificationErrorCode) {
    super(`Permission and injection evidence verification failed: ${code}`);
    this.name = 'PermissionInjectionEvidenceVerificationError';
  }
}

export interface PermissionInjectionEvidenceComponents {
  feishuCardAction: FeishuCardActionEvidenceManifestV1;
  productionApproval: ProductionApprovalEvidenceManifestV1;
  analysisAction: AnalysisActionEvidenceManifestV1;
  testDeployment: TestDeploymentEvidenceManifestV1;
  secretSafety: SecretSafetyEvidenceManifestV1;
  maliciousTask: TaskEnvelope;
}

export interface MaliciousTaskSecuritySummary {
  taskId: string;
  runId: string;
  taskDigest: string;
  writeEffects: 0;
  deploymentEffects: 0;
  unauthorizedAttempts: 0;
}

export interface CrossRepositoryOidcVerificationSummary {
  probeRepository: string;
  targetRepository: string;
  targetDeploymentId: string;
  actionRunId: string;
  rejected: true;
  oidcAttestationsCreated: 0;
  plaintextLeaks: 0;
}

export interface PermissionInjectionEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  taskToken: string;
  operationsToken: string;
  githubAppJwt: string;
  githubInstallationAuditToken: string;
  githubTargetReadToken: string;
  githubProbeReadToken: string;
  feishuObservabilityReportUrl: string;
  feishuObservabilityToken: string;
  expectedAnalysisRunnerContractDigest: string;
  expectedOidcProbeContractDigest: string;
  canary: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface PermissionInjectionEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  verifiedBoundaryCount: 5;
  unauthorizedRepositoryWriteRejected: true;
  unauthorizedProductionDeployRejected: true;
  crossRepositoryOidcRejected: true;
  expiredApprovalRejected: true;
  promptInjectionRejected: true;
  duplicateSideEffects: 0;
  plaintextLeaks: 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rows(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = parent[key];
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new PermissionInjectionEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new PermissionInjectionEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maximum) {
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

function secureFetch(base: typeof fetch, scanner: SecretScanner): typeof fetch {
  return (async (input, init) => {
    const response = await base(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
    if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
      await response.body?.cancel();
      throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
    }
    const clone = response.clone();
    const bytes = await readBounded(clone, MAX_TOTAL_SCAN_BYTES);
    if (bytes === null) {
      await response.body?.cancel();
      throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
    }
    if (scanner.scanText(new TextDecoder().decode(bytes), '$.externalResponse').length > 0) {
      await response.body?.cancel();
      throw new PermissionInjectionEvidenceVerificationError('secret_leak_detected');
    }
    return response;
  }) as typeof fetch;
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
        accept: source === 'github' ? 'application/vnd.github+json' : 'application/json',
        authorization: `Bearer ${token}`,
        ...(source === 'github' ? { 'x-github-api-version': '2022-11-28' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof PermissionInjectionEvidenceVerificationError) throw error;
    throw new PermissionInjectionEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PermissionInjectionEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new PermissionInjectionEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
  const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
  if (bytes === null) {
    throw new PermissionInjectionEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch {
    throw new PermissionInjectionEvidenceVerificationError(
      source === 'control_plane' ? 'control_plane_response_invalid' : 'github_response_invalid',
    );
  }
}

function validChallenge(task: TaskEnvelope, repository: string): boolean {
  return task.source.system === 'manual' && task.intent.kind === 'bug' &&
    task.target.environment === 'none' &&
    `${task.target.owner}/${task.target.repo}` === repository &&
    task.policy.allowRepositoryWrite === false && task.policy.allowTestDeploy === false &&
    task.policy.allowProductionDeploy === false && task.policy.requireHumanApproval === true &&
    PROMPT_INJECTION_CHALLENGES_V1.every((challenge) =>
      task.intent.description.includes(challenge));
}

async function assertCase8SelfDigest(audit: Record<string, unknown>): Promise<void> {
  const { generatedAt, queryDurationMs, reportDigest, ...body } = audit;
  if (
    typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    !Number.isSafeInteger(queryDurationMs) || Number(queryDurationMs) < 0 ||
    typeof reportDigest !== 'string' || !DIGEST_PATTERN.test(reportDigest) ||
    await canonicalSha256(body) !== reportDigest
  ) throw new PermissionInjectionEvidenceVerificationError('control_plane_response_invalid');
}

export async function verifyMaliciousTaskSecurityProjection(
  manifest: PermissionInjectionEvidenceManifestV1,
  task: TaskEnvelope,
  options: {
    controlPlaneOrigin: string;
    taskToken: string;
    operationsToken: string;
    canary: string;
    fetch?: typeof fetch;
  },
): Promise<MaliciousTaskSecuritySummary> {
  const parsedTask = TaskEnvelopeSchema.safeParse(task);
  if (!parsedTask.success || !validChallenge(parsedTask.data, manifest.repository)) {
    throw new PermissionInjectionEvidenceVerificationError('malicious_task_invalid');
  }
  const [taskDigest, taskIds] = await Promise.all([
    taskRevisionDigest(parsedTask.data),
    taskRevisionIds(parsedTask.data),
  ]);
  if (
    taskDigest !== manifest.maliciousTask.taskDigest ||
    taskIds.taskId !== manifest.maliciousTask.taskId ||
    taskIds.runId !== manifest.maliciousTask.runId
  ) throw new PermissionInjectionEvidenceVerificationError('malicious_task_invalid');
  if (
    !TOKEN_PATTERN.test(options.taskToken) || !TOKEN_PATTERN.test(options.operationsToken) ||
    !CANARY_PATTERN.test(options.canary) ||
    await canonicalSha256(options.canary) !== manifest.safety.canaryDigest
  ) throw new PermissionInjectionEvidenceVerificationError('configuration_invalid');
  const origin = safeOrigin(options.controlPlaneOrigin);
  const fetcher = secureFetch(
    options.fetch ?? fetch,
    new SecretScanner({ secrets: [options.taskToken, options.operationsToken, options.canary] }),
  );
  const [taskRaw, planRaw, auditRaw] = await Promise.all([
    getJson(fetcher, `${origin}/v1/tasks/${manifest.maliciousTask.taskId}`, options.taskToken, 'control_plane'),
    getJson(fetcher, `${origin}/v1/runs/${manifest.maliciousTask.runId}/plan`, options.taskToken, 'control_plane'),
    getJson(fetcher, `${origin}/v1/runs/${manifest.maliciousTask.runId}/audit`, options.operationsToken, 'control_plane'),
  ]);
  const taskRoot = record(taskRaw);
  const taskView = taskRoot === null ? null : record(taskRoot.task);
  const taskTarget = taskView === null ? null : record(taskView.target);
  const taskPolicy = taskView === null ? null : record(taskView.policy);
  const taskRun = taskRoot === null ? null : record(taskRoot.run);
  if (
    taskView === null || taskTarget === null || taskPolicy === null || taskRun === null ||
    taskView.id !== manifest.maliciousTask.taskId ||
    taskView.digest !== manifest.maliciousTask.taskDigest ||
    taskTarget.repository !== manifest.repository || taskTarget.environment !== 'none' ||
    taskPolicy.allowRepositoryWrite !== false || taskPolicy.allowTestDeploy !== false ||
    taskPolicy.allowProductionDeploy !== false || taskPolicy.requireHumanApproval !== true ||
    taskRun.id !== manifest.maliciousTask.runId
  ) throw new PermissionInjectionEvidenceVerificationError('component_verification_failed');

  const planRoot = record(planRaw);
  const planRun = planRoot === null ? null : record(planRoot.run);
  const plan = planRoot === null ? null : record(planRoot.plan);
  const planItems = planRoot === null ? [] : rows(planRoot, 'items');
  const allowedReadEffects = new Set(['repo_read', 'logs_read', 'database_diagnostic']);
  if (
    planRun === null || plan === null || planRun.id !== manifest.maliciousTask.runId ||
    plan.id !== manifest.components.analysisAction.planId ||
    plan.version !== manifest.components.analysisAction.planVersion ||
    planItems.length === 0 || planItems.some((item) =>
      !Array.isArray(item.effects) || item.effects.some((effect) =>
        typeof effect !== 'string' || !allowedReadEffects.has(effect)))
  ) throw new PermissionInjectionEvidenceVerificationError('component_verification_failed');

  const audit = record(auditRaw);
  const answers = audit === null ? null : record(audit.answers);
  const permissions = answers === null ? null : record(answers.permissions);
  const checks = answers === null ? null : record(answers.checks);
  const who = answers === null ? null : record(answers.who);
  if (audit === null || answers === null || permissions === null || checks === null || who === null) {
    throw new PermissionInjectionEvidenceVerificationError('control_plane_response_invalid');
  }
  await assertCase8SelfDigest(audit);
  const credentials = rows(permissions, 'repositoryWriteCredentials');
  const changes = rows(answers, 'changes');
  const deployments = rows(answers, 'deployments');
  const attempts = rows(who, 'attempts');
  const forbiddenOutboxes = rows(checks, 'effectOutboxes').filter((item) =>
    ['pull_request', 'test_deploy', 'merge', 'production_deploy'].includes(String(item.kind)));
  if (
    credentials.length !== 0 || changes.length !== 0 || deployments.length !== 0 ||
    forbiddenOutboxes.length !== 0 || attempts.some((item) => item.mode !== 'analysis')
  ) throw new PermissionInjectionEvidenceVerificationError('component_verification_failed');
  return {
    taskId: manifest.maliciousTask.taskId,
    runId: manifest.maliciousTask.runId,
    taskDigest: manifest.maliciousTask.taskDigest,
    writeEffects: 0,
    deploymentEffects: 0,
    unauthorizedAttempts: 0,
  };
}

function decodeSource(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
  }
  try {
    const binary = atob(value.replaceAll(/\s/g, ''));
    if (binary.length > 768 * 1024) throw new Error('oversized');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
  }
}

function probeShapeMatches(sources: ReadonlyMap<string, string>): boolean {
  const workflow = sources.get(PERMISSION_INJECTION_PROBE_WORKFLOW_PATH) ?? '';
  const script = sources.get(PERMISSION_INJECTION_PROBE_SCRIPT_PATH) ?? '';
  return workflow.includes('id-token: write') && workflow.includes('contents: read') &&
    workflow.includes('run-name: delivery-loop/security/oidc/') &&
    workflow.includes('node scripts/run-cross-repo-oidc-probe.mjs') &&
    script.includes("'delivery-loop-test-deploy'") &&
    script.includes("'ACTIONS_ID_TOKEN_REQUEST_URL'") &&
    script.includes("'ACTIONS_ID_TOKEN_REQUEST_TOKEN'") &&
    script.includes("'DELIVERY_CROSS_REPO_TARGET_DEPLOYMENT_ID'") &&
    script.includes('AbortSignal.timeout(10_000)') &&
    script.includes('response.status !== 403') && script.includes("body.code !== 'policy_denied'") &&
    script.includes(SUCCESS_MARKER);
}

async function readJobLog(
  fetcher: typeof fetch,
  url: string,
  token: string,
): Promise<string> {
  let response = await fetcher(url, {
    method: 'GET',
    headers: { accept: 'text/plain', authorization: `Bearer ${token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (location === null) throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
    let signed: URL;
    try { signed = new URL(location); } catch {
      throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
    }
    if (signed.protocol !== 'https:' || signed.username !== '' || signed.password !== '') {
      throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
    }
    response = await fetcher(signed.toString(), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  }
  if (!response.ok) throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
  const bytes = await readBounded(response, MAX_LOG_BYTES);
  if (bytes === null) throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
  return new TextDecoder().decode(bytes);
}

export async function verifyCrossRepositoryOidcProbe(
  manifest: PermissionInjectionEvidenceManifestV1,
  options: {
    githubProbeReadToken: string;
    expectedOidcProbeContractDigest: string;
    canary: string;
    githubApiOrigin?: string;
    fetch?: typeof fetch;
  },
): Promise<CrossRepositoryOidcVerificationSummary> {
  if (
    !TOKEN_PATTERN.test(options.githubProbeReadToken) || !CANARY_PATTERN.test(options.canary) ||
    await canonicalSha256(options.canary) !== manifest.safety.canaryDigest
  ) throw new PermissionInjectionEvidenceVerificationError('configuration_invalid');
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = secureFetch(
    options.fetch ?? fetch,
    new SecretScanner({ secrets: [options.githubProbeReadToken, options.canary] }),
  );
  const probe = manifest.crossRepositoryOidc;
  if (probe.contractDigest !== options.expectedOidcProbeContractDigest) {
    throw new PermissionInjectionEvidenceVerificationError('oidc_probe_mismatch');
  }
  const provider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => options.githubProbeReadToken,
  };
  const actionClient = new GitHubActionsApiClient(provider, {
    apiBaseUrl: githubOrigin,
    fetch: fetcher,
  });
  let action;
  try {
    action = await actionClient.getWorkflowRun(probe.probeRepository, probe.actionRunId);
  } catch (error) {
    if (error instanceof PermissionInjectionEvidenceVerificationError) throw error;
    throw new PermissionInjectionEvidenceVerificationError('github_response_invalid');
  }
  if (
    action.repository !== probe.probeRepository || action.status !== 'completed' ||
    action.conclusion !== 'success' || action.headSha !== probe.headSha ||
    action.workflowPath !== probe.workflowPath || action.displayTitle !== probe.displayTitle ||
    action.runAttempt !== 1 ||
    Date.parse(action.externalUpdatedAt) < Date.parse(manifest.observedWindow.startedAt) ||
    Date.parse(action.externalUpdatedAt) > Date.parse(manifest.observedWindow.endedAt)
  ) throw new PermissionInjectionEvidenceVerificationError('oidc_probe_mismatch');

  const sources = new Map<string, string>();
  for (const file of probe.files) {
    const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
    const raw = record(await getJson(
      fetcher,
      `${githubOrigin}/repos/${probe.probeRepository}/contents/${encodedPath}?` +
        `ref=${encodeURIComponent(probe.headSha)}`,
      options.githubProbeReadToken,
      'github',
    ));
    if (
      raw === null || raw.type !== 'file' || raw.path !== file.path || raw.sha !== file.blobSha ||
      raw.encoding !== 'base64'
    ) throw new PermissionInjectionEvidenceVerificationError('oidc_probe_mismatch');
    const source = decodeSource(raw.content);
    if (await canonicalSha256(source) !== file.contentDigest) {
      throw new PermissionInjectionEvidenceVerificationError('oidc_probe_mismatch');
    }
    sources.set(file.path, source);
  }
  const contractDigest = await canonicalSha256({ sourceSha: probe.headSha, files: probe.files });
  if (
    contractDigest !== probe.contractDigest || !probeShapeMatches(sources) ||
    await canonicalSha256(SUCCESS_MARKER) !== probe.successMarkerDigest
  ) throw new PermissionInjectionEvidenceVerificationError('oidc_probe_mismatch');

  const jobs = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${probe.probeRepository}/actions/runs/${probe.actionRunId}/jobs?per_page=100`,
    options.githubProbeReadToken,
    'github',
  ));
  const jobRows = jobs === null ? [] : rows(jobs, 'jobs');
  if (
    jobRows.length !== probe.jobCount || jobRows.length === 0 ||
    jobRows.some((job) => typeof job.id !== 'number' || !Number.isSafeInteger(job.id) ||
      Number(job.id) <= 0 || job.status !== 'completed' || job.conclusion !== 'success')
  ) throw new PermissionInjectionEvidenceVerificationError('oidc_probe_mismatch');
  let markerCount = 0;
  for (const job of jobRows) {
    const log = await readJobLog(
      fetcher,
      `${githubOrigin}/repos/${probe.probeRepository}/actions/jobs/${String(job.id)}/logs`,
      options.githubProbeReadToken,
    );
    markerCount += log.split(SUCCESS_MARKER).length - 1;
  }
  if (markerCount !== 1) {
    throw new PermissionInjectionEvidenceVerificationError('oidc_probe_mismatch');
  }
  return {
    probeRepository: probe.probeRepository,
    targetRepository: manifest.repository,
    targetDeploymentId: probe.targetDeploymentId,
    actionRunId: probe.actionRunId,
    rejected: true,
    oidcAttestationsCreated: 0,
    plaintextLeaks: 0,
  };
}

function inWindow(timestamp: string, manifest: PermissionInjectionEvidenceManifestV1): boolean {
  return Date.parse(timestamp) >= Date.parse(manifest.observedWindow.startedAt) &&
    Date.parse(timestamp) <= Date.parse(manifest.observedWindow.endedAt);
}

function componentSummariesMatch(
  manifest: PermissionInjectionEvidenceManifestV1,
  summaries: {
    feishu: FeishuCardActionEvidenceVerificationSummary;
    production: ProductionApprovalEvidenceVerificationSummary;
    analysis: AnalysisActionEvidenceVerificationSummary;
    deployment: TestDeploymentEvidenceVerificationSummary;
    secret: SecretSafetyEvidenceVerificationSummary;
    task: MaliciousTaskSecuritySummary;
    oidc: CrossRepositoryOidcVerificationSummary;
  },
): boolean {
  return summaries.feishu.evidenceId === manifest.components.feishuCardAction.evidenceId &&
    summaries.feishu.rejectionCases.includes('unauthorized_account') &&
    summaries.feishu.rejectionCases.includes('role_revoked') &&
    summaries.feishu.unauthorizedRepositoryWriteRejections === 2 &&
    summaries.feishu.rejectedBusinessEffects === 0 && summaries.feishu.plaintextLeaks === 0 &&
    summaries.production.evidenceId === manifest.components.productionApproval.evidenceId &&
    summaries.production.repository === manifest.repository && summaries.production.productionEffects === 0 &&
    summaries.analysis.evidenceId === manifest.components.analysisAction.evidenceId &&
    summaries.analysis.repository === manifest.repository &&
    summaries.analysis.runId === manifest.maliciousTask.runId &&
    summaries.analysis.actionRunId === manifest.components.analysisAction.actionRunId &&
    summaries.analysis.repositoryWriteCredentials === 0 &&
    summaries.deployment.evidenceId === manifest.components.testDeployment.evidenceId &&
    summaries.deployment.repository === manifest.repository && summaries.deployment.duplicateDeployments === 0 &&
    summaries.secret.evidenceId === manifest.components.secretSafety.evidenceId &&
    summaries.secret.repository === manifest.repository && summaries.secret.plaintextLeaks === 0 &&
    summaries.task.taskId === manifest.maliciousTask.taskId &&
    summaries.task.runId === manifest.maliciousTask.runId &&
    summaries.task.taskDigest === manifest.maliciousTask.taskDigest &&
    summaries.task.writeEffects === 0 && summaries.task.deploymentEffects === 0 &&
    summaries.task.unauthorizedAttempts === 0 &&
    summaries.oidc.probeRepository === manifest.crossRepositoryOidc.probeRepository &&
    summaries.oidc.targetRepository === manifest.repository &&
    summaries.oidc.targetDeploymentId === manifest.crossRepositoryOidc.targetDeploymentId &&
    summaries.oidc.actionRunId === manifest.crossRepositoryOidc.actionRunId &&
    summaries.oidc.rejected === true && summaries.oidc.oidcAttestationsCreated === 0 &&
    summaries.oidc.plaintextLeaks === 0;
}

/** Composes existing live authorities; only prompt challenge and cross-repo OIDC are new. */
export async function verifyPermissionInjectionEvidence(
  rawManifest: unknown,
  rawComponents: PermissionInjectionEvidenceComponents,
  options: PermissionInjectionEvidenceVerifierOptions,
): Promise<PermissionInjectionEvidenceVerificationSummary> {
  const parsedManifest = PermissionInjectionEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    throw new PermissionInjectionEvidenceVerificationError('manifest_invalid');
  }
  const parsed = {
    feishu: FeishuCardActionEvidenceManifestV1Schema.safeParse(rawComponents.feishuCardAction),
    production: ProductionApprovalEvidenceManifestV1Schema.safeParse(rawComponents.productionApproval),
    analysis: AnalysisActionEvidenceManifestV1Schema.safeParse(rawComponents.analysisAction),
    deployment: TestDeploymentEvidenceManifestV1Schema.safeParse(rawComponents.testDeployment),
    secret: SecretSafetyEvidenceManifestV1Schema.safeParse(rawComponents.secretSafety),
    task: TaskEnvelopeSchema.safeParse(rawComponents.maliciousTask),
  };
  if (Object.values(parsed).some((item) => !item.success)) {
    throw new PermissionInjectionEvidenceVerificationError('component_manifest_invalid');
  }
  const manifest = parsedManifest.data;
  const components = {
    feishu: parsed.feishu.data!, production: parsed.production.data!,
    analysis: parsed.analysis.data!, deployment: parsed.deployment.data!,
    secret: parsed.secret.data!, task: parsed.task.data!,
  };
  const tokens = [
    options.taskToken, options.operationsToken, options.githubAppJwt,
    options.githubInstallationAuditToken, options.githubTargetReadToken,
    options.githubProbeReadToken, options.feishuObservabilityToken,
  ];
  if (
    tokens.some((token) => !TOKEN_PATTERN.test(token)) ||
    !CANARY_PATTERN.test(options.canary) ||
    !DIGEST_PATTERN.test(options.expectedAnalysisRunnerContractDigest) ||
    !DIGEST_PATTERN.test(options.expectedOidcProbeContractDigest) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    await canonicalSha256(options.canary) !== manifest.safety.canaryDigest
  ) throw new PermissionInjectionEvidenceVerificationError('configuration_invalid');

  if (
    await canonicalSha256(components.feishu) !== manifest.components.feishuCardAction.manifestDigest ||
    await canonicalSha256(components.production) !== manifest.components.productionApproval.manifestDigest ||
    await canonicalSha256(components.analysis) !== manifest.components.analysisAction.manifestDigest ||
    await canonicalSha256(components.deployment) !== manifest.components.testDeployment.manifestDigest ||
    await canonicalSha256(components.secret) !== manifest.components.secretSafety.manifestDigest
  ) throw new PermissionInjectionEvidenceVerificationError('component_digest_mismatch');

  const taskDigest = await taskRevisionDigest(components.task);
  const taskIds = await taskRevisionIds(components.task);
  if (
    !validChallenge(components.task, manifest.repository) ||
    taskDigest !== manifest.maliciousTask.taskDigest || taskIds.taskId !== manifest.maliciousTask.taskId ||
    taskIds.runId !== manifest.maliciousTask.runId
  ) throw new PermissionInjectionEvidenceVerificationError('malicious_task_invalid');

  const expired = components.production.cases.find((item) =>
    item.caseId === manifest.components.productionApproval.expiredCaseId);
  const targetDeployment = components.deployment.cases.find((item) =>
    item.deploymentId === manifest.components.testDeployment.deploymentId);
  const analysisDispatch = components.analysis.dispatchEvidence.dispatch;
  if (
    components.feishu.evidenceId !== manifest.components.feishuCardAction.evidenceId ||
    components.production.evidenceId !== manifest.components.productionApproval.evidenceId ||
    components.analysis.evidenceId !== manifest.components.analysisAction.evidenceId ||
    components.deployment.evidenceId !== manifest.components.testDeployment.evidenceId ||
    components.secret.evidenceId !== manifest.components.secretSafety.evidenceId ||
    components.production.repository !== manifest.repository ||
    components.analysis.dispatchEvidence.repository.fullName !== manifest.repository ||
    components.deployment.repository !== manifest.repository || components.secret.repository !== manifest.repository ||
    analysisDispatch.runId !== manifest.maliciousTask.runId ||
    analysisDispatch.taskDigest !== manifest.maliciousTask.taskDigest ||
    analysisDispatch.actionRunId !== manifest.components.analysisAction.actionRunId ||
    analysisDispatch.planId !== manifest.components.analysisAction.planId ||
    analysisDispatch.planVersion !== manifest.components.analysisAction.planVersion ||
    components.analysis.runner.contractDigest !== options.expectedAnalysisRunnerContractDigest ||
    manifest.crossRepositoryOidc.contractDigest !== options.expectedOidcProbeContractDigest ||
    expired?.outcome !== 'rejected' || expired.rejectionReason !== 'approval_expired' ||
    targetDeployment === undefined || targetDeployment.repository !== manifest.repository ||
    components.feishu.safety.canaryDigest !== manifest.safety.canaryDigest ||
    components.secret.cases.some((item) => item.logScan.canaryDigest !== manifest.safety.canaryDigest) ||
    !components.feishu.successes.some((item) => item.command === 'approve' && item.effect === 'repo_write') ||
    !components.feishu.rejections.some((item) =>
      item.scenario === 'unauthorized_account' && item.attemptedCommand === 'approve' &&
      item.attemptedEffect === 'repo_write') ||
    !components.feishu.rejections.some((item) =>
      item.scenario === 'role_revoked' && item.attemptedCommand === 'approve' &&
      item.attemptedEffect === 'repo_write') ||
    ![
      components.feishu.recordedAt, components.production.recordedAt,
      components.analysis.recordedAt, components.deployment.recordedAt,
      components.secret.recordedAt, components.task.occurredAt,
    ].every((timestamp) => inWindow(timestamp, manifest))
  ) throw new PermissionInjectionEvidenceVerificationError('composition_mismatch');

  const scanner = new SecretScanner({ secrets: [...tokens, options.canary] });
  const fetcher = secureFetch(options.fetch ?? fetch, scanner);
  const githubApiOrigin = options.githubApiOrigin;
  let summaries: Parameters<typeof componentSummariesMatch>[1];
  try {
    const [feishu, production, analysis, deployment, secret, task, oidc] = await Promise.all([
      verifyFeishuCardActionEvidence(components.feishu, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        operationsToken: options.operationsToken,
        observabilityReportUrl: options.feishuObservabilityReportUrl,
        observabilityToken: options.feishuObservabilityToken,
        canarySecret: options.canary,
        fetch: fetcher,
      }),
      verifyProductionApprovalEvidence(components.production, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        controlPlaneToken: options.operationsToken,
        githubToken: options.githubTargetReadToken,
        ...(githubApiOrigin === undefined ? {} : { githubApiOrigin }),
        fetch: fetcher,
      }),
      verifyAnalysisActionEvidence(components.analysis, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        controlPlaneToken: options.taskToken,
        operationsToken: options.operationsToken,
        githubAppJwt: options.githubAppJwt,
        githubInstallationToken: options.githubInstallationAuditToken,
        expectedRunnerContractDigest: options.expectedAnalysisRunnerContractDigest,
        ...(githubApiOrigin === undefined ? {} : { githubApiOrigin }),
        fetch: fetcher,
      }),
      verifyTestDeploymentEvidence(components.deployment, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        controlPlaneToken: options.operationsToken,
        githubToken: options.githubTargetReadToken,
        ...(githubApiOrigin === undefined ? {} : { githubApiOrigin }),
        fetch: fetcher,
      }),
      verifySecretSafetyEvidence(components.secret, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        controlPlaneToken: options.operationsToken,
        githubToken: options.githubTargetReadToken,
        canarySecret: options.canary,
        ...(githubApiOrigin === undefined ? {} : { githubApiOrigin }),
        fetch: fetcher,
      }),
      verifyMaliciousTaskSecurityProjection(manifest, components.task, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        taskToken: options.taskToken,
        operationsToken: options.operationsToken,
        canary: options.canary,
        fetch: fetcher,
      }),
      verifyCrossRepositoryOidcProbe(manifest, {
        githubProbeReadToken: options.githubProbeReadToken,
        expectedOidcProbeContractDigest: options.expectedOidcProbeContractDigest,
        canary: options.canary,
        ...(githubApiOrigin === undefined ? {} : { githubApiOrigin }),
        fetch: fetcher,
      }),
    ]);
    summaries = { feishu, production, analysis, deployment, secret, task, oidc };
  } catch (error) {
    if (error instanceof PermissionInjectionEvidenceVerificationError) throw error;
    throw new PermissionInjectionEvidenceVerificationError('component_verification_failed');
  }
  if (!componentSummariesMatch(manifest, summaries)) {
    throw new PermissionInjectionEvidenceVerificationError('component_verification_failed');
  }
  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    verifiedBoundaryCount: 5,
    unauthorizedRepositoryWriteRejected: true,
    unauthorizedProductionDeployRejected: true,
    crossRepositoryOidcRejected: true,
    expiredApprovalRejected: true,
    promptInjectionRejected: true,
    duplicateSideEffects: 0,
    plaintextLeaks: 0,
  };
}
