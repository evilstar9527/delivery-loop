import {
  AnalysisRunnerError,
  runAnalysisAttempt,
} from '../src/runner/analysis-runner.js';
import { writeRunnerStructuredLog } from '../src/observability/runner-log.js';

try {
  await runAnalysisAttempt();
  writeRunnerStructuredLog('analysis_attempt_result', 'accepted');
} catch (error) {
  const classification = error instanceof AnalysisRunnerError
    ? error.analysisFailure
    : undefined;
  writeRunnerStructuredLog(
    'analysis_attempt_result',
    'failed',
    process.env,
    classification?.kind,
    classification?.stage,
    classification?.providerFailureCode,
  );
  process.exitCode = 1;
}
