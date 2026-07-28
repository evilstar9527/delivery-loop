import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from '../reconciliation/github-run-reconciliation-runtime.js';
import { GitHubDispatchOutboxProcessor } from './github-dispatcher.js';

export function githubDispatchProcessorFromEnv(
  env: Bindings,
): GitHubDispatchOutboxProcessor | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  if (runtime === null) return null;
  if (env.CONTROL_PLANE_URL === undefined || env.CODEX_MODEL_PROFILE_ID === undefined) {
    throw new Error('GitHub dispatch configuration is incomplete');
  }
  return new GitHubDispatchOutboxProcessor(env.DB_CONTROL, runtime.client, {
    allowedRepositories: runtime.allowedRepositories,
    controlPlaneUrl: env.CONTROL_PLANE_URL,
    modelProfileId: env.CODEX_MODEL_PROFILE_ID,
  });
}
