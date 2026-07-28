import type {
  ToolCallResultCategory,
  ToolEffect,
} from '../domain/tool-bridge.js';

export interface ToolCallTraceInput {
  traceId: string;
  runId: string;
  attemptId: string;
  toolPath: string;
  action: string;
  effect: ToolEffect;
  durationMs: number;
  resultCategory: ToolCallResultCategory;
  occurredAt: string;
}

/**
 * D1 metadata-only trace store, adapted from Watt's AuditStore. The schema has
 * no argument, response, header, URL, or error-detail column by design.
 */
export class ToolCallTraceStore {
  constructor(private readonly db: D1Database) {}

  async write(input: ToolCallTraceInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tool_call_traces (
           trace_id, run_id, attempt_id, tool_path, action, effect,
           duration_ms, result_category, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.traceId,
        input.runId,
        input.attemptId,
        input.toolPath,
        input.action,
        input.effect,
        input.durationMs,
        input.resultCategory,
        input.occurredAt,
      )
      .run();
  }
}
