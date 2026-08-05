import { describe, expect, it } from 'vitest';
import {
  ExecutionPlanValidationError,
  computeExecutionPlanDigest,
  validateExecutionPlanProposal,
  type ExecutionPlanBodyV1,
  type ExecutionPlanV1,
  type ExecutionPlanValidationContext,
  type ExecutionPlanValidationIssueCode,
} from '../src/domain/plan.js';
import { deriveAnalysisPlanPolicy } from '../src/domain/analysis-plan-policy.js';

const BASE_SHA = 'a'.repeat(40);

const CONTEXT: ExecutionPlanValidationContext = {
  runId: 'run-plan-contract',
  taskRevision: 'revision-7',
  baseSha: BASE_SHA,
  expectedVersion: 1,
  acceptanceCriteriaCount: 2,
  allowedCommandRefs: ['test:unit', 'verify:all'],
  verificationCommandRefs: ['verify:all'],
  allowedEffects: ['repo_read', 'repo_write'],
  requiresRepositoryChange: false,
};

function planBody(): ExecutionPlanBodyV1 {
  return {
    schemaVersion: '1',
    id: 'plan-contract-v1',
    runId: CONTEXT.runId,
    version: 1,
    taskRevision: CONTEXT.taskRevision,
    baseSha: BASE_SHA,
    createdByAttemptId: 'analysis-run-plan-contract-1',
    objective: 'Diagnose the report, make the smallest safe change, and verify it.',
    assumptions: ['The repository delivery policy is authoritative.'],
    evidenceRefs: ['d1://evidence/diagnostic-1'],
    items: [
      {
        id: 'investigate',
        kind: 'investigation',
        title: 'Locate the cause',
        objective: 'Confirm the failing behavior and its source.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['A source-backed root cause is recorded.'],
        verification: {
          commandRefs: ['test:unit'],
          evidenceKinds: ['diagnostic'],
        },
        effects: ['repo_read'],
        dependsOn: [],
        required: true,
      },
      {
        id: 'change',
        kind: 'change',
        title: 'Implement the fix',
        objective: 'Make the minimal policy-compliant code change.',
        acceptanceCriteriaIndexes: [1],
        doneWhen: ['The targeted behavior matches the acceptance criterion.'],
        verification: {
          commandRefs: ['test:unit'],
          evidenceKinds: ['test'],
        },
        effects: ['repo_write'],
        dependsOn: ['investigate'],
        required: true,
      },
      {
        id: 'verify',
        kind: 'verification',
        title: 'Run required verification',
        objective: 'Prove the change against the trusted repository contract.',
        acceptanceCriteriaIndexes: [0, 1],
        doneWhen: ['The trusted full verification command exits zero.'],
        verification: {
          commandRefs: ['verify:all'],
          evidenceKinds: ['test'],
        },
        effects: ['repo_read'],
        dependsOn: ['change'],
        required: true,
      },
    ],
  };
}

async function proposal(
  mutate?: (body: ExecutionPlanBodyV1) => void,
): Promise<ExecutionPlanV1> {
  const body = planBody();
  mutate?.(body);
  return {
    ...body,
    digest: await computeExecutionPlanDigest(body),
    status: 'proposed',
  };
}

async function expectIssue(
  input: unknown,
  code: ExecutionPlanValidationIssueCode,
  context: ExecutionPlanValidationContext = CONTEXT,
): Promise<void> {
  try {
    await validateExecutionPlanProposal(input, context);
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionPlanValidationError);
    if (!(error instanceof ExecutionPlanValidationError)) throw error;
    expect(error.issues.map((issue) => issue.code)).toContain(code);
    return;
  }
  throw new Error(`expected ExecutionPlan validation issue: ${code}`);
}

