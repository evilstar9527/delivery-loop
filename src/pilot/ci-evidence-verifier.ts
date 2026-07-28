import { parseDocument } from 'yaml';
import { canonicalSha256 } from '../domain/digest.js';
import {
  CiEvidenceManifestV1Schema,
  type CiEvidenceManifestV1,
} from '../domain/ci-evidence.js';
import { GitHubActionsApiClient, type GitHubInstallationTokenProvider } from '../outbox/github-dispatcher.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export type CiEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'github_workflow_mismatch'
  | 'github_job_mismatch'
  | 'github_log_leak_detected';

export class CiEvidenceVerificationError extends Error {
  constructor(readonly code: CiEvidenceVerificationErrorCode) {
    super(`CI evidence verification failed: ${code}`);
    this.name = 'CiEvidenceVerificationError';
  }
}

export interface CiEvidenceVerifierOptions {
  githubToken: string;
  githubApiOrigin?: string;
  canarySecret: string;
  fetch?: typeof fetch;
}

export interface CiEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  caseCount: number;
  verifiedRunCount: number;
  verifiedJobCount: number;
  verifiedWorkflowCount: number;
  scannedLogCount: number;
  leakedCanaries: 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CiEvidenceVerificationError('configuration_invalid'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    throw new CiEvidenceVerificationError('configuration_invalid');
  }
  return url.origin;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function getJson(fetcher: typeof fetch, url: string, token: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch { throw new CiEvidenceVerificationError('github_api_unavailable'); }
  if (!response.ok || /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new CiEvidenceVerificationError('github_api_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CiEvidenceVerificationError('github_response_invalid');
  }
  const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
  if (bytes === null) throw new CiEvidenceVerificationError('github_response_invalid');
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new CiEvidenceVerificationError('github_response_invalid'); }
}

