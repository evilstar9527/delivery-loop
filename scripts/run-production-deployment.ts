import { runProductionDeployment } from '../src/runner/production-deployment-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

try {
  const result = await runProductionDeployment();
  if (result.status === 'succeeded') {
    writeRunnerStructuredLog('production_deployment_result', 'accepted');
  } else {
    writeRunnerStructuredLog('production_deployment_result', 'failed');
    process.exitCode = 1;
  }
} catch {
  writeRunnerStructuredLog('production_deployment_result', 'failed');
  process.exitCode = 1;
}
