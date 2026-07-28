import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { executeCommand, type CommandExecutor } from '../agent/command-runtime.js';
import {
  TEST_ACCEPTANCE_OIDC_AUDIENCE,
  resolveDeliveryCommand,
} from '../domain/delivery-policy.js';
import { loadDeliveryPolicyAtCommit } from './delivery-policy-loader.js';

const exec = promisify(execFile);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 64 * 1_024;

const OidcResponseSchema = z.object({ value: z.string().min(1).max(20_000) }).strict();
const ContextResponseSchema = z.object({
  accepted: z.literal(true),
  attestationId: z.string().regex(ID_PATTERN),
  disposition: z.enum(['created', 'duplicate']),
  acceptanceId: z.string().regex(ID_PATTERN),
  commandRef: z.string().regex(/^acceptance:[a-z][a-z0-9_-]{0,63}$/),
  refSha: z.string().regex(SHA_PATTERN),
  environmentUrl: z.url().max(2_000),
}).strict();
const ReportResponseSchema = z.object({
  accepted: z.literal(true),
  acceptanceId: z.string().regex(ID_PATTERN),
  status: z.enum(['passed', 'failed']),
  disposition: z.enum(['created', 'duplicate']),
}).strict();

interface Configuration {
  acceptanceId: string;
  sha: string;
  repository: string;
  workspacePath: string;
  controlPlaneUrl: string;
  oidcRequestUrl: string;
  oidcRequestToken: string;
}

export interface RunTestAcceptanceOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  execute?: CommandExecutor;
  monotonicNow?: () => number;
}

export interface TestAcceptanceRunResult {
  acceptanceId: string;
  status: 'passed' | 'failed';
  exitCode: number;
  durationMs: number;
}

export class TestAcceptanceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestAcceptanceRunnerError';
  }
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new TestAcceptanceRunnerError('test acceptance configuration is incomplete');
  }
  return value;
}

function httpsUrl(raw: string, originOnly: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestAcceptanceRunnerError('test acceptance URL configuration is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    (originOnly && (url.pathname !== '/' || url.search !== '' || url.hash !== ''))
  ) throw new TestAcceptanceRunnerError('test acceptance URL configuration is invalid');
  return url;
}

