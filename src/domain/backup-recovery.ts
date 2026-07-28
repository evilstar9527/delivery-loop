import { z } from 'zod';
import { canonicalSha256 } from './digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const R2_KEY_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\u0020-\u007e]{1,1024}$/;

export const BackupIdSchema = z.string().regex(ID_PATTERN);
export const BackupDigestSchema = z.string().regex(DIGEST_PATTERN);

export const BackupR2ObjectDescriptorV1Schema = z.object({
  schemaVersion: z.literal('1'),
  bucket: z.enum(['task', 'checkpoint']),
  key: z.string().regex(R2_KEY_PATTERN),
  backupKey: z.string().regex(R2_KEY_PATTERN),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contentDigest: BackupDigestSchema,
  etag: z.string().min(1).max(256),
  contentType: z.string().min(1).max(256).optional(),
  customMetadata: z.record(
    z.string().min(1).max(128),
    z.string().max(1_024),
  ),
}).strict();

export type BackupR2ObjectDescriptorV1 = z.infer<
  typeof BackupR2ObjectDescriptorV1Schema
>;

export const BackupR2SetSummaryV1Schema = z.object({
  descriptorPrefix: z.string().regex(R2_KEY_PATTERN),
  descriptorSetDigest: BackupDigestSchema,
  objectCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type BackupR2SetSummaryV1 = z.infer<typeof BackupR2SetSummaryV1Schema>;

export const BackupD1ExportV1Schema = z.object({
  key: z.string().regex(R2_KEY_PATTERN),
  digest: BackupDigestSchema,
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type BackupD1ExportV1 = z.infer<typeof BackupD1ExportV1Schema>;

export const BackupManifestBodyV1Schema = z.object({
  schemaVersion: z.literal('1'),
  backupId: BackupIdSchema,
  createdAt: z.iso.datetime({ offset: true }),
  d1: z.object({
    bookmark: z.string().min(1).max(500).regex(/^[A-Za-z0-9_-]+$/),
    key: z.string().regex(R2_KEY_PATTERN),
    digest: BackupDigestSchema,
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  r2: BackupR2SetSummaryV1Schema,
}).strict();

export const BackupManifestV1Schema = BackupManifestBodyV1Schema.extend({
  digest: BackupDigestSchema,
}).strict();

export type BackupManifestBodyV1 = z.infer<typeof BackupManifestBodyV1Schema>;
export type BackupManifestV1 = z.infer<typeof BackupManifestV1Schema>;

export async function computeBackupManifestDigest(
  manifest: BackupManifestBodyV1,
): Promise<string> {
  return await canonicalSha256(BackupManifestBodyV1Schema.parse(manifest));
}

export async function assertBackupManifest(
  raw: unknown,
  expectedDigest?: string,
): Promise<BackupManifestV1> {
  const manifest = BackupManifestV1Schema.parse(raw);
  const { digest: declaredDigest, ...body } = manifest;
  const computed = await computeBackupManifestDigest(body);
  if (computed !== declaredDigest ||
      (expectedDigest !== undefined && expectedDigest !== declaredDigest)) {
    throw new Error('backup manifest digest mismatch');
  }
  return manifest;
}
