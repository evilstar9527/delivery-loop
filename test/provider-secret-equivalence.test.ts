import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  computeProviderSecretEquivalenceProof,
  verifyProviderSecretEquivalence,
} from '../src/agent/provider-secret-equivalence.js';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, {
    permissions?: Record<string, string>;
    environment?: string;
    steps: WorkflowStep[];
  }>;
}

describe('provider Secret equivalence proof', () => {
  it('matches only the exact API key and base URL bytes under a private proof key', () => {
    const proofKey = Buffer.alloc(32, 7).toString('base64');
    const expectedProof = computeProviderSecretEquivalenceProof({
      apiKey: 'key-example-local-only',
      baseUrl: 'https://relay.example.test/v1',
      proofKeyBase64: proofKey,
    });

    expect(verifyProviderSecretEquivalence({
      apiKey: 'key-example-local-only',
      baseUrl: 'https://relay.example.test/v1',
      proofKeyBase64: proofKey,
      expectedApiKeyProof: expectedProof.apiKeyProof,
      expectedBaseUrlProof: expectedProof.baseUrlProof,
    })).toEqual({ apiKeyMatched: true, baseUrlMatched: true, matched: true });
    expect(verifyProviderSecretEquivalence({
      apiKey: 'key-example-local-only ',
      baseUrl: 'https://relay.example.test/v1',
      proofKeyBase64: proofKey,
      expectedApiKeyProof: expectedProof.apiKeyProof,
      expectedBaseUrlProof: expectedProof.baseUrlProof,
    })).toEqual({ apiKeyMatched: false, baseUrlMatched: true, matched: false });
    expect(verifyProviderSecretEquivalence({
      apiKey: 'key-example-local-only',
      baseUrl: 'https://relay.example.test/v1/',
      proofKeyBase64: proofKey,
      expectedApiKeyProof: expectedProof.apiKeyProof,
      expectedBaseUrlProof: expectedProof.baseUrlProof,
    })).toEqual({ apiKeyMatched: true, baseUrlMatched: false, matched: false });
  });

  it('rejects malformed proof material with fixed errors that do not contain inputs', () => {
    const secret = 'key-sensitive-example';
    const url = 'https://sensitive.example.test/v1';

    const invalidProofs: Array<[string, string]> = [
      ['', '0'.repeat(64)],
      [Buffer.alloc(31, 1).toString('base64'), '0'.repeat(64)],
      [Buffer.alloc(32, 1).toString('base64'), 'not-a-proof'],
    ];
    for (const [proofKeyBase64, expectedProof] of invalidProofs) {
      expect(() => verifyProviderSecretEquivalence({
        apiKey: secret,
        baseUrl: url,
        proofKeyBase64,
        expectedApiKeyProof: expectedProof,
        expectedBaseUrlProof: expectedProof,
      })).toThrow(/provider_secret_equivalence_(?:proof_key|expected_proof)_invalid/);
    }
  });

  it('uses a manual read-only workflow and logs no Secret or proof digest', () => {
    const workflow = parse(readFileSync(
      new URL('../.github/workflows/provider-secret-equivalence.yml', import.meta.url),
      'utf8',
    )) as Workflow;

    expect(workflow.name).toBe('Provider Secret equivalence');
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs.verify;
    expect(job).toBeDefined();
    expect(job?.permissions).toBeUndefined();
    expect(job?.environment).toBeUndefined();
    expect(job?.steps.filter((step) => step.uses !== undefined).map((step) => step.uses))
      .toEqual([
        'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
        'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
        'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      ]);
    const verifier = job?.steps.find((step) => step.name === 'Compare provider Secret bytes');
    expect(verifier?.env).toEqual({
      CODEX_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}',
      PROVIDER_CONFIG_PROOF_KEY: '${{ secrets.PROVIDER_CONFIG_PROOF_KEY }}',
      PROVIDER_CONFIG_EXPECTED_API_KEY_PROOF:
        '${{ secrets.PROVIDER_CONFIG_EXPECTED_API_KEY_PROOF }}',
      PROVIDER_CONFIG_EXPECTED_BASE_URL_PROOF:
        '${{ secrets.PROVIDER_CONFIG_EXPECTED_BASE_URL_PROOF }}',
    });
    expect(verifier?.run).toBe('pnpm run verify:provider-secret-equivalence');
    const serialized = JSON.stringify(workflow);
    expect(serialized).not.toContain('id-token');
    expect(serialized).not.toContain('upload-artifact');
    expect(serialized).not.toContain('workflow_call');
    expect(serialized).not.toContain('pull_request');
  });
});
