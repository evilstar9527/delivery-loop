import { ExecutionAttemptError } from './execution-attempt-runner.js';
import { ExecutionRunnerError } from './execution-runner.js';
import { ExecutorWorkAttemptError } from './executor-work-runner.js';
import type { RunnerExecutionFailureKind } from '../observability/runner-log.js';
import type { RepositoryCommitFailureStage } from './git-repository-writer.js';

/**
 * Classification for the runner's own `execution_attempt_result` structured log.
 * The Cloudflare sandbox reaps a failed container before its stderr can be read,
 * so this log line (projected into executor_observations.facts_json by the
 * executor) is often the only durable signal of WHY a work/execution attempt
 * failed. Every failure must therefore carry a real, validated failure kind —
 * an unclassified failure (undefined kind) or a failure mislabeled `accepted`
 * leaves the operator blind.
 */
export interface ExecutionAttemptLogClassification {
  outcome: 'accepted' | 'passed' | 'failed' | 'blocked' | 'replanning';
  failureKind?: RunnerExecutionFailureKind;
  failureStage?: RepositoryCommitFailureStage;
}

// ExecutorWorkAttemptError.kind is the credential-free work lane's own
// vocabulary; map each onto an EXECUTION_FAILURE_KINDS value writeRunnerStructuredLog
// accepts. `upload_failed` has no dedicated kind — `unknown` is honest, and the
// bounded stderr tail (captured by the executor on failure) covers the detail.
const WORK_ATTEMPT_FAILURE_KIND: Record<
  ExecutorWorkAttemptError['kind'],
  RunnerExecutionFailureKind
> = {
  patch_failed: 'repository_patch_failed',
  verification_failed: 'process_nonzero_exit',
  invalid_output: 'decision_invalid',
  upload_failed: 'unknown',
};

/** Classify a thrown error into the failed-outcome log fields. */
export function classifyExecutionAttemptError(
  error: unknown,
): ExecutionAttemptLogClassification {
  if (error instanceof ExecutorWorkAttemptError) {
    return { outcome: 'failed', failureKind: WORK_ATTEMPT_FAILURE_KIND[error.kind] };
  }
  if (error instanceof ExecutionAttemptError) {
    return {
      outcome: 'failed',
      failureKind: error.kind,
      ...(error.failureStage === undefined ? {} : { failureStage: error.failureStage }),
    };
  }
  if (error instanceof ExecutionRunnerError) {
    return { outcome: 'failed', failureKind: error.kind };
  }
  // An unrecognized throw is still a failure — never let it read as accepted.
  return { outcome: 'failed', failureKind: 'unknown' };
}

/**
 * Classify a returned result. A `failed` result (work verification failure, or
 * the GitHub lane's failed suite) must log `failed`, not fall through to
 * `accepted`. A `failedCommandRef` means a verify/test command exited nonzero.
 */
export function classifyExecutionAttemptResult(
  result: { status: string; failedCommandRef?: string },
): ExecutionAttemptLogClassification {
  switch (result.status) {
    case 'passed':
      return { outcome: 'passed' };
    case 'replanning':
      return { outcome: 'replanning' };
    case 'blocked':
      return { outcome: 'blocked' };
    case 'failed':
      return { outcome: 'failed', failureKind: 'process_nonzero_exit' };
    default:
      return { outcome: 'accepted' };
  }
}
