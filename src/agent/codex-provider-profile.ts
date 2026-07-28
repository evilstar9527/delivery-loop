import { normalizeProviderBaseUrl } from './provider-base-url.js';

export const CODEX_RELAY_PROVIDER_ID = 'delivery_loop_relay';
export const CODEX_RELAY_REASONING_EFFORT = 'high';

/**
 * Build the single trusted Codex relay profile used by session, analysis, and
 * execution adapters. `CODEX_API_KEY` remains process-only authentication and
 * is deliberately absent from these arguments.
 */
export function codexProviderProfileArguments(
  providerBaseUrl: string | undefined,
): string[] {
  const normalizedBaseUrl = normalizeProviderBaseUrl(providerBaseUrl);
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
    `model_reasoning_effort=${JSON.stringify(CODEX_RELAY_REASONING_EFFORT)}`,
  ];
}
