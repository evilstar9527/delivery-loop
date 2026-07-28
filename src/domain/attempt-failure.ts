import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

// Copied from Watt packages/core/src/agent/expect-schema.ts at commit 476e3cd.
export const DEFAULT_MAX_ATTEMPTS = 3;

export function shouldRetry(
  attempt: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): boolean {
  return attempt < maxAttempts;
}

export const REPEATED_FAILURE_LIMIT = 2;

export const FAILURE_CODES = [
  'invalid_agent_output',
  'tool_unavailable',
  'tool_policy_denied',
  'command_nonzero_exit',
  'verification_nonzero_exit',
  'workspace_changed',
  'external_fact_conflict',
  'lease_timeout',
  'unknown_failure',
] as const;

export const FAILURE_SITES = [
  'agent_output',
  'repo_snapshot',
  'tool_repo_read',
  'tool_logs_search',
  'tool_trace_get',
  'tool_database_diagnose',
  'tool_k8s_diagnose',
  'policy_inspect',
  'policy_diagnose',
  'targeted_verification',
  'full_verification',
  'external_reconciliation',
] as const;

export const ATTEMPTED_PATHS = [
  'repository_inspection',
  'log_query',
  'trace_query',
  'database_diagnostic',
  'k8s_diagnostic',
  'plan_revision',
  'code_change',
  'targeted_test',
  'full_verification',
  'external_reconciliation',
] as const;

export const HUMAN_INPUT_CODES = [
  'clarify_requirement',
  'provide_reproduction',
  'grant_context_access',
  'resolve_external_dependency',
  'approve_policy_change',
  'manual_investigation',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];
export type FailureSite = (typeof FAILURE_SITES)[number];
export type AttemptedPath = (typeof ATTEMPTED_PATHS)[number];
export type HumanInputCode = (typeof HUMAN_INPUT_CODES)[number];
export type FailureClass =
  | 'invalid_output'
  | 'tool_error'
  | 'command_error'
  | 'verification_error'
  | 'policy_denied'
  | 'external_error'
  | 'timeout'
  | 'unknown';

export type RetryScopeMode = 'analysis' | 'execution' | 'deploy';

export const AttemptFailureReportV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    eventId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    sequence: z.number().int().positive(),
    type: z.literal('attempt_failed'),
    failureCode: z.enum(FAILURE_CODES),
    failureSite: z.enum(FAILURE_SITES),
    attemptedPaths: z
      .array(z.enum(ATTEMPTED_PATHS))
      .min(1)
      .max(ATTEMPTED_PATHS.length)
      .refine((paths) => new Set(paths).size === paths.length, 'attempted paths must be unique'),
    neededHumanInput: z.enum(HUMAN_INPUT_CODES),
    occurredAt: z.iso.datetime({ offset: true }),
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
  })
  .strict();

export type AttemptFailureReportV1 = z.infer<typeof AttemptFailureReportV1Schema>;

const FAILURE_CLASS_BY_CODE: Record<FailureCode, FailureClass> = {
  invalid_agent_output: 'invalid_output',
  tool_unavailable: 'tool_error',
  tool_policy_denied: 'policy_denied',
  command_nonzero_exit: 'command_error',
  verification_nonzero_exit: 'verification_error',
  workspace_changed: 'policy_denied',
  external_fact_conflict: 'external_error',
  lease_timeout: 'timeout',
  unknown_failure: 'unknown',
};

export const ATTEMPTED_PATH_LABELS: Record<AttemptedPath, string> = {
  repository_inspection: 'Inspected the trusted repository snapshot',
  log_query: 'Queried bounded diagnostic logs',
  trace_query: 'Queried a bounded request trace',
  database_diagnostic: 'Ran an allowlisted database diagnostic',
  k8s_diagnostic: 'Inspected allowlisted Kubernetes diagnostics',
  plan_revision: 'Revised the execution plan within policy',
  code_change: 'Applied a bounded code change',
  targeted_test: 'Ran trusted targeted verification',
  full_verification: 'Ran the trusted full verification command',
  external_reconciliation: 'Reconciled an external platform fact',
};

export const HUMAN_INPUT_PROMPTS: Record<HumanInputCode, string> = {
  clarify_requirement: 'Clarify the expected behavior or acceptance criterion.',
  provide_reproduction: 'Provide a minimal reproduction with expected and actual behavior.',
  grant_context_access: 'Grant the missing read-only context scope or provide a safe reference.',
  resolve_external_dependency: 'Resolve the external dependency and confirm when retry is safe.',
  approve_policy_change: 'Review and explicitly approve the requested policy or effect change.',
  manual_investigation: 'Review the safe failure summary and choose the next investigation path.',
};

export function failureClassFor(code: FailureCode): FailureClass {
  return FAILURE_CLASS_BY_CODE[code];
}

/** Implementation and review-fix Attempts consume one shared durable retry budget. */
export function retryScopeMode(mode: string): RetryScopeMode {
  if (mode === 'implement' || mode === 'review_fix') return 'execution';
  if (mode === 'analysis' || mode === 'deploy') return mode;
  throw new Error('Attempt mode cannot form a retry scope');
}

export async function retryScopeDigest(input: {
  runId: string;
  mode: RetryScopeMode;
  planId: string | null;
  planVersion: number | null;
  planItemId: string | null;
}): Promise<string> {
  return await canonicalSha256({ schemaVersion: '1', ...input });
}

export async function failureFingerprint(input: {
  retryScopeDigest: string;
  failureCode: FailureCode;
  failureSite: FailureSite;
  failureFactDigest?: string;
}): Promise<string> {
  return await canonicalSha256({
    schemaVersion: '1',
    retryScopeDigest: input.retryScopeDigest,
    failureCode: input.failureCode,
    failureSite: input.failureSite,
    ...(input.failureFactDigest === undefined
      ? {}
      : { failureFactDigest: input.failureFactDigest }),
  });
}
