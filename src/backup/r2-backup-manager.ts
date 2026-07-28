import { canonicalSha256 } from '../domain/digest.js';
import {
  assertBackupManifest,
  BackupD1ExportV1Schema,
  BackupIdSchema,
  BackupR2ObjectDescriptorV1Schema,
  BackupR2SetSummaryV1Schema,
  type BackupManifestV1,
  type BackupD1ExportV1,
  type BackupR2ObjectDescriptorV1,
  type BackupR2SetSummaryV1,
} from '../domain/backup-recovery.js';
import { IncrementalSha256 } from './incremental-sha256.js';

const MAX_DESCRIPTOR_BYTES = 32 * 1_024;

export type BackupBucketKind = 'task' | 'checkpoint';
export type R2BackupErrorCode =
  | 'invalid_request'
  | 'source_missing'
  | 'content_conflict'
  | 'descriptor_conflict'
  | 'manifest_conflict';

export class R2BackupError extends Error {
  constructor(readonly code: R2BackupErrorCode) {
    super(`R2 backup operation failed: ${code}`);
    this.name = 'R2BackupError';
  }
}

export interface R2BackupBuckets {
  task: R2Bucket;
  checkpoint: R2Bucket;
}

export interface BackupR2Reference {
  referenceId: string;
  bucket: BackupBucketKind;
  objectKey: string;
  expectedDigest: string;
  metadataKey: 'taskDigest' | 'checkpointDigest' | 'bodyDigest' | 'contextDigest';
}

