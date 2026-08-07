import {
  ExecutionRunnerError,
  runExecutionAttempt,
} from '../src/runner/execution-runner.js';
import { ExecutionAttemptError } from '../src/runner/execution-attempt-runner.js';
import {
  writeRunnerExecutionAgentActivity,
  writeRunnerStructuredLog,
} from '../src/observability/runner-log.js';

try {
  const result = await runExecutionAttempt({
    onAgentActivity: (activity) => { writeRunnerExecutionAgentActivity(activity); },
  });
  writeRunnerStructuredLog(
    'execution_attempt_result',
    result.status === 'passed'
      ? 'passed'
      : result.status === 'replanning'
        ? 'replanning'
        : result.status === 'blocked' ? 'blocked' : 'accepted',
  );
} catch (error) {
  writeRunnerStructuredLog(
    'execution_attempt_result',
    'failed',
    process.env,
    error instanceof ExecutionAttemptError || error instanceof ExecutionRunnerError
      ? error.kind
      : undefined,
  );
  process.exitCode = 1;
}
