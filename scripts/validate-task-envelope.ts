import { readFileSync } from 'node:fs';
import { TaskEnvelopeSchema } from '../src/domain/task.js';

function taskJsonInput(): string {
  const direct = process.env.DELIVERY_TASK_JSON;
  if (direct !== undefined) return direct;

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) throw new Error('task input is unavailable');
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as unknown;
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new Error('workflow event is invalid');
  }
  const inputs = (event as { inputs?: unknown }).inputs;
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    throw new Error('workflow inputs are unavailable');
  }
  const taskJson = (inputs as { task_json?: unknown }).task_json;
  if (typeof taskJson !== 'string') throw new Error('task input is unavailable');
  return taskJson;
}

try {
  TaskEnvelopeSchema.parse(JSON.parse(taskJsonInput()) as unknown);
  process.stdout.write(`${JSON.stringify({ valid: true })}\n`);
} catch {
  // Task input is untrusted and may contain secrets or sensitive user content.
  // Never let JSON/Zod errors (which include the rejected input) reach Action logs.
  process.stderr.write('TaskEnvelope validation failed\n');
  process.exitCode = 1;
}
