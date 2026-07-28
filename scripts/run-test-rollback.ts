import { runTestRollback } from '../src/runner/test-rollback-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

try {
  const result = await runTestRollback();
  if (result.status === 'passed') {
    writeRunnerStructuredLog('test_rollback_result', 'accepted');
  } else {
    writeRunnerStructuredLog('test_rollback_result', 'failed');
    process.exitCode = 1;
  }
} catch {
  writeRunnerStructuredLog('test_rollback_result', 'failed');
  process.exitCode = 1;
}
