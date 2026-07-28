import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const IdentitySchema = z.object({
  manifestDigest: z.string().regex(DIGEST_PATTERN),
  evidenceId: z.string().regex(ID_PATTERN),
}).strict();

const SelectedCaseSchema = IdentitySchema.extend({
  caseId: z.string().regex(ID_PATTERN),
}).strict();

export const MergeDeploymentE2EEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  recordedAt: z.iso.datetime({ offset: true }),
  observedWindow: z.object({
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  components: z.object({
    testMergeGate: SelectedCaseSchema,
    productionMergeGate: SelectedCaseSchema,
    merge: IdentitySchema.extend({
      testCaseId: z.string().regex(ID_PATTERN),
      productionCaseId: z.string().regex(ID_PATTERN),
    }).strict(),
    testDeployment: SelectedCaseSchema,
    testAcceptance: SelectedCaseSchema,
    productionApproval: SelectedCaseSchema,
    productionDeployment: SelectedCaseSchema,
    feishuCompletion: IdentitySchema.extend({
      testCaseId: z.string().regex(ID_PATTERN),
      productionCaseId: z.string().regex(ID_PATTERN),
    }).strict(),
  }).strict(),
  safety: z.object({ canaryDigest: z.string().regex(DIGEST_PATTERN) }).strict(),
}).strict().superRefine((manifest, context) => {
  const identities = Object.values(manifest.components);
  const evidenceIds = [manifest.evidenceId, ...identities.map((item) => item.evidenceId)];
  if (
    Date.parse(manifest.observedWindow.startedAt) >= Date.parse(manifest.observedWindow.endedAt) ||
    Date.parse(manifest.observedWindow.endedAt) > Date.parse(manifest.recordedAt) ||
    new Set(evidenceIds).size !== evidenceIds.length ||
    manifest.components.testMergeGate.caseId === manifest.components.productionMergeGate.caseId ||
    manifest.components.merge.testCaseId === manifest.components.merge.productionCaseId ||
    manifest.components.feishuCompletion.testCaseId ===
      manifest.components.feishuCompletion.productionCaseId
  ) context.addIssue({ code: 'custom', message: 'merge/deployment E2E evidence is inconsistent' });
});

export type MergeDeploymentE2EEvidenceManifestV1 = z.infer<
  typeof MergeDeploymentE2EEvidenceManifestV1Schema
>;
