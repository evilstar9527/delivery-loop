import type { PlanEffect } from './plan.js';

export const ANALYSIS_READ_EFFECTS = [
  'repo_read',
  'logs_read',
  'database_diagnostic',
] as const satisfies readonly PlanEffect[];

export const ANALYSIS_READ_COMMAND_REFS = ['policy:inspect', 'policy:diagnose'] as const;

/**
 * Current pilot repository refs, frozen from the trusted delivery.yaml contract.
 * These are the in-sandbox verification commands the analysis agent may attach
 * to a self-verifying change Item, so they must stay lightweight enough to run
 * on the small executor sandbox (0.5 vCPU). The authoritative full suite
 * (`pnpm run verify`) runs as the target repository's pull_request CI, which is
 * the enforced merge gate — not inside the sandbox.
 */
export const ANALYSIS_PILOT_CHANGE_COMMAND_REFS = ['test:typecheck', 'verify:typecheck'] as const;
export const ANALYSIS_PILOT_VERIFICATION_COMMAND_REFS = ['verify:typecheck'] as const;

export interface AnalysisPlanPolicy {
  allowedEffects: readonly PlanEffect[];
  allowedCommandRefs: readonly string[];
  verificationCommandRefs: readonly string[];
  requiresRepositoryChange: boolean;
  requiresTestDeployment: boolean;
}

/** Derives the Plan proposal ceiling from trusted Task classification, never Task prose. */
export function deriveAnalysisPlanPolicy(
  intentKind: 'requirement' | 'bug',
  allowRepositoryWrite: boolean,
  allowTestDeploy = false,
  targetEnvironment: 'none' | 'test' | 'production' = 'none',
): AnalysisPlanPolicy {
  const allowsTestDeployment =
    allowRepositoryWrite && allowTestDeploy && targetEnvironment === 'test';
  return {
    allowedEffects: allowRepositoryWrite
      ? [...ANALYSIS_READ_EFFECTS, 'repo_write', ...(allowsTestDeployment ? ['test_deploy' as const] : [])]
      : ANALYSIS_READ_EFFECTS,
    allowedCommandRefs: allowRepositoryWrite
      ? [...ANALYSIS_READ_COMMAND_REFS, ...ANALYSIS_PILOT_CHANGE_COMMAND_REFS]
      : ANALYSIS_READ_COMMAND_REFS,
    verificationCommandRefs: allowRepositoryWrite
      ? ANALYSIS_PILOT_VERIFICATION_COMMAND_REFS
      : [],
    // A writable intake is an execution request regardless of whether it began
    // as a PRD or a bug report. Read-only bug intake remains investigation-only.
    requiresRepositoryChange: allowRepositoryWrite,
    requiresTestDeployment: allowsTestDeployment,
  };
}
