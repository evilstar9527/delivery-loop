import { z } from 'zod';
import {
  PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE,
  PRODUCTION_DEPLOYMENT_WORKFLOW_PATH,
} from './delivery-policy.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PRODUCTION_ROLE_PATTERN =
  /^production:[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const ProductionDeploymentTargetSchema = z.object({
  repository: z.string().regex(REPOSITORY_PATTERN),
  environment: z.literal('production'),
  workflowPath: z.literal(PRODUCTION_DEPLOYMENT_WORKFLOW_PATH),
  oidcAudience: z.literal(PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE),
  roleRef: z.string().regex(PRODUCTION_ROLE_PATTERN),
}).strict();

const ProductionDeploymentTargetsSchema = z.array(ProductionDeploymentTargetSchema)
  .min(1)
  .max(100)
  .refine(
    (targets) => new Set(targets.map((target) => target.repository)).size === targets.length,
    'production deployment repositories must be unique',
  );

export type ProductionDeploymentTarget = z.infer<typeof ProductionDeploymentTargetSchema>;

export function productionDeploymentTargetsFromJson(
  raw: string,
): ReadonlyMap<string, ProductionDeploymentTarget> {
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('production deployment configuration is invalid');
  }
  const parsed = ProductionDeploymentTargetsSchema.safeParse(input);
  if (!parsed.success) throw new Error('production deployment configuration is invalid');
  return new Map(parsed.data.map((target) => [target.repository, Object.freeze(target)]));
}
