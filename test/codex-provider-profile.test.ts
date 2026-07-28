import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CODEX_RELAY_PROVIDER_ID,
  CODEX_RELAY_REASONING_EFFORT,
  codexProviderProfileArguments,
} from '../src/agent/codex-provider-profile.js';

describe('Codex relay provider profile', () => {
  it('matches the owner-verified CC Switch Responses/SSE profile without putting a key in argv', () => {
    const args = codexProviderProfileArguments('https://relay.example.com/openai/v1');

    expect(CODEX_RELAY_PROVIDER_ID).toBe('delivery_loop_relay');
    expect(CODEX_RELAY_REASONING_EFFORT).toBe('high');
    expect(args).toEqual([
      '-c',
      'model_provider="delivery_loop_relay"',
      '-c',
      'model_providers.delivery_loop_relay.name="Delivery Loop OpenAI-compatible relay"',
      '-c',
      'model_providers.delivery_loop_relay.base_url="https://relay.example.com/openai/v1"',
      '-c',
      'model_providers.delivery_loop_relay.wire_api="responses"',
      '-c',
      'model_providers.delivery_loop_relay.requires_openai_auth=true',
      '-c',
      'model_providers.delivery_loop_relay.supports_websockets=false',
      '-c',
      'model_reasoning_effort="high"',
    ]);
    expect(JSON.stringify(args)).not.toContain('openai_base_url');
    expect(JSON.stringify(args)).not.toContain('OPENAI_API_KEY');
    expect(JSON.stringify(args)).not.toContain('CODEX_API_KEY');
  });

  it('leaves the built-in OpenAI profile unchanged when no relay is configured', () => {
    expect(codexProviderProfileArguments(undefined)).toEqual([]);
  });

  it('binds the deployed control plane to a new immutable Sol/high quota profile', () => {
    const wrangler = JSON.parse(readFileSync(
      new URL('../wrangler.jsonc', import.meta.url),
      'utf8',
    )) as { vars?: { CODEX_MODEL_PROFILE_ID?: string } };

    expect(wrangler.vars?.CODEX_MODEL_PROFILE_ID)
      .toBe('codex-gpt-5p6-sol-high-20260729');

    const migration = readFileSync(
      new URL('../migrations/0062_codex_sol_relay_profile.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('INSERT INTO quota_model_profiles');
    expect(migration).not.toContain('INSERT OR IGNORE');
  });
});
