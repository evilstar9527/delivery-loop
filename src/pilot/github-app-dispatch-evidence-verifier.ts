import { parseDocument } from 'yaml';
import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubAppDispatchEvidenceManifestV1Schema,
  type GitHubAppDispatchEvidenceManifestV1,
} from '../domain/github-app-dispatch-evidence.js';
import {
  GitHubActionsApiClient,
  type GitHubInstallationTokenProvider,
} from '../outbox/github-dispatcher.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MAX_WORKFLOW_BYTES = 256 * 1_024;
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';
const REQUIRED_JOB_STEPS = [
  ['Checkout trusted execution snapshot', 'success'],
  ['Validate attempt mode bindings', 'success'],
  ['Set up pnpm', 'success'],
  ['Set up Node.js', 'success'],
  ['Install locked dependencies', 'success'],
  ['Run read-only analysis attempt', 'success'],
  ['Run approved execution attempt', 'skipped'],
  ['Verify read-only workspace', 'success'],
] as const;
const REQUIRED_READ_ONLY_WORKSPACE_SCRIPT = [
  'test "$(git rev-parse HEAD)" = "$DELIVERY_CHECKOUT_SHA"',
  'if git symbolic-ref --quiet --short HEAD >/dev/null; then',
  '  exit 1',
  'else',
  '  test "$?" -eq 1',
  'fi',
  'test -z "$(git status --porcelain=v1 --untracked-files=all)"',
].join('\n');

export type GitHubAppDispatchEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'control_plane_projection_mismatch'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_app_mismatch'
  | 'github_installation_mismatch'
  | 'github_repository_mismatch'
  | 'github_workflow_mismatch'
  | 'github_action_mismatch'
  | 'github_inventory_mismatch'
  | 'github_job_mismatch';

export class GitHubAppDispatchEvidenceVerificationError extends Error {
  constructor(readonly code: GitHubAppDispatchEvidenceVerificationErrorCode) {
    super(`GitHub App dispatch evidence verification failed: ${code}`);
    this.name = 'GitHubAppDispatchEvidenceVerificationError';
  }
}

export interface GitHubAppDispatchEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  operationsToken: string;
  githubAppJwt: string;
  githubInstallationToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface GitHubAppDispatchEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  appId: string;
  installationId: string;
  repository: string;
  runId: string;
  actionRunId: string;
  selectedRepositoryCount: 1;
  analysisAttemptCount: 1;
  analysisDispatchOutboxCount: 1;
  githubActionRunCount: 1;
  githubJobCount: 1;
  fixedWorkflowVerified: true;
  duplicateDispatches: 0;
}

type Source = 'control_plane' | 'github';

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

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new GitHubAppDispatchEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new GitHubAppDispatchEvidenceVerificationError('configuration_invalid');
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

function unavailableCode(source: Source): GitHubAppDispatchEvidenceVerificationErrorCode {
  return source === 'control_plane' ? 'control_plane_unavailable' : 'github_api_unavailable';
}

function invalidCode(source: Source): GitHubAppDispatchEvidenceVerificationErrorCode {
  return source === 'control_plane'
    ? 'control_plane_response_invalid' : 'github_response_invalid';
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: Source,
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
    });
  } catch { throw new GitHubAppDispatchEvidenceVerificationError(unavailableCode(source)); }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new GitHubAppDispatchEvidenceVerificationError(unavailableCode(source));
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new GitHubAppDispatchEvidenceVerificationError(invalidCode(source));
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GitHubAppDispatchEvidenceVerificationError(invalidCode(source));
  }
  const bytes = await readBounded(response);
  if (bytes === null) throw new GitHubAppDispatchEvidenceVerificationError(invalidCode(source));
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new GitHubAppDispatchEvidenceVerificationError(invalidCode(source)); }
}

function githubId(value: unknown): string | null {
  if (typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value) : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value : null;
}

function sortedStringArray(value: unknown): string[] | null {
  return stringArray(value)?.slice().sort() ?? null;
}

async function sameCanonical(left: unknown, right: unknown): Promise<boolean> {
  return await canonicalSha256(left) === await canonicalSha256(right);
}

