import { describe, expect, it } from 'vitest';
import {
  classifyExecutionAttemptError,
  classifyExecutionAttemptResult,
} from '../src/runner/execution-attempt-classification.js';
import { ExecutorWorkAttemptError } from '../src/runner/executor-work-runner.js';
import { ExecutionAttemptError } from '../src/runner/execution-attempt-runner.js';
import { ExecutionRunnerError } from '../src/runner/execution-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

describe('execution attempt classification', () => {
  it('maps every work-lane error kind onto a validated execution failure kind', () => {
    expect(classifyExecutionAttemptError(new ExecutorWorkAttemptError('patch_failed')))
      .toEqual({ outcome: 'failed', failureKind: 'repository_patch_failed' });
    expect(classifyExecutionAttemptError(new ExecutorWorkAttemptError('verification_failed')))
      .toEqual({ outcome: 'failed', failureKind: 'process_nonzero_exit' });
    expect(classifyExecutionAttemptError(new ExecutorWorkAttemptError('invalid_output')))
      .toEqual({ outcome: 'failed', failureKind: 'decision_invalid' });
    expect(classifyExecutionAttemptError(new ExecutorWorkAttemptError('upload_failed')))
      .toEqual({ outcome: 'failed', failureKind: 'unknown' });
  });

  it('passes an ExecutionRunnerError kind through', () => {
    expect(classifyExecutionAttemptError(new ExecutionRunnerError('quota unavailable', 'quota_unavailable')))
      .toEqual({ outcome: 'failed', failureKind: 'quota_unavailable' });
  });

  it('passes an ExecutionAttemptError kind and stage through', () => {
    expect(classifyExecutionAttemptError(
      new ExecutionAttemptError('repository_commit_failed', 'commit'),
    )).toEqual({
      outcome: 'failed',
      failureKind: 'repository_commit_failed',
      failureStage: 'commit',
    });
  });

  it('never lets an unrecognized throw read as accepted', () => {
    expect(classifyExecutionAttemptError(new Error('boom')))
      .toEqual({ outcome: 'failed', failureKind: 'unknown' });
  });

  it('classifies a returned failed result rather than falling through to accepted', () => {
    expect(classifyExecutionAttemptResult({ status: 'failed', failedCommandRef: 'verify:smoke' }))
      .toEqual({ outcome: 'failed', failureKind: 'process_nonzero_exit' });
  });

  it('preserves the non-failed result outcomes', () => {
    expect(classifyExecutionAttemptResult({ status: 'passed' })).toEqual({ outcome: 'passed' });
    expect(classifyExecutionAttemptResult({ status: 'replanning' })).toEqual({ outcome: 'replanning' });
    expect(classifyExecutionAttemptResult({ status: 'blocked' })).toEqual({ outcome: 'blocked' });
    expect(classifyExecutionAttemptResult({ status: 'patch_uploaded' })).toEqual({ outcome: 'accepted' });
  });

  it('produces failure kinds that writeRunnerStructuredLog accepts without throwing', () => {
    for (const error of [
      new ExecutorWorkAttemptError('patch_failed'),
      new ExecutorWorkAttemptError('verification_failed'),
      new ExecutorWorkAttemptError('invalid_output'),
      new ExecutorWorkAttemptError('upload_failed'),
      new ExecutionRunnerError('x', 'context_invalid'),
    ]) {
      const c = classifyExecutionAttemptError(error);
      expect(() => writeRunnerStructuredLog(
        'execution_attempt_result',
        'failed',
        { DELIVERY_ATTEMPT_ID: 'attempt-classify-test' },
        c.failureKind,
        c.failureStage,
      )).not.toThrow();
    }
    const r = classifyExecutionAttemptResult({ status: 'failed', failedCommandRef: 'verify:smoke' });
    expect(() => writeRunnerStructuredLog(
      'execution_attempt_result',
      'failed',
      { DELIVERY_ATTEMPT_ID: 'attempt-classify-test' },
      r.failureKind,
      r.failureStage,
    )).not.toThrow();
  });
});
