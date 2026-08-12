import type {
  GitHubTestDeploymentEffects,
  GitHubTestDeploymentRequest,
  GitHubTestDeploymentResult,
} from './github-test-deployment.js';
import type {
  GitHubTestDeploymentStatusExternalFactClient,
  GitHubTestDeploymentStatusRequest,
} from '../reconciliation/github-test-deployment-status-reconciler.js';
import type { GitHubTestDeploymentStatusFact } from '../storage/github-test-deployment-status-store.js';
import type { ToolBridgeClient } from '../tools/tool-bridge-client.js';

const ORGANIZATION_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const PIPELINE_PATTERN = /^[0-9]{1,32}$/;
const SOURCE_REF_PATTERN = /^(?!.*(?:\.\.|\/\/))[A-Za-z0-9._/-]{1,240}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_RESULT_STRING_BYTES = 256 * 1024;

function assertConfig(organizationId: string, pipelineId: string): void {
  if (!ORGANIZATION_PATTERN.test(organizationId) || !PIPELINE_PATTERN.test(pipelineId)) {
    throw new Error('Yunxiao test deployment configuration is invalid');
  }
}

function stringId(value: unknown): string | null {
  if (typeof value === 'string' && PIPELINE_PATTERN.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function resultObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (new TextEncoder().encode(value).byteLength > MAX_RESULT_STRING_BYTES) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalizedRepositoryUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || !url.pathname.endsWith('.git')
  ) return null;
  return `${url.origin}${url.pathname}`.toLowerCase();
}

function parseStructuredString(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > MAX_RESULT_STRING_BYTES) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function explicitCommitCandidates(body: Record<string, unknown>, repositoryUrl: string): string[] {
  const candidates: string[] = [];
  const globals = Array.isArray(body.globalParams) ? body.globalParams : [];
  for (const item of globals) {
    const parameter = resultObject(item);
    if (
      parameter !== null &&
      (parameter.key === 'CI_COMMIT_SHA' || parameter.key === 'CI_COMMIT_SHA_1') &&
      typeof parameter.value === 'string' && SHA_PATTERN.test(parameter.value.toLowerCase())
    ) candidates.push(parameter.value.toLowerCase());
  }

  const expectedRepositoryUrl = normalizedRepositoryUrl(repositoryUrl);
  const sources = Array.isArray(body.sources) ? body.sources : [];
  for (const source of sources) {
    const data = resultObject(resultObject(source)?.data);
    if (data === null || normalizedRepositoryUrl(String(data.repo ?? '')) !== expectedRepositoryUrl) continue;
    if (typeof data.commitId === 'string' && SHA_PATTERN.test(data.commitId.toLowerCase())) {
      candidates.push(data.commitId.toLowerCase());
    }
    const commits = parseStructuredString(data.commit);
    if (!Array.isArray(commits)) continue;
    const first = resultObject(commits[0]);
    if (typeof first?.commitId === 'string' && SHA_PATTERN.test(first.commitId.toLowerCase())) {
      candidates.push(first.commitId.toLowerCase());
    }
  }
  return [...new Set(candidates)];
}

function globalParameter(body: Record<string, unknown>, key: string): string | null {
  const globals = Array.isArray(body.globalParams) ? body.globalParams : [];
  for (const item of globals) {
    const parameter = resultObject(item);
    if (parameter?.key === key && typeof parameter.value === 'string') return parameter.value;
  }
  return null;
}

function deploymentIdentityMatches(body: Record<string, unknown>, deploymentId: string): boolean {
  const expected = `delivery-loop test deployment ${deploymentId}`;
  return [
    globalParameter(body, 'DELIVERY_LOOP_DEPLOYMENT_ID'),
    globalParameter(body, 'BUILD_REMARK'),
    globalParameter(body, 'FLOW_INST_RUNNING_COMMENT'),
    typeof body.comment === 'string' ? body.comment : null,
    typeof body.description === 'string' ? body.description : null,
  ].some((value) => value === deploymentId || value === expected);
}

