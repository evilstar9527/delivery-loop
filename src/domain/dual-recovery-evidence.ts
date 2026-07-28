import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,31}$/;

const IdentitySchema = z.object({
  manifestDigest: z.string().regex(DIGEST_PATTERN),
  evidenceId: z.string().regex(ID_PATTERN),
  runId: z.string().regex(ID_PATTERN),
}).strict();

export const DualRecoveryEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  observedWindow: z.object({
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  workflowHibernate: IdentitySchema.extend({
    actionRunId: z.string().regex(GITHUB_ID_PATTERN),
  }).strict(),
  runnerRecovery: IdentitySchema.extend({
    lostActionRunId: z.string().regex(GITHUB_ID_PATTERN),
    replacementActionRunId: z.string().regex(GITHUB_ID_PATTERN),
  }).strict(),
  safety: z.object({
    canaryDigest: z.string().regex(DIGEST_PATTERN),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const startedAt = Date.parse(manifest.observedWindow.startedAt);
  const endedAt = Date.parse(manifest.observedWindow.endedAt);
  const recordedAt = Date.parse(manifest.recordedAt);
  const evidenceIds = [
    manifest.evidenceId,
    manifest.workflowHibernate.evidenceId,
    manifest.runnerRecovery.evidenceId,
  ];
  const actionRunIds = [
    manifest.workflowHibernate.actionRunId,
    manifest.runnerRecovery.lostActionRunId,
    manifest.runnerRecovery.replacementActionRunId,
  ];
  if (
    startedAt >= endedAt || endedAt > recordedAt ||
    manifest.workflowHibernate.runId === manifest.runnerRecovery.runId ||
    new Set(evidenceIds).size !== evidenceIds.length ||
    new Set(actionRunIds).size !== actionRunIds.length
  ) context.addIssue({ code: 'custom', message: 'dual recovery evidence is inconsistent' });
});

export type DualRecoveryEvidenceManifestV1 = z.infer<
  typeof DualRecoveryEvidenceManifestV1Schema
>;
