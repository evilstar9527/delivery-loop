import { runExecutionAttempt } from '../src/runner/execution-runner.js';
import {
  classifyExecutionAttemptError,
  classifyExecutionAttemptResult,
} from '../src/runner/execution-attempt-classification.js';
import {
  writeRunnerExecutionAgentActivity,
  writeRunnerStructuredLog,
} from '../src/observability/runner-log.js';

try {
  const result = await runExecutionAttempt({
    onAgentActivity: (activity) => { writeRunnerExecutionAgentActivity(activity); },
  });
  const classification = classifyExecutionAttemptResult(result);
  writeRunnerStructuredLog(
    'execution_attempt_result',
    classification.outcome,
    process.env,
    classification.failureKind,
    classification.failureStage,
  );
  // A returned `failed` result is a real failure: the process must exit nonzero
  // so the sandbox does not observe a false success.
  if (classification.outcome === 'failed') process.exitCode = 1;
} catch (error) {
  const classification = classifyExecutionAttemptError(error);
  writeRunnerStructuredLog(
    'execution_attempt_result',
    'failed',
    process.env,
    classification.failureKind,
    classification.failureStage,
  );
  process.exitCode = 1;
}
