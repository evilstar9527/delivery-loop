import { describe, expect, it } from 'vitest';
import { CloudflareWorkflowStatusClient } from '../src/reconciliation/workflow-instance-reconciler.js';
import { CloudflareWorkflowEffectClient } from '../src/outbox/workflow-outbox.js';
import type { DeliveryRunWorkflowParams } from '../src/workflows/delivery-run-workflow.js';

describe('Cloudflare Workflow status adapter', () => {
  it('returns only the official status and drops platform output/error bodies', async () => {
    const binding = {
      async get() {
        return {
          async status() {
            return {
              status: 'errored',
              error: {
                name: 'CANARY_WORKFLOW_ERROR_NAME',
                message: 'CANARY_WORKFLOW_RAW_ERROR',
              },
              output: { token: 'CANARY_WORKFLOW_OUTPUT' },
            };
          },
        };
      },
    } as unknown as Workflow<DeliveryRunWorkflowParams>;

    const fact = await new CloudflareWorkflowStatusClient(binding).getWorkflowStatus(
      'run-workflow-status',
    );
    expect(fact).toEqual({ status: 'errored' });
    expect(JSON.stringify(fact)).not.toContain('CANARY');
  });

  it('normalizes missing or unavailable instances to unknown without leaking errors', async () => {
    const binding = {
      async get() {
        throw new Error('CANARY_WORKFLOW_GET_ERROR');
      },
    } as unknown as Workflow<DeliveryRunWorkflowParams>;

    await expect(
      new CloudflareWorkflowStatusClient(binding).getWorkflowStatus('run-workflow-missing'),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('restarts only terminal instances and treats an already active retry as existing', async () => {
    let status: 'complete' | 'running' = 'complete';
    let restarts = 0;
    const binding = {
      async get() {
        return {
          async status() {
            return { status };
          },
          async restart() {
            restarts += 1;
            status = 'running';
          },
        };
      },
    } as unknown as Workflow<DeliveryRunWorkflowParams>;
    const client = new CloudflareWorkflowEffectClient(binding);

    await expect(client.restartRunForReconciliation('run-restart')).resolves.toBe('restarted');
    await expect(client.restartRunForReconciliation('run-restart')).resolves.toBe('existing');
    expect(restarts).toBe(1);
  });
});
