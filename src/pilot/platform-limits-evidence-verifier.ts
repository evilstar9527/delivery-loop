import { parseDocument } from 'yaml';
import { canonicalSha256 } from '../domain/digest.js';
import {
  PlatformLimitsEvidenceManifestV1Schema,
  type PlatformLimitsEvidenceManifestV1,
} from '../domain/platform-limits-evidence.js';
import type { RunnerHeartbeatEvidenceManifestV1 } from
  '../domain/runner-heartbeat-evidence.js';
import type { WorkflowHibernateEvidenceManifestV1 } from
  '../domain/workflow-hibernate-evidence.js';
import type { ControlledReplayEvidenceManifestV1 } from
  '../domain/controlled-replay-evidence.js';
import {
  verifyRunnerHeartbeatEvidence,
  type RunnerHeartbeatEvidenceVerifierOptions,
} from './runner-heartbeat-evidence-verifier.js';
import {
  verifyWorkflowHibernateEvidence,
  type WorkflowHibernateEvidenceVerifierOptions,
} from './workflow-hibernate-evidence-verifier.js';
import {
  verifyControlledReplayEvidence,
  type ControlledReplayEvidenceVerifierOptions,
} from './controlled-replay-evidence-verifier.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MAX_JOBS_PER_RUN = 256;
const MAX_JOB_PAGES = 3;
const MIN_CONCURRENCY_JOB_DURATION_MS = 240_000;
const MAX_CONCURRENCY_JOB_DURATION_MS = 600_000;

export type PlatformLimitsEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'github_api_unavailable'
  | 'github_response_invalid'
  | 'official_document_mismatch'
  | 'github_policy_mismatch'
  | 'github_billing_mismatch'
  | 'github_probe_workflow_mismatch'
  | 'github_concurrency_probe_mismatch'
  | 'github_duration_probe_mismatch'
  | 'reused_evidence_mismatch';

export class PlatformLimitsEvidenceVerificationError extends Error {
  constructor(readonly code: PlatformLimitsEvidenceVerificationErrorCode) {
    super(`Platform limits evidence verification failed: ${code}`);
    this.name = 'PlatformLimitsEvidenceVerificationError';
  }
}

export interface PlatformLimitsEvidenceVerifierOptions {
  githubToken: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
  runnerHeartbeat: {
    manifest: RunnerHeartbeatEvidenceManifestV1;
    options: RunnerHeartbeatEvidenceVerifierOptions;
  };
  workflowHibernate: {
    manifest: WorkflowHibernateEvidenceManifestV1;
    options: WorkflowHibernateEvidenceVerifierOptions;
  };
  controlledReplay: {
    manifest: ControlledReplayEvidenceManifestV1;
    options: ControlledReplayEvidenceVerifierOptions;
  };
}

export interface PlatformLimitsEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  organization: string;
  repository: string;
  githubHostedMaximumMinutes: 360;
  reviewedOrganizationConcurrency: number;
  observedMaximumConcurrency: number;
  concurrencyProbeJobCount: number;
  actionsUsageItemCount: number;
  actionsUsageDigest: string;
  githubDocumentationVerified: true;
  githubOrganizationPolicyVerified: true;
  githubBillingVerified: true;
  githubConcurrencyProbeVerified: true;
  githubDurationProbeVerified: true;
  githubAppAndEventSemanticsVerified: true;
  cloudflarePaidLimitsVerified: true;
  cloudflareCreateSendEventUpgradeVerified: true;
  cloudflareRestartVerified: true;
  cloudflareConcurrencyDocumentationConflictObserved: true;
}

type RecordValue = Record<string, unknown>;

interface JsonResponse {
  body: unknown;
  headers: Headers;
}

interface JobInterval {
  id: number;
  name: string;
  startedAt: number;
  completedAt: number;
}

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new PlatformLimitsEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new PlatformLimitsEvidenceVerificationError('configuration_invalid');
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

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
    });
  } catch {
    throw new PlatformLimitsEvidenceVerificationError('github_api_unavailable');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new PlatformLimitsEvidenceVerificationError('github_api_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  }
  const bytes = await readBounded(response);
  if (bytes === null) {
    throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  }
  try {
    return {
      body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      headers: response.headers,
    };
  } catch {
    throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  }
}

function rejectPagination(response: JsonResponse): void {
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  }
}

