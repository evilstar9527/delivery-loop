import { TaskEnvelopeSchema, taskDedupeKey } from '../src/domain/task.js';

try {
  const raw = process.env.DELIVERY_TASK_JSON;
  if (!raw) {
    throw new Error('missing task input');
  }

  const task = TaskEnvelopeSchema.parse(JSON.parse(raw) as unknown);
  process.stdout.write(
    `${JSON.stringify({ valid: true, dedupeKey: taskDedupeKey(task) })}\n`,
  );
} catch {
  // Task input is untrusted and may contain secrets or sensitive user content.
  // Never let JSON/Zod errors (which include the rejected input) reach Action logs.
  process.stderr.write('TaskEnvelope validation failed\n');
  process.exitCode = 1;
}
