import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import type {
  ExecutionAttemptFailure,
  ExecutionFailureReporter,
  ExecutionHeadReporter,
  PlanRevisionReporter,
  PlanRevisionRequestResult,
} from './execution-attempt-runner.js';
import type { VerificationReporterAuthorization } from './verification-evidence-reporter.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_RESPONSE_BYTES = 64 * 1_024;

const HeadResponseSchema = z.object({
  updateId: z.string().regex(IDENTIFIER_PATTERN),
  evidenceId: z.string().regex(IDENTIFIER_PATTERN),
  created: z.boolean(),
  version: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  parentSha: z.string().regex(/^[a-f0-9]{40}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().min(1).max(240),
}).strict();

const FailureResponseSchema = z.object({ accepted: z.literal(true) });
const PlanRevisionResponseSchema = z.object({
  accepted: z.literal(true),
  revisionId: z.string().regex(IDENTIFIER_PATTERN),
  analysisAttemptId: z.string().regex(IDENTIFIER_PATTERN),
  dispatchOutboxId: z.string().regex(IDENTIFIER_PATTERN),
  created: z.boolean(),
  runVersion: z.number().int().positive(),
}).strict();
const BaseRebaseConflictResponseSchema = z.object({
  accepted: z.literal(true),
  rebaseId: z.string().regex(IDENTIFIER_PATTERN),
  status: z.literal('blocked'),
  reason: z.literal('content_conflict'),
  runVersion: z.number().int().positive(),
  cancelOutboxId: z.string().regex(IDENTIFIER_PATTERN),
  created: z.boolean(),
}).strict();
const BaseRebaseCompletionResponseSchema = z.object({
  accepted: z.literal(true),
  rebaseId: z.string().regex(IDENTIFIER_PATTERN),
  status: z.literal('passed'),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  suiteId: z.string().regex(IDENTIFIER_PATTERN),
  created: z.boolean(),
}).strict();

export interface MutableExecutionReporterAuthorization {
  authorization(): VerificationReporterAuthorization;
  updateVersion(previousVersion: number, nextVersion: number): void;
  withAuthorization<T>(
    operation: (authorization: VerificationReporterAuthorization) => Promise<T>,
  ): Promise<T>;
}

export interface ExecutionReporterContext {
  controlPlaneUrl: string;
  attemptId: string;
  fencing: MutableExecutionReporterAuthorization;
}

export type ExecutionReporterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ExecutionControlPlaneReporterError extends Error {
  constructor() {
    super('execution control-plane report failed');
    this.name = 'ExecutionControlPlaneReporterError';
  }
}

function endpoint(context: ExecutionReporterContext, suffix: string): string {
  let base: URL;
  try {
    base = new URL(context.controlPlaneUrl);
  } catch {
    throw new ExecutionControlPlaneReporterError();
  }
  if (
    base.protocol !== 'https:' ||
    base.username !== '' ||
    base.password !== '' ||
    base.search !== '' ||
    base.hash !== '' ||
    !IDENTIFIER_PATTERN.test(context.attemptId) ||
    typeof context.fencing?.authorization !== 'function' ||
    typeof context.fencing?.updateVersion !== 'function' ||
    typeof context.fencing?.withAuthorization !== 'function'
  ) {
    throw new ExecutionControlPlaneReporterError();
  }
  return new URL(
    `/v1/attempts/${encodeURIComponent(context.attemptId)}${suffix}`,
    base,
  ).toString();
}

function validAuthorization(value: VerificationReporterAuthorization): boolean {
  return value.attemptToken.length > 0 &&
    value.attemptToken.length <= 2_000 &&
    !/[\0\r\n]/.test(value.attemptToken) &&
    Number.isSafeInteger(value.expectedVersion) &&
    value.expectedVersion >= 0 &&
    Number.isSafeInteger(value.leaseGeneration) &&
    value.leaseGeneration > 0;
}

async function json(response: Response, statuses: readonly number[]): Promise<unknown> {
  if (
    !statuses.includes(response.status) ||
    !response.headers.get('cache-control')?.toLowerCase().includes('no-store')
  ) {
    await response.body?.cancel();
    throw new ExecutionControlPlaneReporterError();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ExecutionControlPlaneReporterError();
  }
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new ExecutionControlPlaneReporterError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExecutionControlPlaneReporterError();
  }
}

/** Records the one bot commit transition and advances the in-memory CAS version. */
export class ControlPlaneExecutionHeadReporter implements ExecutionHeadReporter {
  private readonly endpoint: string;

  constructor(
    private readonly context: ExecutionReporterContext,
    private readonly fetcher: ExecutionReporterFetch = fetch,
  ) {
    this.endpoint = endpoint(context, '/head');
  }

  async record(input: { parentSha: string; headSha: string; branch: string }): Promise<void> {
    await this.context.fencing.withAuthorization(async (first) => {
      if (!validAuthorization(first)) throw new ExecutionControlPlaneReporterError();
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${first.attemptToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedVersion: first.expectedVersion,
            leaseGeneration: first.leaseGeneration,
            ...input,
          }),
          redirect: 'error',
        });
      } catch {
        throw new ExecutionControlPlaneReporterError();
      }
      const accepted = HeadResponseSchema.safeParse(await json(response, [200, 201]));
      if (
        !accepted.success ||
        accepted.data.leaseGeneration !== first.leaseGeneration ||
        accepted.data.version !== first.expectedVersion + 1 ||
        accepted.data.parentSha !== input.parentSha ||
        accepted.data.headSha !== input.headSha ||
        accepted.data.branch !== input.branch
      ) {
        throw new ExecutionControlPlaneReporterError();
      }
      this.context.fencing.updateVersion(first.expectedVersion, accepted.data.version);
    });
  }
}

