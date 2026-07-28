import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { executeCommand, type CommandExecutor } from '../agent/command-runtime.js';
import {
  TEST_ROLLBACK_OIDC_AUDIENCE,
  TEST_ROLLBACK_WORKFLOW_PATH,
  resolveTestRollbackCommand,
} from '../domain/delivery-policy.js';
import { canonicalSha256 } from '../domain/digest.js';
import { loadDeliveryPolicyAtCommit } from './delivery-policy-loader.js';

const exec = promisify(execFile);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 64 * 1_024;

const OidcResponseSchema = z.object({ value: z.string().min(1).max(20_000) }).strict();
const ContextResponseSchema = z.object({
  accepted: z.literal(true),
  attestationId: z.string().regex(ID_PATTERN),
  disposition: z.enum(['created', 'duplicate']),
  rollbackId: z.string().regex(ID_PATTERN),
  sourceKind: z.enum(['deployment_failure', 'acceptance_failure']),
  refSha: z.string().regex(SHA_PATTERN),
  roleRef: z.string().regex(/^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  policyDigest: z.string().regex(DIGEST_PATTERN),
  contractDigest: z.string().regex(DIGEST_PATTERN),
}).strict();
const ReportResponseSchema = z.object({
  accepted: z.literal(true),
  rollbackId: z.string().regex(ID_PATTERN),
  status: z.enum(['passed', 'failed']),
  disposition: z.enum(['created', 'duplicate']),
}).strict();

interface Configuration {
  rollbackId: string;
  sourceKind: 'deployment_failure' | 'acceptance_failure';
  sha: string;
  repository: string;
  workspacePath: string;
  controlPlaneUrl: string;
  oidcRequestUrl: string;
  oidcRequestToken: string;
}

export interface RunTestRollbackOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  execute?: CommandExecutor;
  monotonicNow?: () => number;
}

export interface TestRollbackRunResult {
  rollbackId: string;
  status: 'passed' | 'failed';
  exitCode: number;
  durationMs: number;
}

export class TestRollbackRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestRollbackRunnerError';
  }
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new TestRollbackRunnerError('test rollback configuration is incomplete');
  }
  return value;
}

function httpsUrl(raw: string, originOnly: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestRollbackRunnerError('test rollback URL configuration is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    (originOnly && (url.pathname !== '/' || url.search !== '' || url.hash !== ''))
  ) throw new TestRollbackRunnerError('test rollback URL configuration is invalid');
  return url;
}

