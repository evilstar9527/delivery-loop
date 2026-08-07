import { readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SecretScanner } from '../src/security/redaction.js';
import { configuredSecrets } from '../src/security/runtime-secrets.js';
import { secureStructuredLogSink } from '../src/observability/structured-log.js';
import {
  writeRunnerExecutionAgentActivity,
  writeRunnerStructuredLog,
} from '../src/observability/runner-log.js';

const LOG_SECRET = 'CANARY_STRUCTURED_LOG_SECRET_123456';

function typescriptFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(path, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && extname(entry.name) === '.ts' ? [absolute] : [];
  });
}

describe('secure structured logging', () => {
  it('redacts nested values, headers, URLs, errors, and registered Secrets before one JSON sink', () => {
    const records: Record<string, unknown>[] = [];
    const sink = secureStructuredLogSink({
      component: 'test_component',
      secrets: [LOG_SECRET],
      now: () => new Date('2026-07-26T08:00:00.000Z'),
      sink: (record) => records.push(record),
    });
    sink({
      schemaVersion: '1',
      event: 'test_event',
      runId: 'run-safe',
      nested: { authorization: `Bearer ${LOG_SECRET}`, note: `prefix-${LOG_SECRET}` },
      callbackUrl: `https://user:${LOG_SECRET}@example.test/path?token=${LOG_SECRET}#private`,
      error: new Error(`failed with ${LOG_SECRET}`),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schemaVersion: '1',
      level: 'info',
      component: 'test_component',
      event: 'test_event',
      observedAt: '2026-07-26T08:00:00.000Z',
    });
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain(LOG_SECRET);
    expect(serialized).not.toContain('user:');
    expect(serialized).not.toContain('private');
    expect(new SecretScanner({ secrets: [LOG_SECRET] }).scan(records[0])).toEqual([]);
  });

  it('uses one complete Worker Secret catalog instead of per-producer partial lists', () => {
    const secrets = configuredSecrets({
      TASK_INTAKE_TOKEN: 'task-secret-value',
      OPERATIONS_TOKEN: 'operations-secret-value',
      APPROVAL_ADAPTER_TOKEN: 'approval-secret-value',
      GITHUB_WEBHOOK_SECRET: 'github-webhook-value',
      GITHUB_APP_PRIVATE_KEY: 'github-private-key-value',
      GITHUB_CREDENTIAL_ENCRYPTION_KEY: 'github-encryption-value',
      FEISHU_APP_SECRET: 'feishu-app-secret-value',
      FEISHU_EVENT_ENCRYPT_KEY: 'feishu-encrypt-value',
      FEISHU_EVENT_VERIFICATION_TOKEN: 'feishu-verify-value',
      MONITOR_WEBHOOK_SECRET: 'monitor-secret-value',
      D1_BACKUP_API_TOKEN: 'backup-token-value',
      TOOL_BRIDGE_INTERNAL_TOKEN: 'tool-bridge-token-value',
      RAW_AGENT_ARTIFACT_ENCRYPTION_KEY: 'artifact-encryption-value',
    });
    expect(new Set(secrets)).toEqual(new Set([
      'task-secret-value',
      'operations-secret-value',
      'approval-secret-value',
      'github-webhook-value',
      'github-private-key-value',
      'github-encryption-value',
      'feishu-app-secret-value',
      'feishu-encrypt-value',
      'feishu-verify-value',
      'monitor-secret-value',
      'backup-token-value',
      'tool-bridge-token-value',
      'artifact-encryption-value',
    ]));
  });

  it('forbids direct console logging outside the one security sink', () => {
    const offenders = typescriptFiles(resolve('src')).filter((file) => {
      if (file.endsWith('/src/observability/structured-log.ts')) return false;
      return /\bconsole\.(?:log|info|warn|error|debug)\s*\(/.test(readFileSync(file, 'utf8'));
    });
    expect(offenders).toEqual([]);
  });

  it('emits one fixed-schema Runner JSON line and never writes environment Secrets', () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      writeRunnerStructuredLog('execution_attempt_result', 'passed', {
        DELIVERY_ATTEMPT_ID: 'attempt-structured-runner',
        OPENAI_API_KEY: LOG_SECRET,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: `runtime-${LOG_SECRET}`,
      });
    } finally {
      write.mockRestore();
    }
    expect(output).toHaveLength(1);
    expect(output[0]?.endsWith('\n')).toBe(true);
    const record = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: '1',
      level: 'info',
      component: 'runner',
      event: 'execution_attempt_result',
      outcome: 'passed',
      attemptId: 'attempt-structured-runner',
    });
    expect(JSON.stringify(record)).not.toContain(LOG_SECRET);
  });

  it('allows only a fixed execution failure kind on failed execution logs', () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      writeRunnerStructuredLog(
        'execution_attempt_result',
        'failed',
        { DELIVERY_ATTEMPT_ID: 'attempt-safe-failure-kind' },
        'repository_commit_failed',
      );
      writeRunnerStructuredLog(
        'execution_attempt_result',
        'failed',
        { DELIVERY_ATTEMPT_ID: 'attempt-safe-patch-failure-kind' },
        'repository_patch_failed',
      );
      writeRunnerStructuredLog(
        'execution_attempt_result',
        'failed',
        { DELIVERY_ATTEMPT_ID: 'attempt-safe-context-failure-kind' },
        'context_invalid',
      );
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(output[0]!)).toMatchObject({
      event: 'execution_attempt_result',
      outcome: 'failed',
      failureKind: 'repository_commit_failed',
    });
    expect(JSON.parse(output[1]!)).toMatchObject({
      event: 'execution_attempt_result',
      outcome: 'failed',
      failureKind: 'repository_patch_failed',
    });
    expect(JSON.parse(output[2]!)).toMatchObject({
      event: 'execution_attempt_result',
      outcome: 'failed',
      failureKind: 'context_invalid',
    });
    expect(() => writeRunnerStructuredLog(
      'analysis_attempt_result',
      'failed',
      {},
      'transcript_invalid',
    )).toThrow('Runner failure kind is invalid');
  });

  it('emits only fixed analysis failure kind and stage fields', () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      writeRunnerStructuredLog(
        'analysis_attempt_result',
        'failed',
        {
          DELIVERY_ATTEMPT_ID: 'attempt-safe-analysis-failure',
          OPENAI_API_KEY: LOG_SECRET,
        },
        'structured_output_invalid',
        'diagnostic_root_cause',
      );
      writeRunnerStructuredLog(
        'analysis_attempt_result',
        'failed',
        { DELIVERY_ATTEMPT_ID: 'attempt-safe-provider-failure' },
        'process_nonzero_exit',
        'diagnostic_plan',
        'provider_output_schema_rejected',
      );
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(output[0]!)).toMatchObject({
      event: 'analysis_attempt_result',
      outcome: 'failed',
      failureKind: 'structured_output_invalid',
      failureStage: 'diagnostic_root_cause',
    });
    expect(output[0]).not.toContain(LOG_SECRET);
    expect(JSON.parse(output[1]!)).toMatchObject({
      event: 'analysis_attempt_result',
      outcome: 'failed',
      failureKind: 'process_nonzero_exit',
      failureStage: 'diagnostic_plan',
      providerFailureCode: 'provider_output_schema_rejected',
    });
    expect(() => writeRunnerStructuredLog(
      'analysis_attempt_result',
      'failed',
      {},
      'structured_output_invalid',
      'repository_commit' as never,
    )).toThrow('Runner failure classification is invalid');
    expect(() => writeRunnerStructuredLog(
      'analysis_attempt_result',
      'failed',
      {},
      'structured_output_invalid',
      'diagnostic_plan',
      'provider_process_failed',
    )).toThrow('Runner provider failure classification is invalid');
  });

  it('logs only fixed execution Agent activity counters', () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      writeRunnerExecutionAgentActivity({
        schemaVersion: '1',
        jsonlEventCount: 9,
        commandExecutionStartedCount: 2,
        commandExecutionCompletedCount: 2,
        fileChangeStartedCount: 1,
        fileChangeCompletedCount: 1,
        agentMessageCompletedCount: 2,
        turnCompletedCount: 1,
      }, {
        DELIVERY_ATTEMPT_ID: 'attempt-safe-activity',
        OPENAI_API_KEY: LOG_SECRET,
      });
    } finally {
      write.mockRestore();
    }
    expect(output).toHaveLength(1);
    const record = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: 'execution_agent_activity',
      attemptId: 'attempt-safe-activity',
      jsonlEventCount: 9,
      commandExecutionCompletedCount: 2,
      fileChangeCompletedCount: 1,
    });
    expect(JSON.stringify(record)).not.toContain(LOG_SECRET);
    expect(Object.keys(record)).not.toContain('command');
    expect(Object.keys(record)).not.toContain('output');
    expect(Object.keys(record)).not.toContain('path');
    expect(Object.keys(record)).not.toContain('message');
  });
});
