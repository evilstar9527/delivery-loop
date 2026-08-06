import { isIP } from 'node:net';
import { analysisAttemptId } from '../domain/workflow-event.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
  type TaskEnvelope,
} from '../domain/task.js';
import { SecretScanner } from '../security/redaction.js';

const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 10_000;
const ACTIONS_PER_PAGE = 50;
const MAX_ACTION_PAGES = 20;
const TOKEN_PATTERN = /^[^\0\r\n]{8,2000}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';

export type GuardedTaskIntakeErrorCode =
  | 'configuration_invalid'
  | 'task_input_invalid'
  | 'task_policy_rejected'
  | 'guard_request_failed'
  | 'task_already_exists'
  | 'action_already_exists'
  | 'action_inventory_invalid'
  | 'intake_request_failed'
  | 'intake_response_invalid';

export class GuardedTaskIntakeError extends Error {
  constructor(
    readonly code: GuardedTaskIntakeErrorCode,
    readonly taskCreateRequests: 0 | 1,
  ) {
    super(`Guarded task intake failed: ${code}`);
    this.name = 'GuardedTaskIntakeError';
  }
}

export interface GuardedTaskIntakeOptions {
  controlPlaneOrigin: string;
  githubApiOrigin: string;
  repository: string;
  taskToken: string;
  githubToken: string;
  task: unknown;
  fetch?: typeof fetch;
}

export interface GuardedTaskIntakeSummary {
  schemaVersion: '1';
  taskId: string;
  runId: string;
  analysisAttemptId: string;
  taskDigest: string;
  taskGuardStatus: 404;
  matchingActionRuns: 0;
  taskCreateRequests: 1;
  accepted: true;
}

function fail(code: GuardedTaskIntakeErrorCode, requests: 0 | 1): never {
  throw new GuardedTaskIntakeError(code, requests);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeOrigin(raw: string, allowGitHubIp = false): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  const ipCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    raw !== raw.trim() || raw.length > 2_048 || url.protocol !== 'https:' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') ||
    (!allowGitHubIp && isIP(ipCandidate) !== 0)
  ) return null;
  return url.origin;
}

function safeRepository(value: string): boolean {
  if (!REPOSITORY_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
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
      void reader.cancel().catch(() => undefined);
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

function discardBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* fixed rejection */ }
}

function scanner(options: GuardedTaskIntakeOptions): SecretScanner {
  return new SecretScanner({ secrets: [options.taskToken, options.githubToken] });
}

async function request(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail('guard_request_failed', 0);
  }
}

