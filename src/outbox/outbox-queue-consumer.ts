import type { OutboxDeliveryResult } from './fenced-outbox.js';
import type { WorkflowOutboxMessage } from './workflow-outbox.js';

export interface DestinationOutboxProcessor {
  deliver(outboxId: string): Promise<OutboxDeliveryResult>;
}

export type OutboxRouteResult =
  | OutboxDeliveryResult
  | 'dead_lettered'
  | 'unconfigured'
  | 'unsupported';

interface OutboxDestinationRow {
  destination: string;
  dead_lettered: number;
}

/** Routes only by the durable D1 destination; Queue payloads carry no authority beyond an ID. */
export class OutboxDestinationRouter {
  constructor(
    private readonly db: D1Database,
    private readonly workflowProcessor: DestinationOutboxProcessor,
    private readonly githubProcessor: DestinationOutboxProcessor | null,
    private readonly githubApiProcessor: DestinationOutboxProcessor | null = null,
    private readonly githubDeploymentProcessor: DestinationOutboxProcessor | null = null,
    private readonly githubAcceptanceProcessor: DestinationOutboxProcessor | null = null,
    private readonly githubProductionDeploymentProcessor: DestinationOutboxProcessor | null = null,
    private readonly githubTestRollbackProcessor: DestinationOutboxProcessor | null = null,
    private readonly feishuCardProcessor: DestinationOutboxProcessor | null = null,
    private readonly yunxiaoPipelineProcessor: DestinationOutboxProcessor | null = null,
  ) {}

  async deliver(outboxId: string): Promise<OutboxRouteResult> {
    if (outboxId.length < 1 || outboxId.length > 256) return 'missing';
    const row = await this.db
      .prepare(
        `SELECT outbox.destination,
                EXISTS (
                  SELECT 1 FROM outbox_dead_letters
                  WHERE outbox_dead_letters.outbox_id = outbox.outbox_id
                    AND outbox_dead_letters.status = 'open'
                ) AS dead_lettered
         FROM outbox WHERE outbox.outbox_id = ?`,
      )
      .bind(outboxId)
      .first<OutboxDestinationRow>();
    if (row === null) return 'missing';
    if (row.dead_lettered === 1) return 'dead_lettered';
    switch (row.destination) {
      case 'cloudflare_workflows':
        return await this.workflowProcessor.deliver(outboxId);
      case 'github_actions':
        return this.githubProcessor === null
          ? 'unconfigured'
          : await this.githubProcessor.deliver(outboxId);
      case 'github_api':
        return this.githubApiProcessor === null
          ? 'unconfigured'
          : await this.githubApiProcessor.deliver(outboxId);
      case 'github_deployments':
        return this.githubDeploymentProcessor === null
          ? 'unconfigured'
          : await this.githubDeploymentProcessor.deliver(outboxId);
      case 'yunxiao_pipelines':
        return this.yunxiaoPipelineProcessor === null
          ? 'unconfigured'
          : await this.yunxiaoPipelineProcessor.deliver(outboxId);
      case 'github_acceptance':
        return this.githubAcceptanceProcessor === null
          ? 'unconfigured'
          : await this.githubAcceptanceProcessor.deliver(outboxId);
      case 'github_production_deployments':
        return this.githubProductionDeploymentProcessor === null
          ? 'unconfigured'
          : await this.githubProductionDeploymentProcessor.deliver(outboxId);
      case 'github_test_rollback':
        return this.githubTestRollbackProcessor === null
          ? 'unconfigured'
          : await this.githubTestRollbackProcessor.deliver(outboxId);
      case 'feishu_cards':
        return this.feishuCardProcessor === null
          ? 'unconfigured'
          : await this.feishuCardProcessor.deliver(outboxId);
      default:
        return 'unsupported';
    }
  }
}

export interface OutboxMessageRouter {
  deliver(outboxId: string): Promise<OutboxRouteResult>;
}

export async function consumeOutboxBatch(
  batch: MessageBatch<WorkflowOutboxMessage>,
  router: OutboxMessageRouter,
): Promise<void> {
  for (const message of batch.messages) {
    if (
      typeof message.body !== 'object' ||
      message.body === null ||
      typeof message.body.outboxId !== 'string'
    ) {
      message.ack();
      continue;
    }
    let result: OutboxRouteResult;
    try {
      result = await router.deliver(message.body.outboxId);
    } catch {
      message.retry();
      continue;
    }
    if (
      result === 'settled' || result === 'missing' || result === 'dead_lettered'
    ) message.ack();
    else message.retry();
  }
}
