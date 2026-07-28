import {
  FeishuCardCompletionEvidenceManifestV1Schema,
  type FeishuCardCompletionEvidenceManifestV1,
} from '../domain/feishu-card-completion-evidence.js';
import {
  FeishuCardPresentationEvidenceVerificationError,
  type FeishuCardPresentationEvidenceVerifierOptions,
  verifyFeishuLivePresentation,
} from './feishu-card-presentation-evidence-verifier.js';

export type FeishuCardCompletionEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'live_evidence_unavailable'
  | 'completion_snapshot_mismatch'
  | 'completion_delivery_mismatch'
  | 'completion_card_mismatch';

export class FeishuCardCompletionEvidenceVerificationError extends Error {
  constructor(readonly code: FeishuCardCompletionEvidenceVerificationErrorCode) {
    super(`Feishu completion card evidence verification failed: ${code}`);
    this.name = 'FeishuCardCompletionEvidenceVerificationError';
  }
}

export type FeishuCardCompletionEvidenceVerifierOptions =
  FeishuCardPresentationEvidenceVerifierOptions;

export interface FeishuCardCompletionEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  testRunId: string;
  productionRunId: string;
  completedCards: 2;
  settledPresentations: 2;
  liveCards: 2;
  activeActions: 0;
  activeApprovals: 0;
  plaintextLeaks: 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function translated(error: unknown): FeishuCardCompletionEvidenceVerificationError {
  if (!(error instanceof FeishuCardPresentationEvidenceVerificationError)) {
    return new FeishuCardCompletionEvidenceVerificationError('live_evidence_unavailable');
  }
  if (error.code === 'configuration_invalid') {
    return new FeishuCardCompletionEvidenceVerificationError('configuration_invalid');
  }
  if (
    error.code === 'control_plane_unavailable' || error.code === 'feishu_api_unavailable' ||
    error.code === 'control_plane_response_invalid' || error.code === 'feishu_response_invalid' ||
    error.code === 'secret_leak_detected'
  ) return new FeishuCardCompletionEvidenceVerificationError('live_evidence_unavailable');
  if (error.code === 'card_digest_mismatch' || error.code === 'card_content_mismatch') {
    return new FeishuCardCompletionEvidenceVerificationError('completion_card_mismatch');
  }
  return new FeishuCardCompletionEvidenceVerificationError('completion_delivery_mismatch');
}

export async function verifyFeishuCardCompletionEvidence(
  input: FeishuCardCompletionEvidenceManifestV1,
  options: FeishuCardCompletionEvidenceVerifierOptions,
): Promise<FeishuCardCompletionEvidenceVerificationSummary> {
  const parsed = FeishuCardCompletionEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new FeishuCardCompletionEvidenceVerificationError('manifest_invalid');
  }
  for (const item of parsed.data.cases) {
    let live: Awaited<ReturnType<typeof verifyFeishuLivePresentation>>;
    try {
      live = await verifyFeishuLivePresentation({
        taskId: item.taskId,
        runId: item.runId,
        repository: item.repository,
        card: item.card,
        presentation: item.completion,
        canaryDigest: parsed.data.safety.canaryDigest,
      }, options);
    } catch (error) {
      throw translated(error);
    }
    const snapshot = live.presentation.snapshot;
    if (
      snapshot.runState !== 'succeeded' || snapshot.runVersion !== item.runVersion ||
      snapshot.taskRevision !== item.taskRevision ||
      snapshot.targetRepository !== item.repository || snapshot.baseSha !== item.baseSha ||
      snapshot.planVersion !== item.planVersion || snapshot.planDigest !== item.planDigest ||
      JSON.stringify(snapshot.progress) !== JSON.stringify(item.progress) ||
      snapshot.blocker !== null || snapshot.approvedEffects.length !== 0 ||
      snapshot.pr.status !== 'open' || snapshot.pr.url !== item.pullRequestUrl ||
      snapshot.merge.status !== 'merged' || snapshot.merge.url !== item.mergeUrl ||
      (item.lane === 'test' && (
        snapshot.testDeploy.status !== 'succeeded' ||
        snapshot.testDeploy.url !== item.deploymentUrl ||
        snapshot.productionDeploy.status !== 'not_started' ||
        snapshot.productionDeploy.url !== null
      )) ||
      (item.lane === 'production' && (
        snapshot.testDeploy.status !== 'not_started' || snapshot.testDeploy.url !== null ||
        snapshot.productionDeploy.status !== 'succeeded' ||
        snapshot.productionDeploy.url !== item.deploymentUrl
      ))
    ) throw new FeishuCardCompletionEvidenceVerificationError('completion_snapshot_mismatch');

    const rows = [...live.evidence.presentations].sort((left, right) =>
      left.revision - right.revision);
    const firstDelivered = rows.find((row) => row.delivery !== null);
    if (
      new Set(rows.map((row) => row.presentationId)).size !== rows.length ||
      new Set(rows.map((row) => row.revision)).size !== rows.length ||
      firstDelivered?.delivery?.disposition !== 'created' ||
      rows.filter((row) => row.delivery !== null).some((row) =>
        row.delivery?.messageId !== item.card.messageId) ||
      live.presentation.delivery?.disposition !== 'updated' ||
      live.presentation.lineage.trigger !== 'source_change' ||
      live.presentation.lineage.priorPresentationId === null ||
      live.presentation.lineage.triggerRefreshAt !== null ||
      live.presentation.lineage.nextRefreshAt !== null
    ) throw new FeishuCardCompletionEvidenceVerificationError('completion_delivery_mismatch');

    const card = record(live.liveCard);
    const elements = card === null || !Array.isArray(card.elements) ? null : card.elements;
    if (
      elements === null || elements.some((element) => record(element)?.tag !== 'div')
    ) throw new FeishuCardCompletionEvidenceVerificationError('completion_card_mismatch');
  }
  const test = parsed.data.cases.find((item) => item.lane === 'test')!;
  const production = parsed.data.cases.find((item) => item.lane === 'production')!;
  return {
    schemaVersion: '1',
    evidenceId: parsed.data.evidenceId,
    repository: parsed.data.repository,
    testRunId: test.runId,
    productionRunId: production.runId,
    completedCards: 2,
    settledPresentations: 2,
    liveCards: 2,
    activeActions: 0,
    activeApprovals: 0,
    plaintextLeaks: 0,
  };
}
