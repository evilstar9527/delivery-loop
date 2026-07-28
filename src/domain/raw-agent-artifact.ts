import { z } from 'zod';

export const RawAgentArtifactCategorySchema = z.enum(['raw_session', 'raw_transcript']);

export const RawAgentArtifactRequestBodySchema = z.object({
  schemaVersion: z.literal('1'),
  artifactId: z.uuid(),
  category: RawAgentArtifactCategorySchema,
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  content: z.string().min(1).max(1_048_576),
}).strict();

export type RawAgentArtifactRequestBody = z.infer<typeof RawAgentArtifactRequestBodySchema>;
export type RawAgentArtifactCategory = z.infer<typeof RawAgentArtifactCategorySchema>;
