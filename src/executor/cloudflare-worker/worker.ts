import {
  ContainerProxy as SandboxContainerProxy,
  Sandbox,
  getSandbox,
  type Process,
  type ProcessStatus,
} from '@cloudflare/sandbox';
import { canonicalSha256 } from '../../domain/digest.js';
import { secureStructuredLogSink } from '../../observability/structured-log.js';
import type { ExecutorCancelReason, ExecutorStatus } from '../core/executor-plugin.js';
import {
  CloudflareExecutorBackendError,
  createCloudflareSandboxExecutorHandler,
  sandboxRpcFailure,
  type CloudflareSandboxExecutorBackend,
} from './executor-api.js';
import type {
  CloudflareSandboxProviderFact,
  CloudflareSandboxStartRequest,
  CloudflareSandboxStartResult,
} from './protocol.js';
import {
  CONTROL_PLANE_PROXY_ORIGIN,
  dispatchControlPlaneProxyOverride,
  proxyControlPlaneRequest,
} from './control-plane-proxy.js';
import { providerContainerIdentity, sandboxIdFor } from './sandbox-id.js';
import { sandboxProcessDiagnostic } from './process-diagnostic.js';

const EXECUTION_SPEC_PATH = '/workspace/.delivery-loop/execution.json';
const EXECUTION_GRANT_PATH = '/workspace/.delivery-loop/execution-grant.json';
const EXECUTION_COMMAND =
  '/opt/delivery-agent/bin/run-execution /workspace/.delivery-loop/execution.json';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOOL_BRIDGE_ORIGIN = 'https://tool-bridge.fantacy.live';
const TOOL_BRIDGE_HOST = 'tool-bridge.fantacy.live';
const executorErrorLog = secureStructuredLogSink({
  component: 'agent_executor',
  level: 'error',
});
const executorInfoLog = secureStructuredLogSink({ component: 'agent_executor' });
type EnsureFailureStage =
  | 'binding'
  | 'storage_read'
  | 'storage_initialize'
  | 'network_policy_allowlist'
  | 'network_policy_proxy'
  | 'workspace_prepare'
  | 'process_lookup'
  | 'process_start'
  | 'placement'
  | 'storage_projection';

interface AgentExecutorEnv {
  EXECUTOR_SANDBOX: DurableObjectNamespace<DeliveryAgentSandbox>;
  EXECUTOR_CONTROL_TOKEN?: string;
  EXECUTOR_CALLBACK_TOKEN?: string;
  EXECUTOR_IMAGE_REF?: string;
  EXECUTOR_IMAGE_DIGEST?: string;
  TOOL_BRIDGE_BASE_URL?: string;
  TOOL_BRIDGE_SK?: string;
  TOOL_BRIDGE_SLS_LOGSTORE?: string;
  TOOL_BRIDGE_SLS_ENVIRONMENT?: string;
}

interface StoredExecution {
  schemaVersion: '1';
  requestDigest: string;
  request: CloudflareSandboxStartRequest;
  processId: string;
  containerId: string | null;
  processStatus: ProcessStatus;
  providerStatus: ExecutorStatus;
  statusUpdatedAt: string;
  exitCode: number | null;
  imageDigest: string;
}

type EnsureExecutionResult =
  | { disposition: 'created' | 'existing'; containerId: string }
  | {
      disposition: 'failed';
      errorCode:
        | 'execution_binding_conflict'
        | `sandbox_${EnsureFailureStage}_unavailable`;
    };