function configuration(environment: NodeJS.ProcessEnv): Configuration {
  const acceptanceId = required(environment, 'DELIVERY_ACCEPTANCE_ID');
  const sha = required(environment, 'DELIVERY_ACCEPTANCE_SHA');
  const repository = required(environment, 'GITHUB_REPOSITORY');
  const workspacePath = resolve(required(environment, 'GITHUB_WORKSPACE'));
  const controlPlane = httpsUrl(required(environment, 'DELIVERY_CONTROL_PLANE_URL'), true);
  const oidcRequest = httpsUrl(required(environment, 'ACTIONS_ID_TOKEN_REQUEST_URL'), false);
  if (
    !ID_PATTERN.test(acceptanceId) || !SHA_PATTERN.test(sha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !workspacePath.startsWith('/')
  ) throw new TestAcceptanceRunnerError('test acceptance configuration is invalid');
  return {
    acceptanceId,
    sha,
    repository,
    workspacePath,
    controlPlaneUrl: controlPlane.origin,
    oidcRequestUrl: oidcRequest.toString(),
    oidcRequestToken: required(environment, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
  };
}

async function fetchJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error' });
  } catch {
    throw new TestAcceptanceRunnerError(`${operation} request failed`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new TestAcceptanceRunnerError(`${operation} failed`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new TestAcceptanceRunnerError(`${operation} response is invalid`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TestAcceptanceRunnerError(`${operation} response is invalid`);
  }
}

async function assertCheckout(config: Configuration): Promise<void> {
  let head: string;
  try {
    head = (await exec('git', ['rev-parse', 'HEAD'], {
      cwd: config.workspacePath,
      encoding: 'utf8',
      timeout: 30_000,
    })).stdout.trim();
  } catch {
    throw new TestAcceptanceRunnerError('test acceptance checkout is invalid');
  }
  if (head !== config.sha) {
    throw new TestAcceptanceRunnerError('test acceptance checkout binding changed');
  }
}

async function requestOidc(
  fetcher: typeof globalThis.fetch,
  config: Configuration,
): Promise<string> {
  const url = new URL(config.oidcRequestUrl);
  url.searchParams.set('audience', TEST_ACCEPTANCE_OIDC_AUDIENCE);
  const parsed = OidcResponseSchema.safeParse(await fetchJson(fetcher, url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.oidcRequestToken}`,
    },
  }, 'GitHub acceptance OIDC token'));
  if (!parsed.success) throw new TestAcceptanceRunnerError('GitHub OIDC response is invalid');
  return parsed.data.value;
}

function isolatedEnvironment(
  environment: NodeJS.ProcessEnv,
  environmentUrl: string,
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {
    ...environment,
    DELIVERY_TEST_BASE_URL: environmentUrl,
  };
  delete isolated.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete isolated.DELIVERY_ACCEPTANCE_ID;
  delete isolated.DELIVERY_CONTROL_PLANE_URL;
  delete isolated.GITHUB_TOKEN;
  return isolated;
}

/** Executes one commit-bound acceptance command; signed workflow_run remains final authority. */
export async function runTestAcceptance(
  options: RunTestAcceptanceOptions = {},
): Promise<TestAcceptanceRunResult> {
  const environment = options.environment ?? process.env;
  const config = configuration(environment);
  const fetcher = options.fetch ?? globalThis.fetch;
  const executor = options.execute ?? executeCommand;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  await assertCheckout(config);
  const token = await requestOidc(fetcher, config);
  const context = ContextResponseSchema.safeParse(await fetchJson(
    fetcher,
    `${config.controlPlaneUrl}/v1/test-acceptances/${config.acceptanceId}/oidc-attestation`,
    {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    },
    'test acceptance attestation',
  ));
  if (
    !context.success || context.data.acceptanceId !== config.acceptanceId ||
    context.data.refSha !== config.sha
  ) throw new TestAcceptanceRunnerError('test acceptance context is invalid');
  const environmentUrl = httpsUrl(context.data.environmentUrl, false);
  environmentUrl.search = '';
  environmentUrl.hash = '';
  if (environmentUrl.toString() !== context.data.environmentUrl) {
    throw new TestAcceptanceRunnerError('test acceptance URL is invalid');
  }
  const loaded = await loadDeliveryPolicyAtCommit(config.workspacePath, config.sha);
  if (
    loaded.policy.deployment.mode !== 'github_actions' ||
    loaded.policy.deployment.test?.acceptanceCommandRef !== context.data.commandRef
  ) throw new TestAcceptanceRunnerError('test acceptance policy binding is invalid');
  const command = resolveDeliveryCommand(
    loaded.policy,
    context.data.commandRef,
    config.workspacePath,
  );
  const startedAt = monotonicNow();
  let exitCode = 127;
  try {
    exitCode = (await executor({
      command: command.command,
      args: command.args,
      cwd: command.cwd,
      stdin: command.stdin,
      timeoutMs: command.timeoutMs,
      environment: isolatedEnvironment(environment, context.data.environmentUrl),
    })).exitCode;
  } catch {
    exitCode = 127;
  }
  const elapsed = Math.ceil(monotonicNow() - startedAt);
  const durationMs = Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 3_600_000
    ? elapsed
    : 3_600_000;
  const report = ReportResponseSchema.safeParse(await fetchJson(
    fetcher,
    `${config.controlPlaneUrl}/v1/test-acceptances/${config.acceptanceId}/result`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ exitCode, durationMs }),
    },
    'test acceptance result',
  ));
  const status = exitCode === 0 ? 'passed' as const : 'failed' as const;
  if (
    !report.success || report.data.acceptanceId !== config.acceptanceId ||
    report.data.status !== status
  ) throw new TestAcceptanceRunnerError('test acceptance result response is invalid');
  return { acceptanceId: config.acceptanceId, status, exitCode, durationMs };
}