function decodeBase64(raw: string): string {
  if (raw.length > MAX_RESPONSE_BYTES || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
    throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  }
  try {
    const binary = atob(raw.replaceAll(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  }
}

function requiredPatternsMatch(source: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(source));
}

const GITHUB_LIMIT_PATTERNS = [
  /Workflow run time\s*\|\s*35 days \/ workflow run/,
  /Job Matrix\s*\|\s*256 jobs \/ workflow run/,
  /Job execution time\s*\|\s*6 hours/,
  /Support \*\*can\*\* increase job concurrency limits/,
  /Standard .*hosted runner\s*\|\s*Free\s*\|\s*20/,
  /Standard .*hosted runner\s*\|\s*Pro\s*\|\s*40/,
  /Standard .*hosted runner\s*\|\s*Team\s*\|\s*60/,
  /Standard .*hosted runner\s*\|\s*Enterprise\s*\|\s*500/,
  /Larger runner\s*\|\s*Team\s*\|\s*1000/,
  /Larger runner\s*\|\s*Enterprise\s*\|\s*1000/,
] as const;

const CLOUDFLARE_LIMIT_PATTERNS = [
  /10MB max script size/,
  /30 seconds \(default\) \/ configurable to 5 minutes/,
  /Duration \(wall clock\) per step[^\n]*Unlimited/,
  /Maximum non-stream step result per step[^\n]*1MiB \(2\^20 bytes\)/,
  /Maximum event[^\n]*payload size[^\n]*1MiB \(2\^20 bytes\)/,
  /Maximum state that can be persisted per Workflow instance[^\n]*1GB/,
  /Maximum `?step\.sleep`? duration[^\n]*365 days \(1 year\)/,
  /Maximum steps per Workflow[^\n]*10,000 \(default\) \/ configurable up to 25,000/,
  /Concurrent Workflow instances[^\n]*50,000/,
  /Maximum Workflow instance creation rate[^\n]*300 per second per account[^\n]*100 per second per workflow/,
  /Maximum number of[^\n]*queued instances[^\n]*2,000,000/,
  /Retention limit for completed Workflow instance state[^\n]*30 days/,
  /Maximum number of subrequests per Workflow instance[^\n]*10,000\/request \(default\) \/ configurable up to 10 million/,
  /Each instance created or restarted counts towards this limit/,
  /10,000 concurrent instance limit/,
] as const;

async function verifyOfficialDocument(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  expected: PlatformLimitsEvidenceManifestV1['officialDocumentation']['githubActions'] |
    PlatformLimitsEvidenceManifestV1['officialDocumentation']['cloudflareWorkflows'],
  patterns: readonly RegExp[],
): Promise<string> {
  const contentPath = expected.path.split('/').map(encodeURIComponent).join('/');
  const response = await getJson(
    fetcher,
    `${apiOrigin}/repos/${expected.owner}/${expected.repository}/contents/${contentPath}` +
      `?ref=${encodeURIComponent(expected.commit)}`,
    token,
  );
  rejectPagination(response);
  const root = record(response.body);
  if (
    root === null || root.path !== expected.path || root.sha !== expected.blobSha ||
    root.encoding !== 'base64' || typeof root.content !== 'string'
  ) throw new PlatformLimitsEvidenceVerificationError('official_document_mismatch');
  const source = decodeBase64(root.content);
  if (
    await canonicalSha256(source) !== expected.contentDigest ||
    !requiredPatternsMatch(source, patterns)
  ) throw new PlatformLimitsEvidenceVerificationError('official_document_mismatch');
  return source;
}

async function verifyOrganizationPolicy(
  manifest: PlatformLimitsEvidenceManifestV1,
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
): Promise<void> {
  const org = encodeURIComponent(manifest.github.organization);
  const [actionsResponse, workflowResponse, retentionResponse] = await Promise.all([
    getJson(fetcher, `${apiOrigin}/orgs/${org}/actions/permissions`, token),
    getJson(fetcher, `${apiOrigin}/orgs/${org}/actions/permissions/workflow`, token),
    getJson(
      fetcher,
      `${apiOrigin}/orgs/${org}/actions/permissions/artifact-and-log-retention`,
      token,
    ),
  ]);
  for (const response of [actionsResponse, workflowResponse, retentionResponse]) {
    rejectPagination(response);
  }
  const actions = record(actionsResponse.body);
  const workflow = record(workflowResponse.body);
  const retention = record(retentionResponse.body);
  const enabledRepositories = actions?.enabled_repositories;
  const allowedActions = actions?.allowed_actions;
  const defaultWorkflowPermissions = workflow?.default_workflow_permissions;
  const canApprovePullRequestReviews = workflow?.can_approve_pull_request_reviews;
  const days = retention?.days;
  if (
    !['all', 'none', 'selected'].includes(String(enabledRepositories)) ||
    !['all', 'local_only', 'selected'].includes(String(allowedActions)) ||
    !['read', 'write'].includes(String(defaultWorkflowPermissions)) ||
    typeof canApprovePullRequestReviews !== 'boolean' ||
    typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > 400
  ) throw new PlatformLimitsEvidenceVerificationError('github_policy_mismatch');
  const normalized = {
    actions: { enabledRepositories, allowedActions },
    workflow: { defaultWorkflowPermissions, canApprovePullRequestReviews },
    artifactAndLogRetention: { days },
  };
  const expected = manifest.github.organizationPolicy;
  if (
    await canonicalSha256(normalized) !== expected.digest ||
    enabledRepositories !== expected.enabledRepositories ||
    allowedActions !== expected.allowedActions ||
    defaultWorkflowPermissions !== expected.defaultWorkflowPermissions ||
    canApprovePullRequestReviews !== expected.canApprovePullRequestReviews ||
    days !== expected.artifactAndLogRetentionDays
  ) throw new PlatformLimitsEvidenceVerificationError('github_policy_mismatch');
}

const BILLING_NUMERIC_KEYS = [
  'pricePerUnit', 'quantity', 'grossAmount', 'discountAmount', 'netAmount',
] as const;

interface NormalizedBillingItem extends RecordValue {
  product: 'actions';
  date: string;
  sku: string;
  unitType: string;
  pricePerUnit: number;
  quantity: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
}

function normalizeBillingItem(
  value: unknown,
  organization: string,
  year: number,
  month: number,
): NormalizedBillingItem | null {
  const item = record(value);
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`;
  const date = typeof item?.date === 'string' ? item.date : '';
  const parsedDate = Date.parse(`${date}T00:00:00.000Z`);
  if (
    item === null || typeof item.product !== 'string' || item.product.toLowerCase() !== 'actions' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(monthPrefix) ||
    !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== date ||
    typeof item.sku !== 'string' || item.sku.length < 1 || item.sku.length > 200 ||
    typeof item.unitType !== 'string' || item.unitType.length < 1 || item.unitType.length > 100 ||
    item.organizationName !== organization ||
    (item.repositoryName !== undefined && (
      typeof item.repositoryName !== 'string' || item.repositoryName.length > 200
    ))
  ) return null;
  for (const key of BILLING_NUMERIC_KEYS) {
    if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0) return null;
  }
  if (!Number.isSafeInteger(item.quantity)) return null;
  return {
    product: 'actions', date, sku: item.sku, unitType: item.unitType,
    pricePerUnit: item.pricePerUnit as number,
    quantity: item.quantity as number,
    grossAmount: item.grossAmount as number,
    discountAmount: item.discountAmount as number,
    netAmount: item.netAmount as number,
  };
}

async function verifyBilling(
  manifest: PlatformLimitsEvidenceManifestV1,
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
): Promise<void> {
  const expected = manifest.github.billing;
  const org = encodeURIComponent(manifest.github.organization);
  const response = await getJson(
    fetcher,
    `${apiOrigin}/organizations/${org}/settings/billing/usage` +
      `?year=${expected.year}&month=${expected.month}`,
    token,
  );
  rejectPagination(response);
  const root = record(response.body);
  const usageItems = root === null || !Array.isArray(root.usageItems) ? null : root.usageItems;
  if (root === null || usageItems === null) {
    throw new PlatformLimitsEvidenceVerificationError('github_billing_mismatch');
  }
  const aggregated = new Map<string, NormalizedBillingItem>();
  let actionsUsageItemCount = 0;
  for (const raw of usageItems) {
    const itemRecord = record(raw);
    if (typeof itemRecord?.product !== 'string') {
      throw new PlatformLimitsEvidenceVerificationError('github_billing_mismatch');
    }
    if (itemRecord.product.toLowerCase() !== 'actions') continue;
    const normalized = normalizeBillingItem(
      raw,
      manifest.github.organization,
      expected.year,
      expected.month,
    );
    if (normalized === null) {
      throw new PlatformLimitsEvidenceVerificationError('github_billing_mismatch');
    }
    actionsUsageItemCount += 1;
    const key = JSON.stringify([
      normalized.date,
      normalized.sku,
      normalized.unitType,
      normalized.pricePerUnit,
    ]);
    const prior = aggregated.get(key);
    if (prior === undefined) aggregated.set(key, normalized);
    else aggregated.set(key, {
      ...prior,
      quantity: prior.quantity + normalized.quantity,
      grossAmount: prior.grossAmount + normalized.grossAmount,
      discountAmount: prior.discountAmount + normalized.discountAmount,
      netAmount: prior.netAmount + normalized.netAmount,
    });
  }
  const actionsItems = [...aggregated.values()];
  actionsItems.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (actionsUsageItemCount < 1 || actionsUsageItemCount > 10_000) {
    throw new PlatformLimitsEvidenceVerificationError('github_billing_mismatch');
  }
  const total = (key: 'quantity' | 'grossAmount' | 'discountAmount' | 'netAmount'): number =>
    actionsItems.reduce((sum, item) => sum + item[key], 0);
  const unitTypes = [...new Set(actionsItems.map((item) => item.unitType))].sort();
  if (
    await canonicalSha256(actionsItems) !== expected.actionsUsageDigest ||
    actionsUsageItemCount !== expected.actionsUsageItemCount ||
    JSON.stringify(unitTypes) !== JSON.stringify(expected.unitTypes) ||
    total('quantity') !== expected.quantity ||
    total('grossAmount') !== expected.grossAmount ||
    total('discountAmount') !== expected.discountAmount ||
    total('netAmount') !== expected.netAmount
  ) throw new PlatformLimitsEvidenceVerificationError('github_billing_mismatch');
}

function workflowRoot(source: string): RecordValue | null {
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) return null;
    return record(document.toJS() as unknown);
  } catch { return null; }
}

function inputMatches(value: unknown, description: string): boolean {
  const input = record(value);
  return input !== null && exactKeys(input, ['description', 'required', 'type']) &&
    input.description === description && input.required === true && input.type === 'string';
}

function workflowContractMatches(source: string, kind: 'concurrency' | 'duration'): boolean {
  const root = workflowRoot(source);
  if (root === null || !exactKeys(root, ['name', 'run-name', 'on', 'permissions', 'jobs'])) {
    return false;
  }
  const triggers = record(root.on);
  const dispatch = triggers === null ? null : record(triggers.workflow_dispatch);
  const inputs = dispatch === null ? null : record(dispatch.inputs);
  const permissions = record(root.permissions);
  const jobs = record(root.jobs);
  const job = jobs === null ? null : record(jobs.probe);
  if (
    triggers === null || !exactKeys(triggers, ['workflow_dispatch']) ||
    dispatch === null || !exactKeys(dispatch, ['inputs']) || inputs === null ||
    permissions === null || Object.keys(permissions).length !== 0 ||
    jobs === null || !exactKeys(jobs, ['probe']) || job === null ||
    !inputMatches(inputs.probe_id, 'Non-sensitive audit correlation ID') ||
    !Array.isArray(job.steps) || job.steps.length !== 1
  ) return false;
  const step = record(job.steps[0]);
  if (step === null || !exactKeys(step, ['name', 'run'])) return false;
  if (kind === 'concurrency') {
    const strategy = record(job.strategy);
    const matrix = strategy === null ? null : record(strategy.matrix);
    return root.name === 'Platform concurrency probe' &&
      root['run-name'] === 'delivery-loop/platform-concurrency/${{ inputs.probe_id }}' &&
      exactKeys(inputs, ['probe_id', 'slots_json']) &&
      inputMatches(inputs.slots_json, 'JSON array of unique integer slots (maximum 256)') &&
      exactKeys(job, ['name', 'strategy', 'runs-on', 'timeout-minutes', 'steps']) &&
      job.name === 'platform-concurrency-${{ matrix.slot }}' &&
      strategy !== null && exactKeys(strategy, ['fail-fast', 'max-parallel', 'matrix']) &&
      strategy['fail-fast'] === false && strategy['max-parallel'] === 256 &&
      matrix !== null && exactKeys(matrix, ['slot']) &&
      matrix.slot === '${{ fromJSON(inputs.slots_json) }}' &&
      job['runs-on'] === 'ubuntu-latest' && job['timeout-minutes'] === 10 &&
      step.name === 'Hold runner slot for overlap measurement' && step.run === 'sleep 300';
  }
  return root.name === 'Platform duration probe' &&
    root['run-name'] === 'delivery-loop/platform-duration/${{ inputs.probe_id }}' &&
    exactKeys(inputs, ['probe_id']) &&
    exactKeys(job, ['name', 'runs-on', 'timeout-minutes', 'steps']) &&
    job.name === 'platform-duration' && job['runs-on'] === 'ubuntu-latest' &&
    job['timeout-minutes'] === 360 &&
    step.name === 'Exceed the hosted runner maximum duration' && step.run === 'sleep 22200';
}

async function verifyProbeWorkflow(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  repository: string,
  expected: PlatformLimitsEvidenceManifestV1['github']['concurrencyProbe'] |
    PlatformLimitsEvidenceManifestV1['github']['durationProbe'],
  kind: 'concurrency' | 'duration',
): Promise<void> {
  const path = expected.workflowPath.split('/').map(encodeURIComponent).join('/');
  const response = await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/contents/${path}` +
      `?ref=${encodeURIComponent(expected.workflowHeadSha)}`,
    token,
  );
  rejectPagination(response);
  const root = record(response.body);
  if (
    root === null || root.path !== expected.workflowPath || root.sha !== expected.workflowBlobSha ||
    root.encoding !== 'base64' || typeof root.content !== 'string'
  ) throw new PlatformLimitsEvidenceVerificationError('github_probe_workflow_mismatch');
  const source = decodeBase64(root.content);
  if (
    await canonicalSha256(source) !== expected.workflowContentDigest ||
    !workflowContractMatches(source, kind)
  ) throw new PlatformLimitsEvidenceVerificationError('github_probe_workflow_mismatch');
}

