import type { Bindings } from '../env.js';
import { dashboardExecutorTransport } from './executor-transport.js';

/**
 * One parsed line of the sandbox process's stdout.
 *
 * The runner emits counter-only activity records (command text, file paths and
 * agent messages are discarded upstream by design — see
 * `src/agent/codex-execution-activity.ts`), so a session view shows *progress
 * evidence*, never conversation content. Lines that are not the expected
 * structured JSON are surfaced verbatim as `raw` rather than dropped, so an
 * operator can still see crash output.
 */
export interface SandboxSessionEvent {
  observedAt: string | null;
  event: string;
  fields: Record<string, unknown>;
  raw: string | null;
}

export interface SandboxSession {
  sandboxId: string;
  executionId: string;
  role: string;
  /** State recorded in D1 by the control plane. */
  recordedStatus: string;
  /** State reported live by the container, or null when it did not answer. */
  liveStatus: string | null;
  exitCode: number | null;
  startedAt: string | null;
  events: SandboxSessionEvent[];
  stderr: string;
  truncated: boolean;
  /**
   * True when the container failed to answer the log read. The sandbox may be
   * wedged; the caller should say so plainly instead of rendering an empty
   * session as if it were idle.
   */
  unreachable: boolean;
}

interface ExecutionRow {
  execution_id: string;
  provider_external_id: string;
  execution_role: string;
  status: string;
  started_at: string | null;
}

const MAX_EVENTS = 400;

/** Reads the newest active execution for a run and its live log tail. */
export class SandboxSessionStore {
  constructor(
    private readonly db: D1Database,
    private readonly env: Pick<
      Bindings,
      'AGENT_EXECUTOR' | 'AGENT_EXECUTOR_URL' | 'AGENT_EXECUTOR_CONTROL_TOKEN' |
      'AGENT_EXECUTOR_CALLBACK_TOKEN'
    >,
  ) {}

  /** Resolves the run's live sandbox, or null when it has none. */
  async activeExecution(runId: string): Promise<ExecutionRow | null> {
    const row = await this.db.prepare(
      `SELECT execution.execution_id, execution.provider_external_id,
              execution.execution_role, execution.status, execution.started_at
       FROM attempt_execution_instances AS execution
       JOIN attempts ON attempts.attempt_id = execution.attempt_id
       WHERE attempts.run_id = ?
         AND execution.status IN ('starting', 'running')
         AND execution.provider_external_id IS NOT NULL
       ORDER BY execution.started_at DESC, execution.execution_id DESC
       LIMIT 1`,
    ).bind(runId).first<ExecutionRow>();
    return row ?? null;
  }

  async session(runId: string): Promise<SandboxSession | null> {
    const row = await this.activeExecution(runId);
    if (row === null) return null;
    const transport = dashboardExecutorTransport(this.env);
    const base = {
      sandboxId: row.provider_external_id,
      executionId: row.execution_id,
      role: row.execution_role,
      recordedStatus: row.status,
      startedAt: row.started_at,
    };
    if (transport === null) {
      // No executor transport configured: report the recorded state honestly
      // rather than pretending the session is empty.
      return {
        ...base,
        liveStatus: null,
        exitCode: null,
        events: [],
        stderr: '',
        truncated: false,
        unreachable: true,
      };
    }
    try {
      const tail = await transport.effects.logsSandbox(
        transport.origin,
        row.provider_external_id,
      );
      return {
        ...base,
        liveStatus: tail.status,
        exitCode: tail.exitCode,
        events: parseSessionEvents(tail.stdout),
        stderr: tail.stderr,
        truncated: tail.truncated,
        unreachable: false,
      };
    } catch {
      return {
        ...base,
        liveStatus: null,
        exitCode: null,
        events: [],
        stderr: '',
        truncated: false,
        unreachable: true,
      };
    }
  }
}

/** Parses newline-delimited structured log records, newest last. */
export function parseSessionEvents(stdout: string): SandboxSessionEvent[] {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const kept = lines.slice(-MAX_EVENTS);
  return kept.map((line) => {
    if (!line.startsWith('{')) return { observedAt: null, event: 'output', fields: {}, raw: line };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return { observedAt: null, event: 'output', fields: {}, raw: line };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { observedAt: null, event: 'output', fields: {}, raw: line };
    }
    const record = parsed as Record<string, unknown>;
    const { event, observedAt, component, level, ...fields } = record;
    void component;
    void level;
    return {
      observedAt: typeof observedAt === 'string' ? observedAt : null,
      event: typeof event === 'string' ? event : 'output',
      fields,
      raw: null,
    };
  });
}
