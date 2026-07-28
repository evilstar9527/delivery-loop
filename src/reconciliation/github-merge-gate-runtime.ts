import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from './github-run-reconciliation-runtime.js';
import {
  GitHubMergeGateApiClient,
  GitHubMergeGateReconciler,
  type GitHubMergeGateBatchResult,
} from './github-merge-gate-reconciler.js';

export function githubMergeGateReconcilerFromEnv(
  env: Bindings,
): GitHubMergeGateReconciler | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  return new GitHubMergeGateReconciler(
    env.DB_CONTROL,
    new GitHubMergeGateApiClient(runtime.provider, {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
    }),
  );
}

export async function reconcileGitHubMergeGatesFromEnv(
  env: Bindings,
): Promise<GitHubMergeGateBatchResult[]> {
  const reconciler = githubMergeGateReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(25);
}
