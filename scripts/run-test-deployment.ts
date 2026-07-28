import { runTestDeployment } from '../src/runner/test-deployment-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

try {
  const result = await runTestDeployment();
  if (result.status === 'succeeded') {
    writeRunnerStructuredLog('test_deployment_result', 'accepted');
  } else {
    writeRunnerStructuredLog('test_deployment_result', 'failed');
    process.exitCode = 1;
  }
} catch {
  writeRunnerStructuredLog('test_deployment_result', 'failed');
  process.exitCode = 1;
}
