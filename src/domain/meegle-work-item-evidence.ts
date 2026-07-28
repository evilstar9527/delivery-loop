import { z } from 'zod';
import { MeegleTriageGapSchema } from './meegle-work-item.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const TimestampSchema = z.iso.datetime({ offset: true });
const ControlPlaneOriginSchema = z.string().url().superRefine((raw, context) => {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) context.addIssue({ code: 'custom', message: 'unsafe control-plane origin' });
});

export const MEEGLE_EVIDENCE_CLI_VERSION = '1.0.16' as const;
export const MEEGLE_EVIDENCE_RELEASE_COMMIT =
  '674042f0f58b62962103aff91598c9bc85ccb138' as const;

const EvidenceCaseSchema = z.object({
  eventId: z.string().regex(ID_PATTERN),
  workItemId: z.string().regex(KEY_PATTERN),
  revision: z.string().min(1).max(500).nullable(),
  expectedGaps: z.array(MeegleTriageGapSchema).max(10),
  pagesMerged: z.number().int().positive().max(200),
  totalItems: z.number().int().nonnegative().max(1_000),
  exactSnapshotDigest: z.string().regex(DIGEST_PATTERN),
  mappingSnapshotDigest: z.string().regex(DIGEST_PATTERN),
}).strict();

export const MeegleWorkItemEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  controlPlaneOrigin: ControlPlaneOriginSchema,
  cli: z.object({
    version: z.literal(MEEGLE_EVIDENCE_CLI_VERSION),
    officialReleaseCommit: z.string().regex(COMMIT_PATTERN)
      .refine((value) => value === MEEGLE_EVIDENCE_RELEASE_COMMIT),
    profile: z.string().regex(KEY_PATTERN),
  }).strict(),
  source: z.object({
    tenantKey: z.string().regex(KEY_PATTERN),
    projectKey: z.string().regex(KEY_PATTERN),
    workItemTypeKey: z.string().regex(KEY_PATTERN),
  }).strict(),
  mappingProfile: z.object({
    version: z.number().int().positive(),
    digest: z.string().regex(DIGEST_PATTERN),
    acceptanceCriteriaFieldKey: z.string().regex(KEY_PATTERN),
    acceptanceCriteriaFieldType: z.string().regex(KEY_PATTERN),
    ownerRoleKey: z.string().regex(KEY_PATTERN),
    targetRepositoryFieldKey: z.string().regex(KEY_PATTERN),
    targetRepositoryFieldType: z.string().regex(KEY_PATTERN),
    allowedRepositories: z.array(z.string().regex(REPOSITORY_PATTERN)).min(1).max(200),
  }).strict(),
  cases: z.object({
    mapped: EvidenceCaseSchema,
    missingFields: EvidenceCaseSchema,
    ownerAmbiguous: EvidenceCaseSchema,
    repositoryDisallowed: EvidenceCaseSchema,
    paginationIncomplete: EvidenceCaseSchema,
  }).strict(),
  mappedResult: z.object({
    sourceTaskKey: z.string().min(1).max(600),
    taskRevision: z.string().min(1).max(500),
    taskDigest: z.string().regex(DIGEST_PATTERN),
    taskId: z.string().regex(ID_PATTERN),
    runId: z.string().regex(ID_PATTERN),
    workflowInstanceId: z.string().regex(ID_PATTERN),
    workflowCreateOutboxId: z.string().regex(ID_PATTERN),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const entries = Object.values(manifest.cases);
  if (
    new Set(entries.map((entry) => entry.eventId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.workItemId)).size !== entries.length
  ) {
    context.addIssue({ code: 'custom', path: ['cases'], message: 'cases must be distinct' });
  }
  const exactGaps = (
    path: keyof typeof manifest.cases,
    expected: readonly z.infer<typeof MeegleTriageGapSchema>[],
  ): void => {
    if (JSON.stringify(manifest.cases[path].expectedGaps) !== JSON.stringify(expected)) {
      context.addIssue({
        code: 'custom',
        path: ['cases', path, 'expectedGaps'],
        message: 'case gaps do not match the required evidence scenario',
      });
    }
  };
  exactGaps('mapped', []);
  exactGaps('missingFields', [
    'description_missing',
    'acceptance_criteria_missing',
    'owner_missing',
    'target_repository_missing',
  ]);
  exactGaps('ownerAmbiguous', ['owner_ambiguous']);
  exactGaps('repositoryDisallowed', ['target_repository_invalid']);
  exactGaps('paginationIncomplete', ['source_fields_incomplete']);
  if (manifest.cases.mapped.revision === null) {
    context.addIssue({
      code: 'custom', path: ['cases', 'mapped', 'revision'], message: 'mapped revision is required',
    });
  }
  if (
    manifest.mappedResult.taskRevision !== manifest.cases.mapped.revision ||
    manifest.mappedResult.sourceTaskKey !==
      `${manifest.source.projectKey}/${manifest.source.workItemTypeKey}/` +
      manifest.cases.mapped.workItemId ||
    manifest.mappedResult.workflowInstanceId !== manifest.mappedResult.runId
  ) {
    context.addIssue({
      code: 'custom', path: ['mappedResult'], message: 'mapped result identity is inconsistent',
    });
  }
  if (
    new Set(manifest.mappingProfile.allowedRepositories).size !==
      manifest.mappingProfile.allowedRepositories.length
  ) {
    context.addIssue({
      code: 'custom', path: ['mappingProfile', 'allowedRepositories'],
      message: 'repository allowlist must be unique',
    });
  }
});

export type MeegleWorkItemEvidenceManifestV1 = z.infer<
  typeof MeegleWorkItemEvidenceManifestV1Schema
>;
