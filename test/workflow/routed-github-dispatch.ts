import { ExecutorPluginRegistry } from '../../src/executor/core/executor-registry.js';
import { GitHubActionsExecutorPlugin } from
  '../../src/executor/plugins/github-actions/github-actions-plugin.js';
import { AgentExecutorOutboxProcessor } from '../../src/outbox/agent-executor.js';
import type {
  GitHubDispatchEffects,
  GitHubDispatchOutboxProcessor,
} from '../../src/outbox/github-dispatcher.js';
import type { OutboxDeliveryResult } from '../../src/outbox/fenced-outbox.js';

/** Test bridge that exercises both stages of a routed legacy GitHub intent. */
export async function deliverRoutedGitHubDispatch(
  db: D1Database,
  legacy: GitHubDispatchOutboxProcessor,
  effects: GitHubDispatchEffects,
  legacyOutboxId: string,
  now: Date,
): Promise<OutboxDeliveryResult> {
  const legacyResult = await legacy.deliver(legacyOutboxId);
  if (legacyResult !== 'settled') return legacyResult;
  const routed = await db.prepare(
    `SELECT executions.outbox_id
     FROM outbox AS legacy_outbox
     JOIN attempt_execution_instances AS executions
       ON executions.attempt_id = substr(
         legacy_outbox.payload_ref,
         length('d1://attempts/') + 1
       )
     WHERE legacy_outbox.outbox_id = ?
       AND legacy_outbox.payload_ref LIKE 'd1://attempts/%'
       AND executions.execution_role = 'work'
     ORDER BY executions.lease_generation DESC
     LIMIT 1`,
  ).bind(legacyOutboxId).first<{ outbox_id: string }>();
  if (routed === null) return legacyResult;
  const processor = new AgentExecutorOutboxProcessor(
    db,
    new ExecutorPluginRegistry([new GitHubActionsExecutorPlugin(effects)]),
    {
      now: () => now,
      generateLeaseToken: () => crypto.randomUUID(),
    },
  );
  return await processor.deliver(routed.outbox_id);
}