async function verifyControlPlane(
  planRaw: unknown,
  auditRaw: unknown,
  manifest: GitHubAppDispatchEvidenceManifestV1,
): Promise<void> {
  const planRoot = record(planRaw);
  const run = planRoot === null ? null : record(planRoot.run);
  const plan = planRoot === null ? null : record(planRoot.plan);
  const attempts = planRoot === null ? [] : rows(planRoot, 'attempts');
  if (
    planRoot === null || run === null || plan === null ||
    run.id !== manifest.dispatch.runId || run.state !== manifest.dispatch.runState ||
    run.version !== manifest.dispatch.runVersion ||
    run.taskRevision !== manifest.dispatch.taskRevision || run.baseSha !== manifest.dispatch.baseSha ||
    plan.id !== manifest.dispatch.planId || plan.version !== manifest.dispatch.planVersion ||
    plan.taskRevision !== manifest.dispatch.taskRevision || plan.baseSha !== manifest.dispatch.baseSha ||
    plan.digest !== manifest.dispatch.planDigest || plan.status !== 'active' ||
    plan.createdByAttemptId !== manifest.dispatch.attemptId
  ) throw new GitHubAppDispatchEvidenceVerificationError('control_plane_projection_mismatch');
  const analysisAttempts = attempts.filter((attempt) => attempt.mode === 'analysis');
  if (
    analysisAttempts.length !== 1 || analysisAttempts[0]!.id !== manifest.dispatch.attemptId ||
    analysisAttempts[0]!.ordinal !== 1 ||
    analysisAttempts[0]!.status !== manifest.dispatch.attemptStatus ||
    analysisAttempts[0]!.baseSha !== manifest.dispatch.baseSha
  ) throw new GitHubAppDispatchEvidenceVerificationError('control_plane_projection_mismatch');

  const auditRoot = record(auditRaw);
  const auditRun = auditRoot === null ? null : record(auditRoot.run);
  const task = auditRoot === null ? null : record(auditRoot.task);
  const answers = auditRoot === null ? null : record(auditRoot.answers);
  const who = answers === null ? null : record(answers.who);
  const checks = answers === null ? null : record(answers.checks);
  const digests = auditRoot === null ? null : record(auditRoot.digests);
  if (
    auditRoot === null || auditRun === null || task === null || who === null ||
    checks === null || digests === null || auditRoot.schemaVersion !== '1' ||
    auditRoot.runId !== manifest.dispatch.runId ||
    auditRun.state !== manifest.dispatch.runState || auditRun.version !== manifest.dispatch.runVersion ||
    task.repository !== manifest.repository.fullName || task.revision !== manifest.dispatch.taskRevision ||
    digests.task !== manifest.dispatch.taskDigest
  ) throw new GitHubAppDispatchEvidenceVerificationError('control_plane_projection_mismatch');
  const auditAttempts = rows(who, 'attempts').filter((attempt) => attempt.mode === 'analysis');
  const dispatches = rows(checks, 'effectOutboxes').filter(
    (outbox) => outbox.kind === 'analysis_dispatch',
  );
  if (
    auditAttempts.length !== 1 || auditAttempts[0]!.attemptId !== manifest.dispatch.attemptId ||
    auditAttempts[0]!.ordinal !== 1 ||
    auditAttempts[0]!.status !== manifest.dispatch.attemptStatus ||
    auditAttempts[0]!.baseSha !== manifest.dispatch.baseSha ||
    auditAttempts[0]!.repository !== manifest.repository.fullName ||
    auditAttempts[0]!.workflowRef !== manifest.dispatch.workflowRef ||
    auditAttempts[0]!.githubRunId !== manifest.dispatch.actionRunId ||
    auditAttempts[0]!.githubStatus !== 'completed' ||
    auditAttempts[0]!.githubConclusion !== manifest.dispatch.actionConclusion ||
    dispatches.length !== 1 || dispatches[0]!.id !== manifest.dispatch.dispatchOutboxId ||
    dispatches[0]!.state !== 'settled' || dispatches[0]!.lastErrorCode !== undefined
  ) throw new GitHubAppDispatchEvidenceVerificationError('control_plane_projection_mismatch');
}

