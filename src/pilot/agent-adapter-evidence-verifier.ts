import {
  AgentAdapterEvidenceManifestV1Schema,
  type AgentAdapterEvidenceManifestV1,
} from '../domain/agent-adapter-evidence.js';

export type AgentAdapterEvidenceVerificationErrorCode = 'manifest_invalid';

export class AgentAdapterEvidenceVerificationError extends Error {
  constructor(readonly code: AgentAdapterEvidenceVerificationErrorCode) {
    super(`Agent adapter evidence verification failed: ${code}`);
    this.name = 'AgentAdapterEvidenceVerificationError';
  }
}

export interface AgentAdapterEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  provider: 'codex';
  status: 'passed';
  processExitCode: 0;
  sessionStatus: 'completed';
  checkpointSequence: number;
  structuredOutputDigest: string;
  checkpointDigest: string;
  headSha: string;
  repositoryClean: true;
}

/** Validate only the safe reference projection; never logs the supplied object. */
export function verifyAgentAdapterEvidence(
  input: unknown,
): AgentAdapterEvidenceVerificationSummary {
  const parsed = AgentAdapterEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new AgentAdapterEvidenceVerificationError('manifest_invalid');
  const manifest: AgentAdapterEvidenceManifestV1 = parsed.data;
  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    provider: manifest.provider,
    status: manifest.status,
    processExitCode: manifest.processExitCode,
    sessionStatus: manifest.sessionStatus,
    checkpointSequence: manifest.checkpoint.sequence,
    structuredOutputDigest: manifest.structuredOutputDigest,
    checkpointDigest: manifest.checkpoint.digest,
    headSha: manifest.workspace.headSha,
    repositoryClean: manifest.workspace.repositoryClean,
  };
}
