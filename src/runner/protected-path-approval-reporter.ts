import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  ProtectedPathChangeReportV1Schema,
  type ProtectedPathChangeReportV1,
} from '../domain/protected-path-change.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const ProtectedPathApprovalResponseSchema = z
  .object({
    gateId: z.string().regex(IDENTIFIER_PATTERN),
    created: z.boolean(),
    state: z.literal('awaiting_approval'),
    runVersion: z.number().int().nonnegative(),
    report: ProtectedPathChangeReportV1Schema,
  })
  .strict();

export interface ProtectedPathApprovalReporterContext {
  controlPlaneUrl: string;
  attemptId: string;
  attemptToken: string;
  expectedVersion: number;
  leaseGeneration: number;
}

export type ProtectedPathApprovalFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ProtectedPathApprovalReporterError extends Error {
  constructor() {
    super('protected path approval report failed');
    this.name = 'ProtectedPathApprovalReporterError';
  }
}

/** Fixed HTTP adapter used by the trusted Runner, never by Agent-authored code. */
export class ControlPlaneProtectedPathApprovalReporter {
  private readonly endpoint: string;
  private readonly context: Omit<ProtectedPathApprovalReporterContext, 'controlPlaneUrl'>;

  constructor(
    context: ProtectedPathApprovalReporterContext,
    private readonly fetcher: ProtectedPathApprovalFetch = fetch,
  ) {
    let base: URL;
    try {
      base = new URL(context.controlPlaneUrl);
    } catch {
      throw new ProtectedPathApprovalReporterError();
    }
    if (
      base.protocol !== 'https:' ||
      base.username !== '' ||
      base.password !== '' ||
      base.search !== '' ||
      base.hash !== '' ||
      !IDENTIFIER_PATTERN.test(context.attemptId) ||
      context.attemptToken.length < 1 ||
      context.attemptToken.length > 2_000 ||
      /[\0\r\n]/.test(context.attemptToken) ||
      !Number.isSafeInteger(context.expectedVersion) ||
      context.expectedVersion < 0 ||
      !Number.isSafeInteger(context.leaseGeneration) ||
      context.leaseGeneration < 1
    ) {
      throw new ProtectedPathApprovalReporterError();
    }
    this.endpoint = new URL(
      `/v1/attempts/${encodeURIComponent(context.attemptId)}/protected-path-changes`,
      base,
    ).toString();
    this.context = {
      attemptId: context.attemptId,
      attemptToken: context.attemptToken,
      expectedVersion: context.expectedVersion,
      leaseGeneration: context.leaseGeneration,
    };
  }

  async report(report: ProtectedPathChangeReportV1): Promise<void> {
    const parsed = ProtectedPathChangeReportV1Schema.safeParse(report);
    if (!parsed.success) throw new ProtectedPathApprovalReporterError();
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.context.attemptToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: this.context.expectedVersion,
          leaseGeneration: this.context.leaseGeneration,
          report: parsed.data,
        }),
        redirect: 'error',
      });
    } catch {
      throw new ProtectedPathApprovalReporterError();
    }
    if (response.status !== 202) throw new ProtectedPathApprovalReporterError();
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new ProtectedPathApprovalReporterError();
    }
    const accepted = ProtectedPathApprovalResponseSchema.safeParse(rawResponse);
    if (
      !accepted.success ||
      await canonicalSha256(accepted.data.report) !== await canonicalSha256(parsed.data)
    ) {
      throw new ProtectedPathApprovalReporterError();
    }
  }
}
