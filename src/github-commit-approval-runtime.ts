import type { Bindings } from './env.js';
import {
  GitHubCommitApprovalApiClient,
  type GitHubCommitApprovalClient,
} from './github-commit-approval.js';
import { githubActionsRuntimeFromEnv } from './reconciliation/github-run-reconciliation-runtime.js';

export function githubCommitApprovalClientFromEnv(
  env: Bindings,
): GitHubCommitApprovalClient | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  return new GitHubCommitApprovalApiClient(runtime.provider, {
    ...(env.GITHUB_API_BASE_URL === undefined
      ? {}
      : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
  });
}
