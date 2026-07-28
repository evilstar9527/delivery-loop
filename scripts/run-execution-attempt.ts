import { runExecutionAttempt } from '../src/runner/execution-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

try {
  const result = await runExecutionAttempt();
  writeRunnerStructuredLog(
    'execution_attempt_result',
    result.status === 'passed'
      ? 'passed'
      : result.status === 'replanning'
        ? 'replanning'
        : result.status === 'blocked' ? 'blocked' : 'accepted',
  );
} catch {
  writeRunnerStructuredLog('execution_attempt_result', 'failed');
  process.exitCode = 1;
}
