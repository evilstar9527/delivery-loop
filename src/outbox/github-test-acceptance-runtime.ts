import { testDeploymentTargetsFromJson } from '../domain/test-deployment.js';
import type { Bindings } from '../env.js';
import {
  GitHubTestAcceptanceRunReconciler,
} from '../reconciliation/github-test-acceptance-run-reconciler.js';
import { githubActionsRuntimeFromEnv } from '../reconciliation/github-run-reconciliation-runtime.js';
import { TestAcceptanceReconciler } from '../reconciliation/test-acceptance-reconciler.js';
import { TestAcceptanceOutboxProcessor } from './github-test-acceptance.js';

export interface GitHubTestAcceptanceRuntime {
  processor: TestAcceptanceOutboxProcessor;
  scheduler: TestAcceptanceReconciler;
  runReconciler: GitHubTestAcceptanceRunReconciler;
}

export function githubTestAcceptanceRuntimeFromEnv(
  env: Bindings,
): GitHubTestAcceptanceRuntime | null {
  if (env.TEST_DEPLOY_TARGETS_JSON === undefined) return null;
  if (env.CONTROL_PLANE_URL === undefined) {
    throw new Error('test acceptance configuration is incomplete');
  }
  const github = githubActionsRuntimeFromEnv(env);
  if (github === null) throw new Error('test acceptance configuration is incomplete');
  const targets = testDeploymentTargetsFromJson(env.TEST_DEPLOY_TARGETS_JSON);
  const repositories = [...targets.keys()];
  const githubAllowed = new Set(github.allowedRepositories);
  if (repositories.some((repository) => !githubAllowed.has(repository))) {
    throw new Error('test acceptance configuration is invalid');
  }
  const allowedRepositories = new Set(repositories);
  return {
    processor: new TestAcceptanceOutboxProcessor(env.DB_CONTROL, github.client, {
      allowedRepositories: repositories,
      controlPlaneUrl: env.CONTROL_PLANE_URL,
    }),
    scheduler: new TestAcceptanceReconciler(
      env.DB_CONTROL,
      () => new Date(),
      allowedRepositories,
    ),
    runReconciler: new GitHubTestAcceptanceRunReconciler(env.DB_CONTROL, {
      getWorkflowRun: async (repository, githubRunId) =>
        await github.client.getAcceptanceWorkflowRun(repository, githubRunId),
    }),
  };
}

export async function reconcileTestAcceptancesFromEnv(env: Bindings): Promise<unknown[]> {
  const runtime = githubTestAcceptanceRuntimeFromEnv(env);
  if (runtime === null) return [];
  const [scheduled, observed] = await Promise.all([
    runtime.scheduler.reconcileBatch(25),
    runtime.runReconciler.reconcileBatch(25),
  ]);
  return [...scheduled, ...observed];
}
