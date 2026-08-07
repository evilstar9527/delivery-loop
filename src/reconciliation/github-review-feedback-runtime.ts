import type { Bindings } from '../env.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import { githubActionsRuntimeFromEnv } from './github-run-reconciliation-runtime.js';
import { GitHubMergeGateApiClient } from './github-merge-gate-reconciler.js';
import {
  GitHubReviewFeedbackReconciler,
  GitHubReviewFeedbackRecoveryReconciler,
  type GitHubReviewFeedbackBatchResult,
} from './github-review-feedback-reconciler.js';

export function githubReviewFeedbackReconcilerFromEnv(
  env: Bindings,
): GitHubReviewFeedbackReconciler | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  return new GitHubReviewFeedbackReconciler(
    env.DB_CONTROL,
    env.TASK_OBJECTS,
    new GitHubMergeGateApiClient(runtime.provider, {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
    }),
    { secrets: configuredSecrets(env) },
  );
}

export async function reconcileGitHubReviewFeedbacksFromEnv(
  env: Bindings,
): Promise<GitHubReviewFeedbackBatchResult[]> {
  const reconciler = githubReviewFeedbackReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(25);
}

export async function recoverLostGitHubReviewFeedbacksFromEnv(
  env: Bindings,
): Promise<unknown[]> {
  return await new GitHubReviewFeedbackRecoveryReconciler(env.DB_CONTROL).reconcileBatch(1);
}