function bytesToDigest(bytes: Uint8Array): string {
  return `sha256:${[...bytes]
    .map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

async function digestBody(body: ReadableStream<Uint8Array>): Promise<string> {
  const digest = new IncrementalSha256();
  const reader = body.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    digest.update(result.value);
  }
  return bytesToDigest(digest.digest());
}

function sortedMetadata(raw: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(raw ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)));
}

async function readBoundedText(object: R2ObjectBody, maximum: number): Promise<string> {
  if (object.size > maximum) throw new R2BackupError('descriptor_conflict');
  return await object.text();
}

/** Copies immutable control-plane R2 objects into a private, digest-addressed backup set. */
export class R2BackupManager {
  constructor(
    private readonly backupBucket: R2Bucket,
    private readonly sourceBuckets: R2BackupBuckets,
  ) {}

  async backupAll(rawBackupId: string): Promise<BackupR2SetSummaryV1> {
    const backupId = this.backupId(rawBackupId);
    for (const kind of ['task', 'checkpoint'] as const) {
      await this.backupBucketKind(backupId, kind, this.sourceBuckets[kind]);
    }
    return await this.descriptorSetSummary(backupId);
  }

  async storeD1Export(
    rawBackupId: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ key: string; digest: string; size: number }> {
    const backupId = this.backupId(rawBackupId);
    const key = `backups/${backupId}/d1/export.sql`;
    const stored = await this.storeStream(key, body, {
      customMetadata: { kind: 'd1-export' },
      httpMetadata: { contentType: 'application/sql; charset=utf-8' },
    });
    if (stored.size < 1) throw new R2BackupError('content_conflict');
    return { key, digest: stored.digest, size: stored.size };
  }

  async storeManifest(
    rawManifest: BackupManifestV1,
  ): Promise<{ key: string; digest: string; size: number }> {
    const manifest = await assertBackupManifest(rawManifest);
    const key = `backups/${manifest.backupId}/manifest.json`;
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const stored = await this.backupBucket.put(key, bytes, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { manifestDigest: manifest.digest },
    });
    return { key, digest: manifest.digest, size: stored.size };
  }

  async loadManifest(rawBackupId: string, expectedDigest: string): Promise<BackupManifestV1> {
    const backupId = this.backupId(rawBackupId);
    const object = await this.backupBucket.get(`backups/${backupId}/manifest.json`);
    if (object === null || object.size > MAX_DESCRIPTOR_BYTES) {
      throw new R2BackupError('manifest_conflict');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await object.text()) as unknown;
    } catch {
      throw new R2BackupError('manifest_conflict');
    }
    try {
      return await assertBackupManifest(raw, expectedDigest);
    } catch {
      throw new R2BackupError('manifest_conflict');
    }
  }

  async verifyD1Export(rawExport: BackupD1ExportV1): Promise<{ size: number; digest: string }> {
    const expected = BackupD1ExportV1Schema.parse({
      key: rawExport.key,
      digest: rawExport.digest,
      size: rawExport.size,
    });
    const object = await this.backupBucket.get(expected.key);
    if (object === null) throw new R2BackupError('source_missing');
    const digest = await digestBody(object.body);
    if (object.size !== expected.size || digest !== expected.digest) {
      throw new R2BackupError('content_conflict');
    }
    return { size: object.size, digest };
  }

  async restoreAll(
    rawBackupId: string,
    rawSummary: BackupR2SetSummaryV1,
  ): Promise<{ objectCount: number; totalBytes: number }> {
    const backupId = this.backupId(rawBackupId);
    const summary = BackupR2SetSummaryV1Schema.parse(rawSummary);
    await this.assertDescriptorSummary(backupId, summary);
    let objectCount = 0;
    let totalBytes = 0;
    await this.forEachDescriptor(backupId, async (descriptor) => {
      const backup = await this.backupBucket.get(descriptor.backupKey);
      if (backup === null) throw new R2BackupError('source_missing');
      const [forDigest, forRestore] = backup.body.tee();
      const digestPromise = digestBody(forDigest);
      const restored = await this.sourceBuckets[descriptor.bucket].put(
        descriptor.key,
        forRestore,
        {
          ...(descriptor.contentType === undefined
            ? {}
            : { httpMetadata: { contentType: descriptor.contentType } }),
          customMetadata: descriptor.customMetadata,
        },
      );
      if (
        await digestPromise !== descriptor.contentDigest ||
        restored.size !== descriptor.size
      ) throw new R2BackupError('content_conflict');
      objectCount += 1;
      totalBytes += descriptor.size;
    });
    if (objectCount !== summary.objectCount || totalBytes !== summary.totalBytes) {
      throw new R2BackupError('descriptor_conflict');
    }
    return { objectCount, totalBytes };
  }

  async verifyAll(
    rawBackupId: string,
    rawSummary: BackupR2SetSummaryV1,
  ): Promise<{ objectCount: number; totalBytes: number }> {
    const backupId = this.backupId(rawBackupId);
    const summary = BackupR2SetSummaryV1Schema.parse(rawSummary);
    await this.assertDescriptorSummary(backupId, summary);
    let objectCount = 0;
    let totalBytes = 0;
    await this.forEachDescriptor(backupId, async (descriptor) => {
      const [backup, restored] = await Promise.all([
        this.backupBucket.get(descriptor.backupKey),
        this.sourceBuckets[descriptor.bucket].get(descriptor.key),
      ]);
      if (backup === null || restored === null) throw new R2BackupError('source_missing');
      const [backupDigest, restoredDigest] = await Promise.all([
        digestBody(backup.body),
        digestBody(restored.body),
      ]);
      if (
        backupDigest !== descriptor.contentDigest ||
        restoredDigest !== descriptor.contentDigest ||
        backup.size !== descriptor.size || restored.size !== descriptor.size ||
        JSON.stringify(sortedMetadata(restored.customMetadata)) !==
          JSON.stringify(descriptor.customMetadata) ||
        restored.httpMetadata?.contentType !== descriptor.contentType
      ) throw new R2BackupError('content_conflict');
      objectCount += 1;
      totalBytes += descriptor.size;
    });
    if (objectCount !== summary.objectCount || totalBytes !== summary.totalBytes) {
      throw new R2BackupError('descriptor_conflict');
    }
    return { objectCount, totalBytes };
  }

  async verifyReferences(
    rawBackupId: string,
    rawSummary: BackupR2SetSummaryV1,
    references: readonly BackupR2Reference[],
  ): Promise<{ referenceCount: number }> {
    const backupId = this.backupId(rawBackupId);
    const summary = BackupR2SetSummaryV1Schema.parse(rawSummary);
    await this.assertDescriptorSummary(backupId, summary);
    for (const reference of references) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(reference.referenceId) ||
        !['task', 'checkpoint'].includes(reference.bucket) ||
        !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\u0020-\u007e]{1,1024}$/.test(
          reference.objectKey,
        ) ||
        !/^sha256:[a-f0-9]{64}$/.test(reference.expectedDigest) ||
        !['taskDigest', 'checkpointDigest', 'bodyDigest', 'contextDigest']
          .includes(reference.metadataKey)
      ) throw new R2BackupError('descriptor_conflict');
      const suffix = (await canonicalSha256({
        bucket: reference.bucket,
        key: reference.objectKey,
      })).slice('sha256:'.length);
      const descriptorObject = await this.backupBucket.get(
        `backups/${backupId}/descriptors/${reference.bucket}/${suffix}.json`,
      );
      if (descriptorObject === null) throw new R2BackupError('source_missing');
      let descriptor: BackupR2ObjectDescriptorV1;
      try {
        descriptor = BackupR2ObjectDescriptorV1Schema.parse(
          JSON.parse(await readBoundedText(descriptorObject, MAX_DESCRIPTOR_BYTES)) as unknown,
        );
      } catch {
        throw new R2BackupError('descriptor_conflict');
      }
      if (
        descriptor.bucket !== reference.bucket ||
        descriptor.key !== reference.objectKey ||
        descriptor.customMetadata[reference.metadataKey] !== reference.expectedDigest
      ) throw new R2BackupError('descriptor_conflict');
      const restored = await this.sourceBuckets[reference.bucket].get(reference.objectKey);
      if (
        restored === null ||
        restored.customMetadata?.[reference.metadataKey] !== reference.expectedDigest ||
        restored.size !== descriptor.size ||
        await digestBody(restored.body) !== descriptor.contentDigest
      ) throw new R2BackupError('content_conflict');
    }
    return { referenceCount: references.length };
  }

  private async backupBucketKind(
    backupId: string,
    kind: BackupBucketKind,
    bucket: R2Bucket,
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ ...(cursor === undefined ? {} : { cursor }) });
      for (const listed of page.objects) {
        const source = await bucket.get(listed.key);
        if (source === null) throw new R2BackupError('source_missing');
        const keyDigest = await canonicalSha256({ bucket: kind, key: source.key });
        const suffix = keyDigest.slice('sha256:'.length);
        const backupKey = `backups/${backupId}/objects/${kind}/${suffix}`;
        const descriptorKey = `backups/${backupId}/descriptors/${kind}/${suffix}.json`;
        const stored = await this.storeStream(backupKey, source.body, {
          customMetadata: { sourceBucket: kind },
        });
        const descriptor = BackupR2ObjectDescriptorV1Schema.parse({
          schemaVersion: '1',
          bucket: kind,
          key: source.key,
          backupKey,
          size: source.size,
          contentDigest: stored.digest,
          etag: source.etag,
          ...(source.httpMetadata?.contentType === undefined
            ? {}
            : { contentType: source.httpMetadata.contentType }),
          customMetadata: sortedMetadata(source.customMetadata),
        });
        await this.backupBucket.put(descriptorKey, JSON.stringify(descriptor), {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
          customMetadata: {
            descriptorDigest: await canonicalSha256(descriptor),
          },
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }

  private async descriptorSetSummary(backupId: string): Promise<BackupR2SetSummaryV1> {
    const descriptorPrefix = `backups/${backupId}/descriptors/`;
    const digest = new IncrementalSha256();
    let objectCount = 0;
    let totalBytes = 0;
    await this.forEachDescriptor(backupId, async (descriptor, descriptorKey) => {
      const descriptorDigest = await canonicalSha256(descriptor);
      digest.update(new TextEncoder().encode(
        `${JSON.stringify({ descriptorKey, descriptorDigest })}\n`,
      ));
      objectCount += 1;
      totalBytes += descriptor.size;
    });
    return BackupR2SetSummaryV1Schema.parse({
      descriptorPrefix,
      descriptorSetDigest: bytesToDigest(digest.digest()),
      objectCount,
      totalBytes,
    });
  }

  private async assertDescriptorSummary(
    backupId: string,
    expected: BackupR2SetSummaryV1,
  ): Promise<void> {
    const actual = await this.descriptorSetSummary(backupId);
    if (
      actual.descriptorPrefix !== expected.descriptorPrefix ||
      actual.descriptorSetDigest !== expected.descriptorSetDigest ||
      actual.objectCount !== expected.objectCount ||
      actual.totalBytes !== expected.totalBytes
    ) throw new R2BackupError('descriptor_conflict');
  }

  private async forEachDescriptor(
    backupId: string,
    operation: (
      descriptor: BackupR2ObjectDescriptorV1,
      descriptorKey: string,
    ) => Promise<void>,
  ): Promise<void> {
    const prefix = `backups/${backupId}/descriptors/`;
    let cursor: string | undefined;
    do {
      const page = await this.backupBucket.list({
        prefix,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const listed of page.objects) {
        const object = await this.backupBucket.get(listed.key);
        if (object === null) throw new R2BackupError('descriptor_conflict');
        let descriptor: BackupR2ObjectDescriptorV1;
        try {
          descriptor = BackupR2ObjectDescriptorV1Schema.parse(
            JSON.parse(await readBoundedText(object, MAX_DESCRIPTOR_BYTES)) as unknown,
          );
        } catch {
          throw new R2BackupError('descriptor_conflict');
        }
        await operation(descriptor, listed.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }

  private async storeStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: R2PutOptions = {},
  ): Promise<{ digest: string; size: number }> {
    const [forDigest, forStorage] = body.tee();
    const digestPromise = digestBody(forDigest);
    const stored = await this.backupBucket.put(key, forStorage, options);
    return { digest: await digestPromise, size: stored.size };
  }

  private backupId(raw: string): string {
    const parsed = BackupIdSchema.safeParse(raw);
    if (!parsed.success) throw new R2BackupError('invalid_request');
    return parsed.data;
  }
}
