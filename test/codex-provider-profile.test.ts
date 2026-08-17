import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CODEX_RELAY_PROVIDER_ID,
  CODEX_RELAY_REASONING_EFFORT,
  codexProviderEnvironment,
  codexProviderProfileArguments,
} from '../src/agent/codex-provider-profile.js';
import { executorModelProviderBaseUrl } from '../src/agent/provider-base-url.js';

describe('Codex relay provider profile', () => {
  it('matches the owner-verified CC Switch Responses/SSE profile without putting a key in argv', () => {
    const args = codexProviderProfileArguments('https://relay.example.com/openai/v1');

    expect(CODEX_RELAY_PROVIDER_ID).toBe('delivery_loop_relay');
    expect(CODEX_RELAY_REASONING_EFFORT).toBe('medium');
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
      'model_reasoning_effort="medium"',
    ]);
    expect(JSON.stringify(args)).not.toContain('openai_base_url');
    expect(JSON.stringify(args)).not.toContain('OPENAI_API_KEY');
    expect(JSON.stringify(args)).not.toContain('CODEX_API_KEY');
  });

  it('leaves the built-in OpenAI profile unchanged when no relay is configured', () => {
    expect(codexProviderProfileArguments(undefined)).toEqual([]);
  });

  it('uses an exact internal Responses relay and keeps its placeholder out of argv', () => {
    const baseUrl = executorModelProviderBaseUrl('attempt-model-proxy');
    const args = codexProviderProfileArguments(baseUrl);
    const environment = codexProviderEnvironment('executor-model-placeholder');
    expect(args).toContain(
      `model_providers.delivery_loop_relay.base_url=${JSON.stringify(baseUrl)}`,
    );
    expect(JSON.stringify(args)).not.toContain('executor-model-placeholder');
    expect(environment?.CODEX_API_KEY).toBe('executor-model-placeholder');
    expect(environment?.OPENAI_API_KEY).toBeUndefined();
    expect(() => executorModelProviderBaseUrl('../other')).toThrow();
  });

  it('resolves a fresh executor grant only when building the child environment', () => {
    let grant = 'executor-model-grant-first';
    const source = () => grant;
    expect(codexProviderEnvironment(source)?.CODEX_API_KEY).toBe(grant);
    grant = 'executor-model-grant-second';
    expect(codexProviderEnvironment(source)?.CODEX_API_KEY).toBe(grant);
    expect(process.env.CODEX_API_KEY).not.toBe(grant);
  });

  it('allows a bounded preflight to override reasoning without changing the production default', () => {
    expect(codexProviderProfileArguments('https://relay.example.com/v1', 'high'))
      .toEqual(expect.arrayContaining(['model_reasoning_effort="high"']));
    expect(codexProviderProfileArguments('https://relay.example.com/v1'))
      .toEqual(expect.arrayContaining(['model_reasoning_effort="medium"']));
  });

  it('binds the deployed control plane to a cumulative tool-loop Terra/medium profile', () => {
    const wrangler = JSON.parse(readFileSync(
      new URL('../wrangler.jsonc', import.meta.url),
      'utf8',
    )) as { vars?: { CODEX_MODEL_PROFILE_ID?: string } };

    expect(wrangler.vars?.CODEX_MODEL_PROFILE_ID)
      .toBe('codex-gpt-5p6-terra-medium-tool-loop-20260811');

    const migration = readFileSync(
      new URL('../migrations/0073_codex_terra_tool_loop_profile.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('INSERT INTO quota_model_profiles');
    expect(migration).not.toContain('INSERT OR IGNORE');
    expect(migration).toContain("'codex-gpt-5p6-terra-medium-tool-loop-20260811'");
    expect(migration).toContain('2000000');
  });
});
