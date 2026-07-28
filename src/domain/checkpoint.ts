import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const EvidenceRefSchema = z
  .string()
  .max(500)
  .regex(/^d1:\/\/evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
const ProviderSessionRefSchema = z
  .string()
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const HeadBranchSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..') && !value.endsWith('/') && !value.endsWith('.'));

export const AgentCheckpointV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    sequence: z.number().int().positive(),
    provider: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    providerSessionRef: ProviderSessionRefSchema.optional(),
    planVersion: z.number().int().positive(),
    planItemId: ResourceIdSchema,
    headBranch: HeadBranchSchema.optional(),
    headSha: GitShaSchema,
    completedAcceptanceCriteria: z.array(z.string().min(1).max(1_000)).max(100),
    evidenceRefs: z.array(EvidenceRefSchema).max(200),
    summary: z.string().min(1).max(8_000),
    nextStep: z.string().min(1).max(4_000),
    blockingReason: z.string().min(1).max(4_000).optional(),
    workingTreeDigest: Sha256DigestSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.completedAcceptanceCriteria).size !== value.completedAcceptanceCriteria.length) {
      context.addIssue({
        code: 'custom',
        path: ['completedAcceptanceCriteria'],
        message: 'completed acceptance criteria must be unique',
      });
    }
    if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: 'evidence references must be unique',
      });
    }
  });

export type AgentCheckpointV1 = z.infer<typeof AgentCheckpointV1Schema>;

export async function computeAgentCheckpointDigest(
  checkpoint: AgentCheckpointV1,
): Promise<string> {
  return await canonicalSha256(checkpoint);
}
