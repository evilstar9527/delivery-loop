import { productionDeploymentTargetsFromJson } from '../domain/production-deployment.js';
import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from '../reconciliation/github-run-reconciliation-runtime.js';
import { ProductionDeploymentReconciler } from '../reconciliation/production-deployment-reconciler.js';
import {
  GitHubProductionDeploymentApiClient,
  ProductionDeploymentOutboxProcessor,
} from './github-production-deployment.js';

export interface GitHubProductionDeploymentRuntime {
  client: GitHubProductionDeploymentApiClient;
  processor: ProductionDeploymentOutboxProcessor;
  reconciler: ProductionDeploymentReconciler;
}

export function githubProductionDeploymentRuntimeFromEnv(
  env: Bindings,
): GitHubProductionDeploymentRuntime | null {
  if (env.PRODUCTION_DEPLOY_TARGETS_JSON === undefined) return null;
  const github = githubActionsRuntimeFromEnv(env);
  if (github === null) throw new Error('production deployment configuration is incomplete');
  const targets = productionDeploymentTargetsFromJson(env.PRODUCTION_DEPLOY_TARGETS_JSON);
  const allowed = new Set(github.allowedRepositories);
  if ([...targets.keys()].some((repository) => !allowed.has(repository))) {
    throw new Error('production deployment configuration is invalid');
  }
  const client = new GitHubProductionDeploymentApiClient(github.provider, {
    ...(env.GITHUB_API_BASE_URL === undefined ? {} : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
  });
  return {
    client,
    processor: new ProductionDeploymentOutboxProcessor(env.DB_CONTROL, client),
    reconciler: new ProductionDeploymentReconciler(env.DB_CONTROL, targets),
  };
}

export async function reconcileProductionDeploymentsFromEnv(
  env: Bindings,
): Promise<unknown[]> {
  const runtime = githubProductionDeploymentRuntimeFromEnv(env);
  return runtime === null ? [] : await runtime.reconciler.reconcileBatch(25);
}
