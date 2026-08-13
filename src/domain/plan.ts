import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

export const PLAN_EFFECTS = [
  'repo_read',
  'logs_read',
  'database_diagnostic',
  'repo_write',
  'test_deploy',
  'merge',
  'production_deploy',
] as const;

export const EVIDENCE_KINDS = [
  'diagnostic',
  'plan',
  'test',
  'lint',
  'build',
  'commit',
  'pull_request',
  'check',
  'deployment',
  'approval',
] as const;

const PLAN_STATUSES = [
  'proposed',
  'validated',
  'approved',
  'active',
  'superseded',
  'completed',
  'blocked',
] as const;

const ITEM_KINDS = ['investigation', 'change', 'verification', 'delivery'] as const;
const EXTERNAL_FACTS = ['github_pr', 'github_check', 'deployment'] as const;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const nonBlank = (maximum: number): z.ZodString =>
  z.string().min(1).max(maximum).refine((value) => /\S/.test(value), 'must not be blank');

export const PlanEffectSchema = z.enum(PLAN_EFFECTS);
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const PlanItemV1Schema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(ITEM_KINDS),
    title: nonBlank(200),
    objective: nonBlank(2_000),
    acceptanceCriteriaIndexes: z.array(z.number().int().nonnegative()).max(100),
    doneWhen: z.array(nonBlank(1_000)).min(1).max(50),
    verification: z
      .object({
        commandRefs: z.array(nonBlank(200)).max(50).optional(),
        evidenceKinds: z.array(EvidenceKindSchema).min(1).max(EVIDENCE_KINDS.length),
        externalFacts: z.array(z.enum(EXTERNAL_FACTS)).max(EXTERNAL_FACTS.length).optional(),
      })
      .strict(),
    effects: z.array(PlanEffectSchema).max(PLAN_EFFECTS.length),
    dependsOn: z.array(z.string().min(1).max(64)).max(200),
    required: z.boolean(),
  })
  .strict();

export const ExecutionPlanBodyV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    runId: z.string().min(1).max(64),
    version: z.number().int().positive(),
    taskRevision: z.string().min(1).max(256),
    baseSha: z.string().regex(BASE_SHA_PATTERN),
    createdByAttemptId: z.string().min(1).max(128),
    objective: nonBlank(4_000),
    assumptions: z.array(nonBlank(1_000)).max(100),
    evidenceRefs: z.array(nonBlank(500)).max(200),
    items: z.array(PlanItemV1Schema).min(1).max(200),
  })
  .strict();

export const ExecutionPlanV1Schema = ExecutionPlanBodyV1Schema.extend({
  digest: z.string().regex(SHA256_DIGEST_PATTERN),
  status: z.enum(PLAN_STATUSES),
}).strict();

export type PlanEffect = z.infer<typeof PlanEffectSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type PlanItemV1 = z.infer<typeof PlanItemV1Schema>;
export type ExecutionPlanBodyV1 = z.infer<typeof ExecutionPlanBodyV1Schema>;
export type ExecutionPlanV1 = z.infer<typeof ExecutionPlanV1Schema>;

export interface ExecutionPlanValidationContext {
  runId: string;
  taskRevision: string;
  baseSha: string;
  expectedVersion: number;
  acceptanceCriteriaCount: number;
  allowedCommandRefs: readonly string[];
  /** Trusted subset that actually performs test/lint/build verification. */
  verificationCommandRefs?: readonly string[];
  allowedEffects: readonly PlanEffect[];
  /** Trusted Task/policy classification; never derived from Agent-authored Plan text. */
  requiresRepositoryChange: boolean;
  /** Trusted test-target classification; requires a separately schedulable delivery Item. */
  requiresTestDeployment?: boolean;
  /**
   * Runner-owned, policy-filtered tracked paths. When present, writable Items
   * must name one exactly so execution can materialize its bounded fallback.
   */
  writableRepositoryPaths?: readonly string[];
}

export type ExecutionPlanValidationIssueCode =
  | 'schema_invalid'
  | 'item_id_invalid'
  | 'duplicate_item_id'
  | 'dependency_missing'
  | 'dependency_cycle'
  | 'done_when_required'
  | 'evidence_required'
  | 'command_ref_not_allowed'
  | 'effect_not_allowed'
  | 'acceptance_criterion_uncovered'
  | 'repository_change_required'
  | 'repository_path_required'
  | 'verification_required_after_change'
  | 'evidence_kind_not_producible'
  | 'external_fact_not_producible'
  | 'test_deployment_contract_required'
  | 'duplicate_value'
  | 'acceptance_criterion_out_of_range'
  | 'run_mismatch'
  | 'task_revision_mismatch'
  | 'base_sha_mismatch'
  | 'version_mismatch'
  | 'digest_mismatch'
  | 'status_not_proposed';