describe('ExecutionPlan v1 validation', () => {
  it('derives writable requirement, read-only requirement, and writable bug policy without prose heuristics', () => {
    expect(deriveAnalysisPlanPolicy('requirement', true)).toEqual({
      allowedEffects: ['repo_read', 'logs_read', 'database_diagnostic', 'repo_write'],
      allowedCommandRefs: [
        'policy:inspect', 'policy:diagnose', 'test:unit', 'verify:all',
      ],
      verificationCommandRefs: ['verify:all'],
      requiresRepositoryChange: true,
    });
    expect(deriveAnalysisPlanPolicy('requirement', false)).toMatchObject({
      allowedEffects: ['repo_read', 'logs_read', 'database_diagnostic'],
      requiresRepositoryChange: false,
    });
    expect(deriveAnalysisPlanPolicy('bug', true)).toMatchObject({
      allowedEffects: ['repo_read', 'logs_read', 'database_diagnostic', 'repo_write'],
      requiresRepositoryChange: false,
    });
  });
  it('accepts a complete proposal and returns its canonical digest unchanged', async () => {
    const input = await proposal();
    const result = await validateExecutionPlanProposal(input, CONTEXT);

    expect(result).toEqual(input);
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('accepts one required self-verifying change item that matches the execution Runner contract', async () => {
    const input = await proposal((body) => {
      body.items = [{
        id: 'change',
        kind: 'change',
        title: 'Implement and verify the fix',
        objective: 'Make the smallest safe change and prove it with the trusted commands.',
        acceptanceCriteriaIndexes: [0, 1],
        doneWhen: [
          'The bot commit contains the required change.',
          'Targeted and required verification both pass on the committed head.',
        ],
        verification: {
          commandRefs: ['test:unit', 'verify:all'],
          evidenceKinds: ['commit', 'test'],
        },
        effects: ['repo_write'],
        dependsOn: [],
        required: true,
      }];
    });

    await expect(validateExecutionPlanProposal(input, {
      ...CONTEXT,
      requiresRepositoryChange: true,
    })).resolves.toEqual(input);
  });

  it('rejects the revision-15 investigation-only shape when trusted context requires a repository change', async () => {
    const input = await proposal((body) => {
      body.items = [{
        id: 'inspect-source',
        kind: 'investigation',
        title: 'Inspect the requested documentation',
        objective: 'Locate the requested documentation change without implementing it.',
        acceptanceCriteriaIndexes: [0, 1],
        doneWhen: ['The current document is described in a diagnostic note.'],
        verification: {
          commandRefs: [],
          evidenceKinds: ['diagnostic', 'plan'],
        },
        effects: ['repo_read'],
        dependsOn: [],
        required: true,
      }];
    });

    await expectIssue(input, 'repository_change_required', {
      ...CONTEXT,
      requiresRepositoryChange: true,
    });
  });

  it('keeps investigation-only plans valid when trusted context does not require a repository change', async () => {
    const input = await proposal((body) => {
      body.items = [{
        id: 'inspect-source',
        kind: 'investigation',
        title: 'Inspect the current behavior',
        objective: 'Return a source-backed diagnosis without changing the repository.',
        acceptanceCriteriaIndexes: [0, 1],
        doneWhen: ['The responsible source path is recorded.'],
        verification: {
          commandRefs: [],
          evidenceKinds: ['diagnostic'],
        },
        effects: ['repo_read'],
        dependsOn: [],
        required: true,
      }];
    });

    await expect(validateExecutionPlanProposal(input, CONTEXT)).resolves.toEqual(input);
  });

  it('rejects a repo-write item that cannot verify its own committed head', async () => {
    await expectIssue(
      await proposal((body) => {
        body.items = [{
          id: 'change',
          kind: 'change',
          title: 'Implement an unverified fix',
          objective: 'Change code without a complete trusted verification contract.',
          acceptanceCriteriaIndexes: [0, 1],
          doneWhen: ['The change is written.'],
          verification: {
            commandRefs: ['test:unit'],
            evidenceKinds: ['commit'],
          },
          effects: ['repo_write'],
          dependsOn: [],
          required: true,
        }];
      }),
      'verification_required_after_change',
    );
  });

  it('rejects malformed and duplicate item IDs', async () => {
    await expectIssue(
      await proposal((body) => {
        body.items[0]!.id = 'contains spaces';
      }),
      'item_id_invalid',
    );
    await expectIssue(
      await proposal((body) => {
        body.items[1]!.id = body.items[0]!.id;
      }),
      'duplicate_item_id',
    );
  });

  it('rejects missing dependencies and dependency cycles', async () => {
    await expectIssue(
      await proposal((body) => {
        body.items[1]!.dependsOn = ['missing'];
      }),
      'dependency_missing',
    );
    await expectIssue(
      await proposal((body) => {
        body.items[0]!.dependsOn = ['verify'];
      }),
      'dependency_cycle',
    );
  });

  it('requires at least one doneWhen and one Evidence kind per item', async () => {
    await expectIssue(
      await proposal((body) => {
        body.items[0]!.doneWhen = [];
      }),
      'done_when_required',
    );
    await expectIssue(
      await proposal((body) => {
        body.items[0]!.verification.evidenceKinds = [];
      }),
      'evidence_required',
    );
  });

  it('only accepts command references from the trusted delivery policy', async () => {
    await expectIssue(
      await proposal((body) => {
        body.items[0]!.verification.commandRefs = ['rm -rf /'];
      }),
      'command_ref_not_allowed',
    );
  });

  it('rejects effects above the policy ceiling', async () => {
    await expectIssue(
      await proposal((body) => {
        body.items[1]!.effects = ['production_deploy'];
      }),
      'effect_not_allowed',
    );
  });

  it('binds version, run, task revision, and base SHA to trusted context', async () => {
    await expectIssue(await proposal(), 'version_mismatch', {
      ...CONTEXT,
      expectedVersion: 2,
    });
    await expectIssue(await proposal(), 'run_mismatch', {
      ...CONTEXT,
      runId: 'another-run',
    });
    await expectIssue(await proposal(), 'task_revision_mismatch', {
      ...CONTEXT,
      taskRevision: 'revision-8',
    });
    await expectIssue(await proposal(), 'base_sha_mismatch', {
      ...CONTEXT,
      baseSha: 'b'.repeat(40),
    });
  });

  it('rejects a stale digest after immutable plan content changes', async () => {
    const input = await proposal();
    input.items[0]!.effects = ['repo_write'];

    await expectIssue(input, 'digest_mismatch');
  });

  it('rejects acceptance-criterion indexes outside the task snapshot', async () => {
    await expectIssue(
      await proposal((body) => {
        body.items[0]!.acceptanceCriteriaIndexes = [2];
      }),
      'acceptance_criterion_out_of_range',
    );
  });

  it('does not let an Agent self-promote a plan beyond proposed', async () => {
    const input = await proposal();
    input.status = 'approved';

    await expectIssue(input, 'status_not_proposed');
  });

  it('does not let optional items or detached verification skip required acceptance and tests', async () => {
    await expectIssue(
      await proposal((body) => {
        for (const item of body.items) item.required = false;
      }),
      'acceptance_criterion_uncovered',
    );
    await expectIssue(
      await proposal((body) => {
        body.items[2]!.required = false;
      }),
      'verification_required_after_change',
    );
    await expectIssue(
      await proposal((body) => {
        body.items[2]!.verification.commandRefs = [];
        body.items[2]!.verification.evidenceKinds = ['diagnostic'];
      }),
      'verification_required_after_change',
    );
    await expectIssue(
      await proposal((body) => {
        body.items[2]!.verification.commandRefs = ['test:unit'];
      }),
      'verification_required_after_change',
    );
    await expectIssue(
      await proposal((body) => {
        body.items[2]!.dependsOn = [];
      }),
      'verification_required_after_change',
    );
  });
});
