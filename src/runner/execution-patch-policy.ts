import {
  PatchProposalSchema,
  type PatchProposal,
} from '../domain/patch-proposal.js';
import { isProtectedRepositoryPath } from '../domain/protected-path-change.js';
import { SecretScanner } from '../security/redaction.js';

export class ExecutionPatchPolicyError extends Error {
  constructor() {
    super('execution patch proposal is not allowed');
    this.name = 'ExecutionPatchPolicyError';
  }
}

/** Content-only policy gate; filesystem/Git preconditions remain in GitRepositoryWriter. */
export function validateExecutionPatchProposal(
  rawProposal: PatchProposal,
  protectedPaths: readonly string[],
  runtimeSecrets: readonly string[],
): PatchProposal {
  const parsed = PatchProposalSchema.safeParse(rawProposal);
  if (
    !parsed.success ||
    new SecretScanner({ secrets: runtimeSecrets }).scan(parsed.data).length > 0 ||
    parsed.data.changes.some((change) =>
      isProtectedRepositoryPath(change.path, protectedPaths))
  ) throw new ExecutionPatchPolicyError();
  return structuredClone(parsed.data);
}
