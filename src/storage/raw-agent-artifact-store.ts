import { canonicalSha256 } from '../domain/digest.js';
import {
  RawAgentArtifactRequestBodySchema,
  type RawAgentArtifactCategory,
} from '../domain/raw-agent-artifact.js';
import { isExactExecutionToolActions } from '../domain/tool-bridge.js';
import { SecretScanner } from '../security/redaction.js';
import {
  RAW_AGENT_RETENTION_POLICY,
  RAW_AGENT_RETENTION_SECONDS,
  rawAgentObjectKey,
} from './data-retention-store.js';

const MAX_ARTIFACT_BYTES = 1_048_576;
const DELIVERY_LEASE_MS = 30_000;

export type RawAgentArtifactErrorCode =
  | 'invalid_request'
  | 'invalid_token'
  | 'policy_denied'
  | 'state_conflict'
  | 'payload_conflict'
  | 'secret_detected'
  | 'configuration_unavailable'
  | 'storage_unavailable';

export class RawAgentArtifactError extends Error {
  constructor(readonly code: RawAgentArtifactErrorCode) {
    super(`Raw Agent artifact operation failed: ${code}`);
    this.name = 'RawAgentArtifactError';
  }
}

export interface RawAgentArtifactReadyResult {
  status: 'ready';
  artifactId: string;
  category: RawAgentArtifactCategory;
  objectIdentityDigest: string;
  ciphertextDigest: string;
  sizeBytes: number;
  expiresAt: string;
  created: boolean;
}

export interface RawAgentArtifactBusyResult {
  status: 'uploading';
  artifactId: string;
  category: RawAgentArtifactCategory;
  objectIdentityDigest: string;
  created: false;
}

export type RawAgentArtifactResult = RawAgentArtifactReadyResult | RawAgentArtifactBusyResult;

interface ArtifactAuthorizationRow {
  attempt_id: string;
  mode: string;
  status: string;
  version: number;
  lease_generation: number;
  lease_expires_at: string | null;
  token_expires_at: string;
  scopes_json: string;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_status: string | null;
  progress_status: string | null;
  active_attempt_id: string | null;
}

interface UploadRow {
  upload_id: string;
  object_identity_digest: string;
  attempt_id: string;
  category: RawAgentArtifactCategory;
  lease_generation: number;
  upload_state: 'pending' | 'delivering' | 'complete';
}

interface ArtifactRow {
  object_id: string;
  object_identity_digest: string;
  category: RawAgentArtifactCategory;
  ciphertext_digest: string;
  size_bytes: number;
  expires_at: string;
}

export interface RawAgentArtifactStoreOptions {
  secrets?: readonly string[];
  now?: () => Date;
  generateLeaseToken?: () => string;
}

interface CiphertextEnvelopeV1 {
  v: 1;
  iv: string;
  ct: string;
}

/** Directly copied from Watt SecretStore@476e3cd. */
function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Directly copied from Watt SecretStore@476e3cd. */
function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

