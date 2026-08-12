import { testDeploymentTargetsFromJson } from '../domain/test-deployment.js';
import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from '../reconciliation/github-run-reconciliation-runtime.js';
import {
  GitHubTestDeploymentStatusApiClient,
  GitHubTestDeploymentStatusReconciler,
} from '../reconciliation/github-test-deployment-status-reconciler.js';
import { TestDeploymentReconciler } from '../reconciliation/test-deployment-reconciler.js';
import {
  GitHubTestDeploymentApiClient,
  TestDeploymentOutboxProcessor,
} from './github-test-deployment.js';
import { YunxiaoTestDeploymentClient, YunxiaoTestDeploymentStatusClient } from './yunxiao-test-deployment.js';
import { toolBridgeClientFromEnv } from '../tools/tool-bridge-client.js';

export interface GitHubTestDeploymentRuntime {
  client: GitHubTestDeploymentApiClient | YunxiaoTestDeploymentClient;
  processor: TestDeploymentOutboxProcessor;
  destination: 'github_deployments' | 'yunxiao_pipelines';
  reconciler: TestDeploymentReconciler;
  statusReconciler: GitHubTestDeploymentStatusReconciler;
}

export function githubTestDeploymentRuntimeFromEnv(
  env: Bindings,
): GitHubTestDeploymentRuntime | null {
  if (env.TEST_DEPLOY_TARGETS_JSON === undefined) return null;
  const github = githubActionsRuntimeFromEnv(env);
  if (env.TEST_DEPLOY_TARGETS_JSON.trim() === '[]' && github === null) {
    throw new Error('test deployment configuration is incomplete');
  }
  const targets = testDeploymentTargetsFromJson(env.TEST_DEPLOY_TARGETS_JSON);
  const allowed = new Set(github?.allowedRepositories ?? []);
  if ([...targets.keys()].some((repository) => !allowed.has(repository))) {
    const yunxiaoOnly = [...targets.values()].every((target) => target.provider === 'yunxiao_pipeline');
    if (!yunxiaoOnly) throw new Error('test deployment configuration is invalid');
  }
  const target = [...targets.values()][0];
  if (target === undefined) throw new Error('test deployment configuration is invalid');
  const isYunxiao = target.provider === 'yunxiao_pipeline';
  if ([...targets.values()].some((candidate) => candidate.provider !== target.provider)) {
    throw new Error('mixed test deployment providers are not supported');
  }
  if (isYunxiao && targets.size !== 1) {
    throw new Error('Yunxiao test deployment requires exactly one target');
  }
  const bridge = toolBridgeClientFromEnv(env);
  if (isYunxiao && bridge === null) throw new Error('Yunxiao test deployment configuration is incomplete');
  if (!isYunxiao && github === null) throw new Error('test deployment configuration is incomplete');
  const client = isYunxiao
    ? new YunxiaoTestDeploymentClient(bridge!, target.organizationId!, target.pipelineId!)
    : new GitHubTestDeploymentApiClient(github!.provider, {
      ...(env.GITHUB_API_BASE_URL === undefined ? {} : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
    });
  return {
    client,
    destination: isYunxiao ? 'yunxiao_pipelines' : 'github_deployments',
    processor: new TestDeploymentOutboxProcessor(env.DB_CONTROL, client, {
      destination: isYunxiao ? 'yunxiao_pipelines' : 'github_deployments',
    }),
    reconciler: new TestDeploymentReconciler(env.DB_CONTROL, targets),
    statusReconciler: new GitHubTestDeploymentStatusReconciler(
      env.DB_CONTROL,
      isYunxiao
        ? new YunxiaoTestDeploymentStatusClient(
          bridge!, target.organizationId!, target.pipelineId!, target.repositoryUrl!,
        )
        : new GitHubTestDeploymentStatusApiClient(github!.provider, {
        ...(env.GITHUB_API_BASE_URL === undefined
          ? {}
          : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
          }),
    ),
  };
}

export async function reconcileTestDeploymentsFromEnv(env: Bindings): Promise<unknown[]> {
  const runtime = githubTestDeploymentRuntimeFromEnv(env);
  if (runtime === null) return [];
  const [scheduled, observed] = await Promise.all([
    runtime.reconciler.reconcileBatch(25),
    runtime.statusReconciler.reconcileBatch(25),
  ]);
  return [...scheduled, ...observed];
}