export interface ExecutionPlanValidationIssue {
  code: ExecutionPlanValidationIssueCode;
  path: string;
  message: string;
}

export class ExecutionPlanValidationError extends Error {
  constructor(readonly issues: readonly ExecutionPlanValidationIssue[]) {
    super(`ExecutionPlan validation failed with ${issues.length} issue(s)`);
    this.name = 'ExecutionPlanValidationError';
  }
}

export async function computeExecutionPlanDigest(
  body: ExecutionPlanBodyV1,
): Promise<string> {
  return await canonicalSha256(body);
}

function immutableBody(plan: ExecutionPlanV1): ExecutionPlanBodyV1 {
  return {
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    runId: plan.runId,
    version: plan.version,
    taskRevision: plan.taskRevision,
    baseSha: plan.baseSha,
    createdByAttemptId: plan.createdByAttemptId,
    objective: plan.objective,
    assumptions: plan.assumptions,
    evidenceRefs: plan.evidenceRefs,
    items: plan.items,
  };
}

function schemaIssueCode(issue: z.core.$ZodIssue): ExecutionPlanValidationIssueCode {
  const path = issue.path.map(String);
  if (path.at(-1) === 'doneWhen' && issue.code === 'too_small') return 'done_when_required';
  if (path.at(-1) === 'evidenceKinds' && issue.code === 'too_small') return 'evidence_required';
  return 'schema_invalid';
}

