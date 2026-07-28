import { z } from 'zod';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const URL_SCHEMA = z.string().min(1).max(2_048).superRefine((raw, context) => {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== ''
    ) context.addIssue({ code: 'custom', message: 'URL is not a safe HTTPS link' });
  } catch {
    context.addIssue({ code: 'custom', message: 'URL is invalid' });
  }
});

const TimestampSchema = z.iso.datetime({ offset: true });
export const GitHubPullRequestEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TimestampSchema,
  runId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(REPOSITORY_PATTERN),
  publication: z.object({
    publicationId: z.string().regex(ID_PATTERN),
    approvalId: z.string().regex(ID_PATTERN),
    repository: z.string().regex(REPOSITORY_PATTERN),
    baseBranch: z.string().regex(BRANCH_PATTERN),
    headBranch: z.string().regex(BRANCH_PATTERN),
    headSha: z.string().regex(SHA_PATTERN),
    bodyDigest: z.string().regex(DIGEST_PATTERN),
    status: z.literal('verified'),
    number: z.number().int().positive(),
    url: URL_SCHEMA,
    evidenceId: z.string().regex(ID_PATTERN),
    webhook: z.object({
      deliveryId: z.string().regex(ID_PATTERN),
      payloadDigest: z.string().regex(DIGEST_PATTERN),
      processingState: z.literal('applied'),
      externalUpdatedAt: TimestampSchema,
      receivedAt: TimestampSchema,
    }).strict(),
    apiObservation: z.object({
      observationId: z.string().regex(ID_PATTERN),
      factDigest: z.string().regex(DIGEST_PATTERN),
      processingState: z.literal('applied'),
      externalUpdatedAt: TimestampSchema,
      observedAt: TimestampSchema,
    }).strict(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (
    manifest.publication.repository !== manifest.repository ||
    manifest.publication.baseBranch === manifest.publication.headBranch ||
    Date.parse(manifest.publication.webhook.receivedAt) <
      Date.parse(manifest.publication.webhook.externalUpdatedAt) ||
    Date.parse(manifest.publication.apiObservation.observedAt) <
      Date.parse(manifest.publication.apiObservation.externalUpdatedAt)
  ) context.addIssue({ code: 'custom', message: 'PR evidence binding is inconsistent' });
});

export type GitHubPullRequestEvidenceManifestV1 = z.infer<
  typeof GitHubPullRequestEvidenceManifestV1Schema
>;
