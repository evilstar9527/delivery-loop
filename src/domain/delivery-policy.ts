import { parseDocument } from 'yaml';
import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

export const MAX_DELIVERY_POLICY_BYTES = 64 * 1_024;

const COMMAND_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const COMMAND_REF_PATTERN = /^(setup|test|verify|acceptance):([a-z][a-z0-9_-]{0,63})$/;
const ROLE_REF_PATTERN = /^(?:test|production):[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export const TEST_DEPLOYMENT_WORKFLOW_PATH = '.github/workflows/delivery-test-deploy.yml';
export const PRODUCTION_DEPLOYMENT_WORKFLOW_PATH =
  '.github/workflows/delivery-production-deploy.yml';
export const TEST_DEPLOYMENT_OIDC_AUDIENCE = 'delivery-loop-test-deploy';
export const PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE = 'delivery-loop-production-deploy';
export const TEST_ACCEPTANCE_WORKFLOW_PATH =
  '.github/workflows/delivery-test-acceptance.yml';
export const TEST_ACCEPTANCE_OIDC_AUDIENCE = 'delivery-loop-test-acceptance';
export const TEST_ROLLBACK_WORKFLOW_PATH =
  '.github/workflows/delivery-test-rollback.yml';
export const TEST_ROLLBACK_OIDC_AUDIENCE = 'delivery-loop-test-rollback';

export const TestRollbackTriggerSchema = z.enum([
  'deployment_failure',
  'acceptance_failure',
]);

const commandArgument = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\0\r\n]/.test(value), 'command arguments must be single-line');

const DeliveryCommandSchema = z
  .object({
    argv: z.array(commandArgument).min(1).max(64),
    timeoutSeconds: z.number().int().min(1).max(3_600),
  })
  .strict();

const CommandMapSchema = z
  .record(z.string().regex(COMMAND_ID_PATTERN), DeliveryCommandSchema)
  .refine((commands) => Object.keys(commands).length > 0, 'command group must not be empty')
  .refine((commands) => Object.keys(commands).length <= 50, 'command group is too large');

const TestRollbackContractSchema = z
  .object({
    workflowPath: z.literal(TEST_ROLLBACK_WORKFLOW_PATH),
    environment: z.literal('test'),
    oidcAudience: z.literal(TEST_ROLLBACK_OIDC_AUDIENCE),
    roleRef: z.string().regex(ROLE_REF_PATTERN).refine(
      (value) => value.startsWith('test:'),
      'rollback role must be test-specific',
    ),
    automaticOn: z
      .array(TestRollbackTriggerSchema)
      .min(1)
      .max(2)
      .refine(
        (triggers) => new Set(triggers).size === triggers.length,
        'rollback triggers must be unique',
      ),
    command: DeliveryCommandSchema,
  })
  .strict();

const protectedPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.startsWith('!') &&
      !value.includes('\\') &&
      !/[\0\r\n]/.test(value) &&
      !value.split('/').includes('..'),
    'protected path must be a safe repository-relative pattern',
  );

const deploymentTarget = (environment: 'test' | 'production') =>
  z
    .object({
      workflowPath: environment === 'test'
        ? z.literal(TEST_DEPLOYMENT_WORKFLOW_PATH)
        : z.literal(PRODUCTION_DEPLOYMENT_WORKFLOW_PATH),
      environment: z.literal(environment),
      oidcAudience: environment === 'test'
        ? z.literal(TEST_DEPLOYMENT_OIDC_AUDIENCE)
        : z.literal(PRODUCTION_DEPLOYMENT_OIDC_AUDIENCE),
      roleRef: z.string().regex(ROLE_REF_PATTERN).refine(
        (value) => value.startsWith(`${environment}:`),
        'deployment role must be environment-specific',
      ),
      command: DeliveryCommandSchema,
      verifyCommandRef: z.string().regex(/^verify:[a-z][a-z0-9_-]{0,63}$/),
      acceptanceCommandRef: environment === 'test'
        ? z.string().regex(/^acceptance:[a-z][a-z0-9_-]{0,63}$/)
        : z.string().regex(/^acceptance:[a-z][a-z0-9_-]{0,63}$/).optional(),
      rollback: environment === 'test'
        ? TestRollbackContractSchema.optional()
        : z.never().optional(),
    })
    .strict();

const DeploymentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('github_actions'),
      test: deploymentTarget('test').optional(),
      production: deploymentTarget('production').optional(),
    })
    .strict()
    .refine(
      (deployment) => deployment.test !== undefined || deployment.production !== undefined,
      'deployment contract requires at least one target',
    ),
]);

export const DeliveryPolicyV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    commands: z
      .object({
        setup: CommandMapSchema,
        targeted: CommandMapSchema,
        verify: CommandMapSchema,
        acceptance: CommandMapSchema.optional(),
      })
      .strict(),
    protectedPaths: z
      .array(protectedPath)
      .min(3)
      .max(200)
      .refine((paths) => new Set(paths).size === paths.length, 'protected paths must be unique')
      .refine(
        (paths) =>
          paths.includes('delivery.yaml') &&
          paths.includes('.github/workflows/**') &&
          paths.includes('CODEOWNERS'),
        'delivery policy must protect its policy, workflows, and CODEOWNERS',
      ),
    deployment: DeploymentSchema,
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.deployment.mode !== 'github_actions') return;
    const verificationRefs = new Set(
      Object.keys(policy.commands.verify).map((id) => `verify:${id}`),
    );
    const acceptanceRefs = new Set(
      Object.keys(policy.commands.acceptance ?? {}).map((id) => `acceptance:${id}`),
    );
    for (const target of [policy.deployment.test, policy.deployment.production]) {
      if (target !== undefined && !verificationRefs.has(target.verifyCommandRef)) {
        context.addIssue({
          code: 'custom',
          path: ['deployment'],
          message: 'deployment verification ref is not declared by the trusted policy',
        });
      }
      if (
        target?.environment === 'test' &&
        (
          target.acceptanceCommandRef === undefined ||
          !acceptanceRefs.has(target.acceptanceCommandRef)
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['deployment', 'test', 'acceptanceCommandRef'],
          message: 'test acceptance ref is not declared by the trusted policy',
        });
      }
      if (
        target?.environment === 'test' && target.rollback !== undefined &&
        target.rollback.roleRef === target.roleRef
      ) {
        context.addIssue({
          code: 'custom',
          path: ['deployment', 'test', 'rollback', 'roleRef'],
          message: 'test rollback must use a role distinct from deployment',
        });
      }
    }
  });

export type DeliveryPolicyV1 = z.infer<typeof DeliveryPolicyV1Schema>;
export type DeliveryCommandCategory = 'setup' | 'test' | 'verify' | 'acceptance';

export interface ParsedDeliveryPolicy {
  policy: DeliveryPolicyV1;
  digest: string;
}

export interface ResolvedDeliveryCommand {
  ref: string;
  category: DeliveryCommandCategory;
  command: string;
  args: string[];
  cwd: string;
  stdin: '';
  timeoutMs: number;
}

export interface ResolvedDeploymentCommand {
  environment: 'test' | 'production';
  command: string;
  args: string[];
  cwd: string;
  stdin: '';
  timeoutMs: number;
}

export interface ResolvedTestRollbackCommand {
  environment: 'test';
  command: string;
  args: string[];
  cwd: string;
  stdin: '';
  timeoutMs: number;
}

