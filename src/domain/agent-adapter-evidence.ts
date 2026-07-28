import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

/** Safe, reference-only result emitted after a real non-interactive adapter run. */
export const AgentAdapterEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  provider: z.literal('codex'),
  cliVersion: z.string().regex(SAFE_VERSION_PATTERN),
  resultSchema: z.literal('AgentSessionResultV1'),
  status: z.literal('passed'),
  processExitCode: z.literal(0),
  sessionStatus: z.literal('completed'),
  structuredOutputDigest: z.string().regex(DIGEST_PATTERN),
  checkpoint: z.object({
    sequence: z.number().int().min(2).max(100_000),
    digest: z.string().regex(DIGEST_PATTERN),
    planVersion: z.number().int().positive(),
    planItemId: z.string().regex(ID_PATTERN),
    headBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
    headSha: z.string().regex(SHA_PATTERN),
  }).strict(),
  workspace: z.object({
    headSha: z.string().regex(SHA_PATTERN),
    headBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
    repositoryClean: z.literal(true),
    ephemeral: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (
    manifest.checkpoint.headSha !== manifest.workspace.headSha ||
    manifest.checkpoint.headBranch !== manifest.workspace.headBranch
  ) {
    context.addIssue({ code: 'custom', message: 'checkpoint and workspace heads are not bound' });
  }
});

export type AgentAdapterEvidenceManifestV1 = z.infer<
  typeof AgentAdapterEvidenceManifestV1Schema
>;
