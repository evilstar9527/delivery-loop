import { testDeploymentTargetsFromJson } from '../domain/test-deployment.js';
import type { Bindings } from '../env.js';
import {
  GitHubTestRollbackRunReconciler,
} from '../reconciliation/github-test-rollback-run-reconciler.js';
import { githubActionsRuntimeFromEnv } from '../reconciliation/github-run-reconciliation-runtime.js';
import {
  GitHubDeliveryPolicyApiClient,
  TestRollbackReconciler,
} from '../reconciliation/test-rollback-reconciler.js';
import { TestRollbackOutboxProcessor } from './github-test-rollback.js';

export interface GitHubTestRollbackRuntime {
  processor: TestRollbackOutboxProcessor;
  scheduler: TestRollbackReconciler;
  runReconciler: GitHubTestRollbackRunReconciler;
}

export function githubTestRollbackRuntimeFromEnv(
  env: Bindings,
): GitHubTestRollbackRuntime | null {
  if (env.TEST_DEPLOY_TARGETS_JSON === undefined) return null;
  if (env.CONTROL_PLANE_URL === undefined) {
    throw new Error('test rollback configuration is incomplete');
  }
  const github = githubActionsRuntimeFromEnv(env);
  if (github === null) throw new Error('test rollback configuration is incomplete');
  const targets = testDeploymentTargetsFromJson(env.TEST_DEPLOY_TARGETS_JSON);
  const repositories = [...targets.keys()];
  const githubAllowed = new Set(github.allowedRepositories);
  if (repositories.some((repository) => !githubAllowed.has(repository))) {
    throw new Error('test rollback configuration is invalid');
  }
  const allowedRepositories = new Set(repositories);
  const policyClient = new GitHubDeliveryPolicyApiClient(github.provider, {
    ...(env.GITHUB_API_BASE_URL === undefined ? {} : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
  });
  return {
    processor: new TestRollbackOutboxProcessor(env.DB_CONTROL, github.client, {
      allowedRepositories: repositories,
      controlPlaneUrl: env.CONTROL_PLANE_URL,
    }),
    scheduler: new TestRollbackReconciler(
      env.DB_CONTROL,
      policyClient,
      allowedRepositories,
    ),
    runReconciler: new GitHubTestRollbackRunReconciler(env.DB_CONTROL, github.client),
  };
}

export async function reconcileTestRollbacksFromEnv(env: Bindings): Promise<unknown[]> {
  const runtime = githubTestRollbackRuntimeFromEnv(env);
  if (runtime === null) return [];
  const [scheduled, observed] = await Promise.all([
    runtime.scheduler.reconcileBatch(25),
    runtime.runReconciler.reconcileBatch(25),
  ]);
  return [...scheduled, ...observed];
}

