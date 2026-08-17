import {
  ContainerProxy,
  Sandbox,
  getSandbox,
  type Process,
  type ProcessStatus,
} from '@cloudflare/sandbox';
import { canonicalSha256 } from '../../domain/digest.js';
import type { ExecutorCancelReason, ExecutorStatus } from '../core/executor-plugin.js';
import {
  CloudflareExecutorBackendError,
  createCloudflareSandboxExecutorHandler,
  type CloudflareSandboxExecutorBackend,
} from './executor-api.js';
import type {
  CloudflareSandboxProviderFact,
  CloudflareSandboxStartRequest,
  CloudflareSandboxStartResult,
} from './protocol.js';
import {
  CONTROL_PLANE_PROXY_ORIGIN,
  proxyControlPlaneRequest,
} from './control-plane-proxy.js';

const EXECUTION_SPEC_PATH = '/workspace/.delivery-loop/execution.json';
const EXECUTION_GRANT_PATH = '/workspace/.delivery-loop/execution-grant.json';
const EXECUTION_COMMAND =
  '/opt/delivery-agent/bin/run-execution /workspace/.delivery-loop/execution.json';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface AgentExecutorEnv {
  EXECUTOR_SANDBOX: DurableObjectNamespace<DeliveryAgentSandbox>;
  EXECUTOR_CONTROL_TOKEN?: string;
  EXECUTOR_CALLBACK_TOKEN?: string;
  EXECUTOR_IMAGE_REF?: string;
  EXECUTOR_IMAGE_DIGEST?: string;
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

function validExecutorConfiguration(env: AgentExecutorEnv): env is AgentExecutorEnv & {
  EXECUTOR_CONTROL_TOKEN: string;
  EXECUTOR_CALLBACK_TOKEN: string;
  EXECUTOR_IMAGE_REF: string;
  EXECUTOR_IMAGE_DIGEST: string;
} {
  return (
    typeof env.EXECUTOR_CONTROL_TOKEN === 'string' &&
    env.EXECUTOR_CONTROL_TOKEN.length >= 16 &&
    typeof env.EXECUTOR_CALLBACK_TOKEN === 'string' &&
    env.EXECUTOR_CALLBACK_TOKEN.length >= 16 &&
    typeof env.EXECUTOR_IMAGE_REF === 'string' &&
    env.EXECUTOR_IMAGE_REF.length > 0 &&
    typeof env.EXECUTOR_IMAGE_DIGEST === 'string' &&
    DIGEST_PATTERN.test(env.EXECUTOR_IMAGE_DIGEST)
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
 * One immutable execution per Sandbox Durable Object. Internet is disabled;
 * only the exact control-plane host is intercepted by the trusted Worker.
 */
export class DeliveryAgentSandbox extends Sandbox<AgentExecutorEnv> {
  override enableInternet = false;
  override allowedHosts: string[] = [];

  static override outboundHandlers = {
    controlPlaneProxy: proxyControlPlaneRequest,
  };

  async ensureExecution(
    request: CloudflareSandboxStartRequest,
  ): Promise<{ disposition: 'created' | 'existing'; containerId: string }> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      if (
        this.env.EXECUTOR_IMAGE_REF !== request.imageRef ||
        this.env.EXECUTOR_IMAGE_DIGEST === undefined ||
        !DIGEST_PATTERN.test(this.env.EXECUTOR_IMAGE_DIGEST)
      ) {
        throw new CloudflareExecutorBackendError('execution_binding_conflict');
      }
      const requestDigest = await canonicalSha256(request);
      const existing = await this.ctx.storage.get<StoredExecution>('execution');
      if (existing !== undefined && existing.requestDigest !== requestDigest) {
        throw new CloudflareExecutorBackendError('execution_binding_conflict');
      }
      const created = existing === undefined;
      const now = new Date().toISOString();
      const processId = `delivery-agent-${(await canonicalSha256(request.executionId)).slice(7, 31)}`;
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
      if (created) await this.ctx.storage.put('execution', record);
      if (!terminal(record.providerStatus)) {
        const controlPlaneOrigin = new URL(request.controlPlaneUrl).origin;
        await this.setAllowedHosts([]);
        await this.setOutboundByHost('control.delivery-loop.internal', 'controlPlaneProxy', {
          controlPlaneOrigin,
          executionId: request.executionId,
          attemptId: request.attemptId,
        });
        await this.mkdir('/workspace/.delivery-loop', { recursive: true });
        await this.writeFile(EXECUTION_SPEC_PATH, JSON.stringify(request));
        await this.writeFile(EXECUTION_GRANT_PATH, JSON.stringify({
          schemaVersion: '1',
          identityKind: 'cloudflare_sandbox_proxy',
          executionId: request.executionId,
          attemptId: request.attemptId,
          controlPlaneUrl: CONTROL_PLANE_PROXY_ORIGIN,
        }));
        let process = await this.getProcess(processId);
        if (process === null) {
          process = await this.startProcess(EXECUTION_COMMAND, {
            processId,
            autoCleanup: false,
            cwd: '/workspace',
          });
        }
        const placement = await this.getContainerPlacementId();
        if (typeof placement !== 'string' || placement.length === 0) {
          throw new Error('container placement unavailable');
        }
        record = {
          ...record,
          containerId: placement,
          processStatus: process.status,
          providerStatus: providerStatus(process),
          statusUpdatedAt: record.processStatus === process.status
            ? record.statusUpdatedAt
            : now,
          exitCode: process.exitCode ?? null,
        };
        await this.ctx.storage.put('execution', record);
      }
      if (record.containerId === null) {
        throw new Error('container placement unavailable');
      }
      return {
        disposition: created ? 'created' : 'existing',
        containerId: record.containerId,
      };
    });
  }

  async observeExecution(): Promise<CloudflareSandboxProviderFact> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      let record = await this.ctx.storage.get<StoredExecution>('execution');
      if (record === undefined) {
        throw new CloudflareExecutorBackendError('execution_not_found');
      }
      if (!terminal(record.providerStatus)) {
        const process = await this.getProcess(record.processId);
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
      return {
        status: record.providerStatus,
        externalUpdatedAt: record.statusUpdatedAt,
        exitCode: record.exitCode,
        imageDigest: record.imageDigest,
      };
    });
  }

  async cancelExecution(
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    void reason;
    return await this.ctx.blockConcurrencyWhile(async () => {
      let record = await this.ctx.storage.get<StoredExecution>('execution');
      if (record === undefined) {
        throw new CloudflareExecutorBackendError('execution_not_found');
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
      await this.destroy();
      return 'cancelled';
    });
  }
}

async function sandboxIdFor(executionId: string): Promise<string> {
  return `executor-${(await canonicalSha256(executionId)).slice(7)}`;
}

class SandboxBackend implements CloudflareSandboxExecutorBackend {
  constructor(private readonly env: AgentExecutorEnv) {}

  async ensure(request: CloudflareSandboxStartRequest): Promise<CloudflareSandboxStartResult> {
    const sandboxId = await sandboxIdFor(request.executionId);
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
    return { ...result, sandboxId };
  }

  async observe(executionId: string): Promise<CloudflareSandboxProviderFact> {
    return await getSandbox(
      this.env.EXECUTOR_SANDBOX,
      await sandboxIdFor(executionId),
      { keepAlive: true, enableDefaultSession: false, normalizeId: true },
    ).observeExecution();
  }

  async cancel(
    executionId: string,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    return await getSandbox(
      this.env.EXECUTOR_SANDBOX,
      await sandboxIdFor(executionId),
      { keepAlive: true, enableDefaultSession: false, normalizeId: true },
    ).cancelExecution(reason);
  }
}

export { ContainerProxy };

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
