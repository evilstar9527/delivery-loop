import type { PlanEffect } from './plan.js';

const PLAN_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const VERIFY_ANALYSIS_REPLAY_STEP = 'verify-analysis-result';

export interface WorkflowRestartTarget {
  name: string;
  type: 'do' | 'sleep' | 'waitForEvent';
  count: number;
}

export type WorkflowReplayFrom =
  | { stepName: typeof VERIFY_ANALYSIS_REPLAY_STEP; stepCount?: 1 | undefined }
  | { planVersion: number; planItemId: string };

export interface WorkflowReplayEffectSnapshot {
  effect: PlanEffect;
  approvalId?: string;
}

export function verificationPlanItemStep(
  planVersion: number,
  planItemId: string,
): WorkflowRestartTarget {
  if (
    !Number.isSafeInteger(planVersion) ||
    planVersion <= 0 ||
    !PLAN_ITEM_ID_PATTERN.test(planItemId)
  ) {
    throw new Error('invalid verification Plan Item replay target');
  }
  return {
    name: `plan-v${planVersion}-item-${planItemId}-verify`,
    type: 'do',
    count: 1,
  };
}

export function normalizeWorkflowReplayTarget(
  from: WorkflowReplayFrom,
): WorkflowRestartTarget {
  if ('stepName' in from) {
    if (
      from.stepName !== VERIFY_ANALYSIS_REPLAY_STEP ||
      (from.stepCount !== undefined && from.stepCount !== 1)
    ) {
      throw new Error('invalid system replay target');
    }
    return { name: VERIFY_ANALYSIS_REPLAY_STEP, type: 'do', count: 1 };
  }
  return verificationPlanItemStep(from.planVersion, from.planItemId);
}
