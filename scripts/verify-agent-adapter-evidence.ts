import { AgentAdapterEvidenceManifestV1Schema } from '../src/domain/agent-adapter-evidence.js';
import {
  AgentAdapterEvidenceVerificationError,
  verifyAgentAdapterEvidence,
} from '../src/pilot/agent-adapter-evidence-verifier.js';

/** Contract-only verifier for a manifest produced by the real adapter runner. */
async function main(): Promise<void> {
  if (process.env.DELIVERY_LOOP_AGENT_ADAPTER_E2E !== '1') {
    console.error(
      'agent-adapter-e2e: opt-in missing (set DELIVERY_LOOP_AGENT_ADAPTER_E2E=1)',
    );
    process.exitCode = 2;
    return;
  }
  const raw = process.env.AGENT_ADAPTER_EVIDENCE_JSON ?? '';
  if (raw === '') {
    console.error('agent-adapter-e2e: evidence manifest is unavailable');
    process.exitCode = 2;
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    console.error('agent-adapter-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  if (!AgentAdapterEvidenceManifestV1Schema.safeParse(input).success) {
    console.error('agent-adapter-e2e: evidence manifest is invalid');
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(verifyAgentAdapterEvidence(input)));
  } catch (error) {
    const code = error instanceof AgentAdapterEvidenceVerificationError
      ? error.code
      : 'manifest_invalid';
    console.error(`agent-adapter-e2e: FAIL ${code}`);
    process.exitCode = 1;
  }
}

await main();
