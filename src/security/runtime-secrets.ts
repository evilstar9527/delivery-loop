import type { Bindings } from '../env.js';

/** One authoritative catalog for every configured plaintext Worker credential. */
export function configuredSecrets(env: Partial<Bindings>): string[] {
  return [...new Set([
    env.TASK_INTAKE_TOKEN,
    env.OPERATIONS_TOKEN,
    env.APPROVAL_ADAPTER_TOKEN,
    env.GITHUB_WEBHOOK_SECRET,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_PAT,
    env.GITHUB_CREDENTIAL_ENCRYPTION_KEY,
    env.FEISHU_APP_SECRET,
    env.FEISHU_EVENT_ENCRYPT_KEY,
    env.FEISHU_EVENT_VERIFICATION_TOKEN,
    env.MONITOR_WEBHOOK_SECRET,
    env.D1_BACKUP_API_TOKEN,
    env.TOOL_BRIDGE_INTERNAL_TOKEN,
    env.RAW_AGENT_ARTIFACT_ENCRYPTION_KEY,
  ].filter((value): value is string => value !== undefined && value.length > 0))];
}
