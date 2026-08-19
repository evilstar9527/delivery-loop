import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  if: string;
  needs?: string;
  environment?: string;
  'runs-on': string;
  'timeout-minutes': number;
  steps: Step[];
}

interface Workflow {
  name: string;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: { preflight: Job; intake: Job };
}

const EXACT_RUN_GUARD =
  "github.repository == 'evilstar9527/delivery-loop' && " +
  "github.ref == 'refs/heads/main' && github.actor == 'evilstar9527' && " +
  'github.run_attempt == 1';

describe('guarded Task intake workflow', () => {
  it('keeps Task JSON out of step environments and gates the unique POST', () => {
    const source = readFileSync(
      new URL('../.github/workflows/guarded-task-intake.yml', import.meta.url),
      'utf8',
    );
    const workflow = parse(source) as Workflow;
    expect(workflow.name).toBe('Guarded task intake');
    expect(workflow.on.workflow_dispatch.inputs).toEqual({
      task_json: {
        description: 'Exact fresh TaskEnvelope v1 JSON',
        required: true,
        type: 'string',
      },
    });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.concurrency).toEqual({
      group: 'phase7-guarded-task-intake',
      'cancel-in-progress': false,
    });

    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe(EXACT_RUN_GUARD);
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBe(10);
      const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with).toEqual({
        ref: '${{ github.sha }}',
        'persist-credentials': false,
        'fetch-depth': 1,
      });
    }
    expect(workflow.jobs.preflight.environment).toBeUndefined();
    expect(workflow.jobs.preflight.needs).toBeUndefined();
    expect(workflow.jobs.preflight.steps.at(-1)).toEqual({
      name: 'Validate Task only from the workflow event file',
      run: 'pnpm validate:task',
    });
    expect(workflow.jobs.intake.needs).toBe('preflight');
    expect(workflow.jobs.intake.environment).toBe('phase1-readiness');
    expect(workflow.jobs.intake.steps.at(-1)).toEqual({
      name: 'Guard and create exactly one fresh Task',
      env: {
        DELIVERY_LOOP_GUARDED_TASK_INTAKE: '1',
        GUARDED_TASK_INTAKE_CONTROL_PLANE_URL:
          'https://delivery-loop-control-plane.eve55265.workers.dev',
        GUARDED_TASK_INTAKE_ALLOWED_TARGETS_JSON:
          '[{"repository":"evilstar9527/delivery-loop","baseBranch":"main","environment":"none","allowTestDeploy":false},{"repository":"lightspeed-intelligence/tipsy-backend","baseBranch":"dev","environment":"test","allowTestDeploy":true}]',
        GUARDED_TASK_INTAKE_TASK_TOKEN: '${{ secrets.TASK_INTAKE_TOKEN }}',
        GUARDED_TASK_INTAKE_GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      },
      run: 'pnpm run ops:guarded-task-intake',
    });

    const serialized = JSON.stringify(workflow);
    for (const forbidden of [
      '${{ inputs.task_json }}',
      'DELIVERY_TASK_JSON',
      'task_json":"${{',
      'pull_request',
      'push',
      'schedule',
      'workflow_call',
      'contents: write',
      'actions: write',
      'id-token',
      'OPENAI_API_KEY',
      'wrangler',
      'deploy',
      'rollback',
      'continue-on-error',
    ]) expect(serialized).not.toContain(forbidden);
  });
});
