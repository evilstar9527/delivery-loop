import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  TEST_DEPLOYMENT_OIDC_AUDIENCE,
  TEST_DEPLOYMENT_WORKFLOW_PATH,
  resolveDeploymentCommand,
} from '../domain/delivery-policy.js';
import {
  executeCommand,
  type CommandExecutor,
} from '../agent/command-runtime.js';
import { loadDeliveryPolicyAtCommit } from './delivery-policy-loader.js';

const exec = promisify(execFile);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const MAX_RESPONSE_BYTES = 64 * 1_024;

const OidcResponseSchema = z.object({ value: z.string().min(1).max(20_000) }).strict();
const AttestationResponseSchema = z.object({
  accepted: z.literal(true),
  attestationId: z.string().regex(ID_PATTERN),
  disposition: z.enum(['created', 'duplicate']),
  roleRef: z.string().regex(/^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
}).strict();

interface TestDeploymentConfiguration {
  deploymentId: string;
  githubDeploymentId: string;
  repository: string;
  sha: string;
  controlPlaneUrl: string;
  oidcRequestUrl: string;
  oidcRequestToken: string;
  githubToken: string;
  environmentUrl: string | null;
  workspacePath: string;
}

export interface RunTestDeploymentOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  execute?: CommandExecutor;
}

export interface TestDeploymentRunResult {
  status: 'succeeded' | 'failed';
  deploymentId: string;
  githubDeploymentId: string;
  exitCode: number;
}

export class TestDeploymentRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDeploymentRunnerError';
  }
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new TestDeploymentRunnerError('test deployment configuration is incomplete');
  }
  return value;
}

function httpsUrl(raw: string, originOnly: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestDeploymentRunnerError('test deployment URL configuration is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    (originOnly && (url.pathname !== '/' || url.search !== '' || url.hash !== ''))
  ) throw new TestDeploymentRunnerError('test deployment URL configuration is invalid');
  return url;
}

function configuration(environment: NodeJS.ProcessEnv): TestDeploymentConfiguration {
  const deploymentId = required(environment, 'DELIVERY_DEPLOYMENT_ID');
  const githubDeploymentId = required(environment, 'DELIVERY_GITHUB_DEPLOYMENT_ID');
  const repository = required(environment, 'GITHUB_REPOSITORY');
  const sha = required(environment, 'DELIVERY_DEPLOYMENT_SHA');
  const workspacePath = resolve(required(environment, 'GITHUB_WORKSPACE'));
  const controlPlane = httpsUrl(required(environment, 'DELIVERY_CONTROL_PLANE_URL'), true);
  const oidcRequest = httpsUrl(required(environment, 'ACTIONS_ID_TOKEN_REQUEST_URL'), false);
  const environmentUrlRaw = environment.DELIVERY_TEST_ENVIRONMENT_URL;
  const environmentUrl = environmentUrlRaw === undefined || environmentUrlRaw === ''
    ? null
    : httpsUrl(environmentUrlRaw, false).toString();
  if (
    !ID_PATTERN.test(deploymentId) || !GITHUB_ID_PATTERN.test(githubDeploymentId) ||
    !REPOSITORY_PATTERN.test(repository) || !SHA_PATTERN.test(sha) ||
    !workspacePath.startsWith('/')
  ) throw new TestDeploymentRunnerError('test deployment configuration is invalid');
  return {
    deploymentId,
    githubDeploymentId,
    repository,
    sha,
    controlPlaneUrl: controlPlane.origin,
    oidcRequestUrl: oidcRequest.toString(),
    oidcRequestToken: required(environment, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
    githubToken: required(environment, 'GITHUB_TOKEN'),
    environmentUrl,
    workspacePath,
  };
}

async function fetchJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  expectedStatus: number,
  operation: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error' });
  } catch {
    throw new TestDeploymentRunnerError(`${operation} request failed`);
  }
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new TestDeploymentRunnerError(`${operation} failed`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new TestDeploymentRunnerError(`${operation} response is invalid`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TestDeploymentRunnerError(`${operation} response is invalid`);
  }
}

async function assertCheckout(config: TestDeploymentConfiguration): Promise<void> {
  let head: string;
  try {
    head = (await exec('git', ['rev-parse', 'HEAD'], {
      cwd: config.workspacePath,
      encoding: 'utf8',
      timeout: 30_000,
    })).stdout.trim();
  } catch {
    throw new TestDeploymentRunnerError('test deployment checkout is invalid');
  }
  if (head !== config.sha) {
    throw new TestDeploymentRunnerError('test deployment checkout binding changed');
  }
}