function duplicateValues(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

const REPOSITORY_PATH_ADJACENT_CHARACTER = /[\p{L}\p{N}._/-]/u;

export function explicitlyReferencesRepositoryPath(
  text: string,
  paths: readonly string[],
): boolean {
  return paths.some((path) => {
    if (path.length === 0) return false;
    let offset = 0;
    while (offset <= text.length - path.length) {
      const index = text.indexOf(path, offset);
      if (index < 0) return false;
      const before = index === 0 ? undefined : text[index - 1];
      const afterIndex = index + path.length;
      const after = afterIndex === text.length ? undefined : text[afterIndex];
      const periodIsSentencePunctuation = after === '.' &&
        (text[afterIndex + 1] === undefined || /\s/u.test(text[afterIndex + 1]!));
      if (
        (before === undefined || !REPOSITORY_PATH_ADJACENT_CHARACTER.test(before)) &&
        (
          after === undefined || !REPOSITORY_PATH_ADJACENT_CHARACTER.test(after) ||
          periodIsSentencePunctuation
        )
      ) return true;
      offset = index + 1;
    }
    return false;
  });
}

function dependencyGraphHasCycle(items: readonly PlanItemV1[]): boolean {
  const dependencies = new Map(items.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (itemId: string): boolean => {
    if (visiting.has(itemId)) return true;
    if (visited.has(itemId)) return false;
    visiting.add(itemId);
    for (const dependency of dependencies.get(itemId) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(itemId);
    visited.add(itemId);
    return false;
  };

  return items.some((item) => visit(item.id));
}

function dependsTransitivelyOn(
  itemId: string,
  dependencyId: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): boolean {
  const pending = [...(dependencies.get(itemId) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === dependencyId) return true;
    visited.add(current);
    pending.push(...(dependencies.get(current) ?? []));
  }
  return false;
}

/**
 * Treats Agent output as an untrusted proposal and binds it to trusted Run/policy context.
 * The returned object is safe to persist as `validated`; it is not approved to execute.
 */
export async function validateExecutionPlanProposal(
  input: unknown,
  context: ExecutionPlanValidationContext,
): Promise<ExecutionPlanV1> {
  const parsed = ExecutionPlanV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new ExecutionPlanValidationError(
      parsed.error.issues.map((issue) => ({
        code: schemaIssueCode(issue),
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  const plan = parsed.data;
  const issues: ExecutionPlanValidationIssue[] = [];
  const push = (
    code: ExecutionPlanValidationIssueCode,
    path: string,
    message: string,
  ): void => {
    issues.push({ code, path, message });
  };

  if (plan.status !== 'proposed') {
    push('status_not_proposed', 'status', 'Agent-generated plans must be proposed');
  }
  if (plan.runId !== context.runId) {
    push('run_mismatch', 'runId', 'plan run does not match trusted context');
  }
  if (plan.taskRevision !== context.taskRevision) {
    push(
      'task_revision_mismatch',
      'taskRevision',
      'plan task revision does not match trusted context',
    );
  }
  if (plan.baseSha !== context.baseSha) {
    push('base_sha_mismatch', 'baseSha', 'plan base SHA does not match trusted context');
  }
  if (plan.version !== context.expectedVersion) {
    push('version_mismatch', 'version', 'plan version is not the expected next version');
  }
  if (duplicateValues(plan.assumptions)) {
    push('duplicate_value', 'assumptions', 'assumptions must not contain duplicates');
  }
  if (duplicateValues(plan.evidenceRefs)) {
    push('duplicate_value', 'evidenceRefs', 'evidenceRefs must not contain duplicates');
  }

  const itemIds = new Set<string>();
  const allowedCommandRefs = new Set(context.allowedCommandRefs);
  const allowedEffects = new Set(context.allowedEffects);
  let hasRequiredTestDeployment = false;
  for (const [index, item] of plan.items.entries()) {
    const itemPath = `items.${index}`;
    if (!ITEM_ID_PATTERN.test(item.id)) {
      push('item_id_invalid', `${itemPath}.id`, 'item id is not a stable identifier');
    }
    if (itemIds.has(item.id)) {
      push('duplicate_item_id', `${itemPath}.id`, 'item id must be unique within the plan');
    }
    itemIds.add(item.id);

    const arrays: Array<[string, readonly unknown[]]> = [
      ['acceptanceCriteriaIndexes', item.acceptanceCriteriaIndexes],
      ['doneWhen', item.doneWhen],
      ['evidenceKinds', item.verification.evidenceKinds],
      ['commandRefs', item.verification.commandRefs ?? []],
      ['externalFacts', item.verification.externalFacts ?? []],
      ['effects', item.effects],
      ['dependsOn', item.dependsOn],
    ];
    for (const [name, values] of arrays) {
      if (duplicateValues(values)) {
        push('duplicate_value', `${itemPath}.${name}`, `${name} must not contain duplicates`);
      }
    }

    for (const criterionIndex of item.acceptanceCriteriaIndexes) {
      if (criterionIndex >= context.acceptanceCriteriaCount) {
        push(
          'acceptance_criterion_out_of_range',
          `${itemPath}.acceptanceCriteriaIndexes`,
          'acceptance criterion index is outside the trusted task snapshot',
        );
      }
    }
    for (const commandRef of item.verification.commandRefs ?? []) {
      if (!allowedCommandRefs.has(commandRef)) {
        push(
          'command_ref_not_allowed',
          `${itemPath}.verification.commandRefs`,
          'command reference is not in the trusted delivery policy',
        );
      }
    }
    for (const effect of item.effects) {
      if (!allowedEffects.has(effect)) {
        push(
          'effect_not_allowed',
          `${itemPath}.effects`,
          'effect exceeds the trusted task policy ceiling',
        );
      }
    }
  }

  const coveredCriteria = new Set(
    plan.items
      .filter((item) => item.required)
      .flatMap((item) => item.acceptanceCriteriaIndexes),
  );
  for (let criterionIndex = 0; criterionIndex < context.acceptanceCriteriaCount; criterionIndex += 1) {
    if (!coveredCriteria.has(criterionIndex)) {
      push(
        'acceptance_criterion_uncovered',
        'items',
        `acceptance criterion ${criterionIndex} is not covered by a required item`,
      );
    }
  }

  const dependencies = new Map(plan.items.map((item) => [item.id, item.dependsOn]));
  const verificationCommandRefs = new Set(
    context.verificationCommandRefs ??
      context.allowedCommandRefs.filter((ref) => /^(?:test|verify|lint|build):/.test(ref)),
  );
  const verifications = plan.items.filter(
    (item) =>
      item.kind === 'verification' &&
      item.required &&
      (item.verification.commandRefs ?? []).some((ref) => verificationCommandRefs.has(ref)) &&
      item.verification.evidenceKinds.some((kind) =>
        kind === 'test' || kind === 'lint' || kind === 'build'),
  );
  const selfVerifyingChanges = plan.items.filter((item) => {
    const commandRefs = item.verification.commandRefs ?? [];
    return item.kind === 'change' && item.required && item.effects.includes('repo_write') &&
      commandRefs.some((ref) => ref.startsWith('test:')) &&
      commandRefs.some((ref) => ref.startsWith('verify:') && verificationCommandRefs.has(ref)) &&
      item.verification.evidenceKinds.includes('commit') &&
      item.verification.evidenceKinds.includes('test');
  });
  if (context.requiresRepositoryChange) {
    for (const [index, item] of plan.items.entries()) {
      if (
        item.kind === 'investigation' &&
        (
          item.required ||
          selfVerifyingChanges.some((change) =>
            dependsTransitivelyOn(change.id, item.id, dependencies))
        )
      ) {
        push(
          'repository_change_required',
          `items.${index}`,
          'repository inspection is completed by analysis and cannot remain as a required execution dependency',
        );
      }
    }
  }
  let hasRequiredRepositoryChange = false;
  for (const [index, item] of plan.items.entries()) {
    if (item.kind !== 'change' && !item.effects.includes('repo_write')) continue;
    const commandRefs = item.verification.commandRefs ?? [];
    const selfVerifying =
      item.kind === 'change' &&
      item.required &&
      item.effects.includes('repo_write') &&
      commandRefs.some((ref) => ref.startsWith('test:')) &&
      commandRefs.some((ref) => ref.startsWith('verify:') && verificationCommandRefs.has(ref)) &&
      item.verification.evidenceKinds.includes('commit') &&
      item.verification.evidenceKinds.includes('test');
    if (
      item.kind === 'change' &&
      item.required &&
      item.effects.includes('repo_write') &&
      item.verification.evidenceKinds.some(
        (kind) => kind !== 'commit' && kind !== 'test',
      )
    ) {
      push(
        'evidence_kind_not_producible',
        `items.${index}.verification.evidenceKinds`,
        'a pre-PR repository change can produce only commit and test Evidence',
      );
    }
    if (
      item.kind === 'change' &&
      item.required &&
      item.effects.includes('repo_write') &&
      (item.verification.externalFacts?.length ?? 0) > 0
    ) {
      push(
        'external_fact_not_producible',
        `items.${index}.verification.externalFacts`,
        'a pre-PR repository change cannot require a future external fact',
      );
    }
    if (selfVerifying) hasRequiredRepositoryChange = true;
    if (
      context.requiresRepositoryChange && selfVerifying &&
      context.writableRepositoryPaths !== undefined &&
      !explicitlyReferencesRepositoryPath(
        [item.objective, ...item.doneWhen].join('\n'),
        context.writableRepositoryPaths,
      )
    ) {
      push(
        'repository_path_required',
        `items.${index}`,
        'a required repository change must name an exact trusted writable path',
      );
    }
    const downstreamVerification = verifications.some((verification) =>
      dependsTransitivelyOn(verification.id, item.id, dependencies));
    if (!selfVerifying && !downstreamVerification) {
      push(
        'verification_required_after_change',
        `items.${index}`,
        'every change must verify its committed head or feed a required trusted verification',
      );
    }
  }
  if (context.requiresRepositoryChange && !hasRequiredRepositoryChange) {
    push(
      'repository_change_required',
      'items',
      'trusted task policy requires one self-verifying required repository change',
    );
  }

  for (const [index, item] of plan.items.entries()) {
    if (!item.effects.includes('test_deploy')) continue;
    const commandRefs = item.verification.commandRefs ?? [];
    const externalFacts = item.verification.externalFacts ?? [];
    const validTestDeployment =
      item.kind === 'delivery' &&
      item.required &&
      item.effects.length === 1 &&
      commandRefs.length === 0 &&
      item.verification.evidenceKinds.length === 1 &&
      item.verification.evidenceKinds[0] === 'deployment' &&
      externalFacts.length === 1 &&
      externalFacts[0] === 'deployment' &&
      selfVerifyingChanges.some((change) => item.dependsOn.includes(change.id));
    if (validTestDeployment) hasRequiredTestDeployment = true;
    if (!validTestDeployment) {
      push(
        'test_deployment_contract_required',
        `items.${index}`,
        'test deployment must be a required delivery item with only deployment Evidence/external fact and a direct self-verifying change dependency',
      );
    }
  }
  if (context.requiresTestDeployment === true && !hasRequiredTestDeployment) {
    push(
      'test_deployment_contract_required',
      'items',
      'trusted test-target policy requires one separately schedulable test deployment item',
    );
  }

  for (const [index, item] of plan.items.entries()) {
    for (const dependency of item.dependsOn) {
      if (!itemIds.has(dependency)) {
        push(
          'dependency_missing',
          `items.${index}.dependsOn`,
          'dependency does not reference an item in this plan',
        );
      }
    }
  }
  if (dependencyGraphHasCycle(plan.items)) {
    push('dependency_cycle', 'items', 'plan item dependency graph must be acyclic');
  }

  const expectedDigest = await computeExecutionPlanDigest(immutableBody(plan));
  if (plan.digest !== expectedDigest) {
    push('digest_mismatch', 'digest', 'plan digest does not match immutable plan content');
  }

  if (issues.length > 0) throw new ExecutionPlanValidationError(issues);
  return plan;
}
