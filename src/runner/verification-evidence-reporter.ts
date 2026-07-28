import { z } from 'zod';
import {
  VerificationCommandResultV1Schema,
  VerificationSuiteManifestV1Schema,
  verificationSuiteCommands,
  type VerificationCommandResultV1,
  type VerificationSuiteCommand,
  type VerificationSuiteManifestV1,
} from '../domain/verification-evidence.js';
import type { VerificationEvidenceReporter } from './verification-execution-runner.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_RESPONSE_BYTES = 64 * 1_024;

const SuiteResponseSchema = z
  .object({
    suiteId: z.string().regex(IDENTIFIER_PATTERN),
    created: z.boolean(),
    status: z.enum(['running', 'failed', 'completed']),
    commands: z.array(z.object({
      position: z.number().int().nonnegative().max(99),
      phase: z.enum(['targeted', 'required_verify']),
      commandRef: z.string().min(1).max(80),
    }).strict()).min(2).max(100),
  })
  .strict();

const EvidenceResponseSchema = z
  .object({
    evidenceId: z.string().regex(IDENTIFIER_PATTERN),
    created: z.boolean(),
    suiteStatus: z.enum(['running', 'failed', 'completed']),
  })
  .strict();

export interface VerificationReporterAuthorization {
  attemptToken: string;
  expectedVersion: number;
  leaseGeneration: number;
}

export interface VerificationEvidenceReporterContext {
  controlPlaneUrl: string;
  attemptId: string;
  authorization: () => VerificationReporterAuthorization;
  withAuthorization?: <T>(
    operation: (authorization: VerificationReporterAuthorization) => Promise<T>,
  ) => Promise<T>;
}

export type VerificationEvidenceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class VerificationEvidenceReporterError extends Error {
  constructor() {
    super('verification Evidence report failed');
    this.name = 'VerificationEvidenceReporterError';
  }
}

/** Authenticated HTTP adapter; each call reads the latest heartbeat-rotated fencing snapshot. */
export class ControlPlaneVerificationEvidenceReporter implements VerificationEvidenceReporter {
  private readonly baseEndpoint: string;

  constructor(
    private readonly context: VerificationEvidenceReporterContext,
    private readonly fetcher: VerificationEvidenceFetch = fetch,
  ) {
    let base: URL;
    try {
      base = new URL(context.controlPlaneUrl);
    } catch {
      throw new VerificationEvidenceReporterError();
    }
    if (
      base.protocol !== 'https:' ||
      base.username !== '' ||
      base.password !== '' ||
      base.search !== '' ||
      base.hash !== '' ||
      !IDENTIFIER_PATTERN.test(context.attemptId) ||
      typeof context.authorization !== 'function'
    ) {
      throw new VerificationEvidenceReporterError();
    }
    this.baseEndpoint = new URL(
      `/v1/attempts/${encodeURIComponent(context.attemptId)}/verifications`,
      base,
    ).toString();
  }

  async start(manifest: VerificationSuiteManifestV1): Promise<{
    suiteId: string;
    created: boolean;
    status: 'running' | 'failed' | 'completed';
    commands: VerificationSuiteCommand[];
  }> {
    const parsed = VerificationSuiteManifestV1Schema.safeParse(manifest);
    if (!parsed.success) throw new VerificationEvidenceReporterError();
    const response = await this.post(this.baseEndpoint, (authorization) => ({
      expectedVersion: authorization.expectedVersion,
      leaseGeneration: authorization.leaseGeneration,
      manifest: parsed.data,
    }));
    const accepted = SuiteResponseSchema.safeParse(response);
    const expectedCommands = verificationSuiteCommands(parsed.data);
    if (
      !accepted.success ||
      accepted.data.commands.length !== expectedCommands.length ||
      accepted.data.commands.some((command, index) =>
        command.position !== expectedCommands[index]?.position ||
        command.phase !== expectedCommands[index]?.phase ||
        command.commandRef !== expectedCommands[index]?.commandRef)
    ) {
      throw new VerificationEvidenceReporterError();
    }
    return {
      suiteId: accepted.data.suiteId,
      created: accepted.data.created,
      status: accepted.data.status,
      commands: accepted.data.commands,
    };
  }

  async record(
    suiteId: string,
    result: VerificationCommandResultV1,
  ): Promise<{
    evidenceId: string;
    created: boolean;
    suiteStatus: 'running' | 'failed' | 'completed';
  }> {
    if (!IDENTIFIER_PATTERN.test(suiteId)) throw new VerificationEvidenceReporterError();
    const parsed = VerificationCommandResultV1Schema.safeParse(result);
    if (!parsed.success) throw new VerificationEvidenceReporterError();
    const response = await this.post(
      `${this.baseEndpoint}/${encodeURIComponent(suiteId)}/results`,
      (authorization) => ({
        expectedVersion: authorization.expectedVersion,
        leaseGeneration: authorization.leaseGeneration,
        result: parsed.data,
      }),
    );
    const accepted = EvidenceResponseSchema.safeParse(response);
    if (!accepted.success) throw new VerificationEvidenceReporterError();
    return accepted.data;
  }

  private authorization(): VerificationReporterAuthorization {
    const authorization = this.context.authorization();
    if (
      authorization.attemptToken.length < 1 ||
      authorization.attemptToken.length > 2_000 ||
      /[\0\r\n]/.test(authorization.attemptToken) ||
      !Number.isSafeInteger(authorization.expectedVersion) ||
      authorization.expectedVersion < 0 ||
      !Number.isSafeInteger(authorization.leaseGeneration) ||
      authorization.leaseGeneration < 1
    ) {
      throw new VerificationEvidenceReporterError();
    }
    return authorization;
  }

  private async post(
    url: string,
    body: (authorization: VerificationReporterAuthorization) => unknown,
  ): Promise<unknown> {
    const perform = async (): Promise<unknown> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const authorization = this.authorization();
        const result = await this.request(url, body, authorization, attempt === 0);
        if (result.retry) continue;
        return result.value;
      }
      throw new VerificationEvidenceReporterError();
    };
    if (this.context.withAuthorization !== undefined) {
      return await this.context.withAuthorization(async (authorization) => {
        const result = await this.request(url, body, authorization, false);
        if (result.retry) throw new VerificationEvidenceReporterError();
        return result.value;
      });
    }
    return await perform();
  }

  private async request(
    url: string,
    body: (authorization: VerificationReporterAuthorization) => unknown,
    authorization: VerificationReporterAuthorization,
    allowRetry: boolean,
  ): Promise<{ retry: true } | { retry: false; value: unknown }> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${authorization.attemptToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body(authorization)),
        redirect: 'error',
      });
    } catch {
      throw new VerificationEvidenceReporterError();
    }
    if (
      (response.status === 401 || response.status === 409) &&
      allowRetry
    ) {
      await response.body?.cancel();
      const latest = this.authorization();
      if (
        latest.attemptToken !== authorization.attemptToken ||
        latest.expectedVersion !== authorization.expectedVersion
      ) {
        return { retry: true };
      }
    }
    if (
      (response.status !== 200 && response.status !== 201) ||
      !response.headers.get('cache-control')?.toLowerCase().includes('no-store')
    ) {
      throw new VerificationEvidenceReporterError();
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new VerificationEvidenceReporterError();
    }
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
      throw new VerificationEvidenceReporterError();
    }
    try {
      return { retry: false, value: JSON.parse(text) as unknown };
    } catch {
      throw new VerificationEvidenceReporterError();
    }
  }
}
