import { z } from 'zod';
import { PatchProposalSchema } from './patch-proposal.js';

const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export const ExecutorPatchUploadRequestSchema = z.object({
  schemaVersion: z.literal('1'),
  workExecutionId: z.string().regex(EXECUTOR_ID_PATTERN),
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  proposal: PatchProposalSchema,
}).strict();

export type ExecutorPatchUploadRequest = z.infer<typeof ExecutorPatchUploadRequestSchema>;