async function getRun(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  repository: string,
  runId: string,
): Promise<RecordValue> {
  const response = await getJson(
    fetcher,
    `${apiOrigin}/repos/${repository}/actions/runs/${runId}`,
    token,
  );
  rejectPagination(response);
  const root = record(response.body);
  if (root === null) throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  return root;
}

async function getJobs(
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
  repository: string,
  runId: string,
): Promise<RecordValue[]> {
  const jobs: RecordValue[] = [];
  let totalCount: number | null = null;
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const response = await getJson(
      fetcher,
      `${apiOrigin}/repos/${repository}/actions/runs/${runId}/jobs` +
        `?filter=all&per_page=100&page=${page}`,
      token,
    );
    const root = record(response.body);
    const pageJobs = root === null || !Array.isArray(root.jobs) ? null : root.jobs;
    if (
      root === null || typeof root.total_count !== 'number' ||
      !Number.isSafeInteger(root.total_count) || root.total_count < 1 ||
      root.total_count > MAX_JOBS_PER_RUN || pageJobs === null
    ) throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
    if (totalCount === null) totalCount = root.total_count;
    if (root.total_count !== totalCount) {
      throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
    }
    for (const raw of pageJobs) {
      const job = record(raw);
      if (job === null) throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
      jobs.push(job);
    }
    if (jobs.length >= totalCount) break;
    if (!/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
      throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
    }
  }
  if (totalCount === null || jobs.length !== totalCount) {
    throw new PlatformLimitsEvidenceVerificationError('github_response_invalid');
  }
  return jobs;
}

