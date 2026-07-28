import { runTestAcceptance } from '../src/runner/test-acceptance-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

try {
  const result = await runTestAcceptance();
  if (result.status === 'passed') {
    writeRunnerStructuredLog('test_acceptance_result', 'accepted');
  } else {
    writeRunnerStructuredLog('test_acceptance_result', 'failed');
    process.exitCode = 1;
  }
} catch {
  writeRunnerStructuredLog('test_acceptance_result', 'failed');
  process.exitCode = 1;
}
