import { SecretScanner, SensitiveDataRedactor } from '../security/redaction.js';

const COMPONENT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;

export type StructuredLogLevel = 'info' | 'warn' | 'error';
export type StructuredLogRecord = Readonly<Record<string, unknown>>;
export type StructuredLogSink = (record: StructuredLogRecord) => void;

export interface SecureStructuredLogSinkOptions {
  component: string;
  level?: StructuredLogLevel;
  secrets?: readonly string[];
  now?: () => Date;
  sink?: StructuredLogSink;
}

function consoleSink(level: StructuredLogLevel): StructuredLogSink {
  if (level === 'error') return (record) => console.error(record);
  if (level === 'warn') return (record) => console.warn(record);
  return (record) => console.info(record);
}

/**
 * The only production console sink. Every record is one structured object,
 * recursively redacted and scanned before emission.
 */
export function secureStructuredLogSink(
  options: SecureStructuredLogSinkOptions,
): (record: unknown) => void {
  if (!COMPONENT_PATTERN.test(options.component)) {
    throw new Error('structured log component is invalid');
  }
  const level = options.level ?? 'info';
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? consoleSink(level);
  const secrets = [...(options.secrets ?? [])];
  const redactor = new SensitiveDataRedactor({ secrets });
  const scanner = new SecretScanner({ secrets });
  return (record: unknown): void => {
    const raw = typeof record === 'object' && record !== null
      ? record as Record<string, unknown>
      : {};
    const event = typeof raw.event === 'string' && EVENT_PATTERN.test(raw.event)
      ? raw.event
      : 'structured_log_rejected';
    const redacted = redactor.redactJson(raw);
    const fields = typeof redacted === 'object' && redacted !== null
      ? redacted as Record<string, unknown>
      : {};
    const observedAt = typeof fields.observedAt === 'string' &&
        Number.isFinite(Date.parse(fields.observedAt))
      ? new Date(fields.observedAt).toISOString()
      : now().toISOString();
    const envelope: StructuredLogRecord = {
      ...fields,
      schemaVersion: '1',
      level,
      component: options.component,
      event,
      observedAt,
    };
    scanner.assertNoSecrets(envelope, '$.log');
    sink(envelope);
  };
}
