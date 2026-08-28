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
import {
  REPOSITORY_COMMIT_FAILURE_STAGES,
  type RepositoryCommitFailureStage,
} from '../runner/git-repository-writer.js';

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
  'checkout_invalid',
  'oidc_exchange_failed',
  'context_invalid',
  'policy_invalid',
  'quota_unavailable',
  'credential_unavailable',
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
  failureStage?: CodexAnalysisFailureStage | RepositoryCommitFailureStage,
  providerFailureCode?: AnalysisProviderProcessFailureCode,
  planIssueCodes?: readonly string[],
  boundaryReason?: string,
): void {
  const validExecutionFailure = event === 'execution_attempt_result' &&
    outcome === 'failed' &&
    EXECUTION_FAILURE_KINDS.includes(failureKind as RunnerExecutionFailureKind) &&
    (failureKind === 'repository_commit_failed'
      ? REPOSITORY_COMMIT_FAILURE_STAGES.includes(
        failureStage as RepositoryCommitFailureStage,
      )
      : failureStage === undefined);
  const validAnalysisFailure = event === 'analysis_attempt_result' &&
    outcome === 'failed' &&
    CODEX_ANALYSIS_FAILURE_KINDS.includes(failureKind as CodexAnalysisFailureKind) &&
    CODEX_ANALYSIS_FAILURE_STAGES.includes(failureStage as CodexAnalysisFailureStage);
  if (failureStage !== undefined && failureKind === undefined) {
    throw new Error('Runner failure classification is invalid');
  }
  if (failureKind !== undefined && !validExecutionFailure && !validAnalysisFailure) {
    throw new Error(
      failureStage !== undefined
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
    ...(planIssueCodes === undefined || planIssueCodes.length === 0
      ? {}
      : { planIssueCodes: [...planIssueCodes].slice(0, 30) }),
    ...(typeof boundaryReason === 'string' && /^[a-z0-9_]{1,80}$/.test(boundaryReason)
      ? { boundaryReason }
      : {}),
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

/**
 * Diagnostic projection of a failed verification command. The command's own
 * stdout/stderr are otherwise dropped (only the exit code is kept), so a build
 * or test failure is invisible. Emit a bounded, secret-scrubbed tail through the
 * one permitted sink so an operator can see why `verify:smoke` (etc.) failed.
 * Observability only; never used for control flow.
 */
export function writeVerificationCommandFailure(
  commandRef: string,
  exitCode: number,
  outputTail: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  secureStructuredLogSink({
    component: 'runner',
    level: 'error',
    secrets: processSecrets(environment),
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  })({
    event: 'verification_command_failed',
    commandRef: commandRef.slice(0, 80),
    exitCode,
    outputTail: outputTail.slice(-4000),
    ...(ID_PATTERN.test(environment.DELIVERY_ATTEMPT_ID ?? '')
      ? { attemptId: environment.DELIVERY_ATTEMPT_ID }
      : {}),
  });
}

/**
 * Diagnostic projection of a heartbeat POST outcome. The heartbeat loop is the
 * runner's only channel into the control plane, so when it fails there is no
 * durable record of why — the attempt just silently ages into `lost`. Emit a
 * bounded, secret-scrubbed record (retry attempts and the final give-up) so the
 * cause of a heartbeat-timeout `lost` is observable. Observability only.
 */
export function writeHeartbeatDiagnostic(
  outcome: 'retrying' | 'giving_up',
  detail: { attempt: number; httpStatus?: number | undefined; message?: string | undefined },
  environment: NodeJS.ProcessEnv = process.env,
): void {
  secureStructuredLogSink({
    component: 'runner',
    level: 'error',
    secrets: processSecrets(environment),
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  })({
    event: 'heartbeat_delivery_failed',
    outcome,
    heartbeatAttempt: detail.attempt,
    ...(detail.httpStatus === undefined ? {} : { httpStatus: detail.httpStatus }),
    ...(detail.message === undefined ? {} : { message: detail.message.slice(0, 300) }),
    ...(ID_PATTERN.test(environment.DELIVERY_ATTEMPT_ID ?? '')
      ? { attemptId: environment.DELIVERY_ATTEMPT_ID }
      : {}),
  });
}

/**
 * Lifecycle breadcrumb for the heartbeat loop, OFF unless
 * `DELIVERY_HEARTBEAT_TRACE=1`. `writeHeartbeatDiagnostic` only fires on a POST
 * failure, so a loop that never reaches the send — or never launches — leaves no
 * trace and the attempt silently freezes (heartbeat_at stuck at its exchange
 * value). This emits one bounded stderr line per phase so a frozen run's
 * captured logs pinpoint the exact stall: `launched` (loop task started),
 * `iteration` (past the interval wait, about to send), `beat` (a POST landed).
 * Absent `launched` ⇒ a pre-loop await hung; `launched` without `iteration` ⇒
 * stuck in the interval wait / lock; `iteration` without `beat` ⇒ the send
 * itself hung or failed silently. Diagnostic only; gated so normal runs stay on
 * the strict result/diagnostic contract.
 */
export function writeHeartbeatLifecycle(
  phase: 'launched' | 'iteration' | 'beat',
  detail: { iteration?: number | undefined } = {},
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.DELIVERY_HEARTBEAT_TRACE !== '1') return;
  secureStructuredLogSink({
    component: 'runner',
    level: 'info',
    secrets: processSecrets(environment),
    sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  })({
    event: 'heartbeat_lifecycle',
    phase,
    ...(detail.iteration === undefined ? {} : { iteration: detail.iteration }),
    ...(ID_PATTERN.test(environment.DELIVERY_ATTEMPT_ID ?? '')
      ? { attemptId: environment.DELIVERY_ATTEMPT_ID }
      : {}),
  });
}

// Pre-heartbeat startup stages, in order, reported to the CONTROL PLANE (not
// stderr, which the sandbox does not capture for analysis runs). See
// migrations/0102 for why this channel exists.
export const RUNNER_STARTUP_STAGES = [
  'exchanged',
  'checked_out',
  'snapshotted',
  'context_loaded',
  'workspace_prepared',
  'reserving_model',
  'reserved_model',
  'launching_heartbeat',
] as const;

export type RunnerStartupStage = (typeof RUNNER_STARTUP_STAGES)[number];

const RUNNER_STAGE_POST_TIMEOUT_MS = 5_000;

/**
 * Fire-and-forget POST recording that the runner crossed a startup stage. This
 * is deliberately NOT awaited by the caller, NOT routed through the runner's
 * request lock, and bounded by its own short timeout — so it can neither be
 * blocked by the freeze it diagnoses nor introduce a new hang. All errors are
 * swallowed: a diagnostic must never affect the attempt. Returns immediately;
 * the network call runs detached.
 */
export function postRunnerStage(input: {
  fetchImplementation: typeof globalThis.fetch;
  controlPlaneUrl: string;
  attemptId: string;
  attemptToken: string;
  stage: RunnerStartupStage;
}): void {
  void (async () => {
    try {
      await input.fetchImplementation(
        `${input.controlPlaneUrl}/v1/attempts/${input.attemptId}/runner-stage`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${input.attemptToken}`,
          },
          body: JSON.stringify({ stage: input.stage }),
          signal: AbortSignal.timeout(RUNNER_STAGE_POST_TIMEOUT_MS),
        },
      );
    } catch {
      // Best-effort diagnostic: never surface a failure to the attempt.
    }
  })();
}