function hostedJobInterval(
  job: RecordValue,
  expectedName: RegExp,
  expectedConclusion: 'success' | 'failure',
): JobInterval | null {
  const startedAt = timestamp(job.started_at);
  const completedAt = timestamp(job.completed_at);
  const labels = Array.isArray(job.labels) ? job.labels : null;
  if (
    typeof job.id !== 'number' || !Number.isSafeInteger(job.id) || job.id <= 0 ||
    typeof job.name !== 'string' || !expectedName.test(job.name) ||
    job.status !== 'completed' || job.conclusion !== expectedConclusion ||
    startedAt === null || completedAt === null || completedAt <= startedAt ||
    labels === null || !labels.includes('ubuntu-latest') || labels.includes('self-hosted')
  ) return null;
  return { id: job.id, name: job.name, startedAt, completedAt };
}

function maximumOverlap(intervals: JobInterval[]): number {
  const events = intervals.flatMap((interval) => [
    { time: interval.startedAt, delta: 1 },
    { time: interval.completedAt, delta: -1 },
  ]).sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
    if (active < 0) return -1;
  }
  return active === 0 ? maximum : -1;
}

async function verifyConcurrencyProbe(
  manifest: PlatformLimitsEvidenceManifestV1,
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
): Promise<void> {
  const probe = manifest.github.concurrencyProbe;
  await verifyProbeWorkflow(
    fetcher, apiOrigin, token, manifest.github.repository, probe, 'concurrency',
  );
  const intervals: JobInterval[] = [];
  const runIds = new Set<string>();
  const jobIds = new Set<number>();
  const jobNames = new Set<string>();
  for (const [index, runId] of probe.runIds.entries()) {
    if (runIds.has(runId)) {
      throw new PlatformLimitsEvidenceVerificationError('github_concurrency_probe_mismatch');
    }
    runIds.add(runId);
    const run = await getRun(
      fetcher, apiOrigin, token, manifest.github.repository, runId,
    );
    const createdAt = timestamp(run.created_at);
    const updatedAt = timestamp(run.updated_at);
    if (
      String(run.id) !== runId || run.event !== 'workflow_dispatch' ||
      run.status !== 'completed' || run.conclusion !== 'success' ||
      run.head_sha !== probe.workflowHeadSha || run.path !== probe.workflowPath ||
      run.html_url !== probe.auditUrls[index] || createdAt === null || updatedAt === null
    ) throw new PlatformLimitsEvidenceVerificationError('github_concurrency_probe_mismatch');
    const jobs = await getJobs(
      fetcher, apiOrigin, token, manifest.github.repository, runId,
    );
    for (const job of jobs) {
      const interval = hostedJobInterval(job, /^platform-concurrency-[1-9][0-9]{0,5}$/, 'success');
      if (
        interval === null || jobIds.has(interval.id) || jobNames.has(interval.name) ||
        interval.startedAt < createdAt || interval.completedAt > updatedAt ||
        interval.completedAt - interval.startedAt < MIN_CONCURRENCY_JOB_DURATION_MS ||
        interval.completedAt - interval.startedAt > MAX_CONCURRENCY_JOB_DURATION_MS
      ) throw new PlatformLimitsEvidenceVerificationError('github_concurrency_probe_mismatch');
      jobIds.add(interval.id);
      jobNames.add(interval.name);
      intervals.push(interval);
    }
  }
  const firstStartedAt = Math.min(...intervals.map((interval) => interval.startedAt));
  const lastCompletedAt = Math.max(...intervals.map((interval) => interval.completedAt));
  const observedMaximum = maximumOverlap(intervals);
  if (
    intervals.length !== probe.requestedJobCount ||
    firstStartedAt !== Date.parse(probe.startedAt) ||
    lastCompletedAt !== Date.parse(probe.completedAt) ||
    observedMaximum !== probe.observedMaximumConcurrency ||
    observedMaximum !== probe.reviewedOrganizationLimit ||
    intervals.length <= observedMaximum
  ) throw new PlatformLimitsEvidenceVerificationError('github_concurrency_probe_mismatch');
}

