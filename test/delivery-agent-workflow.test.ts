import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface DeliveryWorkflow {
  'run-name': string;
  on: {
    workflow_dispatch: {
      inputs: Record<string, { required?: boolean; type?: string }>;
    };
  };
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: {
    attempt: {
      'timeout-minutes': number;
      steps: WorkflowStep[];
    };
  };
}

describe('fixed delivery Agent workflow', () => {
  it('locks dispatch identity, read-only permissions, immutable Actions, and zero-write checks', async () => {
    const path = resolve('.github/workflows/delivery-agent.yml');
    const source = await readFile(path, 'utf8');
    const workflow = parse(source) as DeliveryWorkflow;
    const inputs = workflow.on.workflow_dispatch.inputs;

    expect(workflow['run-name']).toBe(
      "delivery-loop/${{ inputs.attempt_id }}${{ inputs.dispatch_generation && format('/redispatch-{0}', inputs.dispatch_generation) || '' }}",
    );
    expect(Object.keys(inputs)).toEqual([
      'schema_version',
      'run_id',
      'attempt_id',
      'dispatch_generation',
      'task_digest',
      'base_sha',
      'checkout_sha',
      'control_plane_url',
      'mode',
      'model_profile_id',
      'plan_version',
      'plan_item_id',
    ]);
    expect(
      Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value.required])),
    ).toMatchObject({
      schema_version: true,
      run_id: true,
      attempt_id: true,
      dispatch_generation: false,
      task_digest: true,
      base_sha: true,
      checkout_sha: true,
      control_plane_url: true,
      mode: true,
      model_profile_id: true,
      plan_version: false,
      plan_item_id: false,
    });
    expect(Object.keys(inputs).join(' ')).not.toMatch(/secret|token|description|feedback|prd|body/i);
    expect(workflow.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow.concurrency).toEqual({
      group: 'delivery-${{ github.repository }}-${{ inputs.run_id }}',
      'cancel-in-progress': false,
    });
    expect(workflow.jobs.attempt['timeout-minutes']).toBe(60);

    const steps = workflow.jobs.attempt.steps;
    const checkout = steps.find((step) => step.name === 'Checkout trusted execution snapshot');
    expect(checkout).toMatchObject({
      uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      with: {
        ref: '${{ inputs.checkout_sha }}',
        'persist-credentials': false,
        'fetch-depth': 0,
      },
    });
    expect(steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.uses).toBe(
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    );
    expect(steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'))?.uses).toBe(
      'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
    );
    expect(steps.filter((step) => step.uses !== undefined).every((step) => /@[a-f0-9]{40}$/.test(step.uses!))).toBe(true);

    const install = steps.find((step) => step.name === 'Install locked dependencies');
    expect(install?.run).toBe('pnpm install --frozen-lockfile');
    const analysis = steps.find((step) => step.name === 'Run read-only analysis attempt');
    expect(analysis?.run).toBe('pnpm exec tsx scripts/run-analysis-attempt.ts');
    expect(analysis?.if).toBe("inputs.mode == 'analysis'");
    expect(analysis?.env).toMatchObject({
      DELIVERY_RUN_ID: '${{ inputs.run_id }}',
      DELIVERY_ATTEMPT_ID: '${{ inputs.attempt_id }}',
      DELIVERY_TASK_DIGEST: '${{ inputs.task_digest }}',
      DELIVERY_BASE_SHA: '${{ inputs.base_sha }}',
      DELIVERY_CHECKOUT_SHA: '${{ inputs.checkout_sha }}',
      DELIVERY_CONTROL_PLANE_URL: '${{ inputs.control_plane_url }}',
      DELIVERY_MODEL_PROFILE_ID: '${{ inputs.model_profile_id }}',
      CODEX_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}',
    });

    const execution = steps.find((step) => step.name === 'Run approved execution attempt');
    expect(execution?.if).toBe(
      "inputs.mode == 'implement' || inputs.mode == 'review_fix'",
    );
    expect(execution?.run).toBe('pnpm exec tsx scripts/run-execution-attempt.ts');
    expect(execution?.env).toMatchObject({
      DELIVERY_RUN_ID: '${{ inputs.run_id }}',
      DELIVERY_ATTEMPT_ID: '${{ inputs.attempt_id }}',
      DELIVERY_TASK_DIGEST: '${{ inputs.task_digest }}',
      DELIVERY_BASE_SHA: '${{ inputs.base_sha }}',
      DELIVERY_CHECKOUT_SHA: '${{ inputs.checkout_sha }}',
      DELIVERY_ATTEMPT_MODE: '${{ inputs.mode }}',
      DELIVERY_PLAN_VERSION: '${{ inputs.plan_version }}',
      DELIVERY_PLAN_ITEM_ID: '${{ inputs.plan_item_id }}',
      DELIVERY_CONTROL_PLANE_URL: '${{ inputs.control_plane_url }}',
      DELIVERY_MODEL_PROFILE_ID: '${{ inputs.model_profile_id }}',
      CODEX_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}',
    });

    const zeroWrite = steps.find((step) => step.name === 'Verify read-only workspace');
    expect(zeroWrite?.if).toBe("always() && inputs.mode == 'analysis'");
    expect(zeroWrite?.run).toContain('git rev-parse HEAD');
    expect(zeroWrite?.run).toContain('git symbolic-ref --quiet --short HEAD');
    expect(zeroWrite?.run).toContain('git status --porcelain=v1 --untracked-files=all');
    expect(zeroWrite?.env).toEqual({
      DELIVERY_CHECKOUT_SHA: '${{ inputs.checkout_sha }}',
    });
    expect(source).not.toContain('persist-credentials: true');
  });
});