function decodeBase64(raw: string): string {
  if (raw.length > MAX_RESPONSE_BYTES || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    throw new CiEvidenceVerificationError('github_response_invalid');
  }
  try {
    const binary = atob(raw.replaceAll(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch { throw new CiEvidenceVerificationError('github_response_invalid'); }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactUsesStep(value: unknown, uses: string): boolean {
  const step = record(value);
  return step !== null && exactKeys(step, ['uses']) && step.uses === uses;
}

function exactRunStep(value: unknown, run: string): boolean {
  const step = record(value);
  return step !== null && exactKeys(step, ['run']) && step.run === run;
}

function workflowContractMatches(
  workflow: Record<string, unknown>,
  path: CiEvidenceManifestV1['cases'][number]['workflowPath'],
): boolean {
  if (!exactKeys(workflow, ['name', 'on', 'permissions', 'jobs'])) return false;
  const triggers = record(workflow.on);
  const jobs = record(workflow.jobs);
  if (triggers === null || jobs === null) return false;
  const expectedJobName = path === '.github/workflows/ci.yml' ? 'verify' : 'validate';
  if (!exactKeys(jobs, [expectedJobName])) return false;
  const job = record(jobs[expectedJobName]);
  if (
    job === null || !exactKeys(job, ['runs-on', 'timeout-minutes', 'steps']) ||
    job['runs-on'] !== 'ubuntu-latest' ||
    job['timeout-minutes'] !== (expectedJobName === 'verify' ? 15 : 10) ||
    !Array.isArray(job.steps)
  ) return false;
  const steps = job.steps;
  const setupNode = record(steps[2]);
  const setupNodeWith = setupNode === null ? null : record(setupNode.with);
  if (
    !exactUsesStep(steps[0], 'actions/checkout@v4') ||
    !exactUsesStep(steps[1], 'pnpm/action-setup@v4') ||
    setupNode === null || !exactKeys(setupNode, ['uses', 'with']) ||
    setupNode.uses !== 'actions/setup-node@v4' || setupNodeWith === null ||
    !exactKeys(setupNodeWith, ['node-version', 'cache']) ||
    setupNodeWith['node-version'] !== 22 || setupNodeWith.cache !== 'pnpm' ||
    !exactRunStep(steps[3], 'pnpm install --frozen-lockfile')
  ) return false;
  if (path === '.github/workflows/ci.yml') {
    const push = record(triggers.push);
    return workflow.name === 'CI' && exactKeys(triggers, ['pull_request', 'push']) &&
      triggers.pull_request === null && push !== null && exactKeys(push, ['branches']) &&
      Array.isArray(push.branches) && push.branches.length === 1 && push.branches[0] === 'main' &&
      steps.length === 5 && exactRunStep(steps[4], 'pnpm run verify');
  }
  const dispatch = record(triggers.workflow_dispatch);
  const inputs = dispatch === null ? null : record(dispatch.inputs);
  const taskInput = inputs === null ? null : record(inputs.task_json);
  const validation = record(steps[4]);
  return workflow.name === 'Validate task contract' && exactKeys(triggers, ['workflow_dispatch']) &&
    dispatch !== null && exactKeys(dispatch, ['inputs']) && inputs !== null &&
    exactKeys(inputs, ['task_json']) && taskInput !== null &&
    exactKeys(taskInput, ['description', 'required', 'type']) &&
    taskInput.description === 'TaskEnvelope v1 JSON (contract validation only)' &&
    taskInput.required === true && taskInput.type === 'string' && steps.length === 5 &&
    validation !== null && exactKeys(validation, ['name', 'run']) &&
    validation.name === 'Validate without printing the task body' &&
    validation.run === 'pnpm validate:task';
}

async function fetchLogs(
  fetcher: typeof fetch,
  url: string,
  token: string,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET', headers: { accept: 'text/plain', authorization: `Bearer ${token}` }, redirect: 'manual',
    });
  } catch { throw new CiEvidenceVerificationError('github_api_unavailable'); }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (location === null) throw new CiEvidenceVerificationError('github_response_invalid');
    let signed: URL;
    try { signed = new URL(location); } catch { throw new CiEvidenceVerificationError('github_response_invalid'); }
    if (signed.protocol !== 'https:' || signed.username !== '' || signed.password !== '') {
      throw new CiEvidenceVerificationError('github_response_invalid');
    }
    try { response = await fetcher(signed.toString(), { method: 'GET', redirect: 'error' }); }
    catch { throw new CiEvidenceVerificationError('github_api_unavailable'); }
  }
  if (!response.ok) { await response.body?.cancel(); throw new CiEvidenceVerificationError('github_api_unavailable'); }
  const bytes = await readBounded(response, MAX_LOG_BYTES);
  if (bytes === null) throw new CiEvidenceVerificationError('github_response_invalid');
  return bytes;
}

async function verifyWorkflowFile(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  item: CiEvidenceManifestV1['cases'][number],
): Promise<void> {
  const contentPath = item.workflowPath.split('/').map(encodeURIComponent).join('/');
  const raw = record(await getJson(
    fetcher,
    `${apiOrigin}/repos/${item.repository}/contents/${contentPath}?ref=${encodeURIComponent(item.headSha)}`,
    token,
  ));
  if (raw === null || raw.path !== item.workflowPath || raw.encoding !== 'base64' ||
      raw.sha !== item.workflowBlobSha || typeof raw.content !== 'string') {
    throw new CiEvidenceVerificationError('github_workflow_mismatch');
  }
  const source = decodeBase64(raw.content);
  if (await canonicalSha256(source) !== item.workflowContentDigest) {
    throw new CiEvidenceVerificationError('github_workflow_mismatch');
  }
  let parsed: Record<string, unknown>;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) throw new Error('yaml');
    const value = document.toJS() as unknown;
    parsed = record(value) ?? (() => { throw new Error('yaml'); })();
  } catch { throw new CiEvidenceVerificationError('github_workflow_mismatch'); }
  const permissions = record(parsed.permissions);
  if (
    permissions === null || Object.keys(permissions).length !== 1 ||
    permissions.contents !== 'read' || !workflowContractMatches(parsed, item.workflowPath)
  ) {
    throw new CiEvidenceVerificationError('github_workflow_mismatch');
  }
}