async function verifyDurationProbe(
  manifest: PlatformLimitsEvidenceManifestV1,
  fetcher: typeof fetch,
  apiOrigin: string,
  token: string,
): Promise<void> {
  const probe = manifest.github.durationProbe;
  await verifyProbeWorkflow(fetcher, apiOrigin, token, manifest.github.repository, probe, 'duration');
  const run = await getRun(
    fetcher, apiOrigin, token, manifest.github.repository, probe.runId,
  );
  const createdAt = timestamp(run.created_at);
  const updatedAt = timestamp(run.updated_at);
  if (
    String(run.id) !== probe.runId || run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' || run.conclusion !== probe.conclusion ||
    run.head_sha !== probe.workflowHeadSha || run.path !== probe.workflowPath ||
    run.html_url !== probe.auditUrl || createdAt === null || updatedAt === null
  ) throw new PlatformLimitsEvidenceVerificationError('github_duration_probe_mismatch');
  const jobs = await getJobs(
    fetcher, apiOrigin, token, manifest.github.repository, probe.runId,
  );
  const interval = jobs.length === 1
    ? hostedJobInterval(jobs[0]!, /^platform-duration$/, 'failure')
    : null;
  if (
    interval === null || interval.startedAt < createdAt || interval.completedAt > updatedAt ||
    interval.startedAt !== Date.parse(probe.startedAt) ||
    interval.completedAt !== Date.parse(probe.completedAt) ||
    interval.completedAt - interval.startedAt !== probe.observedDurationMs
  ) throw new PlatformLimitsEvidenceVerificationError('github_duration_probe_mismatch');
}

