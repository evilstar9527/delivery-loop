/** Cloudflare Workflows event names only allow this character set and 100 bytes. */
const EVENT_NAME_MAX_LENGTH = 100;
const EVENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidWorkflowEventNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkflowEventNameError';
  }
}

/**
 * Keep the Watt adapter's readable, deterministic mapping at the platform edge.
 * Domain identifiers stay unchanged in D1; only the Workflow event type is sanitized.
 */
export function sanitizeWorkflowEventName(name: string): string {
  const sanitized = name.replace(/\./g, '-').replace(/[^A-Za-z0-9_-]/g, '-');
  return sanitized.length === 0 ? 'x' : sanitized;
}

export function assertWorkflowEventName(name: string): void {
  if (name.length === 0) {
    throw new InvalidWorkflowEventNameError('workflow event name must not be empty');
  }
  if (name.length > EVENT_NAME_MAX_LENGTH) {
    throw new InvalidWorkflowEventNameError(
      `workflow event name exceeds ${EVENT_NAME_MAX_LENGTH} characters`,
    );
  }
  if (!EVENT_NAME_PATTERN.test(name)) {
    throw new InvalidWorkflowEventNameError(
      'workflow event name must match [A-Za-z0-9_-]',
    );
  }
}

export function analysisAttemptId(runId: string): string {
  return `analysis-${runId}-1`;
}

export function attemptResultEventName(attemptId: string): string {
  const name = `attempt-result-${sanitizeWorkflowEventName(attemptId)}`;
  assertWorkflowEventName(name);
  return name;
}

/** Small signal only: the plan body is already persisted in D1/R2. */
export const AttemptResultSignalV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    eventId: z.string().min(1).max(128),
    runId: z.string().min(1).max(64),
    type: z.literal('attempt_completed'),
    attemptId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    payloadRef: z
      .string()
      .min(1)
      .max(500)
      .regex(/^d1:\/\/execution-plans\/[A-Za-z0-9_-]+$/),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type AttemptResultSignalV1 = z.infer<typeof AttemptResultSignalV1Schema>;
import { z } from 'zod';
