import { isSensitiveFieldName } from '../security/redaction.js';
import {
  CodexExecutionActivitySchema,
  type CodexExecutionActivity,
} from '../agent/codex-execution-activity.js';
import { secureStructuredLogSink } from './structured-log.js';
import {
  CODEX_ANALYSIS_FAILURE_KINDS,
  CODEX_ANALYSIS_FAILURE_STAGES,
  type CodexAnalysisFailureKind,
  type CodexAnalysisFailureStage,
} from '../agent/codex-analysis-adapter.js';
import {
  ANALYSIS_PROVIDER_PROCESS_FAILURE_CODES,
  type AnalysisProviderProcessFailureCode,
} from '../agent/provider-preflight-failure.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EXECUTION_FAILURE_KINDS = [
  'process_unavailable',
  'process_timeout',
  'process_nonzero_exit',
  'transcript_invalid',
  'usage_invalid',
  'decision_invalid',
  'repository_patch_failed',
  'repository_commit_failed',
  'repository_push_failed',
  'head_report_failed',
  'unknown',
] as const;
export type RunnerExecutionFailureKind = (typeof EXECUTION_FAILURE_KINDS)[number];

export type RunnerLogEvent =
  | 'analysis_attempt_result'
  | 'execution_attempt_result'
  | 'test_deployment_result'
  | 'test_acceptance_result'
  | 'test_rollback_result'
  | 'production_deployment_result';

function processSecrets(environment: NodeJS.ProcessEnv): string[] {
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => value !== undefined && (
      isSensitiveFieldName(key) ||
      /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ENCRYPTION_KEY|API_KEY|DATABASE_URL|DSN)$/.test(key)
    ))
    .map(([, value]) => value!)
    .filter((value) => value.length >= 8))];
}

/** One JSON line for GitHub Action/Runner logs; never accepts free-form output. */
export function writeRunnerStructuredLog(
  event: RunnerLogEvent,
  outcome: 'accepted' | 'passed' | 'failed' | 'blocked' | 'replanning',
  environment: NodeJS.ProcessEnv = process.env,
  failureKind?: RunnerExecutionFailureKind | CodexAnalysisFailureKind,
  failureStage?: CodexAnalysisFailureStage,
  providerFailureCode?: AnalysisProviderProcessFailureCode,
): void {
  const validExecutionFailure = event === 'execution_attempt_result' &&
    outcome === 'failed' && failureStage === undefined &&
    EXECUTION_FAILURE_KINDS.includes(failureKind as RunnerExecutionFailureKind);
  const validAnalysisFailure = event === 'analysis_attempt_result' &&
    outcome === 'failed' &&
    CODEX_ANALYSIS_FAILURE_KINDS.includes(failureKind as CodexAnalysisFailureKind) &&
    CODEX_ANALYSIS_FAILURE_STAGES.includes(failureStage as CodexAnalysisFailureStage);
  if (failureStage !== undefined && failureKind === undefined) {
    throw new Error('Runner failure classification is invalid');
  }
  if (failureKind !== undefined && !validExecutionFailure && !validAnalysisFailure) {
    throw new Error(
      event === 'analysis_attempt_result' && failureStage !== undefined
        ? 'Runner failure classification is invalid'
        : 'Runner failure kind is invalid',
    );
  }
  const validProviderFailure = event === 'analysis_attempt_result' &&
    outcome === 'failed' && failureKind === 'process_nonzero_exit' &&
    failureStage !== undefined &&
    ANALYSIS_PROVIDER_PROCESS_FAILURE_CODES.includes(
      providerFailureCode as AnalysisProviderProcessFailureCode,
    );
  if (
    (failureKind === 'process_nonzero_exit' && event === 'analysis_attempt_result') !==
      (providerFailureCode !== undefined) ||
    providerFailureCode !== undefined && !validProviderFailure
  ) throw new Error('Runner provider failure classification is invalid');
  const failed = outcome === 'failed' || outcome === 'blocked';
  const stream = failed ? process.stderr : process.stdout;
  secureStructuredLogSink({
    component: 'runner',
    level: failed ? 'error' : 'info',
    secrets: processSecrets(environment),
    sink: (record) => stream.write(`${JSON.stringify(record)}\n`),
  })({
    schemaVersion: '1',
    event,
    outcome,
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(failureStage === undefined ? {} : { failureStage }),
    ...(providerFailureCode === undefined ? {} : { providerFailureCode }),
    ...(ID_PATTERN.test(environment.DELIVERY_ATTEMPT_ID ?? '')
      ? { attemptId: environment.DELIVERY_ATTEMPT_ID }
      : {}),
  });
}

/** Emits the only permitted execution-Agent activity projection. */
export function writeRunnerExecutionAgentActivity(
  activity: CodexExecutionActivity,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const parsed = CodexExecutionActivitySchema.safeParse(activity);
  if (!parsed.success) throw new Error('Runner execution Agent activity is invalid');
  secureStructuredLogSink({
    component: 'runner',
    level: 'info',
    secrets: processSecrets(environment),
    sink: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  })({
    ...parsed.data,
    event: 'execution_agent_activity',
    ...(ID_PATTERN.test(environment.DELIVERY_ATTEMPT_ID ?? '')
      ? { attemptId: environment.DELIVERY_ATTEMPT_ID }
      : {}),
  });
}
