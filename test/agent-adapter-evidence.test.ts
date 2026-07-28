import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentAdapterEvidenceManifestV1Schema,
  type AgentAdapterEvidenceManifestV1,
} from '../src/domain/agent-adapter-evidence.js';
import {
  AgentAdapterEvidenceVerificationError,
  verifyAgentAdapterEvidence,
} from '../src/pilot/agent-adapter-evidence-verifier.js';

const HEAD_SHA = 'c'.repeat(40);
const MANIFEST: AgentAdapterEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'agent-adapter-evidence-test',
  recordedAt: '2026-07-26T16:00:00.000Z',
  provider: 'codex',
  cliVersion: 'codex-cli-0.145.0',
  resultSchema: 'AgentSessionResultV1',
  status: 'passed',
  processExitCode: 0,
  sessionStatus: 'completed',
  structuredOutputDigest: `sha256:${'a'.repeat(64)}`,
  checkpoint: {
    sequence: 2,
    digest: `sha256:${'b'.repeat(64)}`,
    planVersion: 1,
    planItemId: 'verify-real-codex-adapter',
    headBranch: 'main',
    headSha: HEAD_SHA,
  },
  workspace: {
    headSha: HEAD_SHA,
    headBranch: 'main',
    repositoryClean: true,
    ephemeral: true,
  },
};

describe('Agent Adapter external evidence contract', () => {
  it('validates the strict example and returns only safe references', () => {
    expect(AgentAdapterEvidenceManifestV1Schema.safeParse(MANIFEST).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/agent-adapter-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(AgentAdapterEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(verifyAgentAdapterEvidence(MANIFEST)).toEqual({
      schemaVersion: '1',
      evidenceId: MANIFEST.evidenceId,
      provider: 'codex',
      status: 'passed',
      processExitCode: 0,
      sessionStatus: 'completed',
      checkpointSequence: 2,
      structuredOutputDigest: MANIFEST.structuredOutputDigest,
      checkpointDigest: MANIFEST.checkpoint.digest,
      headSha: HEAD_SHA,
      repositoryClean: true,
    });
  });

  it('rejects head/session/raw drift without reflecting supplied Secret', () => {
    expect(AgentAdapterEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      workspace: { ...MANIFEST.workspace, headSha: 'd'.repeat(40) },
    }).success).toBe(false);
    const raw = 'CANARY_AGENT_ADAPTER_RAW_OUTPUT';
    const error = (() => {
      try {
        verifyAgentAdapterEvidence({ ...MANIFEST, raw });
        return null;
      } catch (value) {
        return value;
      }
    })();
    expect(error).toBeInstanceOf(AgentAdapterEvidenceVerificationError);
    expect(String(error)).not.toContain(raw);
  });

  it('keeps the real adapter and manifest verifier behind explicit opt-in', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_CODEX_ADAPTER_E2E;
    const adapter = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-real-codex-adapter.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(adapter.status).toBe(2);
    expect(adapter.stdout).toBe('');
    expect(adapter.stderr).toContain('real-codex-adapter-e2e: opt-in missing');

    delete environment.DELIVERY_LOOP_AGENT_ADAPTER_E2E;
    const verifier = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-agent-adapter-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(verifier.status).toBe(2);
    expect(verifier.stdout).toBe('');
    expect(verifier.stderr).toContain('agent-adapter-e2e: opt-in missing');
  });
});
