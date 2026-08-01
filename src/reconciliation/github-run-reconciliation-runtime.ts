import { GitHubAppInstallationTokenProvider } from '../auth/github-app-installation-token.js';
import type { Bindings } from '../env.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';
import { GitHubActionsApiClient } from '../outbox/github-dispatcher.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  GitHubRunReconciler,
  type GitHubBatchReconciliationResult,
} from './github-run-reconciler.js';

export interface GitHubActionsRuntime {
  provider: GitHubAppInstallationTokenProvider;
  client: GitHubActionsApiClient;
  allowedRepositories: readonly string[];
}

function allowedRepositories(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('GitHub reconciliation configuration is invalid');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (entry) =>
        typeof entry === 'string' &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry),
    )
  ) {
    throw new Error('GitHub reconciliation configuration is invalid');
  }
  return [...new Set(parsed)];
}

export function githubActionsRuntimeFromEnv(env: Bindings): GitHubActionsRuntime | null {
  const configured = [
    env.GITHUB_APP_ID,
    env.GITHUB_APP_INSTALLATION_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_ALLOWED_REPOSITORIES,
  ];
  if (configured.every((value) => value === undefined)) return null;
  if (configured.some((value) => value === undefined)) {
    throw new Error('GitHub reconciliation configuration is incomplete');
  }
  const repositories = allowedRepositories(env.GITHUB_ALLOWED_REPOSITORIES!);
  const provider = new GitHubAppInstallationTokenProvider({
    appId: env.GITHUB_APP_ID!,
    installationId: env.GITHUB_APP_INSTALLATION_ID!,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY!,
    allowedRepositories: repositories,
    transportDiagnostic: secureStructuredLogSink({
      component: 'github_app_credential',
      level: 'warn',
      secrets: configuredSecrets(env),
    }),
    ...(env.GITHUB_API_BASE_URL === undefined
      ? {}
      : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
  });
  return {
    provider,
    allowedRepositories: repositories,
    client: new GitHubActionsApiClient(provider, {
      ...(env.GITHUB_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
    }),
  };
}

export function githubRunReconcilerFromEnv(env: Bindings): GitHubRunReconciler | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  return runtime === null ? null : new GitHubRunReconciler(env.DB_CONTROL, runtime.client);
}

export async function reconcileGitHubRunsFromEnv(
  env: Bindings,
): Promise<GitHubBatchReconciliationResult[]> {
  const reconciler = githubRunReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(25);
}
