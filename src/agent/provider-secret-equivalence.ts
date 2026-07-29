import { createHmac, timingSafeEqual } from 'node:crypto';

const PROVIDER_SECRET_EQUIVALENCE_CONTEXT =
  'delivery-loop-provider-secret-equivalence-v1';
const EXPECTED_PROOF_PATTERN = /^[a-f0-9]{64}$/;
const PROOF_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface ProviderSecretEquivalenceProofInput {
  apiKey: string;
  baseUrl: string;
  proofKeyBase64: string;
}

export interface ProviderSecretEquivalenceInput
  extends ProviderSecretEquivalenceProofInput {
  expectedApiKeyProof: string;
  expectedBaseUrlProof: string;
}

export interface ProviderSecretEquivalenceProof {
  apiKeyProof: string;
  baseUrlProof: string;
}

function decodeProofKey(proofKeyBase64: string): Buffer {
  if (!PROOF_KEY_PATTERN.test(proofKeyBase64)) {
    throw new Error('provider_secret_equivalence_proof_key_invalid');
  }
  const proofKey = Buffer.from(proofKeyBase64, 'base64');
  if (proofKey.length !== 32 || proofKey.toString('base64') !== proofKeyBase64) {
    throw new Error('provider_secret_equivalence_proof_key_invalid');
  }
  return proofKey;
}

function requireProviderSecret(value: string): string {
  if (value.length === 0) {
    throw new Error('provider_secret_equivalence_input_missing');
  }
  return value;
}

/**
 * Computes a proof that is safe to compare only while its random key remains
 * secret. Callers must never log or persist the returned credential-derived
 * value outside a Secret store.
 */
export function computeProviderSecretEquivalenceProof(
  input: ProviderSecretEquivalenceProofInput,
): ProviderSecretEquivalenceProof {
  const proofKey = decodeProofKey(input.proofKeyBase64);
  const computeFieldProof = (field: 'api-key' | 'base-url', value: string) =>
    createHmac('sha256', proofKey)
      .update(PROVIDER_SECRET_EQUIVALENCE_CONTEXT, 'utf8')
      .update('\0', 'utf8')
      .update(field, 'utf8')
      .update('\0', 'utf8')
      .update(requireProviderSecret(value), 'utf8')
      .digest('hex');
  return {
    apiKeyProof: computeFieldProof('api-key', input.apiKey),
    baseUrlProof: computeFieldProof('base-url', input.baseUrl),
  };
}

export function verifyProviderSecretEquivalence(
  input: ProviderSecretEquivalenceInput,
): { apiKeyMatched: boolean; baseUrlMatched: boolean; matched: boolean } {
  if (
    !EXPECTED_PROOF_PATTERN.test(input.expectedApiKeyProof)
    || !EXPECTED_PROOF_PATTERN.test(input.expectedBaseUrlProof)
  ) {
    throw new Error('provider_secret_equivalence_expected_proof_invalid');
  }
  const actualProof = computeProviderSecretEquivalenceProof(input);
  const apiKeyMatched = timingSafeEqual(
    Buffer.from(actualProof.apiKeyProof, 'hex'),
    Buffer.from(input.expectedApiKeyProof, 'hex'),
  );
  const baseUrlMatched = timingSafeEqual(
    Buffer.from(actualProof.baseUrlProof, 'hex'),
    Buffer.from(input.expectedBaseUrlProof, 'hex'),
  );
  return {
    apiKeyMatched,
    baseUrlMatched,
    matched: apiKeyMatched && baseUrlMatched,
  };
}