/** Converts a head-bound review decision into a server-derived immutable source fact. */
export class ControlPlanePlanRevisionReporter implements PlanRevisionReporter {
  private readonly endpoint: string;

  constructor(
    private readonly context: ExecutionReporterContext,
    private readonly fetcher: ExecutionReporterFetch = fetch,
  ) {
    this.endpoint = endpoint(context, '/plan-revision');
  }

  async request(): Promise<PlanRevisionRequestResult> {
    return await this.context.fencing.withAuthorization(async (authorization) => {
      if (!validAuthorization(authorization)) throw new ExecutionControlPlaneReporterError();
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${authorization.attemptToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedVersion: authorization.expectedVersion,
            leaseGeneration: authorization.leaseGeneration,
          }),
          redirect: 'error',
        });
      } catch {
        throw new ExecutionControlPlaneReporterError();
      }
      const accepted = PlanRevisionResponseSchema.safeParse(await json(response, [200, 202]));
      if (!accepted.success) throw new ExecutionControlPlaneReporterError();
      return {
        revisionId: accepted.data.revisionId,
        analysisAttemptId: accepted.data.analysisAttemptId,
        dispatchOutboxId: accepted.data.dispatchOutboxId,
        runVersion: accepted.data.runVersion,
      };
    });
  }
}

/** Reports only the trusted rebase terminal projection; no Git output or conflict paths cross it. */
export class ControlPlaneBaseRebaseReporter {
  private readonly conflictEndpoint: string;
  private readonly completionEndpoint: string;

  constructor(
    private readonly context: ExecutionReporterContext,
    private readonly fetcher: ExecutionReporterFetch = fetch,
  ) {
    this.conflictEndpoint = endpoint(context, '/base-rebase/conflict');
    this.completionEndpoint = endpoint(context, '/base-rebase/complete');
  }

  async conflict(): Promise<void> {
    await this.context.fencing.withAuthorization(async (authorization) => {
      if (!validAuthorization(authorization)) throw new ExecutionControlPlaneReporterError();
      let response: Response;
      try {
        response = await this.fetcher(this.conflictEndpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${authorization.attemptToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedVersion: authorization.expectedVersion,
            leaseGeneration: authorization.leaseGeneration,
            reason: 'content_conflict',
          }),
          redirect: 'error',
        });
      } catch {
        throw new ExecutionControlPlaneReporterError();
      }
      if (!BaseRebaseConflictResponseSchema.safeParse(await json(response, [200, 202])).success) {
        throw new ExecutionControlPlaneReporterError();
      }
    });
  }

  async complete(input: { headSha: string; suiteId: string }): Promise<void> {
    await this.context.fencing.withAuthorization(async (authorization) => {
      if (!validAuthorization(authorization)) throw new ExecutionControlPlaneReporterError();
      let response: Response;
      try {
        response = await this.fetcher(this.completionEndpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${authorization.attemptToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedVersion: authorization.expectedVersion,
            leaseGeneration: authorization.leaseGeneration,
            ...input,
          }),
          redirect: 'error',
        });
      } catch {
        throw new ExecutionControlPlaneReporterError();
      }
      const accepted = BaseRebaseCompletionResponseSchema.safeParse(
        await json(response, [200, 201]),
      );
      if (
        !accepted.success ||
        accepted.data.headSha !== input.headSha ||
        accepted.data.suiteId !== input.suiteId
      ) throw new ExecutionControlPlaneReporterError();
    });
  }
}

export interface ExecutionFailureReporterOptions {
  now?: () => Date;
}

/** Converts only the trusted Runner's fixed failure catalogue into a terminal event. */
export class ControlPlaneExecutionFailureReporter implements ExecutionFailureReporter {
  private readonly endpoint: string;
  private readonly now: () => Date;

  constructor(
    private readonly context: ExecutionReporterContext,
    private readonly fetcher: ExecutionReporterFetch = fetch,
    options: ExecutionFailureReporterOptions = {},
  ) {
    this.endpoint = endpoint(context, '/events');
    this.now = options.now ?? (() => new Date());
  }

  async report(failure: ExecutionAttemptFailure): Promise<void> {
    await this.context.fencing.withAuthorization(async (authorization) => {
      if (!validAuthorization(authorization)) throw new ExecutionControlPlaneReporterError();
      const digest = await canonicalSha256({
        attemptId: this.context.attemptId,
        failureCode: failure.failureCode,
        failureSite: failure.failureSite,
        leaseGeneration: authorization.leaseGeneration,
      });
      let response: Response;
      try {
        response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${authorization.attemptToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            schemaVersion: '1',
            eventId: `attempt_failure_${digest.slice('sha256:'.length, 'sha256:'.length + 56)}`,
            sequence: 1,
            type: 'attempt_failed',
            ...failure,
            occurredAt: this.now().toISOString(),
            expectedVersion: authorization.expectedVersion,
            leaseGeneration: authorization.leaseGeneration,
          }),
          redirect: 'error',
        });
      } catch {
        throw new ExecutionControlPlaneReporterError();
      }
      if (!FailureResponseSchema.safeParse(await json(response, [202])).success) {
        throw new ExecutionControlPlaneReporterError();
      }
    });
  }
}
