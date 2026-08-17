import {
  normalizeExecutorModelProviderBaseUrl,
  normalizeProviderBaseUrl,
} from './provider-base-url.js';

export const CODEX_RELAY_PROVIDER_ID = 'delivery_loop_relay';
export const CODEX_RELAY_REASONING_EFFORT = 'medium';
export type CodexRelayReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Build the single trusted Codex relay profile used by session, analysis, and
 * execution adapters. `CODEX_API_KEY` remains process-only authentication and
 * is deliberately absent from these arguments.
 */
export function codexProviderProfileArguments(
  providerBaseUrl: string | undefined,
  reasoningEffort: CodexRelayReasoningEffort = CODEX_RELAY_REASONING_EFFORT,
): string[] {
  const normalizedBaseUrl = providerBaseUrl?.startsWith(
    'https://control.delivery-loop.internal/',
  )
    ? normalizeExecutorModelProviderBaseUrl(providerBaseUrl)
    : normalizeProviderBaseUrl(providerBaseUrl);
  if (normalizedBaseUrl === undefined) return [];

  return [
    '-c',
    `model_provider=${JSON.stringify(CODEX_RELAY_PROVIDER_ID)}`,
    '-c',
    `model_providers.${CODEX_RELAY_PROVIDER_ID}.name=${JSON.stringify(
      'Delivery Loop OpenAI-compatible relay',
    )}`,
    '-c',
    `model_providers.${CODEX_RELAY_PROVIDER_ID}.base_url=${JSON.stringify(
      normalizedBaseUrl,
    )}`,
    '-c',
    `model_providers.${CODEX_RELAY_PROVIDER_ID}.wire_api="responses"`,
    '-c',
    `model_providers.${CODEX_RELAY_PROVIDER_ID}.requires_openai_auth=true`,
    '-c',
    `model_providers.${CODEX_RELAY_PROVIDER_ID}.supports_websockets=false`,
    '-c',
    `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
  ];
}

export type CodexProviderApiKey = string | (() => string | undefined);

export function codexProviderEnvironment(
  source: CodexProviderApiKey | undefined,
): NodeJS.ProcessEnv | undefined {
  const apiKey = typeof source === 'function' ? source() : source;
  if (apiKey === undefined) return undefined;
  if (apiKey.length < 1 || apiKey.length > 4_096 || /[\0\r\n]/.test(apiKey)) {
    throw new Error('Codex provider authentication is invalid');
  }
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  environment.CODEX_API_KEY = apiKey;
  return environment;
}