function validExecutorConfiguration(env: AgentExecutorEnv): env is AgentExecutorEnv & {
  EXECUTOR_CONTROL_TOKEN: string;
  EXECUTOR_CALLBACK_TOKEN: string;
  EXECUTOR_IMAGE_REF: string;
  EXECUTOR_IMAGE_DIGEST: string;
  TOOL_BRIDGE_BASE_URL: string;
  TOOL_BRIDGE_SK: string;
  TOOL_BRIDGE_SLS_LOGSTORE: string;
  TOOL_BRIDGE_SLS_ENVIRONMENT: 'prod' | 'test';
} {
  return (
    typeof env.EXECUTOR_CONTROL_TOKEN === 'string' &&
    env.EXECUTOR_CONTROL_TOKEN.length >= 16 &&
    typeof env.EXECUTOR_CALLBACK_TOKEN === 'string' &&
    env.EXECUTOR_CALLBACK_TOKEN.length >= 16 &&
    typeof env.EXECUTOR_IMAGE_REF === 'string' &&
    env.EXECUTOR_IMAGE_REF.length > 0 &&
    typeof env.EXECUTOR_IMAGE_DIGEST === 'string' &&
    DIGEST_PATTERN.test(env.EXECUTOR_IMAGE_DIGEST) &&
    env.TOOL_BRIDGE_BASE_URL === TOOL_BRIDGE_ORIGIN &&
    typeof env.TOOL_BRIDGE_SK === 'string' &&
    env.TOOL_BRIDGE_SK.length >= 16 &&
    env.TOOL_BRIDGE_SK.length <= 4_096 &&
    !/[\0\r\n]/.test(env.TOOL_BRIDGE_SK) &&
    typeof env.TOOL_BRIDGE_SLS_LOGSTORE === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(env.TOOL_BRIDGE_SLS_LOGSTORE) &&
    (env.TOOL_BRIDGE_SLS_ENVIRONMENT === 'prod' ||
      env.TOOL_BRIDGE_SLS_ENVIRONMENT === 'test')
  );
}

function providerStatus(process: Process): ExecutorStatus {
  if (process.status === 'starting') return 'queued';
  if (process.status === 'running') return 'running';
  if (process.status === 'killed') return 'cancelled';
  if (process.status === 'completed' && process.exitCode === 0) return 'succeeded';
  return 'failed';
}