function observedCommitMatches(
  body: Record<string, unknown>,
  repositoryUrl: string,
  expectedSha: string,
): boolean {
  const candidates = explicitCommitCandidates(body, repositoryUrl);
  return candidates.length > 0 && candidates.every((candidate) => candidate === expectedSha);
}

function normalizedTime(raw: unknown, fallback: Date): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) {
    return new Date(raw).toISOString();
  }
  return fallback.toISOString();
}

function validRequest(request: GitHubTestDeploymentRequest): request is GitHubTestDeploymentRequest & {
  sourceRef: string;
  repositoryUrl: string;
} {
  return SHA_PATTERN.test(request.refSha) &&
    typeof request.sourceRef === 'string' && SOURCE_REF_PATTERN.test(request.sourceRef) &&
    typeof request.repositoryUrl === 'string' && normalizedRepositoryUrl(request.repositoryUrl) !== null;
}

/** Tool Bridge adapter for the control-plane-owned Yunxiao test deployment effect. */
export class YunxiaoTestDeploymentClient implements GitHubTestDeploymentEffects {
  constructor(
    private readonly toolBridge: ToolBridgeClient,
    private readonly organizationId: string,
    private readonly pipelineId: string,
  ) { assertConfig(organizationId, pipelineId); }

  async ensureTestDeployment(request: GitHubTestDeploymentRequest): Promise<GitHubTestDeploymentResult> {
    if (!validRequest(request)) throw new Error('Yunxiao test deployment request is invalid');
    // create_pipeline_run has no idempotency key or exact comment filter. If the
    // create response was lost, reconcile the recent run inventory by the stable
    // deployment ID and exact source before deciding whether the write is uncertain.
    if ((request.deliveryAttempt ?? 1) !== 1) {
      const existing = await this.findExisting(request);
      if (existing !== null) {
        return { disposition: 'existing', githubDeploymentId: existing };
      }
      throw new Error('Yunxiao pipeline create outcome is uncertain');
    }
    const result = await this.toolBridge.call({
      traceId: `yunxiao-test-deploy-${request.deploymentId}`,
      runId: request.runId ?? request.deploymentId,
      attemptId: request.attemptId ?? request.deploymentId,
      toolPath: 'mcp/yunxiao/create_pipeline_run',
      arguments: {
        organizationId: this.organizationId,
        pipelineId: this.pipelineId,
        branch: request.sourceRef,
        repositories: [{ url: request.repositoryUrl, branch: request.sourceRef }],
        environmentVariables: {
          DELIVERY_LOOP_DEPLOYMENT_ID: request.deploymentId,
          DELIVERY_LOOP_COMMIT_SHA: request.refSha,
        },
        comment: `delivery-loop test deployment ${request.deploymentId}`,
      },
    });
    if (!result.ok) throw new Error(`Yunxiao pipeline unavailable: ${result.category}`);
    const body = resultObject(unwrapResult(result.result));
    const runId = stringId(body?.pipelineRunId ?? body?.runId ?? body?.id);
    if (runId === null) throw new Error('Yunxiao pipeline response is invalid');
    return { disposition: 'created', githubDeploymentId: runId };
  }

