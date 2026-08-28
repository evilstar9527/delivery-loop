import {
  CODEX_ANALYSIS_FAILURE_KINDS,
  CODEX_ANALYSIS_FAILURE_STAGES,
} from '../../agent/codex-analysis-adapter.js';
import { ANALYSIS_PROVIDER_PROCESS_FAILURE_CODES } from
  '../../agent/provider-preflight-failure.js';

const MAX_LOG_BYTES = 64 * 1024;
const BOOTSTRAP_CODES = [
  'invalid_spec_path',
  'invalid_spec_file',
  'spec_unavailable',
  'invalid_spec_json',
  'invalid_execution_spec',
  'execution_grant_unavailable',
  'invalid_execution_grant',
  'runner_start_failed',
] as const;

// The specific publisher step the runner failed at, mirrored from
// ExecutorPublisherRunnerError.code (run-publisher-attempt.ts emits it on stderr
// as `delivery publisher failed: <code>:<runnerStep>`). Kept as a plain list so
// this module has no runtime dependency on the publisher runner.
const PUBLISHER_STEPS = [
  'invalid_context',
  'checkout_failed',
  'setup_failed',
  'patch_failed',
  'commit_failed',
  'push_failed',
  'head_report_failed',
  'verification_failed',
  'completion_failed',
] as const;

export interface SandboxProcessDiagnostic {
  kind:
    | 'bootstrap_failure'
    | 'analysis_failure'
    | 'execution_failure'
    | 'publisher_failure';
  code?: (typeof BOOTSTRAP_CODES)[number];
  failureKind?: (typeof CODEX_ANALYSIS_FAILURE_KINDS)[number];
  failureStage?: (typeof CODEX_ANALYSIS_FAILURE_STAGES)[number];
  providerFailureCode?: (typeof ANALYSIS_PROVIDER_PROCESS_FAILURE_CODES)[number];
  // Publisher failures: the outer PublisherAttemptError code plus the specific
  // step (ExecutorPublisherRunnerError.code) when the runner classified it.
  publisherCode?: string;
  publisherStep?: (typeof PUBLISHER_STEPS)[number];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function sandboxProcessDiagnostic(stderr: string): SandboxProcessDiagnostic | null {
  if (new TextEncoder().encode(stderr).length > MAX_LOG_BYTES) return null;
  for (const line of stderr.split('\n').reverse()) {
    for (const code of BOOTSTRAP_CODES) {
      if (line === `delivery-agent bootstrap failed: ${code}`) {
        return { kind: 'bootstrap_failure', code };
      }
    }
    // Publisher failure (run-publisher-attempt.ts): a plain line
    // `delivery publisher failed: <publisherCode>[:<runnerStep>]`. The outer
    // code is free-form; the optional runner step is one of PUBLISHER_STEPS.
    const publisher = /^delivery publisher failed: ([a-z_]+)(?::([a-z_]+))?$/.exec(line);
    if (publisher !== null) {
      const publisherCode = publisher[1]!;
      const publisherStep = PUBLISHER_STEPS.find((candidate) => candidate === publisher[2]);
      return {
        kind: 'publisher_failure',
        publisherCode,
        ...(publisherStep === undefined ? {} : { publisherStep }),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const value = record(parsed);
    if (value?.schemaVersion !== '1' || value.component !== 'runner') continue;
    // Analysis and execution runners both emit a `*_attempt_result` / failed
    // structured log with the same failureKind/failureStage vocabulary.
    const isAnalysis = value.event === 'analysis_attempt_result' && value.outcome === 'failed';
    const isExecution = value.event === 'execution_attempt_result' && value.outcome === 'failed';
    if (!isAnalysis && !isExecution) continue;
    const failureKind = CODEX_ANALYSIS_FAILURE_KINDS.find(
      (candidate) => candidate === value.failureKind,
    );
    const failureStage = CODEX_ANALYSIS_FAILURE_STAGES.find(
      (candidate) => candidate === value.failureStage,
    );
    const providerFailureCode = ANALYSIS_PROVIDER_PROCESS_FAILURE_CODES.find(
      (candidate) => candidate === value.providerFailureCode,
    );
    return {
      kind: isAnalysis ? 'analysis_failure' : 'execution_failure',
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(failureStage === undefined ? {} : { failureStage }),
      ...(providerFailureCode === undefined ? {} : { providerFailureCode }),
    };
  }
  return null;
}