/** Fenced scan → AES-256-GCM → private R2 → immutable D1 registry producer. */
export class RawAgentArtifactStore {
  private readonly secrets: readonly string[];
  private readonly now: () => Date;
  private readonly generateLeaseToken: () => string;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    private readonly encryptionKey: string,
    options: RawAgentArtifactStoreOptions = {},
  ) {
    this.secrets = [encryptionKey, ...(options.secrets ?? [])];
    this.now = options.now ?? (() => new Date());
    this.generateLeaseToken = options.generateLeaseToken ?? (() => crypto.randomUUID());
  }

  async save(
    attemptId: string,
    rawToken: string,
    rawInput: unknown,
  ): Promise<RawAgentArtifactResult> {
    const parsed = RawAgentArtifactRequestBodySchema.safeParse(rawInput);
    if (!parsed.success || parsed.data.artifactId !== parsed.data.artifactId.toLowerCase()) {
      throw new RawAgentArtifactError('invalid_request');
    }
    const input = parsed.data;
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new RawAgentArtifactError('invalid_request');
    }
    if (new SecretScanner({ secrets: [rawToken, ...this.secrets] }).scanText(
      input.content,
      '$.artifact.content',
    ).length > 0) throw new RawAgentArtifactError('secret_detected');
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new RawAgentArtifactError('state_conflict');
    const nowIso = now.toISOString();
    const tokenDigest = await canonicalSha256(rawToken);
    await this.authorize(attemptId, tokenDigest, input.expectedVersion, input.leaseGeneration, nowIso);
    const contentDigest = await canonicalSha256({ kind: 'raw_agent_artifact', content: input.content });
    const objectIdentityDigest = await canonicalSha256({
      schemaVersion: '1',
      attemptId,
      artifactId: input.artifactId,
      category: input.category,
      contentDigest,
    });
    let upload = await this.upload(input.artifactId);
    if (upload === null) {
      await this.db.prepare(
        `INSERT INTO raw_agent_artifact_uploads (
           upload_id, object_identity_digest, attempt_id, category,
           lease_generation, upload_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        input.artifactId,
        objectIdentityDigest,
        attemptId,
        input.category,
        input.leaseGeneration,
        nowIso,
        nowIso,
      ).run();
      upload = await this.upload(input.artifactId);
    }
    this.assertUpload(upload, attemptId, input, objectIdentityDigest);
    if (upload.upload_state === 'complete') {
      return await this.ready(upload, false);
    }

    const leaseToken = this.generateLeaseToken();
    const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString();
    const claimed = await this.db.prepare(
      `UPDATE raw_agent_artifact_uploads
       SET upload_state = 'delivering', delivery_lease_token = ?,
           delivery_lease_expires_at = ?, last_error_code = NULL, updated_at = ?
       WHERE upload_id = ? AND object_identity_digest = ?
         AND (
           upload_state = 'pending' OR
           (upload_state = 'delivering' AND delivery_lease_expires_at <= ?)
         )`,
    ).bind(
      leaseToken,
      leaseExpiresAt,
      nowIso,
      input.artifactId,
      objectIdentityDigest,
      nowIso,
    ).run();
    if (claimed.meta.changes !== 1) {
      const current = await this.upload(input.artifactId);
      this.assertUpload(current, attemptId, input, objectIdentityDigest);
      if (current.upload_state === 'complete') return await this.ready(current, false);
      return {
        status: 'uploading',
        artifactId: input.artifactId,
        category: input.category,
        objectIdentityDigest,
        created: false,
      };
    }

    const objectKey = rawAgentObjectKey(input.category, input.artifactId);
    try {
      await this.authorize(
        attemptId,
        tokenDigest,
        input.expectedVersion,
        input.leaseGeneration,
        this.now().toISOString(),
      );
      const envelope = await this.encrypt(input.content, objectIdentityDigest);
      const serialized = JSON.stringify(envelope);
      const ciphertextDigest = await canonicalSha256({
        kind: 'raw_agent_ciphertext_v1',
        value: serialized,
      });
      const createdAt = this.now();
      const createdAtIso = createdAt.toISOString();
      const expiresAt = new Date(
        createdAt.getTime() + RAW_AGENT_RETENTION_SECONDS * 1_000,
      ).toISOString();
      const object = await this.objects.put(objectKey, serialized, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          schemaVersion: '1',
          retentionClass: input.category,
          objectId: input.artifactId,
          ciphertextDigest,
          encryption: 'AES-256-GCM',
        },
      });
      if (object === null) throw new RawAgentArtifactError('storage_unavailable');
      await this.authorize(
        attemptId,
        tokenDigest,
        input.expectedVersion,
        input.leaseGeneration,
        this.now().toISOString(),
      );
      const results = await this.db.batch([
        this.db.prepare(
          `INSERT INTO raw_agent_artifacts (
             object_id, object_identity_digest, category, ciphertext_digest,
             size_bytes, r2_etag, policy_version, created_at, expires_at,
             deletion_state, retry_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)
           ON CONFLICT DO NOTHING`,
        ).bind(
          input.artifactId,
          objectIdentityDigest,
          input.category,
          ciphertextDigest,
          new TextEncoder().encode(serialized).byteLength,
          object.etag,
          RAW_AGENT_RETENTION_POLICY,
          createdAtIso,
          expiresAt,
          createdAtIso,
        ),
        this.db.prepare(
          `UPDATE raw_agent_artifact_uploads
           SET upload_state = 'complete', delivery_lease_token = NULL,
               delivery_lease_expires_at = NULL, last_error_code = NULL,
               completed_at = ?, updated_at = ?
           WHERE upload_id = ? AND upload_state = 'delivering'
             AND delivery_lease_token = ?
             AND EXISTS (
               SELECT 1 FROM raw_agent_artifacts
               WHERE object_id = ? AND object_identity_digest = ?
                 AND category = ? AND ciphertext_digest = ?
             )`,
        ).bind(
          createdAtIso,
          createdAtIso,
          input.artifactId,
          leaseToken,
          input.artifactId,
          objectIdentityDigest,
          input.category,
          ciphertextDigest,
        ),
      ]);
      if (results[1]?.meta.changes !== 1) {
        throw new RawAgentArtifactError('state_conflict');
      }
      const complete = await this.upload(input.artifactId);
      this.assertUpload(complete, attemptId, input, objectIdentityDigest);
      return await this.ready(complete, results[0]?.meta.changes === 1);
    } catch (error) {
      await this.rollback(input.artifactId, leaseToken);
      if (error instanceof RawAgentArtifactError) throw error;
      throw new RawAgentArtifactError('storage_unavailable');
    }
  }

  private async cryptoKey(): Promise<CryptoKey> {
    if (this.keyPromise === null) {
      let raw: Uint8Array<ArrayBuffer>;
      try {
        raw = b64urlDecode(this.encryptionKey);
      } catch {
        throw new RawAgentArtifactError('configuration_unavailable');
      }
      if (raw.length !== 32) throw new RawAgentArtifactError('configuration_unavailable');
      this.keyPromise = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
        'encrypt',
      ]);
    }
    return await this.keyPromise;
  }

  /** Watt SecretStore semantics: random 12B IV and identity-bound AAD. */
  private async encrypt(content: string, identityDigest: string): Promise<CiphertextEnvelopeV1> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(identityDigest),
    }, await this.cryptoKey(), new TextEncoder().encode(content));
    return { v: 1, iv: b64urlEncode(iv), ct: b64urlEncode(new Uint8Array(ciphertext)) };
  }

  private async authorize(
    attemptId: string,
    tokenDigest: string,
    expectedVersion: number,
    leaseGeneration: number,
    nowIso: string,
  ): Promise<void> {
    const row = await this.db.prepare(
      `SELECT attempts.attempt_id, attempts.mode, attempts.status, attempts.version,
              attempts.lease_generation, attempts.lease_expires_at,
              attempt_tokens.expires_at AS token_expires_at,
              attempt_tokens.scopes_json, attempts.plan_id, attempts.plan_version,
              attempts.plan_item_id, runs.active_plan_id, runs.active_plan_version,
              execution_plans.status AS plan_status,
              plan_item_progress.status AS progress_status,
              plan_item_progress.active_attempt_id
       FROM attempts
       JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
       JOIN runs ON runs.run_id = attempts.run_id
       LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
       LEFT JOIN plan_item_progress
         ON plan_item_progress.plan_id = attempts.plan_id
        AND plan_item_progress.item_id = attempts.plan_item_id
       WHERE attempts.attempt_id = ? AND attempt_tokens.token_digest = ?
         AND attempt_tokens.lease_generation = ?
         AND attempt_tokens.revoked_at IS NULL AND attempt_tokens.expires_at > ?`,
    ).bind(attemptId, tokenDigest, leaseGeneration, nowIso).first<ArtifactAuthorizationRow>();
    if (row === null) throw new RawAgentArtifactError('invalid_token');
    let scopes: unknown;
    try {
      scopes = JSON.parse(row.scopes_json) as unknown;
    } catch {
      throw new RawAgentArtifactError('policy_denied');
    }
    if (!isExactExecutionToolActions(scopes) || !scopes.includes('artifact:write')) {
      throw new RawAgentArtifactError('policy_denied');
    }
    if (
      (row.mode !== 'implement' && row.mode !== 'review_fix') || row.status !== 'running' ||
      row.version !== expectedVersion || row.lease_generation !== leaseGeneration ||
      row.lease_expires_at === null || row.lease_expires_at <= nowIso ||
      row.token_expires_at <= nowIso || row.plan_id === null || row.plan_version === null ||
      row.plan_item_id === null || row.active_plan_id !== row.plan_id ||
      row.active_plan_version !== row.plan_version || row.plan_status !== 'active' ||
      row.progress_status !== 'in_progress' || row.active_attempt_id !== row.attempt_id
    ) throw new RawAgentArtifactError('state_conflict');
  }

  private async upload(uploadId: string): Promise<UploadRow | null> {
    return await this.db.prepare(
      `SELECT upload_id, object_identity_digest, attempt_id, category,
              lease_generation, upload_state
       FROM raw_agent_artifact_uploads WHERE upload_id = ?`,
    ).bind(uploadId).first<UploadRow>();
  }

  private assertUpload(
    upload: UploadRow | null,
    attemptId: string,
    input: { artifactId: string; category: RawAgentArtifactCategory;
      expectedVersion: number; leaseGeneration: number },
    identityDigest: string,
  ): asserts upload is UploadRow {
    if (upload === null) throw new RawAgentArtifactError('state_conflict');
    if (
      upload.upload_id !== input.artifactId || upload.object_identity_digest !== identityDigest ||
      upload.attempt_id !== attemptId || upload.category !== input.category ||
      upload.lease_generation !== input.leaseGeneration
    ) throw new RawAgentArtifactError('payload_conflict');
  }

  private async ready(upload: UploadRow, created: boolean): Promise<RawAgentArtifactReadyResult> {
    const artifact = await this.db.prepare(
      `SELECT object_id, object_identity_digest, category, ciphertext_digest,
              size_bytes, expires_at
       FROM raw_agent_artifacts WHERE object_id = ?`,
    ).bind(upload.upload_id).first<ArtifactRow>();
    if (
      artifact === null || artifact.object_identity_digest !== upload.object_identity_digest ||
      artifact.category !== upload.category
    ) throw new RawAgentArtifactError('payload_conflict');
    return {
      status: 'ready',
      artifactId: artifact.object_id,
      category: artifact.category,
      objectIdentityDigest: artifact.object_identity_digest,
      ciphertextDigest: artifact.ciphertext_digest,
      sizeBytes: artifact.size_bytes,
      expiresAt: artifact.expires_at,
      created,
    };
  }

  private async rollback(uploadId: string, leaseToken: string): Promise<void> {
    try {
      await this.db.prepare(
        `UPDATE raw_agent_artifact_uploads
         SET upload_state = 'pending', delivery_lease_token = NULL,
             delivery_lease_expires_at = NULL,
             last_error_code = 'storage_unavailable', updated_at = ?
         WHERE upload_id = ? AND upload_state = 'delivering'
           AND delivery_lease_token = ?`,
      ).bind(this.now().toISOString(), uploadId, leaseToken).run();
    } catch {
      // Expired delivering intents are safely reclaimable by the next request.
    }
  }
}