async function countMatchingActions(
  options: GuardedTaskIntakeOptions,
  attemptId: string,
  githubOrigin: string,
): Promise<number> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const [owner, repository] = options.repository.split('/');
  const url = new URL(
    `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}` +
      `/actions/workflows/${encodeURIComponent(WORKFLOW_PATH)}/runs`,
    githubOrigin,
  );
  url.searchParams.set('event', 'workflow_dispatch');
  url.searchParams.set('per_page', String(ACTIONS_PER_PAGE));
  let matches = 0;
  let seen = 0;
  let expectedTotal: number | null = null;
  for (let page = 1; page <= MAX_ACTION_PAGES; page += 1) {
    const response = await request(fetcher, url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.githubToken}`,
        'x-github-api-version': '2026-03-10',
        'user-agent': 'delivery-loop-guarded-task-intake',
      },
    });
    if (response.status !== 200) {
      discardBody(response);
      fail('guard_request_failed', 0);
    }
    const bytes = await readBounded(response);
    if (bytes === null || scanner(options).scan(bytes).length > 0) {
      fail('action_inventory_invalid', 0);
    }
    let body: Record<string, unknown> | null;
    try { body = record(JSON.parse(new TextDecoder().decode(bytes)) as unknown); } catch {
      fail('action_inventory_invalid', 0);
    }
    if (
      body === null || !Number.isInteger(body.total_count) ||
      (body.total_count as number) < 0 || !Array.isArray(body.workflow_runs)
    ) {
      fail('action_inventory_invalid', 0);
    }
    if (expectedTotal === null) expectedTotal = body.total_count as number;
    if (body.total_count !== expectedTotal) fail('action_inventory_invalid', 0);
    if (body.workflow_runs.length > ACTIONS_PER_PAGE) {
      fail('action_inventory_invalid', 0);
    }
    for (const value of body.workflow_runs) {
      const run = record(value);
      if (run === null || typeof run.display_title !== 'string') {
        fail('action_inventory_invalid', 0);
      }
      if (run.display_title === `delivery-loop/${attemptId}`) matches += 1;
      seen += 1;
    }
    if (seen > expectedTotal) fail('action_inventory_invalid', 0);
    if (seen === expectedTotal) return matches;
    if (body.workflow_runs.length !== ACTIONS_PER_PAGE) {
      fail('action_inventory_invalid', 0);
    }
    url.searchParams.set('page', String(page + 1));
  }
  fail('action_inventory_invalid', 0);
}

function validateOptions(options: GuardedTaskIntakeOptions): {
  controlOrigin: string;
  githubOrigin: string;
  task: TaskEnvelope;
} {
  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin, true);
  const parsed = TaskEnvelopeSchema.safeParse(options.task);
  if (
    controlOrigin === null || githubOrigin !== 'https://api.github.com' ||
    !safeRepository(options.repository) ||
    !TOKEN_PATTERN.test(options.taskToken) || !TOKEN_PATTERN.test(options.githubToken) ||
    options.taskToken === options.githubToken
  ) fail('configuration_invalid', 0);
  if (!parsed.success) fail('task_input_invalid', 0);
  const task = parsed.data;
  if (
    `${task.target.owner}/${task.target.repo}` !== options.repository ||
    task.target.baseBranch !== 'main' || task.target.environment !== 'none' ||
    !task.policy.allowRepositoryWrite || task.policy.allowTestDeploy ||
    task.policy.allowProductionDeploy || !task.policy.requireHumanApproval
  ) fail('task_policy_rejected', 0);
  if (scanner(options).scan(task).length > 0) fail('task_policy_rejected', 0);
  return { controlOrigin, githubOrigin, task };
}

export async function runGuardedTaskIntake(
  options: GuardedTaskIntakeOptions,
): Promise<GuardedTaskIntakeSummary> {
  const { controlOrigin, githubOrigin, task } = validateOptions(options);
  const fetcher = options.fetch ?? globalThis.fetch;
  const ids = await taskRevisionIds(task);
  const attemptId = analysisAttemptId(ids.runId);
  const taskDigest = await taskRevisionDigest(task);
  const taskResponse = await request(fetcher, new URL(`/v1/tasks/${ids.taskId}`, controlOrigin), {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${options.taskToken}`,
    },
  });
  if (taskResponse.status !== 404) {
    discardBody(taskResponse);
    fail(taskResponse.status === 200 ? 'task_already_exists' : 'guard_request_failed', 0);
  }
  discardBody(taskResponse);

  const matchingActionRuns = await countMatchingActions(options, attemptId, githubOrigin);
  if (matchingActionRuns !== 0) fail('action_already_exists', 0);

  let response: Response;
  try {
    response = await fetcher(new URL('/v1/tasks', controlOrigin), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.taskToken}`,
        'content-type': 'application/json',
        'idempotency-key': `guarded-task-intake:${ids.taskId.slice('task_'.length)}`,
      },
      body: JSON.stringify(task),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail('intake_request_failed', 1);
  }
  if (response.status !== 202) {
    discardBody(response);
    fail('intake_request_failed', 1);
  }
  const bytes = await readBounded(response);
  if (bytes === null || scanner(options).scan(bytes).length > 0) {
    fail('intake_response_invalid', 1);
  }
  let body: Record<string, unknown> | null;
  try { body = record(JSON.parse(new TextDecoder().decode(bytes)) as unknown); } catch {
    fail('intake_response_invalid', 1);
  }
  if (
    body === null || body.accepted !== true ||
    body.taskId !== ids.taskId || body.runId !== ids.runId
  ) fail('intake_response_invalid', 1);
  return {
    schemaVersion: '1',
    taskId: ids.taskId,
    runId: ids.runId,
    analysisAttemptId: attemptId,
    taskDigest,
    taskGuardStatus: 404,
    matchingActionRuns: 0,
    taskCreateRequests: 1,
    accepted: true,
  };
}
