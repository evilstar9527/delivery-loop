import { TaskEnvelopeSchema, taskDedupeKey } from '../src/domain/task.js';

const raw = process.env.DELIVERY_TASK_JSON;

if (!raw) {
  throw new Error('DELIVERY_TASK_JSON is required');
}

const task = TaskEnvelopeSchema.parse(JSON.parse(raw) as unknown);
process.stdout.write(
  `${JSON.stringify({ valid: true, dedupeKey: taskDedupeKey(task) })}\n`,
);

