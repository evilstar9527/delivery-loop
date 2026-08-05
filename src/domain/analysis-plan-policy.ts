import type { PlanEffect } from './plan.js';

export const ANALYSIS_READ_EFFECTS = [
  'repo_read',
  'logs_read',
  'database_diagnostic',
] as const satisfies readonly PlanEffect[];

export const ANALYSIS_READ_COMMAND_REFS = ['policy:inspect', 'policy:diagnose'] as const;

/** Current pilot repository refs, frozen from the trusted delivery.yaml contract. */
export const ANALYSIS_PILOT_CHANGE_COMMAND_REFS = ['test:unit', 'verify:all'] as const;
export const ANALYSIS_PILOT_VERIFICATION_COMMAND_REFS = ['verify:all'] as const;

export interface AnalysisPlanPolicy {
  allowedEffects: readonly PlanEffect[];
  allowedCommandRefs: readonly string[];
  verificationCommandRefs: readonly string[];
  requiresRepositoryChange: boolean;
}

/** Derives the Plan proposal ceiling from trusted Task classification, never Task prose. */
export function deriveAnalysisPlanPolicy(
  intentKind: 'requirement' | 'bug',
  allowRepositoryWrite: boolean,
): AnalysisPlanPolicy {
  return {
    allowedEffects: allowRepositoryWrite
      ? [...ANALYSIS_READ_EFFECTS, 'repo_write']
      : ANALYSIS_READ_EFFECTS,
    allowedCommandRefs: allowRepositoryWrite
      ? [...ANALYSIS_READ_COMMAND_REFS, ...ANALYSIS_PILOT_CHANGE_COMMAND_REFS]
      : ANALYSIS_READ_COMMAND_REFS,
    verificationCommandRefs: allowRepositoryWrite
      ? ANALYSIS_PILOT_VERIFICATION_COMMAND_REFS
      : [],
    requiresRepositoryChange: intentKind === 'requirement' && allowRepositoryWrite,
  };
}