function configuration(environment: NodeJS.ProcessEnv): Configuration {
  const rollbackId = required(environment, 'DELIVERY_ROLLBACK_ID');
  const sourceKind = required(environment, 'DELIVERY_ROLLBACK_SOURCE_KIND');
  const sha = required(environment, 'DELIVERY_ROLLBACK_SHA');
  const repository = required(environment, 'GITHUB_REPOSITORY');
  const workspacePath = resolve(required(environment, 'GITHUB_WORKSPACE'));
  const controlPlane = httpsUrl(required(environment, 'DELIVERY_CONTROL_PLANE_URL'), true);
  const oidcRequest = httpsUrl(required(environment, 'ACTIONS_ID_TOKEN_REQUEST_URL'), false);
  if (
    !ID_PATTERN.test(rollbackId) ||
    (sourceKind !== 'deployment_failure' && sourceKind !== 'acceptance_failure') ||
    !SHA_PATTERN.test(sha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !workspacePath.startsWith('/')
  ) throw new TestRollbackRunnerError('test rollback configuration is invalid');
  return {
    rollbackId,
    sourceKind,
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
    throw new TestRollbackRunnerError(`${operation} request failed`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new TestRollbackRunnerError(`${operation} failed`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new TestRollbackRunnerError(`${operation} response is invalid`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TestRollbackRunnerError(`${operation} response is invalid`);
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
    throw new TestRollbackRunnerError('test rollback checkout is invalid');
  }
  if (head !== config.sha) {
    throw new TestRollbackRunnerError('test rollback checkout binding changed');
  }
}

async function requestOidc(
  fetcher: typeof globalThis.fetch,
  config: Configuration,
): Promise<string> {
  const url = new URL(config.oidcRequestUrl);
  url.searchParams.set('audience', TEST_ROLLBACK_OIDC_AUDIENCE);
  const parsed = OidcResponseSchema.safeParse(await fetchJson(fetcher, url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.oidcRequestToken}`,
    },
  }, 'GitHub rollback OIDC token'));
  if (!parsed.success) throw new TestRollbackRunnerError('GitHub OIDC response is invalid');
  return parsed.data.value;
}

function isolatedEnvironment(
  environment: NodeJS.ProcessEnv,
  sourceKind: Configuration['sourceKind'],
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {
    ...environment,
    DELIVERY_ROLLBACK_ENVIRONMENT: 'test',
    DELIVERY_ROLLBACK_TRIGGER: sourceKind,
  };
  delete isolated.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete isolated.DELIVERY_ROLLBACK_ID;
  delete isolated.DELIVERY_ROLLBACK_SOURCE_KIND;
  delete isolated.DELIVERY_ROLLBACK_SHA;
  delete isolated.DELIVERY_CONTROL_PLANE_URL;
  delete isolated.GITHUB_TOKEN;
  return isolated;
}

/** Runs one exact-SHA rollback contract; workflow_run remains final external authority. */
export async function runTestRollback(
  options: RunTestRollbackOptions = {},
): Promise<TestRollbackRunResult> {
  const environment = options.environment ?? process.env;
  const config = configuration(environment);
  const fetcher = options.fetch ?? globalThis.fetch;
  const executor = options.execute ?? executeCommand;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  await assertCheckout(config);
  const loaded = await loadDeliveryPolicyAtCommit(config.workspacePath, config.sha);
  if (loaded.policy.deployment.mode !== 'github_actions') {
    throw new TestRollbackRunnerError('test rollback is not enabled by policy');
  }
  const deployment = loaded.policy.deployment.test;
  const rollback = deployment?.rollback;
  if (
    deployment === undefined || rollback === undefined ||
    rollback.workflowPath !== TEST_ROLLBACK_WORKFLOW_PATH ||
    rollback.oidcAudience !== TEST_ROLLBACK_OIDC_AUDIENCE ||
    rollback.environment !== 'test' || rollback.roleRef === deployment.roleRef ||
    !rollback.automaticOn.includes(config.sourceKind)
  ) throw new TestRollbackRunnerError('test rollback policy binding is invalid');
  const oidcToken = await requestOidc(fetcher, config);
  const context = ContextResponseSchema.safeParse(await fetchJson(
    fetcher,
    `${config.controlPlaneUrl}/v1/test-rollbacks/${config.rollbackId}/oidc-attestation`,
    {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${oidcToken}` },
    },
    'test rollback attestation',
  ));
  const contractDigest = await canonicalSha256(rollback);
  if (
    !context.success || context.data.rollbackId !== config.rollbackId ||
    context.data.sourceKind !== config.sourceKind || context.data.refSha !== config.sha ||
    context.data.roleRef !== rollback.roleRef || context.data.policyDigest !== loaded.digest ||
    context.data.contractDigest !== contractDigest
  ) throw new TestRollbackRunnerError('test rollback context is invalid');
  const command = resolveTestRollbackCommand(loaded.policy, config.workspacePath);
  const startedAt = monotonicNow();
  let exitCode = 127;
  try {
    exitCode = (await executor({
      command: command.command,
      args: command.args,
      cwd: command.cwd,
      stdin: command.stdin,
      timeoutMs: command.timeoutMs,
      environment: isolatedEnvironment(environment, config.sourceKind),
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
    `${config.controlPlaneUrl}/v1/test-rollbacks/${config.rollbackId}/result`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${oidcToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ exitCode, durationMs }),
    },
    'test rollback result',
  ));
  const status = exitCode === 0 ? 'passed' as const : 'failed' as const;
  if (
    !report.success || report.data.rollbackId !== config.rollbackId ||
    report.data.status !== status
  ) throw new TestRollbackRunnerError('test rollback result response is invalid');
  return { rollbackId: config.rollbackId, status, exitCode, durationMs };
}

