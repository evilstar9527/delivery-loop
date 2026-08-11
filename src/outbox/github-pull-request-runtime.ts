import type { Bindings } from '../env.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import { githubActionsRuntimeFromEnv } from '../reconciliation/github-run-reconciliation-runtime.js';
import {
  GitHubPullRequestReconciler,
  type GitHubPullRequestBatchResult,
} from '../reconciliation/github-pull-request-reconciler.js';
import {
  GitHubPullRequestApiClient,
  GitHubPullRequestOutboxProcessor,
} from './github-pull-request.js';

export interface GitHubPullRequestRuntime {
  client: GitHubPullRequestApiClient;
  processor: GitHubPullRequestOutboxProcessor;
}

export function githubPullRequestRuntimeFromEnv(
  env: Bindings,
): GitHubPullRequestRuntime | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  const client = new GitHubPullRequestApiClient(runtime.provider, {
    ...(env.GITHUB_API_BASE_URL === undefined
      ? {}
      : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
  });
  return {
    client,
    processor: new GitHubPullRequestOutboxProcessor(env.DB_CONTROL, client, {
      secrets: configuredSecrets(env),
    }),
  };
}

export async function reconcileGitHubPullRequestsFromEnv(
  env: Bindings,
  limit = 25,
): Promise<GitHubPullRequestBatchResult[]> {
  const runtime = githubPullRequestRuntimeFromEnv(env);
  if (runtime === null) return [];
  return await new GitHubPullRequestReconciler(
    env.DB_CONTROL,
    runtime.client,
  ).reconcileBatch(limit);
}
