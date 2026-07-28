import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from './github-run-reconciliation-runtime.js';
import {
  GitHubMergeStatusApiClient,
  GitHubMergeStatusReconciler,
  type GitHubMergeStatusBatchResult,
} from './github-merge-status-reconciler.js';

export function githubMergeStatusReconcilerFromEnv(
  env: Bindings,
): GitHubMergeStatusReconciler | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  return new GitHubMergeStatusReconciler(
    env.DB_CONTROL,
    new GitHubMergeStatusApiClient(runtime.provider, {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
    }),
  );
}

export async function reconcileGitHubMergeStatusesFromEnv(
  env: Bindings,
): Promise<GitHubMergeStatusBatchResult[]> {
  const reconciler = githubMergeStatusReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(25);
}
