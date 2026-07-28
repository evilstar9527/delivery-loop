import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from './github-run-reconciliation-runtime.js';
import {
  GitHubBaseApiClient,
  GitHubBaseObservationReconciler,
  type GitHubBaseBatchResult,
} from './github-base-observation-reconciler.js';

export function githubBaseObservationReconcilerFromEnv(
  env: Bindings,
): GitHubBaseObservationReconciler | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  return new GitHubBaseObservationReconciler(
    env.DB_CONTROL,
    new GitHubBaseApiClient(runtime.provider, {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
    }),
  );
}

export async function reconcileGitHubBasesFromEnv(
  env: Bindings,
): Promise<GitHubBaseBatchResult[]> {
  const reconciler = githubBaseObservationReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(25);
}
