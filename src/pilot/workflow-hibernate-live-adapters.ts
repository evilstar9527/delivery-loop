import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { TaskEnvelope } from '../domain/task.js';
import { SecretScanner } from '../security/redaction.js';
import {
  WorkflowHibernateLiveWindowError,
  type FrozenWorkerSourceVerification,
  type LiveBeforeDeployment,
  type WorkflowHibernateLiveWindowDependencies,
  type WorkflowHibernateWindowAuthorizationV1,
} from './workflow-hibernate-live-window.js';
import { normalizeCloudflareWorkflowStepName } from './cloudflare-workflow-step.js';
import type {
  WorkflowHibernateAfterResult,
  WorkflowHibernateWindowSnapshot,
} from './workflow-hibernate-window-guard.js';

const executeFile = promisify(execFile);
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MAX_COMMAND_OUTPUT_BYTES = 1 * 1_024 * 1_024;
const HTTP_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 120_000;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[^\0\r\n]{8,2000}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const EXPECTED_WORKFLOW_PATH = '.github/workflows/delivery-agent.yml';

interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type WorkflowHibernateCommandExecutor = (
  request: CommandRequest,
) => Promise<CommandResult>;

export interface WorkflowHibernateLiveAdapterOptions {
  sourceDirectory: string;
  wranglerBinary: string;
  controlPlaneOrigin: string;
  taskToken: string;
  operationsToken: string;
  githubToken: string;
  cloudflareReadToken: string;
  cloudflareDeployToken: string;
  cloudflareAccountId: string;
  githubApiOrigin?: string;
  cloudflareApiOrigin?: string;
  fetch?: typeof fetch;
  command?: WorkflowHibernateCommandExecutor;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

export interface WorkflowReadinessBeforeDeploymentRequest {
  sourceSha: string;
  bundleSha256: string;
  bundleBytes: number;
  expectedCurrentDeploymentId: string;
  expectedCurrentVersionId: string;
  message: string;
}

export interface WorkflowReadinessBeforeDeploymentSummary {
  verification: FrozenWorkerSourceVerification;
  beforeDeployment: LiveBeforeDeployment;
  afterDeployment: LiveBeforeDeployment;
  deploymentAttempts: 1;
}

export interface WorkflowReadinessBeforeDeploymentSession {
  verify(request: WorkflowReadinessBeforeDeploymentRequest): Promise<FrozenWorkerSourceVerification>;
  readCurrentDeployment(): Promise<LiveBeforeDeployment>;
  deploy(): Promise<WorkflowReadinessBeforeDeploymentSummary>;
}

interface FrozenWorkerSourceRequest {
  source: { sha: string };
}

interface FrozenWorkerDeployRequest {
  sourceSha: string;
  bundleSha256: string;
  message: string;
  strict: true;
}

type Source = 'control_plane' | 'github' | 'cloudflare';

function fail(code: ConstructorParameters<typeof WorkflowHibernateLiveWindowError>[0]): never {
  throw new WorkflowHibernateLiveWindowError(code);
}

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

function safeOrigin(raw: string, pathRequired = false): string {
  let url: URL;
  try { url = new URL(raw); } catch { fail('configuration_invalid'); }
  const path = url.pathname.replace(/\/$/, '');
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' ||
    (!pathRequired && path !== '') || (pathRequired && path === '')
  ) fail('configuration_invalid');
  return pathRequired ? `${url.origin}${path}` : url.origin;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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

async function defaultCommand(request: CommandRequest): Promise<CommandResult> {
  try {
    const result = await executeFile(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      encoding: 'utf8',
      timeout: request.timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch {
    return { exitCode: 1, stdout: '', stderr: '' };
  }
}

function minimalEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...(process.env.XDG_CONFIG_HOME === undefined
      ? {} : { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
    CI: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

class FrozenSourceAndWranglerAdapter {
  private frozen: FrozenWorkerSourceVerification | null = null;
  private frozenBundle: Buffer | null = null;
  private deployAttempted = false;

  constructor(
    private readonly options: WorkflowHibernateLiveAdapterOptions,
    private readonly command: WorkflowHibernateCommandExecutor,
  ) {}

  async verify(
    authorization: FrozenWorkerSourceRequest,
  ): Promise<FrozenWorkerSourceVerification> {
    const status = await this.gitStatus();
    if (status.headSha !== authorization.source.sha || !status.clean) {
      fail('source_verification_failed');
    }
    const builds: Array<{ digest: string; bytes: number; bundle: Buffer }> = [];
    for (let index = 0; index < 2; index += 1) builds.push(await this.dryBuild());
    if (
      builds[0]!.digest !== builds[1]!.digest || builds[0]!.bytes !== builds[1]!.bytes
    ) fail('source_verification_failed');
    this.frozen = {
      headSha: status.headSha,
      bundleSha256: builds[0]!.digest,
      bundleBytes: builds[0]!.bytes,
      matchingBundleBuilds: 2,
      clean: true,
    };
    this.frozenBundle = Buffer.from(builds[0]!.bundle);
    return this.frozen;
  }

  async snapshotSource(): Promise<WorkflowHibernateWindowSnapshot['source']> {
    if (this.frozen === null) fail('source_verification_failed');
    const status = await this.gitStatus();
    return {
      headSha: status.headSha,
      bundleSha256: this.frozen.bundleSha256,
      clean: status.clean,
      matchingBundleBuilds: this.frozen.matchingBundleBuilds,
    };
  }

  async deploy(request: FrozenWorkerDeployRequest): Promise<void> {
    if (
      this.frozen === null || this.frozenBundle === null || this.deployAttempted ||
      request.sourceSha !== this.frozen.headSha ||
      request.bundleSha256 !== this.frozen.bundleSha256 || !request.strict
    ) fail('after_deploy_failed');
    const status = await this.gitStatus();
    if (!status.clean || status.headSha !== request.sourceSha) fail('after_deploy_failed');
    this.deployAttempted = true;
    const outputDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-hibernate-upload-'));
    try {
      const workerPath = join(outputDirectory, 'worker.js');
      const emptyEnvironmentPath = join(outputDirectory, 'empty.env');
      await writeFile(workerPath, this.frozenBundle, { flag: 'wx', mode: 0o600 });
      await writeFile(emptyEnvironmentPath, '', { flag: 'wx', mode: 0o600 });
      const bundle = await readFile(workerPath);
      if (
        bundle.byteLength !== this.frozen.bundleBytes ||
        createHash('sha256').update(bundle).digest('hex') !== this.frozen.bundleSha256
      ) fail('after_deploy_failed');
      const result = await this.command({
        command: this.options.wranglerBinary,
        args: [
          'deploy', workerPath, '--no-bundle', '--strict', '--message', request.message,
          '--env-file', emptyEnvironmentPath,
          '--config', join(this.options.sourceDirectory, 'wrangler.jsonc'),
        ],
        cwd: this.options.sourceDirectory,
        env: minimalEnvironment({
          CLOUDFLARE_ACCOUNT_ID: this.options.cloudflareAccountId,
          CLOUDFLARE_API_TOKEN: this.options.cloudflareDeployToken,
          HOME: outputDirectory,
          XDG_CONFIG_HOME: outputDirectory,
        }),
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) fail('after_deploy_failed');
    } catch (error) {
      if (error instanceof WorkflowHibernateLiveWindowError) throw error;
      fail('after_deploy_failed');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }

  private async gitStatus(): Promise<{ headSha: string; clean: boolean }> {
    const environment = minimalEnvironment();
    const [head, status] = await Promise.all([
      this.command({
        command: 'git', args: ['rev-parse', 'HEAD'], cwd: this.options.sourceDirectory,
        env: environment, timeoutMs: 10_000,
      }),
      this.command({
        command: 'git', args: ['status', '--porcelain=v1', '--untracked-files=all'],
        cwd: this.options.sourceDirectory, env: environment, timeoutMs: 10_000,
      }),
    ]);
    const headSha = head.stdout.trim();
    if (head.exitCode !== 0 || status.exitCode !== 0 || !SHA_PATTERN.test(headSha)) {
      fail('source_verification_failed');
    }
    return { headSha, clean: status.stdout === '' };
  }

  private async dryBuild(): Promise<{ digest: string; bytes: number; bundle: Buffer }> {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'delivery-loop-hibernate-'));
    try {
      const emptyEnvironmentPath = join(outputDirectory, 'empty.env');
      await writeFile(emptyEnvironmentPath, '', { flag: 'wx', mode: 0o600 });
      const result = await this.command({
        command: this.options.wranglerBinary,
        args: [
          'deploy', '--dry-run', '--outdir', outputDirectory,
          '--env-file', emptyEnvironmentPath,
          '--config', join(this.options.sourceDirectory, 'wrangler.jsonc'),
        ],
        cwd: this.options.sourceDirectory,
        env: minimalEnvironment({
          CLOUDFLARE_ACCOUNT_ID: this.options.cloudflareAccountId,
          HOME: outputDirectory,
          XDG_CONFIG_HOME: outputDirectory,
        }),
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) fail('source_verification_failed');
      const workerPath = join(outputDirectory, 'worker.js');
      const metadata = await stat(workerPath);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > 10 * 1_024 * 1_024) {
        fail('source_verification_failed');
      }
      const bundle = await readFile(workerPath);
      return {
        digest: createHash('sha256').update(bundle).digest('hex'),
        bytes: bundle.byteLength,
        bundle,
      };
    } catch (error) {
      if (error instanceof WorkflowHibernateLiveWindowError) throw error;
      fail('source_verification_failed');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

class LiveHttpAdapter {
  private readonly fetcher: typeof fetch;
  private readonly controlOrigin: string;
  private readonly githubOrigin: string;
  private readonly cloudflareOrigin: string;
  private readonly scanner: SecretScanner;
  private taskCreateAttempted = false;

  constructor(private readonly options: WorkflowHibernateLiveAdapterOptions) {
    const tokens = [
      options.taskToken,
      options.operationsToken,
      options.githubToken,
      options.cloudflareReadToken,
      options.cloudflareDeployToken,
    ];
    if (
      !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
      !isAbsolute(options.sourceDirectory) || !isAbsolute(options.wranglerBinary) ||
      tokens.some((token) => !TOKEN_PATTERN.test(token)) ||
      new Set(tokens).size !== tokens.length
    ) fail('configuration_invalid');
    this.controlOrigin = safeOrigin(options.controlPlaneOrigin);
    this.githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
    this.cloudflareOrigin = safeOrigin(
      options.cloudflareApiOrigin ?? 'https://api.cloudflare.com/client/v4', true,
    );
    this.fetcher = options.fetch ?? fetch;
    this.scanner = new SecretScanner({ secrets: [
      options.taskToken,
      options.operationsToken,
      options.githubToken,
      options.cloudflareReadToken,
      options.cloudflareDeployToken,
    ] });
  }

  async before(): Promise<LiveBeforeDeployment> {
    const deployments = await this.deployments();
    const current = this.latestDeployment(deployments);
    if (current === null) fail('before_deployment_mismatch');
    return current;
  }

  async taskExists(authorization: WorkflowHibernateWindowAuthorizationV1): Promise<boolean> {
    const result = await this.requestJson(
      `${this.controlOrigin}/v1/tasks/${authorization.task.taskId}`,
      this.options.taskToken,
      'control_plane',
      { allowedStatuses: [200, 404] },
    );
    return result.status === 200;
  }

  async createTask(
    task: TaskEnvelope,
    authorization: WorkflowHibernateWindowAuthorizationV1,
  ): Promise<{ accepted: boolean; taskId: string; runId: string }> {
    if (this.taskCreateAttempted) fail('task_create_failed');
    this.taskCreateAttempted = true;
    const result = await this.requestJson(
      `${this.controlOrigin}/v1/tasks`,
      this.options.taskToken,
      'control_plane',
      {
        method: 'POST',
        allowedStatuses: [202],
        headers: {
          'content-type': 'application/json',
          'idempotency-key': authorization.task.idempotencyKey,
        },
        body: JSON.stringify(task),
      },
    );
    const body = record(result.body);
    if (
      body === null || body.accepted !== true ||
      body.taskId !== authorization.task.taskId || body.runId !== authorization.task.runId
    ) fail('task_create_response_mismatch');
    return {
      accepted: true,
      taskId: authorization.task.taskId,
      runId: authorization.task.runId,
    };
  }

  async snapshot(
    authorization: WorkflowHibernateWindowAuthorizationV1,
    source: WorkflowHibernateWindowSnapshot['source'],
  ): Promise<WorkflowHibernateWindowSnapshot> {
    const [planResponse, auditResponse, instanceResponse, deployments, actionResponse] =
      await Promise.all([
        this.requestJson(
          `${this.controlOrigin}/v1/runs/${authorization.task.runId}/plan`,
          this.options.taskToken, 'control_plane', { allowedStatuses: [200, 404] },
        ),
        this.requestJson(
          `${this.controlOrigin}/v1/runs/${authorization.task.runId}/audit`,
          this.options.operationsToken, 'control_plane', { allowedStatuses: [200, 404] },
        ),
        this.requestJson(
          `${this.cloudflareBase()}/workflows/delivery-run/instances/${authorization.task.runId}`,
          this.options.cloudflareReadToken, 'cloudflare', { allowedStatuses: [200, 404] },
        ),
        this.deployments(),
        this.actionInventory(authorization),
      ]);
    if (
      planResponse.status === 404 || auditResponse.status === 404 ||
      instanceResponse.status === 404
    ) fail('live_snapshot_not_ready');
    const planRoot = record(planResponse.body);
    const run = planRoot === null ? null : record(planRoot.run);
    const attempts = planRoot === null ? [] : rows(planRoot, 'attempts')
      .filter((attempt) => attempt.mode === 'analysis');
    if (run === null || run.id !== authorization.task.runId) fail('live_snapshot_conflict');
    if (run.baseSha === undefined || run.baseSha === null) fail('live_snapshot_not_ready');
    if (run.baseSha !== authorization.analysisWorkflowHeadSha) fail('live_snapshot_conflict');
    if (['received', 'triaging', 'queued'].includes(String(run.state))) {
      fail('live_snapshot_not_ready');
    }
    if (attempts.length === 0 || actionResponse.length === 0) fail('live_snapshot_not_ready');
    if (attempts.length !== 1 || actionResponse.length !== 1) fail('live_snapshot_conflict');
    const attempt = attempts[0]!;
    if (attempt.id !== authorization.task.attemptId) fail('live_snapshot_conflict');

    const auditRoot = record(auditResponse.body);
    const answers = auditRoot === null ? null : record(auditRoot.answers);
    const checks = answers === null ? null : record(answers.checks);
    if (checks === null) fail('live_snapshot_not_ready');
    const effectOutboxes = rows(checks, 'effectOutboxes');
    const dispatches = effectOutboxes.filter((outbox) => outbox.kind === 'analysis_dispatch');
    const signals = effectOutboxes.filter((outbox) => outbox.kind === 'workflow_signal');
    if (dispatches.length === 0) fail('live_snapshot_not_ready');
    if (dispatches.length !== 1 || signals.length > 1) fail('live_snapshot_conflict');
    const dispatch = dispatches[0]!;

    const instance = record(this.cloudflareResult(instanceResponse.body));
    if (instance === null) fail('live_snapshot_not_ready');
    const workflow = this.waitingWorkflow(instance, authorization.task.runId);
    const currentDeployment = this.latestDeployment(deployments);
    if (currentDeployment === null) fail('live_snapshot_conflict');
    const waitStartedAt = Date.parse(workflow.analysisWait.startedAt);
    const deploymentsDuringWait = deployments.filter((deployment) => {
      const createdAt = isoDate(deployment.created_on);
      return createdAt !== null && Date.parse(createdAt) > waitStartedAt;
    }).length;
    const action = actionResponse[0]!;
    const activePlan = run.activePlan === undefined || run.activePlan === null
      ? null : record(run.activePlan);
    if (
      typeof run.state !== 'string' ||
      (activePlan !== null && typeof activePlan.id !== 'string') ||
      typeof attempt.status !== 'string' || typeof dispatch.id !== 'string' ||
      typeof dispatch.state !== 'string' ||
      !(typeof action.id === 'number' || typeof action.id === 'string') ||
      typeof action.status !== 'string'
    ) fail('external_response_invalid');
    return {
      observedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      source,
      deployment: { ...currentDeployment, deploymentsDuringWait },
      run: {
        runId: authorization.task.runId,
        state: String(run.state),
        activePlanId: activePlan === null ? null : String(activePlan.id),
        analysisAttemptCount: attempts.length,
        analysisDispatchOutboxCount: dispatches.length,
        workflowInstanceCount: 1,
      },
      analysis: {
        attemptId: authorization.task.attemptId,
        attemptStatus: String(attempt.status),
        dispatchOutboxId: String(dispatch.id),
        dispatchOutboxState: String(dispatch.state),
        resultSignalOutboxCount: signals.length,
        actionRunId: String(action.id),
        actionStatus: String(action.status),
        actionConclusion: typeof action.conclusion === 'string' ? action.conclusion : null,
        actionRunCount: actionResponse.length,
      },
      workflow,
    };
  }

  async after(
    authorization: WorkflowHibernateWindowAuthorizationV1,
  ): Promise<WorkflowHibernateAfterResult> {
    const [instanceResponse, deployments] = await Promise.all([
      this.requestJson(
        `${this.cloudflareBase()}/workflows/delivery-run/instances/${authorization.task.runId}`,
        this.options.cloudflareReadToken, 'cloudflare', { allowedStatuses: [200] },
      ),
      this.deployments(),
    ]);
    const instance = record(this.cloudflareResult(instanceResponse.body));
    if (instance === null) fail('external_response_invalid');
    const workflow = this.workflowWait(instance, authorization.task.runId, false);
    const current = this.latestDeployment(deployments);
    if (current === null) fail('external_response_invalid');
    const waitStart = Date.parse(workflow.startedAt);
    const waitEnd = workflow.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(workflow.endedAt);
    const deploymentsDuringWait = deployments.filter((deployment) => {
      const createdAt = isoDate(deployment.created_on);
      if (createdAt === null) return false;
      const timestamp = Date.parse(createdAt);
      return timestamp > waitStart && timestamp < waitEnd;
    }).length;
    return {
      deployment: current,
      observedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      workflow: {
        instanceId: authorization.task.runId,
        analysisWaitStartedAt: workflow.startedAt,
        analysisWaitEndedAt: workflow.endedAt,
      },
      deploymentsDuringWait,
    };
  }

  private async actionInventory(
    authorization: WorkflowHibernateWindowAuthorizationV1,
  ): Promise<Array<Record<string, unknown>>> {
    const workflowFile = encodeURIComponent(EXPECTED_WORKFLOW_PATH);
    const response = await this.requestJson(
      `${this.githubOrigin}/repos/${authorization.repository}/actions/workflows/${workflowFile}/runs?` +
        `event=workflow_dispatch&branch=${encodeURIComponent(authorization.baseBranch)}&per_page=100`,
      this.options.githubToken,
      'github',
      { allowedStatuses: [200] },
    );
    const root = record(response.body);
    if (root === null || !Number.isSafeInteger(root.total_count)) {
      fail('external_response_invalid');
    }
    const inventory = rows(root, 'workflow_runs');
    if (Number(root.total_count) !== inventory.length) fail('external_response_invalid');
    return inventory.filter((run) =>
      run.event === 'workflow_dispatch' &&
      run.display_title === `delivery-loop/${authorization.task.attemptId}` &&
      run.head_branch === authorization.baseBranch &&
      run.head_sha === authorization.analysisWorkflowHeadSha &&
      run.path === EXPECTED_WORKFLOW_PATH);
  }

  private waitingWorkflow(
    instance: Record<string, unknown>,
    runId: string,
  ): WorkflowHibernateWindowSnapshot['workflow'] {
    const wait = this.workflowWait(instance, runId);
    const steps = Array.isArray(instance.steps)
      ? instance.steps.map(record).filter((step): step is Record<string, unknown> => step !== null)
      : [];
    if (steps.length < 3) fail('live_snapshot_not_ready');
    const register = steps[0]!;
    const dispatch = steps[1]!;
    const waitStep = steps[2]!;
    const registerEnd = isoDate(register.end);
    const dispatchEnd = isoDate(dispatch.end);
    if (
      normalizeCloudflareWorkflowStepName(register.name, 'register-run') === null ||
      register.type !== 'step' || register.success !== true ||
      normalizeCloudflareWorkflowStepName(
        dispatch.name, 'dispatch-analysis-attempt',
      ) === null || dispatch.type !== 'step' ||
      dispatch.success !== true ||
      normalizeCloudflareWorkflowStepName(waitStep.name, 'await-analysis-result') === null ||
      waitStep.type !== 'waitForEvent' || registerEnd === null || dispatchEnd === null
    ) fail('live_snapshot_conflict');
    return {
      instanceId: runId,
      status: String(instance.status),
      registerRun: { status: 'complete', endedAt: registerEnd },
      dispatchAnalysisAttempt: { status: 'complete', endedAt: dispatchEnd },
      analysisWait: {
        status: wait.endedAt === null ? 'waiting' : 'complete',
        startedAt: wait.startedAt,
        endedAt: wait.endedAt,
      },
      resumedStepCount: steps.slice(3).filter((step) => isoDate(step.start) !== null).length,
    };
  }

  private workflowWait(
    instance: Record<string, unknown>,
    runId: string,
    requireActiveWait = true,
  ): { startedAt: string; endedAt: string | null } {
    if (!UUID_PATTERN.test(String(instance.versionId))) {
      fail('live_snapshot_conflict');
    }
    if (requireActiveWait) {
      if (['queued', 'running'].includes(String(instance.status))) {
        fail('live_snapshot_not_ready');
      }
      if (instance.status !== 'waiting') fail('live_snapshot_conflict');
    } else if (!['waiting', 'running', 'complete'].includes(String(instance.status))) {
      fail('live_snapshot_conflict');
    }
    const steps = Array.isArray(instance.steps)
      ? instance.steps.map(record).filter((step): step is Record<string, unknown> => step !== null)
      : [];
    const waits = steps.filter((step) =>
      normalizeCloudflareWorkflowStepName(step.name, 'await-analysis-result') !== null);
    if (waits.length === 0) fail('live_snapshot_not_ready');
    if (waits.length !== 1) fail('live_snapshot_conflict');
    const wait = waits[0]!;
    const startedAt = isoDate(wait.start);
    const endedAt = wait.end === undefined || wait.end === null ? null : isoDate(wait.end);
    if (startedAt === null || (wait.end !== undefined && wait.end !== null && endedAt === null)) {
      fail('live_snapshot_conflict');
    }
    if (requireActiveWait && endedAt !== null) fail('live_snapshot_conflict');
    void runId;
    return { startedAt, endedAt };
  }

  private async deployments(): Promise<Array<Record<string, unknown>>> {
    const response = await this.requestJson(
      `${this.cloudflareBase()}/workers/scripts/delivery-loop-control-plane/deployments`,
      this.options.cloudflareReadToken,
      'cloudflare',
      { allowedStatuses: [200] },
    );
    const result = record(this.cloudflareResult(response.body));
    if (result === null) fail('external_response_invalid');
    const deployments = rows(result, 'deployments');
    if (deployments.length === 0 || deployments.length > 100) fail('external_response_invalid');
    return deployments;
  }

  private latestDeployment(deployments: Array<Record<string, unknown>>): LiveBeforeDeployment | null {
    const normalized = deployments.map((deployment) => {
      const deploymentId = deployment.id;
      const createdAt = isoDate(deployment.created_on);
      const versions = rows(deployment, 'versions');
      const version = versions.length === 1 ? versions[0]! : null;
      return {
        deploymentId,
        createdAt,
        versionId: version?.version_id,
        trafficPercentage: version?.percentage,
      };
    });
    if (normalized.some((item) =>
      typeof item.deploymentId !== 'string' || !UUID_PATTERN.test(item.deploymentId) ||
      item.createdAt === null || typeof item.versionId !== 'string' ||
      !UUID_PATTERN.test(item.versionId) || typeof item.trafficPercentage !== 'number')) {
      fail('external_response_invalid');
    }
    normalized.sort((left, right) => Date.parse(right.createdAt!) - Date.parse(left.createdAt!));
    const latest = normalized[0];
    return latest === undefined ? null : {
      deploymentId: String(latest.deploymentId),
      versionId: String(latest.versionId),
      createdAt: latest.createdAt!,
      trafficPercentage: Number(latest.trafficPercentage),
    };
  }

  private cloudflareBase(): string {
    return `${this.cloudflareOrigin}/accounts/${this.options.cloudflareAccountId}`;
  }

  private cloudflareResult(input: unknown): unknown {
    const envelope = record(input);
    if (
      envelope === null || envelope.success !== true || !Array.isArray(envelope.errors) ||
      !Array.isArray(envelope.messages) || !Object.hasOwn(envelope, 'result')
    ) fail('external_response_invalid');
    return envelope.result;
  }

  private async requestJson(
    url: string,
    token: string,
    source: Source,
    options: {
      method?: 'GET' | 'POST';
      allowedStatuses: number[];
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{ status: number; body: unknown }> {
    if (
      options.body !== undefined &&
      this.scanner.scanText(options.body, '$.request').length > 0
    ) fail('secret_leak_detected');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: 'error',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch { fail('external_unavailable'); }
    if (!options.allowedStatuses.includes(response.status)) {
      await response.body?.cancel();
      fail(source === 'control_plane' ? 'external_unavailable' : 'external_response_invalid');
    }
    if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
      await response.body?.cancel();
      fail('external_response_invalid');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      fail('external_response_invalid');
    }
    let bytes: Uint8Array | null;
    try { bytes = await readBounded(response); }
    catch { fail('external_response_invalid'); }
    if (bytes === null) fail('external_response_invalid');
    const text = new TextDecoder().decode(bytes);
    if (this.scanner.scanText(text, `$.${source}`).length > 0) fail('secret_leak_detected');
    if (text === '' && response.status === 404) return { status: response.status, body: null };
    try { return { status: response.status, body: JSON.parse(text) as unknown }; }
    catch { fail('external_response_invalid'); }
  }
}

export function createWorkflowReadinessBeforeDeploymentSession(
  options: WorkflowHibernateLiveAdapterOptions,
): WorkflowReadinessBeforeDeploymentSession {
  const command = options.command ?? defaultCommand;
  const source = new FrozenSourceAndWranglerAdapter(options, command);
  const http = new LiveHttpAdapter(options);
  const sleep = options.sleep ?? (async (milliseconds: number) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
  let request: WorkflowReadinessBeforeDeploymentRequest | null = null;
  let verification: FrozenWorkerSourceVerification | null = null;
  let deploymentStarted = false;

  return {
    verify: async (input) => {
      if (
        request !== null || !SHA_PATTERN.test(input.sourceSha) ||
        !/^[a-f0-9]{64}$/.test(input.bundleSha256) ||
        !Number.isSafeInteger(input.bundleBytes) || input.bundleBytes < 1 ||
        input.bundleBytes > 10 * 1_024 * 1_024 ||
        !UUID_PATTERN.test(input.expectedCurrentDeploymentId) ||
        !UUID_PATTERN.test(input.expectedCurrentVersionId) ||
        input.message !== `phase1-readiness-before main@${input.sourceSha}`
      ) fail('configuration_invalid');
      const result = await source.verify({ source: { sha: input.sourceSha } });
      if (
        result.bundleSha256 !== input.bundleSha256 ||
        result.bundleBytes !== input.bundleBytes
      ) fail('source_verification_failed');
      request = { ...input };
      verification = result;
      return result;
    },
    readCurrentDeployment: async () => await http.before(),
    deploy: async () => {
      if (request === null || verification === null || deploymentStarted) {
        fail('after_deploy_failed');
      }
      deploymentStarted = true;
      const beforeDeployment = await http.before();
      if (
        beforeDeployment.deploymentId !== request.expectedCurrentDeploymentId ||
        beforeDeployment.versionId !== request.expectedCurrentVersionId ||
        beforeDeployment.trafficPercentage !== 100
      ) fail('before_deployment_mismatch');
      await source.deploy({
        sourceSha: request.sourceSha,
        bundleSha256: request.bundleSha256,
        message: request.message,
        strict: true,
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const afterDeployment = await http.before();
        if (afterDeployment.deploymentId !== beforeDeployment.deploymentId) {
          if (
            afterDeployment.versionId === beforeDeployment.versionId ||
            afterDeployment.trafficPercentage !== 100 ||
            Date.parse(afterDeployment.createdAt) <= Date.parse(beforeDeployment.createdAt)
          ) fail('after_deploy_failed');
          return {
            verification,
            beforeDeployment,
            afterDeployment,
            deploymentAttempts: 1,
          };
        }
        await sleep(500);
      }
      fail('after_deploy_failed');
    },
  };
}

export function createWorkflowHibernateLiveWindowDependencies(
  options: WorkflowHibernateLiveAdapterOptions,
): WorkflowHibernateLiveWindowDependencies {
  const command = options.command ?? defaultCommand;
  const source = new FrozenSourceAndWranglerAdapter(options, command);
  const http = new LiveHttpAdapter(options);
  const sleep = options.sleep ?? (async (milliseconds: number) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
  let authorization: WorkflowHibernateWindowAuthorizationV1 | null = null;
  return {
    verifyFrozenSource: async (input) => {
      authorization = input;
      return await source.verify(input);
    },
    readBeforeDeployment: async () => await http.before(),
    taskExists: async (input) => await http.taskExists(input),
    createTask: async (task, input) => await http.createTask(task, input),
    readSnapshot: async (input) => await http.snapshot(input, await source.snapshotSource()),
    deployAfter: async (request) => {
      const currentTime = (options.now ?? (() => new Date()))().getTime();
      if (
        authorization === null || authorization.task.runId !== request.runId ||
        authorization.beforeDeployment.deploymentId !== request.expectedBeforeDeploymentId ||
        request.message !== `phase1-hibernate-after run@${request.runId}` ||
        !Number.isFinite(currentTime) || currentTime >= Date.parse(authorization.expiresAt)
      ) {
        fail('after_deploy_failed');
      }
      await source.deploy(request);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await http.after(authorization);
        if (result.deployment.deploymentId !== request.expectedBeforeDeploymentId) return result;
        await sleep(500);
      }
      fail('after_deploy_failed');
    },
    sleep,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}
