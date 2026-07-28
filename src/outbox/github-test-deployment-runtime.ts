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

export interface GitHubTestDeploymentRuntime {
  client: GitHubTestDeploymentApiClient;
  processor: TestDeploymentOutboxProcessor;
  reconciler: TestDeploymentReconciler;
  statusReconciler: GitHubTestDeploymentStatusReconciler;
}

export function githubTestDeploymentRuntimeFromEnv(
  env: Bindings,
): GitHubTestDeploymentRuntime | null {
  if (env.TEST_DEPLOY_TARGETS_JSON === undefined) return null;
  const github = githubActionsRuntimeFromEnv(env);
  if (github === null) {
    throw new Error('test deployment configuration is incomplete');
  }
  const targets = testDeploymentTargetsFromJson(env.TEST_DEPLOY_TARGETS_JSON);
  const allowed = new Set(github.allowedRepositories);
  if ([...targets.keys()].some((repository) => !allowed.has(repository))) {
    throw new Error('test deployment configuration is invalid');
  }
  const client = new GitHubTestDeploymentApiClient(github.provider, {
    ...(env.GITHUB_API_BASE_URL === undefined ? {} : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
  });
  return {
    client,
    processor: new TestDeploymentOutboxProcessor(env.DB_CONTROL, client),
    reconciler: new TestDeploymentReconciler(env.DB_CONTROL, targets),
    statusReconciler: new GitHubTestDeploymentStatusReconciler(
      env.DB_CONTROL,
      new GitHubTestDeploymentStatusApiClient(github.provider, {
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
