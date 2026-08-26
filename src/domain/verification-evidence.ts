import { z } from 'zod';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMAND_REF_PATTERN = /^(?:test|verify):[a-z][a-z0-9_-]{0,63}$/;

const commandRefs = (prefix: 'test' | 'verify') => z
  .array(z.string().regex(new RegExp(`^${prefix}:[a-z][a-z0-9_-]{0,63}$`)))
  .min(1)
  .max(50)
  .refine((refs) => new Set(refs).size === refs.length, 'command refs must be unique');

export const VerificationSuiteManifestV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    headSha: z.string().regex(SHA_PATTERN),
    policyDigest: z.string().regex(DIGEST_PATTERN),
    targetedCommandRefs: commandRefs('test'),
    requiredVerifyCommandRefs: commandRefs('verify'),
  })
  .strict()
  .refine(
    (manifest) =>
      new Set([...manifest.targetedCommandRefs, ...manifest.requiredVerifyCommandRefs]).size ===
      manifest.targetedCommandRefs.length + manifest.requiredVerifyCommandRefs.length,
    'targeted and required command refs must be disjoint',
  );

export const VerificationCommandPhaseSchema = z.enum(['targeted', 'required_verify']);

export const VerificationCommandResultV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    position: z.number().int().nonnegative().max(99),
    phase: VerificationCommandPhaseSchema,
    commandRef: z.string().regex(COMMAND_REF_PATTERN),
    exitCode: z.number().int().min(0).max(255),
    durationMs: z.number().int().nonnegative().max(3_600_000),
    headSha: z.string().regex(SHA_PATTERN),
    // Optional bounded tail of a FAILED command's output (e.g. the `go build`
    // compiler errors). Diagnostic only: lets an operator — and, later, a retry
    // — see why verification failed instead of just its exit code.
    outputTail: z.string().max(4000).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const expectedPrefix = result.phase === 'targeted' ? 'test:' : 'verify:';
    if (!result.commandRef.startsWith(expectedPrefix)) {
      context.addIssue({
        code: 'custom',
        path: ['commandRef'],
        message: 'command ref does not match its verification phase',
      });
    }
  });

export type VerificationSuiteManifestV1 = z.infer<typeof VerificationSuiteManifestV1Schema>;
export type VerificationCommandPhase = z.infer<typeof VerificationCommandPhaseSchema>;
export type VerificationCommandResultV1 = z.infer<typeof VerificationCommandResultV1Schema>;

export interface VerificationSuiteCommand {
  position: number;
  phase: VerificationCommandPhase;
  commandRef: string;
}

export function verificationSuiteCommands(
  manifest: VerificationSuiteManifestV1,
): VerificationSuiteCommand[] {
  return [
    ...manifest.targetedCommandRefs.map((commandRef, position) => ({
      position,
      phase: 'targeted' as const,
      commandRef,
    })),
    ...manifest.requiredVerifyCommandRefs.map((commandRef, index) => ({
      position: manifest.targetedCommandRefs.length + index,
      phase: 'required_verify' as const,
      commandRef,
    })),
  ];
}
