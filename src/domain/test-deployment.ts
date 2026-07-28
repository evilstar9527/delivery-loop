import { z } from 'zod';
import {
  TEST_DEPLOYMENT_OIDC_AUDIENCE,
  TEST_DEPLOYMENT_WORKFLOW_PATH,
} from './delivery-policy.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TEST_ROLE_PATTERN = /^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const TestDeploymentTargetSchema = z.object({
  repository: z.string().regex(REPOSITORY_PATTERN),
  environment: z.literal('test'),
  workflowPath: z.literal(TEST_DEPLOYMENT_WORKFLOW_PATH),
  oidcAudience: z.literal(TEST_DEPLOYMENT_OIDC_AUDIENCE),
  roleRef: z.string().regex(TEST_ROLE_PATTERN),
}).strict();

const TestDeploymentTargetsSchema = z.array(TestDeploymentTargetSchema)
  .min(1)
  .max(100)
  .refine(
    (targets) => new Set(targets.map((target) => target.repository)).size === targets.length,
    'test deployment repositories must be unique',
  );

export type TestDeploymentTarget = z.infer<typeof TestDeploymentTargetSchema>;

export function testDeploymentTargetsFromJson(raw: string): ReadonlyMap<string, TestDeploymentTarget> {
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('test deployment configuration is invalid');
  }
  const parsed = TestDeploymentTargetsSchema.safeParse(input);
  if (!parsed.success) throw new Error('test deployment configuration is invalid');
  return new Map(parsed.data.map((target) => [target.repository, Object.freeze(target)]));
}