async function verifyApp(
  appRaw: unknown,
  manifest: GitHubAppDispatchEvidenceManifestV1,
): Promise<void> {
  const app = record(appRaw);
  const owner = app === null ? null : record(app.owner);
  if (
    app === null || owner === null || githubId(app.id) !== manifest.app.appId ||
    app.slug !== manifest.app.slug || owner.login !== manifest.app.ownerLogin ||
    owner.type !== manifest.app.ownerType || app.html_url !== manifest.app.appUrl ||
    !await sameCanonical(app.permissions, manifest.app.permissions) ||
    !await sameCanonical(sortedStringArray(app.events), manifest.app.events)
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_app_mismatch');
}

async function installationMatches(
  raw: unknown,
  manifest: GitHubAppDispatchEvidenceManifestV1,
): Promise<boolean> {
  const installation = record(raw);
  const account = installation === null ? null : record(installation.account);
  return installation !== null && account !== null &&
    githubId(installation.id) === manifest.installation.installationId &&
    githubId(installation.app_id) === manifest.app.appId &&
    installation.app_slug === manifest.app.slug &&
    githubId(installation.target_id) === manifest.installation.targetId &&
    installation.target_type === manifest.installation.targetType &&
    githubId(account.id) === manifest.installation.targetId &&
    account.login === manifest.installation.targetLogin &&
    account.type === manifest.installation.targetType &&
    installation.repository_selection === manifest.installation.repositorySelection &&
    installation.suspended_at === null &&
    await sameCanonical(installation.permissions, manifest.app.permissions) &&
    await sameCanonical(sortedStringArray(installation.events), manifest.app.events);
}

async function verifyInstallationInventory(
  inventoryRaw: unknown,
  manifest: GitHubAppDispatchEvidenceManifestV1,
): Promise<void> {
  const inventory = record(inventoryRaw);
  const repositories = inventory === null ? [] : rows(inventory, 'repositories');
  if (
    inventory === null || inventory.total_count !== 1 || repositories.length !== 1
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_installation_mismatch');
  const repository = repositories[0]!;
  if (
    githubId(repository.id) !== manifest.repository.repositoryId ||
    repository.full_name !== manifest.repository.fullName ||
    repository.visibility !== manifest.repository.visibility ||
    repository.default_branch !== manifest.repository.defaultBranch ||
    repository.archived !== manifest.repository.archived ||
    repository.disabled !== manifest.repository.disabled
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_repository_mismatch');
  const digest = await canonicalSha256([{
    id: manifest.repository.repositoryId,
    fullName: manifest.repository.fullName,
  }]);
  if (digest !== manifest.installation.selectedRepositoriesDigest) {
    throw new GitHubAppDispatchEvidenceVerificationError('github_installation_mismatch');
  }
}

function decodeWorkflowContent(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new GitHubAppDispatchEvidenceVerificationError('github_workflow_mismatch');
  }
  try {
    const normalized = raw.replaceAll(/\s/g, '');
    const binary = atob(normalized);
    if (binary.length > MAX_WORKFLOW_BYTES) throw new Error('oversize');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new GitHubAppDispatchEvidenceVerificationError('github_workflow_mismatch');
  }
}

function workflowStepByName(steps: unknown[], name: string): Record<string, unknown> | null {
  const matches = steps.map(record).filter(
    (step): step is Record<string, unknown> => step !== null && step.name === name,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function deliveryWorkflowContractMatches(workflow: Record<string, unknown>, source: string): boolean {
  if (!exactKeys(workflow, ['name', 'run-name', 'on', 'permissions', 'concurrency', 'jobs'])) {
    return false;
  }
  const triggers = record(workflow.on);
  const dispatch = triggers === null ? null : record(triggers.workflow_dispatch);
  const inputs = dispatch === null ? null : record(dispatch.inputs);
  const permissions = record(workflow.permissions);
  const concurrency = record(workflow.concurrency);
  const jobs = record(workflow.jobs);
  const attempt = jobs === null ? null : record(jobs.attempt);
  if (
    workflow.name !== 'Delivery Agent' ||
    workflow['run-name'] !== 'delivery-loop/${{ inputs.attempt_id }}' ||
    triggers === null || !exactKeys(triggers, ['workflow_dispatch']) ||
    dispatch === null || !exactKeys(dispatch, ['inputs']) || inputs === null ||
    permissions === null || !exactKeys(permissions, ['contents', 'id-token']) ||
    permissions.contents !== 'read' || permissions['id-token'] !== 'write' ||
    concurrency === null || !exactKeys(concurrency, ['group', 'cancel-in-progress']) ||
    concurrency.group !== 'delivery-${{ github.repository }}-${{ inputs.run_id }}' ||
    concurrency['cancel-in-progress'] !== false || jobs === null || !exactKeys(jobs, ['attempt']) ||
    attempt === null || !exactKeys(attempt, ['runs-on', 'timeout-minutes', 'steps']) ||
    attempt['runs-on'] !== 'ubuntu-latest' || attempt['timeout-minutes'] !== 60 ||
    !Array.isArray(attempt.steps)
  ) return false;
  const expectedInputs: Record<string, boolean> = {
    schema_version: true,
    run_id: true,
    attempt_id: true,
    task_digest: true,
    base_sha: true,
    checkout_sha: true,
    control_plane_url: true,
    mode: true,
    model_profile_id: true,
    plan_version: false,
    plan_item_id: false,
  };
  if (!exactKeys(inputs, Object.keys(expectedInputs))) return false;
  for (const [name, required] of Object.entries(expectedInputs)) {
    const input = record(inputs[name]);
    if (
      input === null || !exactKeys(input, ['required', 'type']) ||
      input.required !== required || input.type !== 'string'
    ) return false;
  }
  if (Object.keys(inputs).some((name) => /secret|token|description|feedback|prd|body/i.test(name))) {
    return false;
  }
  const steps = attempt.steps;
  const checkout = workflowStepByName(steps, 'Checkout trusted execution snapshot');
  const checkoutWith = checkout === null ? null : record(checkout.with);
  const analysis = workflowStepByName(steps, 'Run read-only analysis attempt');
  const analysisEnv = analysis === null ? null : record(analysis.env);
  const execution = workflowStepByName(steps, 'Run approved execution attempt');
  const zeroWrite = workflowStepByName(steps, 'Verify read-only workspace');
  const zeroWriteEnv = zeroWrite === null ? null : record(zeroWrite.env);
  if (
    checkout === null || checkoutWith === null ||
    checkout.uses !== 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262' ||
    checkoutWith.ref !== '${{ inputs.checkout_sha }}' ||
    checkoutWith['persist-credentials'] !== false || checkoutWith['fetch-depth'] !== 0 ||
    analysis === null || analysis.if !== "inputs.mode == 'analysis'" ||
    analysis.run !== 'pnpm exec tsx scripts/run-analysis-attempt.ts' || analysisEnv === null ||
    analysisEnv.DELIVERY_RUN_ID !== '${{ inputs.run_id }}' ||
    analysisEnv.DELIVERY_ATTEMPT_ID !== '${{ inputs.attempt_id }}' ||
    analysisEnv.DELIVERY_TASK_DIGEST !== '${{ inputs.task_digest }}' ||
    analysisEnv.DELIVERY_BASE_SHA !== '${{ inputs.base_sha }}' ||
    analysisEnv.DELIVERY_CHECKOUT_SHA !== '${{ inputs.checkout_sha }}' ||
    analysisEnv.DELIVERY_ATTEMPT_MODE !== '${{ inputs.mode }}' ||
    analysisEnv.DELIVERY_CONTROL_PLANE_URL !== '${{ inputs.control_plane_url }}' ||
    execution === null ||
    execution.if !== "inputs.mode == 'implement' || inputs.mode == 'review_fix'" ||
    execution.run !== 'pnpm exec tsx scripts/run-execution-attempt.ts' ||
    zeroWrite === null || zeroWrite.if !== "always() && inputs.mode == 'analysis'" ||
    zeroWriteEnv === null || !exactKeys(zeroWriteEnv, ['DELIVERY_CHECKOUT_SHA']) ||
    zeroWriteEnv.DELIVERY_CHECKOUT_SHA !== '${{ inputs.checkout_sha }}' ||
    typeof zeroWrite.run !== 'string' ||
    zeroWrite.run.trimEnd() !== REQUIRED_READ_ONLY_WORKSPACE_SCRIPT ||
    source.includes('persist-credentials: true') || source.includes('pull_request_target')
  ) return false;
  return steps.map(record).filter((step): step is Record<string, unknown> => step !== null)
    .filter((step) => step.uses !== undefined)
    .every((step) => typeof step.uses === 'string' && /@[a-f0-9]{40}$/.test(step.uses));
}

async function verifyWorkflow(
  contentRaw: unknown,
  manifest: GitHubAppDispatchEvidenceManifestV1,
): Promise<void> {
  const content = record(contentRaw);
  if (
    content === null || content.type !== 'file' || content.path !== WORKFLOW_PATH ||
    content.sha !== manifest.dispatch.workflowBlobSha || content.encoding !== 'base64'
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_workflow_mismatch');
  const source = decodeWorkflowContent(content.content);
  if (await canonicalSha256(source) !== manifest.dispatch.workflowContentDigest) {
    throw new GitHubAppDispatchEvidenceVerificationError('github_workflow_mismatch');
  }
  let workflow: Record<string, unknown>;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) throw new Error('yaml');
    const parsed = record(document.toJS());
    if (parsed === null) throw new Error('yaml');
    workflow = parsed;
  } catch {
    throw new GitHubAppDispatchEvidenceVerificationError('github_workflow_mismatch');
  }
  if (!deliveryWorkflowContractMatches(workflow, source)) {
    throw new GitHubAppDispatchEvidenceVerificationError('github_workflow_mismatch');
  }
}

function workflowPathMatches(value: unknown): boolean {
  return value === WORKFLOW_PATH ||
    (typeof value === 'string' && value.startsWith(`${WORKFLOW_PATH}@`));
}

function verifyJob(jobRaw: unknown, manifest: GitHubAppDispatchEvidenceManifestV1): void {
  const root = record(jobRaw);
  const jobs = root === null ? [] : rows(root, 'jobs');
  if (root === null || root.total_count !== 1 || jobs.length !== 1) {
    throw new GitHubAppDispatchEvidenceVerificationError('github_job_mismatch');
  }
  const job = jobs[0]!;
  const steps = rows(job, 'steps');
  if (
    githubId(job.id) === null || job.name !== 'attempt' || job.status !== 'completed' ||
    job.conclusion !== 'success' || job.head_sha !== manifest.dispatch.baseSha || steps.length < 8
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_job_mismatch');
  for (const [name, conclusion] of REQUIRED_JOB_STEPS) {
    const matches = steps.filter((step) => step.name === name);
    if (
      matches.length !== 1 || matches[0]!.status !== 'completed' ||
      matches[0]!.conclusion !== conclusion
    ) throw new GitHubAppDispatchEvidenceVerificationError('github_job_mismatch');
  }
  if (steps.some((step) =>
    step.status !== 'completed' || !['success', 'skipped'].includes(String(step.conclusion)))) {
    throw new GitHubAppDispatchEvidenceVerificationError('github_job_mismatch');
  }
}

export async function verifyGitHubAppDispatchEvidence(
  input: GitHubAppDispatchEvidenceManifestV1,
  options: GitHubAppDispatchEvidenceVerifierOptions,
): Promise<GitHubAppDispatchEvidenceVerificationSummary> {
  const parsed = GitHubAppDispatchEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new GitHubAppDispatchEvidenceVerificationError('manifest_invalid');
  }
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.githubAppJwt) ||
    !TOKEN_PATTERN.test(options.githubInstallationToken)
  ) throw new GitHubAppDispatchEvidenceVerificationError('configuration_invalid');
  const manifest = parsed.data;
  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;

  const [planRaw, auditRaw] = await Promise.all([
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${manifest.dispatch.runId}/plan`,
      options.controlPlaneToken,
      'control_plane',
    ),
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${manifest.dispatch.runId}/audit`,
      options.operationsToken,
      'control_plane',
    ),
  ]);
  await verifyControlPlane(planRaw, auditRaw, manifest);

  const [appRaw, installationRaw, repositoryInstallationRaw] = await Promise.all([
    getJson(fetcher, `${githubOrigin}/app`, options.githubAppJwt, 'github'),
    getJson(
      fetcher,
      `${githubOrigin}/app/installations/${manifest.installation.installationId}`,
      options.githubAppJwt,
      'github',
    ),
    getJson(
      fetcher,
      `${githubOrigin}/repos/${manifest.repository.fullName}/installation`,
      options.githubAppJwt,
      'github',
    ),
  ]);
  await verifyApp(appRaw, manifest);
  if (
    !await installationMatches(installationRaw, manifest) ||
    !await installationMatches(repositoryInstallationRaw, manifest)
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_installation_mismatch');

  const inventoryRaw = await getJson(
    fetcher,
    `${githubOrigin}/installation/repositories?per_page=100`,
    options.githubInstallationToken,
    'github',
  );
  await verifyInstallationInventory(inventoryRaw, manifest);

  const contentPath = WORKFLOW_PATH.split('/').map(encodeURIComponent).join('/');
  const workflowRaw = await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository.fullName}/contents/${contentPath}?` +
      `ref=${encodeURIComponent(manifest.dispatch.baseSha)}`,
    options.githubInstallationToken,
    'github',
  );
  await verifyWorkflow(workflowRaw, manifest);

  const provider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => options.githubInstallationToken,
  };
  const actionClient = new GitHubActionsApiClient(provider, {
    apiBaseUrl: githubOrigin,
    fetch: fetcher,
  });
  let action;
  try {
    action = await actionClient.getWorkflowRun(
      manifest.repository.fullName,
      manifest.dispatch.actionRunId,
    );
  } catch {
    throw new GitHubAppDispatchEvidenceVerificationError('github_action_mismatch');
  }
  if (
    action.repository !== manifest.repository.fullName || action.event !== 'workflow_dispatch' ||
    action.status !== 'completed' || action.conclusion !== manifest.dispatch.actionConclusion ||
    !workflowPathMatches(action.workflowPath) || action.headSha !== manifest.dispatch.baseSha ||
    action.headBranch !== manifest.repository.defaultBranch ||
    action.displayTitle !== `delivery-loop/${manifest.dispatch.attemptId}` ||
    action.runAttempt !== 1 || action.externalUpdatedAt !== manifest.dispatch.actionUpdatedAt
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_action_mismatch');

  const workflowFile = encodeURIComponent(WORKFLOW_PATH);
  const actionsInventoryRaw = record(await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository.fullName}/actions/workflows/${workflowFile}/runs?` +
      `event=workflow_dispatch&branch=${encodeURIComponent(manifest.repository.defaultBranch)}` +
      '&per_page=100',
    options.githubInstallationToken,
    'github',
  ));
  const workflowRuns = actionsInventoryRaw === null ? [] : rows(actionsInventoryRaw, 'workflow_runs');
  const stableRuns = workflowRuns.filter((run) =>
    run.event === 'workflow_dispatch' &&
    run.display_title === `delivery-loop/${manifest.dispatch.attemptId}` &&
    run.head_branch === manifest.repository.defaultBranch &&
    run.head_sha === manifest.dispatch.baseSha && workflowPathMatches(run.path));
  if (
    actionsInventoryRaw === null || !Number.isSafeInteger(actionsInventoryRaw.total_count) ||
    Number(actionsInventoryRaw.total_count) !== workflowRuns.length || stableRuns.length !== 1 ||
    githubId(stableRuns[0]!.id) !== manifest.dispatch.actionRunId
  ) throw new GitHubAppDispatchEvidenceVerificationError('github_inventory_mismatch');

  const jobsRaw = await getJson(
    fetcher,
    `${githubOrigin}/repos/${manifest.repository.fullName}/actions/runs/` +
      `${manifest.dispatch.actionRunId}/jobs?filter=latest&per_page=100`,
    options.githubInstallationToken,
    'github',
  );
  verifyJob(jobsRaw, manifest);

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    appId: manifest.app.appId,
    installationId: manifest.installation.installationId,
    repository: manifest.repository.fullName,
    runId: manifest.dispatch.runId,
    actionRunId: manifest.dispatch.actionRunId,
    selectedRepositoryCount: 1,
    analysisAttemptCount: 1,
    analysisDispatchOutboxCount: 1,
    githubActionRunCount: 1,
    githubJobCount: 1,
    fixedWorkflowVerified: true,
    duplicateDispatches: 0,
  };
}
