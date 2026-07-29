import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from './github-run-reconciliation-runtime.js';
import {
  GitHubBaseApiClient,
  GitHubBaseObservationReconciler,
  type GitHubBaseBatchResult,
  type GitHubBaseShaResolver,
} from './github-base-observation-reconciler.js';

function githubBaseClientFromEnv(env: Bindings): GitHubBaseApiClient | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  return new GitHubBaseApiClient(runtime.provider, {
    ...(env.GITHUB_API_BASE_URL === undefined
      ? {}
      : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
  });
}

export function githubBaseShaResolverFromEnv(env: Bindings): GitHubBaseShaResolver | null {
  return githubBaseClientFromEnv(env);
}

export function githubBaseObservationReconcilerFromEnv(
  env: Bindings,
): GitHubBaseObservationReconciler | null {
  const client = githubBaseClientFromEnv(env);
  if (client === null) return null;
  return new GitHubBaseObservationReconciler(
    env.DB_CONTROL,
    client,
  );
}

export async function reconcileGitHubBasesFromEnv(
  env: Bindings,
): Promise<GitHubBaseBatchResult[]> {
  const reconciler = githubBaseObservationReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(25);
}
