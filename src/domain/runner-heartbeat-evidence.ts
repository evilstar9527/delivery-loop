import { z } from 'zod';
import { AnalysisActionEvidenceManifestV1Schema } from './analysis-action-evidence.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP_SCHEMA = z.iso.datetime({ offset: true });

export const RunnerHeartbeatEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal('1'),
  evidenceId: z.string().regex(ID_PATTERN),
  recordedAt: TIMESTAMP_SCHEMA,
  analysisActionEvidence: AnalysisActionEvidenceManifestV1Schema,
  heartbeat: z.object({
    receiptCount: z.number().int().min(2).max(1_000),
    receiptsDigest: z.string().regex(DIGEST_PATTERN),
    leaseGeneration: z.number().int().positive(),
    firstVersion: z.number().int().positive(),
    lastVersion: z.number().int().positive(),
    firstHeartbeatAt: TIMESTAMP_SCHEMA,
    lastHeartbeatAt: TIMESTAMP_SCHEMA,
    minimumIntervalMs: z.number().int().min(30_000).max(60_000),
    maximumIntervalMs: z.number().int().min(30_000).max(60_000),
  }).strict(),
  result: z.object({
    eventId: z.string().regex(ID_PATTERN),
    sequence: z.literal(1),
    digest: z.string().regex(DIGEST_PATTERN),
    reportedAt: TIMESTAMP_SCHEMA,
  }).strict(),
  webhookObservation: z.object({
    sourceId: z.string().regex(ID_PATTERN),
    sourceDigest: z.string().regex(DIGEST_PATTERN),
    externalUpdatedAt: TIMESTAMP_SCHEMA,
    observedAt: TIMESTAMP_SCHEMA,
    processedAt: TIMESTAMP_SCHEMA,
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const dispatch = manifest.analysisActionEvidence.dispatchEvidence.dispatch;
  const heartbeat = manifest.heartbeat;
  if (
    Date.parse(manifest.recordedAt) < Date.parse(manifest.analysisActionEvidence.recordedAt) ||
    heartbeat.lastVersion !== heartbeat.firstVersion + heartbeat.receiptCount - 1 ||
    Date.parse(heartbeat.firstHeartbeatAt) > Date.parse(heartbeat.lastHeartbeatAt) ||
    heartbeat.minimumIntervalMs > heartbeat.maximumIntervalMs ||
    manifest.result.digest !== dispatch.planDigest ||
    Date.parse(manifest.result.reportedAt) < Date.parse(heartbeat.lastHeartbeatAt) ||
    Date.parse(manifest.result.reportedAt) > Date.parse(dispatch.actionUpdatedAt) ||
    manifest.webhookObservation.externalUpdatedAt !== dispatch.actionUpdatedAt ||
    Date.parse(manifest.webhookObservation.observedAt) >
      Date.parse(manifest.webhookObservation.processedAt) ||
    Date.parse(manifest.webhookObservation.processedAt) > Date.parse(manifest.recordedAt)
  ) context.addIssue({ code: 'custom', message: 'Runner heartbeat evidence is inconsistent' });
});

export type RunnerHeartbeatEvidenceManifestV1 = z.infer<
  typeof RunnerHeartbeatEvidenceManifestV1Schema
>;