export async function verifyCiEvidence(
  input: CiEvidenceManifestV1,
  options: CiEvidenceVerifierOptions,
): Promise<CiEvidenceVerificationSummary> {
  const parsed = CiEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new CiEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.githubToken) || !CANARY_PATTERN.test(options.canarySecret)) {
    throw new CiEvidenceVerificationError('configuration_invalid');
  }
  const apiOrigin = httpsOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;
  const scanner = new SecretScanner({ secrets: [options.canarySecret] });
  const canaryDigest = await canonicalSha256(options.canarySecret);
  const provider: GitHubInstallationTokenProvider = {
    getInstallationToken: async () => options.githubToken,
  };
  const actionClient = new GitHubActionsApiClient(provider, { apiBaseUrl: apiOrigin, fetch: fetcher });
  let verifiedJobCount = 0;
  let scannedLogCount = 0;
  for (const item of parsed.data.cases) {
    await verifyWorkflowFile(fetcher, apiOrigin, options.githubToken, item);
    let action;
    try { action = await actionClient.getWorkflowRun(item.repository, item.runId, item.event); }
    catch { throw new CiEvidenceVerificationError('github_api_unavailable'); }
    if (
      action.repository !== item.repository || action.githubRunId !== item.runId ||
      action.event !== item.event || action.workflowPath !== item.workflowPath ||
      action.status !== item.status || action.conclusion !== item.conclusion ||
      action.headSha !== item.headSha || action.headBranch !== item.headBranch ||
      await canonicalSha256(action.displayTitle) !== item.displayTitleDigest
    ) throw new CiEvidenceVerificationError('github_workflow_mismatch');
    const jobsRoot = record(await getJson(
      fetcher,
      `${apiOrigin}/repos/${item.repository}/actions/runs/${item.runId}/jobs?filter=all&per_page=100`,
      options.githubToken,
    ));
    const jobs = jobsRoot !== null && Array.isArray(jobsRoot.jobs)
      ? jobsRoot.jobs.filter((job): job is Record<string, unknown> => record(job) !== null).map(record).filter((job): job is Record<string, unknown> => job !== null)
      : [];
    if (jobsRoot === null || jobsRoot.total_count !== 1 || jobs.length !== 1) {
      throw new CiEvidenceVerificationError('github_job_mismatch');
    }
    const job = jobs[0]!;
    if (job.name !== item.job.name || job.status !== item.job.status || job.conclusion !== item.job.conclusion ||
        typeof job.id !== 'number' || !Number.isSafeInteger(job.id) || job.id <= 0) {
      throw new CiEvidenceVerificationError('github_job_mismatch');
    }
    if (item.workflowPath === '.github/workflows/validate-task.yml') {
      const steps = Array.isArray(job.steps)
        ? job.steps.map(record).filter((step): step is Record<string, unknown> => step !== null)
        : [];
      const validationIndex = steps.findIndex(
        (step) => step.name === 'Validate without printing the task body',
      );
      const validationStep = validationIndex < 0 ? undefined : steps[validationIndex];
      if (
        validationStep === undefined ||
        steps.filter((step) => step.name === 'Validate without printing the task body').length !== 1 ||
        validationStep.status !== 'completed' || validationStep.conclusion !== item.conclusion ||
        steps.slice(0, validationIndex).some(
          (step) => step.status !== 'completed' || step.conclusion !== 'success',
        )
      ) throw new CiEvidenceVerificationError('github_job_mismatch');
    }
    const logs = await fetchLogs(fetcher, `${apiOrigin}/repos/${item.repository}/actions/jobs/${job.id}/logs`, options.githubToken);
    scannedLogCount += 1;
    if (item.logCanaryDigest !== null && item.logCanaryDigest !== canaryDigest) {
      throw new CiEvidenceVerificationError('manifest_invalid');
    }
    if (scanner.scanText(new TextDecoder().decode(logs), '$.githubActionLog').length > 0) {
      throw new CiEvidenceVerificationError('github_log_leak_detected');
    }
    verifiedJobCount += 1;
  }
  return {
    schemaVersion: '1', evidenceId: parsed.data.evidenceId, repository: parsed.data.repository,
    caseCount: parsed.data.cases.length, verifiedRunCount: parsed.data.cases.length,
    verifiedJobCount, verifiedWorkflowCount: parsed.data.cases.length,
    scannedLogCount, leakedCanaries: 0,
  };
}
