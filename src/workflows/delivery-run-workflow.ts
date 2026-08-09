import { WorkflowEntrypoint, type WorkflowStep } from 'cloudflare:workers';
import {
  analysisAttemptId,
  attemptResultEventName,
  type AttemptResultSignalV1,
} from '../domain/workflow-event.js';
import { expectsActiveWorkflow, type RunState } from '../domain/run.js';
import type { Bindings } from '../env.js';
import { RunStore } from '../storage/run-store.js';

export interface DeliveryRunWorkflowParams {
  schemaVersion: '1';
  runId: string;
  taskId: string;
  taskRevision: string;
  taskDigest: string;
}

const ANALYSIS_RESULT_TIMEOUT = '1 day';
const RUN_TERMINAL_TIMEOUT = '365 days';
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function assertParams(params: DeliveryRunWorkflowParams): void {
  if (
    params.schemaVersion !== '1' ||
    params.runId.length === 0 ||
    params.runId.length > 64 ||
    params.taskId.length === 0 ||
    params.taskRevision.length === 0 ||
    !SHA256_DIGEST_PATTERN.test(params.taskDigest)
  ) {
    throw new Error('invalid DeliveryRunWorkflow params');
  }
}

function assertAttemptResult(
  signal: unknown,
  runId: string,
  attemptId: string,
): asserts signal is AttemptResultSignalV1 {
  if (typeof signal !== 'object' || signal === null) {
    throw new Error('invalid analysis attempt result signal');
  }
  const candidate = signal as Partial<AttemptResultSignalV1>;
  if (
    candidate.schemaVersion !== '1' ||
    candidate.type !== 'attempt_completed' ||
    candidate.runId !== runId ||
    candidate.attemptId !== attemptId ||
    typeof candidate.sequence !== 'number' ||
    !Number.isInteger(candidate.sequence) ||
    candidate.sequence < 1 ||
    typeof candidate.eventId !== 'string' ||
    candidate.eventId.length === 0 ||
    typeof candidate.payloadRef !== 'string' ||
    candidate.payloadRef.length === 0 ||
    typeof candidate.digest !== 'string' ||
    !SHA256_DIGEST_PATTERN.test(candidate.digest) ||
    typeof candidate.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.occurredAt))
  ) {
    throw new Error('invalid analysis attempt result signal');
  }
}

/**
 * Watt's proven Workflow shape, adapted to delivery-loop's normalized Run/Plan model:
 * step.do owns every time/DB/external side effect; code between steps is pure control flow.
 */
export class DeliveryRunWorkflow extends WorkflowEntrypoint<
  Bindings,
  DeliveryRunWorkflowParams
> {
  override async run(
    event: Readonly<{ payload: DeliveryRunWorkflowParams }>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const params = event.payload;
    assertParams(params);
    const store = new RunStore(this.env.DB_CONTROL);

    const run = await step.do('register-run', async () => {
      return await store.registerWorkflow(params, new Date().toISOString());
    });

    if (run.state === 'planning' && run.activePlanId === undefined) {
      const dispatch = await step.do('dispatch-analysis-attempt', async () => {
        return await store.ensureAnalysisDispatch(
          params.runId,
          analysisAttemptId(params.runId),
          new Date().toISOString(),
        );
      });

      const result = await step.waitForEvent<AttemptResultSignalV1>('await-analysis-result', {
        type: attemptResultEventName(dispatch.attemptId),
        timeout: ANALYSIS_RESULT_TIMEOUT,
      });
      assertAttemptResult(result.payload, params.runId, dispatch.attemptId);

      await step.do('verify-analysis-result', async () => {
        const verified = await store.verifyAnalysisPlan(result.payload);
        const execution = await store.recordWorkflowStepExecution(
          params.runId,
          'verify-analysis-result',
          new Date().toISOString(),
        );
        return { ...verified, ...execution };
      });

      await step.do('activate-analysis-plan', async () => {
        const activated = await store.activateAnalysisPlan(
          result.payload,
          new Date().toISOString(),
        );
        return this.safeRunOutput(activated);
      });
    } else if (expectsActiveWorkflow(run.state) && run.activePlanId === undefined) {
      throw new Error(`run ${params.runId} has no resumable active Plan`);
    }

    const observed = await step.do('observe-run-control-state', async () => {
      const current = await store.getRun(params.runId);
      if (current === null) throw new Error('Run disappeared before control wait');
      return this.safeRunOutput(current);
    });
    if (expectsActiveWorkflow(observed.state)) {
      await step.waitForEvent('await-run-terminal', {
        type: 'run-terminal',
        timeout: RUN_TERMINAL_TIMEOUT,
      });
    }
    const verificationSteps = await step.do('load-terminal-verification-steps', async () => {
      return await store.terminalVerificationSteps(params.runId);
    });
    for (const verification of verificationSteps) {
      await step.do(verification.stepName, async () => {
        return await store.recordTerminalVerificationStepExecution(
          params.runId,
          verification.planVersion,
          verification.planItemId,
          new Date().toISOString(),
        );
      });
    }
    return await step.do('confirm-run-terminal', async () => {
      const current = await store.getRun(params.runId);
      if (current === null || expectsActiveWorkflow(current.state)) {
        throw new Error('Run terminal event does not match D1 state');
      }
      return this.safeRunOutput(current);
    });
  }

  private safeRunOutput(run: {
    runId: string;
    state: RunState;
    activePlanId?: string;
    activePlanVersion?: number;
    activePlanDigest?: string;
    automatedReview?: {
      iteration: number;
      status: string;
      blockingFindingCount?: number;
      minorFindingCount?: number;
    };
  }): {
    runId: string;
    state: RunState;
    activePlanId: string | null;
    activePlanVersion: number | null;
    activePlanDigest: string | null;
    automatedReview: {
      iteration: number;
      status: string;
      blockingFindingCount: number | null;
      minorFindingCount: number | null;
    } | null;
  } {
    const review = run.automatedReview;
    return {
      runId: run.runId,
      state: run.state,
      activePlanId: run.activePlanId ?? null,
      activePlanVersion: run.activePlanVersion ?? null,
      activePlanDigest: run.activePlanDigest ?? null,
      automatedReview:
        review === undefined
          ? null
          : {
              iteration: review.iteration,
              status: review.status,
              blockingFindingCount: review.blockingFindingCount ?? null,
              minorFindingCount: review.minorFindingCount ?? null,
            },
    };
  }
}