function terminal(status: ExecutorStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * One immutable execution per Sandbox Durable Object. Internet is enabled only
 * for the exact Tool Bridge host; the control-plane host remains a Worker proxy.
 */
export class DeliveryAgentSandbox extends Sandbox<AgentExecutorEnv> {
  override enableInternet = true;
  override allowedHosts: string[] = [];

  private async destroyContainer(
    reason: 'ensure_failed' | 'terminal_cancel' | 'terminal_observation',
  ): Promise<void> {
    try {
      await this.destroy();
    } catch {
      executorErrorLog({
        event: 'sandbox_destroy_failed',
        reason,
      });
    }
  }

  static {
    this.outboundHandlers = {
      controlPlaneProxy: proxyControlPlaneRequest,
    };
  }

  async ensureExecution(
    request: CloudflareSandboxStartRequest,
  ): Promise<EnsureExecutionResult> {
    let destroyAfterFailure = false;
    const result: EnsureExecutionResult = await this.ctx.blockConcurrencyWhile(async () => {
      let stage: EnsureFailureStage = 'binding';
      try {
        if (
          this.env.EXECUTOR_IMAGE_REF !== request.imageRef ||
          this.env.EXECUTOR_IMAGE_DIGEST === undefined ||
          !DIGEST_PATTERN.test(this.env.EXECUTOR_IMAGE_DIGEST)
        ) {
          throw new CloudflareExecutorBackendError('execution_binding_conflict');
        }
        stage = 'storage_read';
        const requestDigest = await canonicalSha256(request);
        const existing = await this.ctx.storage.get<StoredExecution>('execution');
        if (existing !== undefined && existing.requestDigest !== requestDigest) {
          throw new CloudflareExecutorBackendError('execution_binding_conflict');
        }
        const created = existing === undefined;
        const now = new Date().toISOString();
        const processId =
          `delivery-agent-${(await canonicalSha256(request.executionId)).slice(7, 31)}`;
        let record: StoredExecution = existing ?? {
          schemaVersion: '1',
          requestDigest,
          request,
          processId,
          containerId: null,
          processStatus: 'starting',
          providerStatus: 'queued',
          statusUpdatedAt: now,
          exitCode: null,
          imageDigest: this.env.EXECUTOR_IMAGE_DIGEST,
        };
        if (created) {
          stage = 'storage_initialize';
          await this.ctx.storage.put('execution', record);
        }
        if (!terminal(record.providerStatus)) {
          const controlPlaneOrigin = new URL(request.controlPlaneUrl).origin;
          stage = 'network_policy_allowlist';
          await this.setAllowedHosts(['control.delivery-loop.internal', TOOL_BRIDGE_HOST]);
          stage = 'network_policy_proxy';
          await this.setOutboundByHost('control.delivery-loop.internal', 'controlPlaneProxy', {
            controlPlaneOrigin,
            executionId: request.executionId,
            attemptId: request.attemptId,
          });
          stage = 'workspace_prepare';
          await this.mkdir('/workspace/.delivery-loop/tmp', { recursive: true });
          await this.writeFile(EXECUTION_SPEC_PATH, JSON.stringify(request));
          await this.writeFile(EXECUTION_GRANT_PATH, JSON.stringify({
            schemaVersion: '1',
            identityKind: 'cloudflare_sandbox_proxy',
            executionId: request.executionId,
            attemptId: request.attemptId,
            controlPlaneUrl: CONTROL_PLANE_PROXY_ORIGIN,
          }));
          stage = 'process_lookup';
          let process = await this.getProcess(processId);
          if (process === null) {
            stage = 'process_start';
            process = await this.startProcess(EXECUTION_COMMAND, {
              processId,
              autoCleanup: false,
              cwd: '/workspace',
              env: {
                DELIVERY_TOOL_BRIDGE_BASE_URL: this.env.TOOL_BRIDGE_BASE_URL,
                DELIVERY_TOOL_BRIDGE_SK: this.env.TOOL_BRIDGE_SK,
                DELIVERY_TOOL_BRIDGE_SLS_LOGSTORE: this.env.TOOL_BRIDGE_SLS_LOGSTORE,
                DELIVERY_TOOL_BRIDGE_SLS_ENVIRONMENT: this.env.TOOL_BRIDGE_SLS_ENVIRONMENT,
              },
            });
          }
          stage = 'placement';
          const placement = await this.getContainerPlacementId();
          const containerId = providerContainerIdentity(this.ctx.id.toString(), placement);
          record = {
            ...record,
            containerId,
            processStatus: process.status,
            providerStatus: providerStatus(process),
            statusUpdatedAt: record.processStatus === process.status
              ? record.statusUpdatedAt
              : now,
            exitCode: process.exitCode ?? null,
          };
          stage = 'storage_projection';
          await this.ctx.storage.put('execution', record);
        }
        if (record.containerId === null) {
          stage = 'placement';
          throw new Error('container placement unavailable');
        }
        return {
          disposition: created ? 'created' : 'existing',
          containerId: record.containerId,
        };
      } catch (cause) {
        executorErrorLog({
          event: 'sandbox_ensure_failed',
          stage,
        });
        if (
          cause instanceof CloudflareExecutorBackendError &&
          cause.code === 'execution_binding_conflict'
        ) {
          return { disposition: 'failed', errorCode: cause.code };
        }
        destroyAfterFailure = true;
        return {
          disposition: 'failed',
          errorCode: `sandbox_${stage}_unavailable`,
        };
      }
    });
    if (destroyAfterFailure) await this.destroyContainer('ensure_failed');
    return result;
  }

  async observeExecution(): Promise<CloudflareSandboxProviderFact> {
    const fact = await this.ctx.blockConcurrencyWhile(async () => {
      let record = await this.ctx.storage.get<StoredExecution>('execution');
      if (record === undefined) {
        throw new CloudflareExecutorBackendError('execution_not_found');
      }
      let process: Process | null = null;
      if (!terminal(record.providerStatus)) {
        process = await this.getProcess(record.processId);
        if (process === null) {
          throw new CloudflareExecutorBackendError('execution_not_started');
        }
        const nextStatus = providerStatus(process);
        if (nextStatus !== record.providerStatus || process.status !== record.processStatus) {
          record = {
            ...record,
            processStatus: process.status,
            providerStatus: nextStatus,
            statusUpdatedAt: new Date().toISOString(),
            exitCode: process.exitCode ?? null,
          };
          await this.ctx.storage.put('execution', record);
        }
      }
      if (record.providerStatus === 'failed') {
        process ??= await this.getProcess(record.processId);
        try {
          const diagnostic = process === null
            ? null
            : sandboxProcessDiagnostic((await process.getLogs()).stderr);
          executorErrorLog({
            event: 'sandbox_process_failed',
            diagnostic,
          });
        } catch {
          executorErrorLog({
            event: 'sandbox_process_failed',
            diagnostic: null,
          });
        }
      }
      return {
        status: record.providerStatus,
        externalUpdatedAt: record.statusUpdatedAt,
        exitCode: record.exitCode,
        imageDigest: record.imageDigest,
      };
    });
    if (terminal(fact.status)) await this.destroyContainer('terminal_observation');
    return fact;
  }

  async cancelExecution(
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    void reason;
    const disposition = await this.ctx.blockConcurrencyWhile(async () => {
      let record = await this.ctx.storage.get<StoredExecution>('execution');
      if (record === undefined) {
        return 'already_terminal';
      }
      if (terminal(record.providerStatus)) return 'already_terminal';
      const process = await this.getProcess(record.processId);
      if (process !== null) await this.killProcess(record.processId, 'SIGTERM');
      record = {
        ...record,
        processStatus: 'killed',
        providerStatus: 'cancelled',
        statusUpdatedAt: new Date().toISOString(),
        exitCode: null,
      };
      await this.ctx.storage.put('execution', record);
      return 'cancelled';
    });
    await this.destroyContainer('terminal_cancel');
    return disposition;
  }
}

class SandboxBackend implements CloudflareSandboxExecutorBackend {
  constructor(private readonly env: AgentExecutorEnv) {}

  async ensure(request: CloudflareSandboxStartRequest): Promise<CloudflareSandboxStartResult> {
    const sandboxId = await sandboxIdFor(request.executionId);
    try {
      const sandbox = getSandbox(this.env.EXECUTOR_SANDBOX, sandboxId, {
        keepAlive: true,
        enableDefaultSession: false,
        normalizeId: true,
        labels: {
          execution: request.executionId.slice(0, 63),
          role: request.role,
        },
      });
      const result = await sandbox.ensureExecution(request);
      if (result.disposition === 'failed') {
        throw new CloudflareExecutorBackendError(result.errorCode);
      }
      return { ...result, sandboxId };
    } catch (cause) {
      throw sandboxRpcFailure(cause);
    }
  }

  async observe(sandboxId: string): Promise<CloudflareSandboxProviderFact> {
    return await getSandbox(
      this.env.EXECUTOR_SANDBOX,
      sandboxId,
      { keepAlive: true, enableDefaultSession: false, normalizeId: true },
    ).observeExecution();
  }

  async cancel(
    sandboxId: string,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    return await getSandbox(
      this.env.EXECUTOR_SANDBOX,
      sandboxId,
      { keepAlive: true, enableDefaultSession: false, normalizeId: true },
    ).cancelExecution(reason);
  }
}

/** Directly resolves the trusted override because SDK handler registries are isolate-local. */
export class ContainerProxy extends SandboxContainerProxy {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === new URL(CONTROL_PLANE_PROXY_ORIGIN).hostname) {
      executorInfoLog({
        event: 'control_plane_proxy_request',
      });
    }
    return await dispatchControlPlaneProxyOverride(
      request,
      this.env,
      this.ctx.props,
      async () => await super.fetch(request),
    );
  }
}

export default {
  async fetch(request: Request, env: AgentExecutorEnv): Promise<Response> {
    if (!validExecutorConfiguration(env)) {
      if (new URL(request.url).pathname === '/healthz') {
        return Response.json(
          { ok: false, service: 'delivery-loop-agent-executor', code: 'unconfigured' },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        );
      }
      return Response.json(
        { error: { code: 'executor_unconfigured' } },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
    return await createCloudflareSandboxExecutorHandler({
      controlToken: env.EXECUTOR_CONTROL_TOKEN,
      configuredImageRef: env.EXECUTOR_IMAGE_REF,
      backend: new SandboxBackend(env),
    }).fetch(request);
  },
};