  private async findExisting(request: GitHubTestDeploymentRequest & {
    sourceRef: string;
    repositoryUrl: string;
  }): Promise<string | null> {
    const listed = await this.toolBridge.call({
      traceId: `yunxiao-test-reconcile-${request.deploymentId}`,
      runId: request.runId ?? request.deploymentId,
      attemptId: request.attemptId ?? request.deploymentId,
      toolPath: 'mcp/yunxiao/list_pipeline_runs',
      arguments: {
        organizationId: this.organizationId,
        pipelineId: this.pipelineId,
        perPage: 10,
        page: 1,
      },
    });
    if (!listed.ok) throw new Error(`Yunxiao pipeline reconciliation unavailable: ${listed.category}`);
    const listBody = resultObject(unwrapResult(listed.result));
    if (listBody === null || !Array.isArray(listBody.items) || listBody.items.length > 10) {
      throw new Error('Yunxiao pipeline reconciliation response is invalid');
    }
    const runIds = listBody.items.map((item) => stringId(resultObject(item)?.pipelineRunId));
    if (runIds.some((runId) => runId === null)) {
      throw new Error('Yunxiao pipeline reconciliation response is invalid');
    }
    for (const runId of runIds as string[]) {
      const detail = await this.toolBridge.call({
        traceId: `yunxiao-test-reconcile-${request.deploymentId}`,
        runId: request.runId ?? request.deploymentId,
        attemptId: request.attemptId ?? request.deploymentId,
        toolPath: 'mcp/yunxiao/get_pipeline_run',
        arguments: {
          organizationId: this.organizationId,
          pipelineId: this.pipelineId,
          pipelineRunId: runId,
        },
      });
      if (!detail.ok) throw new Error(`Yunxiao pipeline reconciliation unavailable: ${detail.category}`);
      const body = resultObject(unwrapResult(detail.result));
      if (
        body === null || stringId(body.pipelineId) !== this.pipelineId ||
        stringId(body.pipelineRunId) !== runId
      ) throw new Error('Yunxiao pipeline reconciliation response is invalid');
      if (
        deploymentIdentityMatches(body, request.deploymentId) &&
        observedCommitMatches(body, request.repositoryUrl, request.refSha)
      ) return runId;
    }
    return null;
  }
}

/** Read-only Yunxiao pipeline status adapter, normalized to the deployment fact. */
export class YunxiaoTestDeploymentStatusClient implements GitHubTestDeploymentStatusExternalFactClient {
  constructor(
    private readonly toolBridge: ToolBridgeClient,
    private readonly organizationId: string,
    private readonly pipelineId: string,
    private readonly repositoryUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    assertConfig(organizationId, pipelineId);
    if (normalizedRepositoryUrl(repositoryUrl) === null) {
      throw new Error('Yunxiao test deployment configuration is invalid');
    }
  }

  async getTestDeploymentStatus(request: GitHubTestDeploymentStatusRequest): Promise<GitHubTestDeploymentStatusFact | null> {
    const result = await this.toolBridge.call({
      traceId: `yunxiao-test-status-${request.deploymentId}`,
      runId: request.deploymentId,
      attemptId: request.deploymentId,
      toolPath: 'mcp/yunxiao/get_pipeline_run',
      arguments: {
        organizationId: this.organizationId,
        pipelineId: this.pipelineId,
        pipelineRunId: request.githubDeploymentId,
      },
    });
    if (!result.ok) throw new Error(`Yunxiao pipeline status unavailable: ${result.category}`);
    const body = resultObject(unwrapResult(result.result));
    if (
      body === null || stringId(body.pipelineId) !== this.pipelineId ||
      stringId(body.pipelineRunId) !== request.githubDeploymentId
    ) throw new Error('Yunxiao pipeline status response is invalid');

    const rawStatus = String(body.status ?? body.state ?? '').toUpperCase();
    const observedExactCommit = observedCommitMatches(body, this.repositoryUrl, request.refSha);
    const state: GitHubTestDeploymentStatusFact['state'] =
      rawStatus === 'SUCCESS' || rawStatus === 'SUCCEEDED'
        ? observedExactCommit ? 'success' : 'failure'
        : rawStatus === 'FAIL' || rawStatus === 'FAILED' || rawStatus === 'ERROR'
          ? 'failure'
          : 'in_progress';
    return {
      repository: request.repository,
      githubDeploymentId: request.githubDeploymentId,
      deploymentId: request.deploymentId,
      sha: request.refSha,
      task: 'delivery-loop:test',
      environment: 'test',
      state,
      environmentUrl: null,
      externalUpdatedAt: normalizedTime(body.endTime ?? body.updateTime, this.now()),
    };
  }
}
