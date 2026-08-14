import { GitHubAppInstallationTokenProvider } from '../auth/github-app-installation-token.js';
import { GitHubPatTokenProvider } from '../auth/github-pat-token.js';
import type { GitHubRepositoryTokenProvider } from '../auth/github-pat-token.js';
import type { Bindings } from '../env.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';
import { GitHubActionsApiClient } from '../outbox/github-dispatcher.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  GitHubRunReconciler,
  type GitHubBatchReconciliationResult,
  type GitHubRunReconcilerOptions,
} from './github-run-reconciler.js';

export interface GitHubActionsRuntime {
  provider: GitHubRepositoryTokenProvider;
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
  const appConfigured = [
    env.GITHUB_APP_ID,
    env.GITHUB_APP_INSTALLATION_ID,
    env.GITHUB_APP_PRIVATE_KEY,
  ];
  const hasApp = appConfigured.some((value) => value !== undefined);
  const hasPat = env.GITHUB_PAT !== undefined;
  const rawMode = env.GITHUB_AUTH_MODE ?? (hasPat ? 'pat' : 'app');
  if (rawMode !== 'app' && rawMode !== 'pat') {
    throw new Error('GitHub reconciliation configuration is invalid');
  }
  if (
    env.GITHUB_AUTH_MODE === undefined &&
    !hasApp && !hasPat &&
    env.GITHUB_ALLOWED_REPOSITORIES === undefined
  ) return null;
  if (rawMode === 'pat' && hasApp) {
    throw new Error('GitHub reconciliation configuration mixes App and PAT credentials');
  }
  if (rawMode === 'app' && hasPat) {
    throw new Error('GitHub reconciliation configuration mixes App and PAT credentials');
  }
  if (env.GITHUB_ALLOWED_REPOSITORIES === undefined) {
    throw new Error('GitHub reconciliation configuration is incomplete');
  }
  const repositories = allowedRepositories(env.GITHUB_ALLOWED_REPOSITORIES!);
  let provider: GitHubRepositoryTokenProvider;
  if (rawMode === 'pat') {
    if (env.GITHUB_PAT === undefined) {
      throw new Error('GitHub PAT configuration is incomplete');
    }
    provider = new GitHubPatTokenProvider({
      pat: env.GITHUB_PAT,
      allowedRepositories: repositories,
      ...(env.GITHUB_PAT_EXPIRES_AT === undefined ? {} : { patExpiresAt: env.GITHUB_PAT_EXPIRES_AT }),
    });
  } else {
    if (appConfigured.some((value) => value === undefined)) {
      throw new Error('GitHub reconciliation configuration is incomplete');
    }
    provider = new GitHubAppInstallationTokenProvider({
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
  }
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

export function githubRunReconcilerFromEnv(
  env: Bindings,
  options: GitHubRunReconcilerOptions = {},
): GitHubRunReconciler | null {
  const runtime = githubActionsRuntimeFromEnv(env);
  return runtime === null
    ? null
    : new GitHubRunReconciler(env.DB_CONTROL, runtime.client, options);
}

export async function reconcileGitHubRunsFromEnv(
  env: Bindings,
  limit = 25,
): Promise<GitHubBatchReconciliationResult[]> {
  const reconciler = githubRunReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileBatch(limit);
}

export async function reconcileRecoveryGitHubRunsFromEnv(
  env: Bindings,
  limit = 1,
): Promise<GitHubBatchReconciliationResult[]> {
  const reconciler = githubRunReconcilerFromEnv(env);
  return reconciler === null ? [] : await reconciler.reconcileRecoveryBatch(limit);
}

export async function reconcileAtRiskGitHubRunsFromEnv(
  env: Bindings,
  options: {
    limit?: number;
    runningThresholdSeconds?: number;
    now?: () => Date;
  } = {},
): Promise<GitHubBatchReconciliationResult[]> {
  const reconciler = githubRunReconcilerFromEnv(env, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return reconciler === null
    ? []
    : await reconciler.reconcileAtRiskBatch(
        options.limit ?? 5,
        options.runningThresholdSeconds ?? 90,
      );
}
