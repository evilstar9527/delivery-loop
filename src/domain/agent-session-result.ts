import { z } from 'zod';

/** Fixed provider output; durable progress remains Runner-controlled checkpoint state. */
export const AgentSessionResultV1Schema = z.object({
  schemaVersion: z.literal('1'),
  status: z.literal('checkpoint_ready'),
}).strict();

export type AgentSessionResultV1 = z.infer<typeof AgentSessionResultV1Schema>;