async function verifyReusedEvidence(
  manifest: PlatformLimitsEvidenceManifestV1,
  options: PlatformLimitsEvidenceVerifierOptions,
): Promise<void> {
  const expected = manifest.reusedEvidence;
  const runnerRepository = options.runnerHeartbeat.manifest.analysisActionEvidence
    .dispatchEvidence.repository.fullName;
  if (
    options.runnerHeartbeat.manifest.evidenceId !== expected.runnerHeartbeatEvidenceId ||
    options.workflowHibernate.manifest.evidenceId !== expected.workflowHibernateEvidenceId ||
    options.controlledReplay.manifest.evidenceId !== expected.controlledReplayEvidenceId ||
    runnerRepository !== manifest.github.repository ||
    options.workflowHibernate.manifest.repository !== manifest.github.repository ||
    options.controlledReplay.manifest.repository !== manifest.github.repository ||
    options.workflowHibernate.manifest.cloudflare.accountIdDigest !==
      manifest.cloudflare.accountIdDigest
  ) throw new PlatformLimitsEvidenceVerificationError('reused_evidence_mismatch');
  try {
    const [heartbeat, hibernate, replay] = await Promise.all([
      verifyRunnerHeartbeatEvidence(
        options.runnerHeartbeat.manifest,
        options.runnerHeartbeat.options,
      ),
      verifyWorkflowHibernateEvidence(
        options.workflowHibernate.manifest,
        options.workflowHibernate.options,
      ),
      verifyControlledReplayEvidence(
        options.controlledReplay.manifest,
        options.controlledReplay.options,
      ),
    ]);
    if (
      heartbeat.evidenceId !== expected.runnerHeartbeatEvidenceId ||
      heartbeat.repository !== manifest.github.repository ||
      heartbeat.cadenceVerified !== true || heartbeat.externalStateVerified !== true ||
      hibernate.evidenceId !== expected.workflowHibernateEvidenceId ||
      hibernate.repository !== manifest.github.repository || hibernate.verifiedStepCount !== 7 ||
      hibernate.reusedCompletedSteps !== true || hibernate.duplicateDispatches !== 0 ||
      hibernate.controlledReplayCount !== 0 || hibernate.plaintextLeaks !== 0 ||
      replay.evidenceId !== expected.controlledReplayEvidenceId ||
      replay.repository !== manifest.github.repository || replay.replay !== 'verified' ||
      replay.duplicateDispatchCount !== 0 || replay.duplicatePullRequestCount !== 0 ||
      replay.duplicateDeploymentCount !== 0
    ) throw new Error('mismatch');
  } catch {
    throw new PlatformLimitsEvidenceVerificationError('reused_evidence_mismatch');
  }
}

