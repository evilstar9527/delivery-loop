import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { CloudflareD1ExportClient, D1ExportClientError } from '../backup/d1-export-client.js';
import { R2BackupManager } from '../backup/r2-backup-manager.js';
import {
  BackupIdSchema,
  computeBackupManifestDigest,
  type BackupD1ExportV1,
} from '../domain/backup-recovery.js';
import type { Bindings } from '../env.js';
import { BackupSnapshotStore } from '../storage/backup-restore-store.js';

const MAX_EXPORT_POLLS = 120;

export interface ControlPlaneBackupWorkflowParams {
  schemaVersion: '1';
  backupId: string;
  createdAt: string;
}

function assertParams(
  event: Readonly<WorkflowEvent<ControlPlaneBackupWorkflowParams>>,
): ControlPlaneBackupWorkflowParams {
  if (event.schedule !== undefined) {
    const createdAt = new Date(event.schedule.scheduledTime).toISOString();
    return {
      schemaVersion: '1',
      backupId: `backup_${createdAt.slice(0, 10).replaceAll('-', '')}`,
      createdAt,
    };
  }
  const raw = event.payload;
  const date = new Date(raw.createdAt);
  if (
    raw.schemaVersion !== '1' ||
    !BackupIdSchema.safeParse(raw.backupId).success ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== raw.createdAt
  ) throw new Error('invalid control-plane backup params');
  return raw;
}

/** Official D1 polling export adapted to private R2 and a replay-safe Workflow. */
export class ControlPlaneBackupWorkflow extends WorkflowEntrypoint<
  Bindings,
  ControlPlaneBackupWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<ControlPlaneBackupWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const params = assertParams(event);
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
    const databaseId = this.env.D1_DATABASE_ID;
    const apiToken = this.env.D1_BACKUP_API_TOKEN;
    if (accountId === undefined || databaseId === undefined || apiToken === undefined) {
      throw new Error('control-plane backup is not configured');
    }
    const client = new CloudflareD1ExportClient({ accountId, databaseId, apiToken });
    const manager = new R2BackupManager(this.env.BACKUP_OBJECTS, {
      task: this.env.TASK_OBJECTS,
      checkpoint: this.env.CHECKPOINT_OBJECTS,
    });
    const started = await step.do('start-d1-export', {
      retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    }, async () => await client.start());

    let exported: BackupD1ExportV1 | null = null;
    for (let poll = 1; poll <= MAX_EXPORT_POLLS; poll += 1) {
      const result = await step.do(`poll-and-store-d1-export-${poll}`, {
        retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
        timeout: '15 minutes',
      }, async () => {
        try {
          const ready = await client.poll(started.bookmark);
          const stream = await client.download(ready.signedUrl);
          const stored = await manager.storeD1Export(params.backupId, stream);
          // The signed URL is intentionally scoped to this callback and never
          // becomes a Workflow step result, log, manifest, or D1 value.
          return { ready: true as const, export: stored };
        } catch (error) {
          if (error instanceof D1ExportClientError && error.code === 'not_ready') {
            return { ready: false as const, export: null };
          }
          throw error;
        }
      });
      if (result.ready) {
        exported = result.export;
        break;
      }
      await step.sleep(`wait-for-d1-export-${poll}`, '30 seconds');
    }
    if (exported === null) throw new Error('D1 export did not become ready');

    const r2 = await step.do('backup-private-r2-objects', {
      retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
      timeout: '6 hours',
    }, async () => await manager.backupAll(params.backupId));

    return await step.do('seal-backup-manifest', {
      retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
      timeout: '5 minutes',
    }, async () => {
      const body = {
        schemaVersion: '1' as const,
        backupId: params.backupId,
        createdAt: params.createdAt,
        d1: { bookmark: started.bookmark, ...exported },
        r2,
      };
      const manifest = { ...body, digest: await computeBackupManifestDigest(body) };
      await manager.storeManifest(manifest);
      const snapshot = await new BackupSnapshotStore(this.env.DB_CONTROL).seal(
        manifest,
        new Date(params.createdAt),
      );
      return {
        schemaVersion: '1' as const,
        backupId: snapshot.backupId,
        manifestDigest: snapshot.manifestDigest,
        d1ExportDigest: snapshot.d1ExportDigest,
        r2DescriptorSetDigest: snapshot.r2DescriptorSetDigest,
        r2ObjectCount: snapshot.r2ObjectCount,
        createdAt: snapshot.createdAt,
        sealedAt: snapshot.sealedAt,
      };
    });
  }
}
