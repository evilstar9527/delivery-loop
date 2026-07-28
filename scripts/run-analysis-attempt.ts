import { runAnalysisAttempt } from '../src/runner/analysis-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

try {
  await runAnalysisAttempt();
  writeRunnerStructuredLog('analysis_attempt_result', 'accepted');
} catch {
  writeRunnerStructuredLog('analysis_attempt_result', 'failed');
  process.exitCode = 1;
}