export class DeliveryPolicyError extends Error {
  constructor(reason: 'invalid_policy' | 'untrusted_command' = 'invalid_policy') {
    super(
      reason === 'untrusted_command'
        ? 'delivery command reference is not trusted'
        : 'delivery policy is invalid',
    );
    this.name = 'DeliveryPolicyError';
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export async function parseDeliveryPolicy(source: string): Promise<ParsedDeliveryPolicy> {
  if (
    new TextEncoder().encode(source).length > MAX_DELIVERY_POLICY_BYTES ||
    source.includes('\0')
  ) {
    throw new DeliveryPolicyError();
  }
  let value: unknown;
  try {
    const document = parseDocument(source, {
      schema: 'core',
      strict: true,
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new DeliveryPolicyError();
    }
    value = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch {
    throw new DeliveryPolicyError();
  }
  const parsed = DeliveryPolicyV1Schema.safeParse(value);
  if (!parsed.success) throw new DeliveryPolicyError();
  const policy = deepFreeze(parsed.data);
  return { policy, digest: await canonicalSha256(policy) };
}

export function deliveryPolicyCommandRefs(policy: DeliveryPolicyV1): string[] {
  return [
    ...Object.keys(policy.commands.setup).sort().map((id) => `setup:${id}`),
    ...Object.keys(policy.commands.targeted).sort().map((id) => `test:${id}`),
    ...Object.keys(policy.commands.verify).sort().map((id) => `verify:${id}`),
    ...Object.keys(policy.commands.acceptance ?? {}).sort()
      .map((id) => `acceptance:${id}`),
  ];
}

export function resolveDeliveryCommand(
  policy: DeliveryPolicyV1,
  commandRef: string,
  repositoryPath: string,
): ResolvedDeliveryCommand {
  const match = COMMAND_REF_PATTERN.exec(commandRef);
  if (match === null) {
    throw new DeliveryPolicyError('untrusted_command');
  }
  if (!repositoryPath.startsWith('/')) {
    throw new DeliveryPolicyError();
  }
  const category = match[1] as DeliveryCommandCategory;
  const commandId = match[2]!;
  const command = category === 'setup'
    ? policy.commands.setup[commandId]
    : category === 'test'
      ? policy.commands.targeted[commandId]
      : category === 'verify'
        ? policy.commands.verify[commandId]
        : policy.commands.acceptance?.[commandId];
  if (command === undefined) {
    throw new DeliveryPolicyError('untrusted_command');
  }
  return {
    ref: commandRef,
    category,
    command: command.argv[0]!,
    args: command.argv.slice(1),
    cwd: repositoryPath,
    stdin: '',
    timeoutMs: command.timeoutSeconds * 1_000,
  };
}

/** Deployment commands are policy-bound but deliberately excluded from Agent Plan command refs. */
export function resolveDeploymentCommand(
  policy: DeliveryPolicyV1,
  environment: 'test' | 'production',
  repositoryPath: string,
): ResolvedDeploymentCommand {
  if (!repositoryPath.startsWith('/') || policy.deployment.mode !== 'github_actions') {
    throw new DeliveryPolicyError();
  }
  const target = policy.deployment[environment];
  if (target === undefined) throw new DeliveryPolicyError('untrusted_command');
  return {
    environment,
    command: target.command.argv[0]!,
    args: target.command.argv.slice(1),
    cwd: repositoryPath,
    stdin: '',
    timeoutMs: target.command.timeoutSeconds * 1_000,
  };
}

/** Rollback argv is commit-bound policy, never a Plan or failure-payload command. */
export function resolveTestRollbackCommand(
  policy: DeliveryPolicyV1,
  repositoryPath: string,
): ResolvedTestRollbackCommand {
  if (
    !repositoryPath.startsWith('/') || policy.deployment.mode !== 'github_actions' ||
    policy.deployment.test?.rollback === undefined
  ) throw new DeliveryPolicyError('untrusted_command');
  const command = policy.deployment.test.rollback.command;
  return {
    environment: 'test',
    command: command.argv[0]!,
    args: command.argv.slice(1),
    cwd: repositoryPath,
    stdin: '',
    timeoutMs: command.timeoutSeconds * 1_000,
  };
}
