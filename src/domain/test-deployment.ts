import { z } from 'zod';
import {
  TEST_DEPLOYMENT_OIDC_AUDIENCE,
  TEST_DEPLOYMENT_WORKFLOW_PATH,
} from './delivery-policy.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TEST_ROLE_PATTERN = /^test:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PIPELINE_ID_PATTERN = /^[0-9]{1,32}$/;
const YUNXIAO_REPOSITORY_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+\.git$/;

export const TestDeploymentTargetSchema = z.object({
  repository: z.string().regex(REPOSITORY_PATTERN),
  provider: z.enum(['github_actions', 'yunxiao_pipeline']).default('github_actions'),
  environment: z.literal('test'),
  workflowPath: z.literal(TEST_DEPLOYMENT_WORKFLOW_PATH),
  oidcAudience: z.literal(TEST_DEPLOYMENT_OIDC_AUDIENCE),
  roleRef: z.string().regex(TEST_ROLE_PATTERN),
  organizationId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  pipelineId: z.string().regex(PIPELINE_ID_PATTERN).optional(),
  repositoryUrl: z.string().regex(YUNXIAO_REPOSITORY_URL_PATTERN).optional(),
}).strict().superRefine((target, context) => {
  if (target.provider === 'yunxiao_pipeline') {
    if (target.organizationId === undefined) {
      context.addIssue({ code: 'custom', path: ['organizationId'], message: 'Yunxiao organizationId is required' });
    }
    if (target.pipelineId === undefined) {
      context.addIssue({ code: 'custom', path: ['pipelineId'], message: 'Yunxiao pipelineId is required' });
    }
    if (target.repositoryUrl === undefined) {
      context.addIssue({ code: 'custom', path: ['repositoryUrl'], message: 'Yunxiao repositoryUrl is required' });
    }
  } else if (
    target.organizationId !== undefined || target.pipelineId !== undefined ||
    target.repositoryUrl !== undefined
  ) {
    context.addIssue({ code: 'custom', path: ['provider'], message: 'Yunxiao fields require yunxiao_pipeline provider' });
  }
});

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
