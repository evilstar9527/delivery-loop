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

export class ToolCallTraceStoreError extends Error {
  constructor(readonly code: 'not_authorized' | 'state_conflict') {
    super(`Tool call trace operation failed: ${code}`);
    this.name = 'ToolCallTraceStoreError';
  }
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

  /** Records a direct-runtime call only when the control plane admitted that exact trace first. */
  async writeAuthorized(input: ToolCallTraceInput): Promise<'created' | 'existing'> {
    const existing = await this.db.prepare(
      `SELECT run_id, attempt_id, tool_path, action, effect,
              duration_ms, result_category, occurred_at
       FROM tool_call_traces WHERE trace_id = ?`,
    ).bind(input.traceId).first<{
      run_id: string;
      attempt_id: string;
      tool_path: string;
      action: string;
      effect: string;
      duration_ms: number;
      result_category: string;
      occurred_at: string;
    }>();
    if (existing !== null) {
      if (
        existing.run_id !== input.runId || existing.attempt_id !== input.attemptId ||
        existing.tool_path !== input.toolPath || existing.action !== input.action ||
        existing.effect !== input.effect || existing.duration_ms !== input.durationMs ||
        existing.result_category !== input.resultCategory || existing.occurred_at !== input.occurredAt
      ) throw new ToolCallTraceStoreError('state_conflict');
      return 'existing';
    }
    const result = await this.db.prepare(
      `INSERT INTO tool_call_traces (
         trace_id, run_id, attempt_id, tool_path, action, effect,
         duration_ms, result_category, occurred_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM quota_tool_call_admissions
         WHERE trace_id = ? AND run_id = ? AND attempt_id = ?
       )
       ON CONFLICT(trace_id) DO NOTHING`,
    ).bind(
      input.traceId,
      input.runId,
      input.attemptId,
      input.toolPath,
      input.action,
      input.effect,
      input.durationMs,
      input.resultCategory,
      input.occurredAt,
      input.traceId,
      input.runId,
      input.attemptId,
    ).run();
    if (result.meta.changes === 1) return 'created';
    const replay = await this.db.prepare(
      `SELECT run_id, attempt_id, tool_path, action, effect,
              duration_ms, result_category, occurred_at
       FROM tool_call_traces WHERE trace_id = ?`,
    ).bind(input.traceId).first<{
      run_id: string;
      attempt_id: string;
      tool_path: string;
      action: string;
      effect: string;
      duration_ms: number;
      result_category: string;
      occurred_at: string;
    }>();
    if (
      replay !== null && replay.run_id === input.runId &&
      replay.attempt_id === input.attemptId && replay.tool_path === input.toolPath &&
      replay.action === input.action && replay.effect === input.effect &&
      replay.duration_ms === input.durationMs &&
      replay.result_category === input.resultCategory && replay.occurred_at === input.occurredAt
    ) return 'existing';
    const admission = await this.db.prepare(
      `SELECT 1 AS admitted FROM quota_tool_call_admissions
       WHERE trace_id = ? AND run_id = ? AND attempt_id = ?`,
    ).bind(input.traceId, input.runId, input.attemptId).first<{ admitted: number }>();
    if (admission === null) throw new ToolCallTraceStoreError('not_authorized');
    throw new ToolCallTraceStoreError('state_conflict');
  }
}