export async function verifyPlatformLimitsEvidence(
  input: PlatformLimitsEvidenceManifestV1,
  options: PlatformLimitsEvidenceVerifierOptions,
): Promise<PlatformLimitsEvidenceVerificationSummary> {
  const parsed = PlatformLimitsEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new PlatformLimitsEvidenceVerificationError('manifest_invalid');
  if (!TOKEN_PATTERN.test(options.githubToken)) {
    throw new PlatformLimitsEvidenceVerificationError('configuration_invalid');
  }
  const manifest = parsed.data;
  const apiOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const runnerControlOrigin = safeOrigin(options.runnerHeartbeat.options.controlPlaneOrigin);
  const hibernateControlOrigin = safeOrigin(options.workflowHibernate.options.controlPlaneOrigin);
  const replayControlOrigin = safeOrigin(options.controlledReplay.options.controlPlaneOrigin);
  const runnerGithubOrigin = safeOrigin(
    options.runnerHeartbeat.options.githubApiOrigin ?? 'https://api.github.com',
  );
  const hibernateGithubOrigin = safeOrigin(
    options.workflowHibernate.options.githubApiOrigin ?? 'https://api.github.com',
  );
  const replayGithubOrigin = safeOrigin(
    options.controlledReplay.options.githubApiOrigin ?? 'https://api.github.com',
  );
  if (
    runnerControlOrigin !== hibernateControlOrigin ||
    runnerControlOrigin !== replayControlOrigin ||
    apiOrigin !== runnerGithubOrigin || apiOrigin !== hibernateGithubOrigin ||
    apiOrigin !== replayGithubOrigin
  ) throw new PlatformLimitsEvidenceVerificationError('configuration_invalid');
  const fetcher = options.fetch ?? fetch;
  await verifyOfficialDocument(
    fetcher,
    apiOrigin,
    options.githubToken,
    manifest.officialDocumentation.githubActions,
    GITHUB_LIMIT_PATTERNS,
  );
  const cloudflareSource = await verifyOfficialDocument(
    fetcher,
    apiOrigin,
    options.githubToken,
    manifest.officialDocumentation.cloudflareWorkflows,
    CLOUDFLARE_LIMIT_PATTERNS,
  );
  if (
    !cloudflareSource.includes('50,000') ||
    !cloudflareSource.includes('10,000 concurrent instance limit')
  ) throw new PlatformLimitsEvidenceVerificationError('official_document_mismatch');
  await verifyOrganizationPolicy(manifest, fetcher, apiOrigin, options.githubToken);
  await verifyBilling(manifest, fetcher, apiOrigin, options.githubToken);
  await verifyConcurrencyProbe(manifest, fetcher, apiOrigin, options.githubToken);
  await verifyDurationProbe(manifest, fetcher, apiOrigin, options.githubToken);
  await verifyReusedEvidence(manifest, options);
  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    organization: manifest.github.organization,
    repository: manifest.github.repository,
    githubHostedMaximumMinutes: 360,
    reviewedOrganizationConcurrency: manifest.github.concurrencyProbe.reviewedOrganizationLimit,
    observedMaximumConcurrency: manifest.github.concurrencyProbe.observedMaximumConcurrency,
    concurrencyProbeJobCount: manifest.github.concurrencyProbe.requestedJobCount,
    actionsUsageItemCount: manifest.github.billing.actionsUsageItemCount,
    actionsUsageDigest: manifest.github.billing.actionsUsageDigest,
    githubDocumentationVerified: true,
    githubOrganizationPolicyVerified: true,
    githubBillingVerified: true,
    githubConcurrencyProbeVerified: true,
    githubDurationProbeVerified: true,
    githubAppAndEventSemanticsVerified: true,
    cloudflarePaidLimitsVerified: true,
    cloudflareCreateSendEventUpgradeVerified: true,
    cloudflareRestartVerified: true,
    cloudflareConcurrencyDocumentationConflictObserved: true,
  };
}
