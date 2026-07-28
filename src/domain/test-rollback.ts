import { z } from 'zod';
import {
  TEST_ROLLBACK_OIDC_AUDIENCE,
  TEST_ROLLBACK_WORKFLOW_PATH,
  TestRollbackTriggerSchema,
  type ParsedDeliveryPolicy,
} from './delivery-policy.js';
import { canonicalSha256 } from './digest.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TEST_ROLE_PATTERN = /^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export type TestRollbackSourceKind = z.infer<typeof TestRollbackTriggerSchema>;

export const TestRollbackTargetSchema = z.object({
  repository: z.string().regex(REPOSITORY_PATTERN),
  environment: z.literal('test'),
  workflowPath: z.literal(TEST_ROLLBACK_WORKFLOW_PATH),
  oidcAudience: z.literal(TEST_ROLLBACK_OIDC_AUDIENCE),
  roleRef: z.string().regex(TEST_ROLE_PATTERN),
  sourceKind: TestRollbackTriggerSchema,
  policyDigest: z.string().regex(DIGEST_PATTERN),
  contractDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

export type TestRollbackTarget = z.infer<typeof TestRollbackTargetSchema>;

/** Returns an executable snapshot only when the exact commit opts into this failure trigger. */
export async function testRollbackTargetFromPolicy(
  repository: string,
  sourceKind: TestRollbackSourceKind,
  parsed: ParsedDeliveryPolicy,
): Promise<TestRollbackTarget | null> {
  if (parsed.policy.deployment.mode !== 'github_actions') return null;
  const deployment = parsed.policy.deployment.test;
  const rollback = deployment?.rollback;
  if (
    deployment === undefined || rollback === undefined ||
    !rollback.automaticOn.includes(sourceKind) || rollback.roleRef === deployment.roleRef
  ) return null;
  return TestRollbackTargetSchema.parse({
    repository,
    environment: rollback.environment,
    workflowPath: rollback.workflowPath,
    oidcAudience: rollback.oidcAudience,
    roleRef: rollback.roleRef,
    sourceKind,
    policyDigest: parsed.digest,
    contractDigest: await canonicalSha256(rollback),
  });
}