async function requestOidcToken(
  fetcher: typeof globalThis.fetch,
  config: TestDeploymentConfiguration,
): Promise<string> {
  const url = new URL(config.oidcRequestUrl);
  url.searchParams.set('audience', TEST_DEPLOYMENT_OIDC_AUDIENCE);
  const parsed = OidcResponseSchema.safeParse(await fetchJson(fetcher, url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.oidcRequestToken}`,
    },
  }, 200, 'GitHub OIDC token'));
  if (!parsed.success) throw new TestDeploymentRunnerError('GitHub OIDC token response is invalid');
  return parsed.data.value;
}

async function attest(
  fetcher: typeof globalThis.fetch,
  config: TestDeploymentConfiguration,
  oidcToken: string,
): Promise<string> {
  const parsed = AttestationResponseSchema.safeParse(await fetchJson(
    fetcher,
    `${config.controlPlaneUrl}/v1/test-deployments/${config.deploymentId}/oidc-attestation`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${oidcToken}`,
      },
    },
    200,
    'test deployment attestation',
  ));
  if (!parsed.success) {
    throw new TestDeploymentRunnerError('test deployment attestation response is invalid');
  }
  return parsed.data.roleRef;
}

async function reportStatus(
  fetcher: typeof globalThis.fetch,
  config: TestDeploymentConfiguration,
  state: 'in_progress' | 'success' | 'failure',
): Promise<void> {
  const body = {
    state,
    environment: 'test',
    auto_inactive: false,
    description: state === 'success'
      ? 'delivery-loop test deployment succeeded'
      : state === 'failure'
        ? 'delivery-loop test deployment failed'
        : 'delivery-loop test deployment started',
    ...(state === 'success' && config.environmentUrl !== null
      ? { environment_url: config.environmentUrl }
      : {}),
  };
  await fetchJson(
    fetcher,
    `https://api.github.com/repos/${config.repository}/deployments/${config.githubDeploymentId}/statuses`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${config.githubToken}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
    },
    201,
    'GitHub deployment status',
  );
}

function commandEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  delete isolated.GITHUB_TOKEN;
  delete isolated.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete isolated.DELIVERY_DEPLOYMENT_ID;
  delete isolated.DELIVERY_GITHUB_DEPLOYMENT_ID;
  return isolated;
}

/** Fixed test Environment runner: attest exact OIDC identity, then execute only policy argv. */
export async function runTestDeployment(
  options: RunTestDeploymentOptions = {},
): Promise<TestDeploymentRunResult> {
  const environment = options.environment ?? process.env;
  const config = configuration(environment);
  const fetcher = options.fetch ?? globalThis.fetch;
  const executor = options.execute ?? executeCommand;
  await assertCheckout(config);
  const loaded = await loadDeliveryPolicyAtCommit(config.workspacePath, config.sha);
  if (loaded.policy.deployment.mode !== 'github_actions') {
    throw new TestDeploymentRunnerError('test deployment is not enabled by policy');
  }
  const target = loaded.policy.deployment.test;
  if (
    target === undefined || target.environment !== 'test' ||
    target.workflowPath !== TEST_DEPLOYMENT_WORKFLOW_PATH ||
    target.oidcAudience !== TEST_DEPLOYMENT_OIDC_AUDIENCE ||
    !target.roleRef.startsWith('test:')
  ) throw new TestDeploymentRunnerError('test deployment policy binding is invalid');
  const oidcToken = await requestOidcToken(fetcher, config);
  const attestedRoleRef = await attest(fetcher, config, oidcToken);
  if (attestedRoleRef !== target.roleRef) {
    throw new TestDeploymentRunnerError('test deployment role binding changed');
  }
  await reportStatus(fetcher, config, 'in_progress');
  const command = resolveDeploymentCommand(loaded.policy, 'test', config.workspacePath);
  let exitCode = 1;
  try {
    const result = await executor({
      command: command.command,
      args: command.args,
      cwd: command.cwd,
      stdin: command.stdin,
      timeoutMs: command.timeoutMs,
      environment: commandEnvironment(environment),
    });
    exitCode = result.exitCode;
  } catch {
    exitCode = 1;
  }
  if (exitCode !== 0) {
    await reportStatus(fetcher, config, 'failure');
    return {
      status: 'failed',
      deploymentId: config.deploymentId,
      githubDeploymentId: config.githubDeploymentId,
      exitCode,
    };
  }
  await reportStatus(fetcher, config, 'success');
  return {
    status: 'succeeded',
    deploymentId: config.deploymentId,
    githubDeploymentId: config.githubDeploymentId,
    exitCode,
  };
}
