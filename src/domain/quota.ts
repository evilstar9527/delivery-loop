import { z } from 'zod';
import { ApprovalDecisionSourceSchema } from '../storage/identity-bound-approval-store.js';

export const QUOTA_SCOPE_TYPES = ['tenant', 'repository', 'user', 'run'] as const;
export const QUOTA_RESOURCES = [
  'concurrency',
  'attempt',
  'model_tokens',
  'model_cost_microusd',
  'tool_call',
] as const;

export const QuotaScopeTypeSchema = z.enum(QUOTA_SCOPE_TYPES);
export const QuotaResourceSchema = z.enum(QUOTA_RESOURCES);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const QuotaOverrideInputSchema = z.object({
  schemaVersion: z.literal('1'),
  runId: z.string().regex(ID_PATTERN),
  expectedRunVersion: z.number().int().nonnegative(),
  decision: z.enum(['approve', 'reject']),
  resources: z.array(QuotaResourceSchema).min(1).max(QUOTA_RESOURCES.length)
    .refine((resources) => new Set(resources).size === resources.length),
  reasonDigest: z.string().regex(DIGEST_PATTERN),
  expiresAt: z.iso.datetime({ offset: true }),
  source: ApprovalDecisionSourceSchema,
}).strict();

export const QuotaOverrideRequestBodySchema = QuotaOverrideInputSchema.omit({ runId: true });
export type QuotaOverrideInput = z.infer<typeof QuotaOverrideInputSchema>;

export interface CodexModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
