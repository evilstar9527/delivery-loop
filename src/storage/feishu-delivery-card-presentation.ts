import {
  FeishuDeliveryCardPresentationSchema,
  type DeploymentCardStatus,
  type FeishuDeliveryCardPresentation,
  type MergeCardStatus,
  type PullRequestCardStatus,
} from '../domain/feishu-delivery-card.js';

export interface StoredFeishuDeliveryCardPresentationRow {
  presentation_id: string;
  card_id: string;
  run_id: string;
  run_version: number;
  schema_version: '1' | '2';
  presentation_json: string | null;
  refresh_request_id?: string | null;
  pr_status: PullRequestCardStatus;
  pr_url: string | null;
  merge_status: MergeCardStatus;
  merge_url: string | null;
  test_deploy_status: DeploymentCardStatus;
  test_deploy_url: string | null;
  production_deploy_status: DeploymentCardStatus;
  production_deploy_url: string | null;
}

/** Rehydrates old v1 rows and strict v2 JSON through one shared boundary. */
export function feishuDeliveryCardPresentationFromRow(
  row: StoredFeishuDeliveryCardPresentationRow,
): FeishuDeliveryCardPresentation {
  if (row.schema_version === '1') {
    if (row.presentation_json !== null || (row.refresh_request_id ?? null) !== null) {
      throw new Error('Feishu card presentation is invalid');
    }
    return FeishuDeliveryCardPresentationSchema.parse({
      schemaVersion: '1',
      cardId: row.card_id,
      presentationId: row.presentation_id,
      runId: row.run_id,
      runVersion: row.run_version,
      pr: { status: row.pr_status, url: row.pr_url },
      merge: { status: row.merge_status, url: row.merge_url },
      testDeploy: { status: row.test_deploy_status, url: row.test_deploy_url },
      productionDeploy: {
        status: row.production_deploy_status,
        url: row.production_deploy_url,
      },
    });
  }
  if (row.presentation_json === null || row.presentation_json.length > 20_000) {
    throw new Error('Feishu card presentation is invalid');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.presentation_json) as unknown;
  } catch {
    throw new Error('Feishu card presentation is invalid');
  }
  const presentation = FeishuDeliveryCardPresentationSchema.parse(raw);
  if (
    presentation.schemaVersion !== '2' || presentation.cardId !== row.card_id ||
    presentation.presentationId !== row.presentation_id || presentation.runId !== row.run_id ||
    presentation.runVersion !== row.run_version ||
    (presentation.refreshRequestId ?? null) !== (row.refresh_request_id ?? null) ||
    presentation.pr.status !== row.pr_status || presentation.pr.url !== row.pr_url ||
    presentation.merge.status !== row.merge_status || presentation.merge.url !== row.merge_url ||
    presentation.testDeploy.status !== row.test_deploy_status ||
    presentation.testDeploy.url !== row.test_deploy_url ||
    presentation.productionDeploy.status !== row.production_deploy_status ||
    presentation.productionDeploy.url !== row.production_deploy_url
  ) throw new Error('Feishu card presentation is invalid');
  return presentation;
}
