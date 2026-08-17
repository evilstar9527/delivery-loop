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

export interface SandboxProcessDiagnostic {
  kind: 'bootstrap_failure' | 'analysis_failure';
  code?: (typeof BOOTSTRAP_CODES)[number];
  failureKind?: (typeof CODEX_ANALYSIS_FAILURE_KINDS)[number];
  failureStage?: (typeof CODEX_ANALYSIS_FAILURE_STAGES)[number];
  providerFailureCode?: (typeof ANALYSIS_PROVIDER_PROCESS_FAILURE_CODES)[number];
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const value = record(parsed);
    if (
      value?.schemaVersion !== '1' || value.component !== 'runner' ||
      value.event !== 'analysis_attempt_result' || value.outcome !== 'failed'
    ) continue;
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
      kind: 'analysis_failure',
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(failureStage === undefined ? {} : { failureStage }),
      ...(providerFailureCode === undefined ? {} : { providerFailureCode }),
    };
  }
  return null;
}
