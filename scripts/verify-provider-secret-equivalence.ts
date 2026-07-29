import { verifyProviderSecretEquivalence } from '../src/agent/provider-secret-equivalence.js';

const SAFE_FAILURE_CODES = new Set([
  'provider_secret_equivalence_input_missing',
  'provider_secret_equivalence_proof_key_invalid',
  'provider_secret_equivalence_expected_proof_invalid',
]);

try {
  const result = verifyProviderSecretEquivalence({
    apiKey: process.env.CODEX_API_KEY ?? '',
    baseUrl: process.env.OPENAI_BASE_URL ?? '',
    proofKeyBase64: process.env.PROVIDER_CONFIG_PROOF_KEY ?? '',
    expectedApiKeyProof:
      process.env.PROVIDER_CONFIG_EXPECTED_API_KEY_PROOF ?? '',
    expectedBaseUrlProof:
      process.env.PROVIDER_CONFIG_EXPECTED_BASE_URL_PROOF ?? '',
  });
  console.log(result.apiKeyMatched
    ? 'provider_api_key_match'
    : 'provider_api_key_mismatch');
  console.log(result.baseUrlMatched
    ? 'provider_base_url_match'
    : 'provider_base_url_mismatch');
  if (!result.matched) {
    process.exitCode = 1;
  }
} catch (error) {
  const code = error instanceof Error && SAFE_FAILURE_CODES.has(error.message)
    ? error.message
    : 'provider_secret_equivalence_failed';
  console.error(code);
  process.exitCode = 1;
}
