import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from './github-run-reconciliation-runtime.js';
import {
  GitHubProductionDeploymentStatusApiClient,
  GitHubProductionDeploymentStatusReconciler,
  type GitHubProductionDeploymentStatusBatchResult,
} from './github-production-deployment-status-reconciler.js';

export function githubProductionDeploymentStatusReconcilerFromEnv(
  env: Bindings,
): GitHubProductionDeploymentStatusReconciler | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  return new GitHubProductionDeploymentStatusReconciler(
    env.DB_CONTROL,
    new GitHubProductionDeploymentStatusApiClient(runtime.provider, {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
    }),
  );
}

export async function reconcileGitHubProductionDeploymentStatusesFromEnv(
  env: Bindings,
): Promise<GitHubProductionDeploymentStatusBatchResult[]> {
  const reconciler = githubProductionDeploymentStatusReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(25);
}
