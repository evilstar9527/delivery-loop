import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  if?: string;
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
  on: {
    workflow_dispatch: {
      inputs: Record<string, {
        description: string;
        required: boolean;
        default: string;
        type: string;
      }>;
    };
  };
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
    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          diagnostic_run_id: {
            description: 'Optional exact Run ID for a read-only open dead-letter diagnostic',
            required: false,
            default: '',
            type: 'string',
          },
          approval_run_id: {
            description: 'Optional exact Run ID for a repo-write comment observation',
            required: false,
            default: '',
            type: 'string',
          },
          approval_comment_id: {
            description: 'Optional exact GitHub commit comment ID for repo-write approval',
            required: false,
            default: '',
            type: 'string',
          },
          replay_dead_letter_id: {
            description: 'Optional exact workflow outbox dead-letter ID to replay',
            required: false,
            default: '',
            type: 'string',
          },
          replay_expected_outbox_attempt_count: {
            description: 'Exact outbox attempt count bound to the dead letter',
            required: false,
            default: '',
            type: 'string',
          },
          replay_reason_code: {
            description: 'Fixed replay reason code',
            required: false,
            default: '',
            type: 'string',
          },
        },
      },
    });
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
      if: "inputs.diagnostic_run_id == '' && inputs.approval_run_id == '' && " +
        "inputs.approval_comment_id == '' && inputs.replay_dead_letter_id == '' && " +
        "inputs.replay_expected_outbox_attempt_count == '' && inputs.replay_reason_code == ''",
      env: {
        DELIVERY_LOOP_GITHUB_BASE_READINESS: '1',
        GITHUB_BASE_READINESS_CONTROL_PLANE_URL:
          'https://delivery-loop-control-plane.eve55265.workers.dev',
        GITHUB_BASE_READINESS_OPERATIONS_TOKEN:
          '${{ secrets.DELIVERY_LOOP_BASE_READINESS_OPERATIONS_TOKEN }}',
        GITHUB_BASE_READINESS_REPOSITORY: 'evilstar9527/delivery-loop',
        GITHUB_BASE_READINESS_BASE_BRANCH: 'main',
      },
      run: 'pnpm run ops:github-base-readiness',
    });

    const diagnosticStep = readiness.steps.find(
      (step) => step.name === 'Query one exact open workflow-create dead letter',
    );
    expect(diagnosticStep?.if).toBe(
      "inputs.diagnostic_run_id != '' && inputs.approval_run_id == '' && " +
      "inputs.approval_comment_id == '' && inputs.replay_dead_letter_id == '' && " +
      "inputs.replay_expected_outbox_attempt_count == '' && inputs.replay_reason_code == ''",
    );
    expect(diagnosticStep?.env).toEqual({
      DELIVERY_DIAGNOSTIC_RUN_ID: '${{ inputs.diagnostic_run_id }}',
      DELIVERY_OPERATIONS_TOKEN:
        '${{ secrets.DELIVERY_LOOP_BASE_READINESS_OPERATIONS_TOKEN }}',
    });
    expect(diagnosticStep?.run).toContain(
      '/v1/dead-letters?status=open&limit=100',
    );
    expect(diagnosticStep?.run).toContain(
      '[[ "$DELIVERY_DIAGNOSTIC_RUN_ID" =~ ^run_[a-f0-9]{56}$ ]]',
    );
    const runIdPattern = diagnosticStep?.run?.match(/=~ (\^run_.+?\$) \]\]/)?.[1];
    expect(runIdPattern).toBe('^run_[a-f0-9]{56}$');
    expect(new RegExp(runIdPattern!).test(
      'run_bc31ceaf855e3aec031fc419eaa4b6095df957650281791706723691',
    )).toBe(true);
    expect(new RegExp(runIdPattern!).test(`run_${'a'.repeat(64)}`)).toBe(false);
    expect(diagnosticStep?.run).toContain('.runId == $run_id');
    expect(diagnosticStep?.run).toContain('.outboxKind == "workflow_create"');
    expect(diagnosticStep?.run).toContain('select($matches | length == 1)');
    expect(diagnosticStep?.run?.match(/\bcurl\b/g)).toHaveLength(1);
    for (const allowed of [
      'deadLetterId: .id',
      'outboxAttemptCount',
      'lastErrorCode: (.lastErrorCode // null)',
      'status',
    ]) expect(diagnosticStep?.run).toContain(allowed);
    for (const forbidden of [
      '--request POST',
      '/replay',
      'sourceMessageId',
      'destination',
      'capturedAt',
      'outboxId',
    ]) expect(diagnosticStep?.run).not.toContain(forbidden);

    const approvalStep = readiness.steps.find(
      (step) => step.name === 'Observe one exact GitHub repo-write approval comment',
    );
    expect(approvalStep?.if).toBe(
      "inputs.diagnostic_run_id == '' && inputs.approval_run_id != '' && " +
      "inputs.approval_comment_id != '' && inputs.replay_dead_letter_id == '' && " +
      "inputs.replay_expected_outbox_attempt_count == '' && inputs.replay_reason_code == ''",
    );
    expect(approvalStep?.env).toEqual({
      DELIVERY_APPROVAL_RUN_ID: '${{ inputs.approval_run_id }}',
      DELIVERY_APPROVAL_COMMENT_ID: '${{ inputs.approval_comment_id }}',
      DELIVERY_OPERATIONS_TOKEN:
        '${{ secrets.DELIVERY_LOOP_BASE_READINESS_OPERATIONS_TOKEN }}',
    });
    expect(approvalStep?.run).toContain(
      '[[ "$DELIVERY_APPROVAL_RUN_ID" =~ ^run_[a-f0-9]{56}$ ]]',
    );
    expect(approvalStep?.run).toContain(
      '[[ "$DELIVERY_APPROVAL_COMMENT_ID" =~ ^[1-9][0-9]{0,18}$ ]]',
    );
    expect(approvalStep?.run).toContain(
      '/github-commit-approvals',
    );
    expect(approvalStep?.run).toContain('--request POST');
    expect(approvalStep?.run).toContain('--max-time 120');
    expect(approvalStep?.run).toContain("'{commentId:$commentId}'");
    expect(approvalStep?.run).toContain(".status == \"accepted\"");
    expect(approvalStep?.run).toMatch(/select\(\s+\.status == "accepted"/);
    expect(approvalStep?.run?.match(/\bcurl\b/g)).toHaveLength(1);
    for (const forbidden of ['commentBody', 'actor', 'effect', 'expiresAt', 'planId']) {
      expect(approvalStep?.run).not.toContain(forbidden);
    }

    const replayStep = readiness.steps.find(
      (step) => step.name === 'Replay one exact workflow outbox dead letter',
    );
    expect(replayStep?.if).toBe(
      "inputs.diagnostic_run_id == '' && inputs.approval_run_id == '' && " +
      "inputs.approval_comment_id == '' && inputs.replay_dead_letter_id != '' && " +
      "inputs.replay_expected_outbox_attempt_count != '' && inputs.replay_reason_code != ''",
    );
    expect(replayStep?.env).toEqual({
      DELIVERY_REPLAY_DEAD_LETTER_ID: '${{ inputs.replay_dead_letter_id }}',
      DELIVERY_REPLAY_EXPECTED_OUTBOX_ATTEMPT_COUNT:
        '${{ inputs.replay_expected_outbox_attempt_count }}',
      DELIVERY_REPLAY_REASON_CODE: '${{ inputs.replay_reason_code }}',
      DELIVERY_OPERATIONS_TOKEN:
        '${{ secrets.DELIVERY_LOOP_BASE_READINESS_OPERATIONS_TOKEN }}',
    });
    expect(replayStep?.run).toContain(
      '[[ "$DELIVERY_REPLAY_DEAD_LETTER_ID" =~ ^outbox-dlq-[a-f0-9]{64}$ ]]',
    );
    const deadLetterIdPattern = replayStep?.run?.match(
      /DEAD_LETTER_ID" =~ (\^outbox-dlq-.+?\$) \]\]/,
    )?.[1];
    expect(deadLetterIdPattern).toBe('^outbox-dlq-[a-f0-9]{64}$');
    expect(new RegExp(deadLetterIdPattern!).test(
      'outbox-dlq-27f2c9a58bf7be9ae6c44dbe8b23b2587aefeba609edbacc5e1b326502709ecf',
    )).toBe(true);
    expect(new RegExp(deadLetterIdPattern!).test(
      `outbox-dlq-${'a'.repeat(56)}`,
    )).toBe(false);
    expect(replayStep?.run).toContain(
      '(.deadLetterId | test("^outbox-dlq-[a-f0-9]{64}$"))',
    );
    expect(replayStep?.run).toContain(
      '[[ "$DELIVERY_REPLAY_EXPECTED_OUTBOX_ATTEMPT_COUNT" =~ ^[1-9][0-9]{0,9}$ ]]',
    );
    expect(replayStep?.run).toContain(
      'operator_retry|upstream_recovered|configuration_fixed',
    );
    expect(replayStep?.run).toContain('/v1/dead-letters/$DELIVERY_REPLAY_DEAD_LETTER_ID/replay');
    expect(replayStep?.run).toContain('--request POST');
    expect(replayStep?.run).toContain('expectedOutboxAttemptCount');
    expect(replayStep?.run).toContain('reasonCode');
    expect(replayStep?.run).toMatch(/select\(\s+\.accepted == true/);
    expect(replayStep?.run?.match(/\bcurl\b/g)).toHaveLength(1);
    for (const forbidden of ['payloadRef', 'taskJson', 'effect', 'destination']) {
      expect(replayStep?.run).not.toContain(forbidden);
    }

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
      'secrets.GITHUB_',
    ]) expect(serialized).not.toContain(forbidden);
  });
});
