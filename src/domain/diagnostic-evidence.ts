import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]{1,500}$/;

const nonBlank = (maximum: number): z.ZodString =>
  z.string().min(1).max(maximum).refine((value) => /\S/.test(value), 'must not be blank');

export const DIAGNOSTIC_LOCATOR_KINDS = ['uid', 'cid', 'path'] as const;

const DiagnosticCodeRefSchema = z.object({
  path: z.string().regex(RELATIVE_PATH_PATTERN),
  line: z.number().int().positive().max(10_000_000).optional(),
  symbol: nonBlank(300).optional(),
}).strict().refine((value) => value.line !== undefined || value.symbol !== undefined, {
  message: 'a code reference needs a line or symbol',
});

export const DiagnosticRootCauseV1Schema = z.object({
  summary: nonBlank(2_000),
  confidence: z.enum(['low', 'medium', 'high']),
  codeRefs: z.array(DiagnosticCodeRefSchema).min(1).max(50),
}).strict();

export const DiagnosticEvidenceV1Schema = z.object({
  schemaVersion: z.literal('1'),
  locatorKinds: z.array(z.enum(DIAGNOSTIC_LOCATOR_KINDS)).min(1).max(3),
  locatorDigest: z.string().regex(DIGEST_PATTERN),
  rootCause: DiagnosticRootCauseV1Schema,
  sourceTraceIds: z.array(z.string().regex(ID_PATTERN)).min(2).max(50),
}).strict().superRefine((value, context) => {
  if (
    new Set(value.locatorKinds).size !== value.locatorKinds.length ||
    new Set(value.sourceTraceIds).size !== value.sourceTraceIds.length ||
    value.locatorKinds.some((kind, index) =>
      index > 0 && DIAGNOSTIC_LOCATOR_KINDS.indexOf(kind) <=
        DIAGNOSTIC_LOCATOR_KINDS.indexOf(value.locatorKinds[index - 1]!)) ||
    value.sourceTraceIds.some((traceId, index) =>
      index > 0 && traceId.localeCompare(value.sourceTraceIds[index - 1]!) <= 0)
  ) context.addIssue({ code: 'custom', message: 'diagnostic Evidence values must be unique' });
});

export type DiagnosticEvidenceV1 = z.infer<typeof DiagnosticEvidenceV1Schema>;

export async function computeDiagnosticRootCauseDigest(
  rootCause: z.infer<typeof DiagnosticRootCauseV1Schema>,
): Promise<string> {
  return await canonicalSha256(rootCause);
}

export async function computeDiagnosticEvidenceDigest(
  evidence: DiagnosticEvidenceV1,
): Promise<string> {
  return await canonicalSha256(evidence);
}
