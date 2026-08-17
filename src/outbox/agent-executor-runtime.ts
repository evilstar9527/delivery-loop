import type { Bindings } from '../env.js';
import { ExecutorPluginRegistry } from '../executor/core/executor-registry.js';
import { RegistryExecutorIdentityProvider } from
  '../executor/core/executor-identity-provider.js';
import { CloudflareSandboxExecutorPlugin } from
  '../executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';
import { cloudflareSandboxEffectsFromEnv } from
  '../executor/plugins/cloudflare-sandbox/cloudflare-sandbox-runtime.js';
import { GitHubActionsExecutorPlugin } from
  '../executor/plugins/github-actions/github-actions-plugin.js';
import { githubActionsRuntimeFromEnv } from
  '../reconciliation/github-run-reconciliation-runtime.js';
import { AgentExecutorOutboxProcessor } from './agent-executor.js';
import {
  ExecutorReconciler,
  type ExecutorReconcilerOptions,
} from '../reconciliation/executor-reconciler.js';

/** Builds only explicitly configured plugins; frozen provider kinds never fall back. */
export function executorPluginRegistryFromEnv(env: Bindings): ExecutorPluginRegistry | null {
  const registry = new ExecutorPluginRegistry();
  let registered = 0;
  const github = githubActionsRuntimeFromEnv(env);
  if (github !== null) {
    registry.register(new GitHubActionsExecutorPlugin(github.client));
    registered += 1;
  }
  const sandbox = cloudflareSandboxEffectsFromEnv(env);
  if (sandbox !== null) {
    registry.register(new CloudflareSandboxExecutorPlugin(sandbox));
    registered += 1;
  }
  return registered === 0 ? null : registry;
}

export function agentExecutorProcessorFromEnv(
  env: Bindings,
): AgentExecutorOutboxProcessor | null {
  const registry = executorPluginRegistryFromEnv(env);
  return registry === null ? null : new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry);
}

export function executorIdentityProviderFromEnv(
  env: Bindings,
): RegistryExecutorIdentityProvider | null {
  const registry = executorPluginRegistryFromEnv(env);
  return registry === null
    ? null
    : new RegistryExecutorIdentityProvider(env.DB_CONTROL, registry);
}

export function executorReconcilerFromEnv(
  env: Bindings,
  options: ExecutorReconcilerOptions = {},
): ExecutorReconciler | null {
  const registry = executorPluginRegistryFromEnv(env);
  return registry === null ? null : new ExecutorReconciler(env.DB_CONTROL, registry, options);
}
