import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  needs?: string;
  environment?: string;
  'runs-on': string;
  'timeout-minutes': number;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: { preflight: WorkflowJob; readiness: WorkflowJob };
}

const TRUSTED_ACTIONS = [
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
] as const;

const EXACT_RUN_GUARD =
  "github.repository == 'evilstar9527/delivery-loop' && " +
  "github.ref == 'refs/heads/main' && github.actor == 'evilstar9527' && " +
  'github.run_attempt == 1';

function actionUses(job: WorkflowJob): string[] {
  return job.steps
    .filter((step) => step.uses !== undefined)
    .map((step) => step.uses as string);
}

function checkout(job: WorkflowJob): WorkflowStep | undefined {
  return job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
}

describe('GitHub-hosted base readiness workflow', () => {
  it('runs a zero-secret preflight before an Environment-gated one-shot probe', () => {
    const source = readFileSync(
      new URL('../.github/workflows/github-base-readiness.yml', import.meta.url),
      'utf8',
    );
    const workflow = parse(source) as Workflow;

    expect(workflow.name).toBe('GitHub base readiness');
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({
      group: 'phase1-github-base-readiness',
      'cancel-in-progress': false,
    });
    expect(Object.keys(workflow.jobs).sort()).toEqual(['preflight', 'readiness']);

    const { preflight, readiness } = workflow.jobs;
    for (const job of [preflight, readiness]) {
      expect(job.if).toBe(EXACT_RUN_GUARD);
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBe(10);
      expect(job.permissions).toBeUndefined();
      expect(actionUses(job)).toEqual(TRUSTED_ACTIONS);
      expect(checkout(job)?.with).toEqual({
        ref: '${{ github.sha }}',
        'persist-credentials': false,
        'fetch-depth': 1,
      });
      expect(job.steps.find((step) => step.name === 'Install locked dependencies')?.run)
        .toBe('pnpm install --frozen-lockfile --ignore-scripts');
    }

    expect(preflight.needs).toBeUndefined();
    expect(preflight.environment).toBeUndefined();
    const preflightStep = preflight.steps.find(
      (step) => step.name === 'Probe control-plane network path',
    );
    expect(preflightStep).toEqual({
      name: 'Probe control-plane network path',
      env: {
        DELIVERY_LOOP_PROVIDER_NETWORK_PREFLIGHT: '1',
        OPENAI_BASE_URL: 'https://delivery-loop-control-plane.eve55265.workers.dev',
      },
      run: 'pnpm run e2e:provider-network',
    });

    expect(readiness.needs).toBe('preflight');
    expect(readiness.environment).toBe('phase1-readiness');
    const readinessStep = readiness.steps.find(
      (step) => step.name === 'Run exactly one GitHub base readiness GET',
    );
    expect(readinessStep).toEqual({
      name: 'Run exactly one GitHub base readiness GET',
      env: {
        DELIVERY_LOOP_GITHUB_BASE_READINESS: '1',
        GITHUB_BASE_READINESS_CONTROL_PLANE_URL:
          'https://delivery-loop-control-plane.eve55265.workers.dev',
        GITHUB_BASE_READINESS_OPERATIONS_TOKEN:
          '${{ secrets.GITHUB_BASE_READINESS_OPERATIONS_TOKEN }}',
        GITHUB_BASE_READINESS_REPOSITORY: 'evilstar9527/delivery-loop',
        GITHUB_BASE_READINESS_BASE_BRANCH: 'main',
      },
      run: 'pnpm run ops:github-base-readiness',
    });

    const serializedPreflight = JSON.stringify(preflight);
    expect(serializedPreflight).not.toContain('secrets.');
    const serialized = JSON.stringify(workflow);
    for (const forbidden of [
      'pull_request',
      'push',
      'schedule',
      'workflow_call',
      'id-token',
      'actions: write',
      'contents: write',
      'TASK_INTAKE_TOKEN',
      'OPENAI_API_KEY',
      'wrangler',
      'deploy',
      'rollback',
      'continue-on-error',
      'environment":"production',
    ]) expect(serialized).not.toContain(forbidden);
  });
});
