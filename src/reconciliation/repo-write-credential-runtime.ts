import type { Bindings } from '../env.js';
import { githubActionsRuntimeFromEnv } from './github-run-reconciliation-runtime.js';
import {
  RepoWriteCredentialRevoker,
  type GitHubWriteCredentialProvider,
} from '../storage/repo-write-credential-store.js';

export interface RepoWriteCredentialRuntime {
  provider: GitHubWriteCredentialProvider;
  encryptionKey: string;
}

export function repoWriteCredentialRuntimeFromEnv(
  env: Bindings,
): RepoWriteCredentialRuntime | null {
  if (env.GITHUB_CREDENTIAL_ENCRYPTION_KEY === undefined) return null;
  const github = githubActionsRuntimeFromEnv(env);
  if (github === null) return null;
  return {
    provider: github.provider,
    encryptionKey: env.GITHUB_CREDENTIAL_ENCRYPTION_KEY,
  };
}

export async function revokeRepoWriteCredentialsFromEnv(
  env: Bindings,
): Promise<unknown[]> {
  const runtime = repoWriteCredentialRuntimeFromEnv(env);
  if (runtime === null) return [];
  return await new RepoWriteCredentialRevoker(env.DB_CONTROL, runtime.provider, {
    encryptionKey: runtime.encryptionKey,
  }).scan(25);
}
