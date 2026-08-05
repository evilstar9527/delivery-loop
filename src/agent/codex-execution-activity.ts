import { z } from 'zod';

const MAX_ACTIVITY_COUNT = 262_144;
const MAX_JSONL_LINE_BYTES = 64 * 1_024;

export const CodexExecutionActivitySchema = z.object({
  schemaVersion: z.literal('1'),
  jsonlEventCount: z.number().int().min(0).max(MAX_ACTIVITY_COUNT),
  commandExecutionStartedCount: z.number().int().min(0).max(MAX_ACTIVITY_COUNT),
  commandExecutionCompletedCount: z.number().int().min(0).max(MAX_ACTIVITY_COUNT),
  fileChangeStartedCount: z.number().int().min(0).max(MAX_ACTIVITY_COUNT),
  fileChangeCompletedCount: z.number().int().min(0).max(MAX_ACTIVITY_COUNT),
  agentMessageCompletedCount: z.number().int().min(0).max(MAX_ACTIVITY_COUNT),
  turnCompletedCount: z.number().int().min(0).max(MAX_ACTIVITY_COUNT),
}).strict();

export type CodexExecutionActivity = z.infer<typeof CodexExecutionActivitySchema>;

/**
 * Projects raw Codex JSONL into fixed counters. Command text, paths, output,
 * messages, and all unknown fields are deliberately discarded in memory.
 */
export class CodexExecutionActivityAccumulator {
  private readonly activity: CodexExecutionActivity = {
    schemaVersion: '1',
    jsonlEventCount: 0,
    commandExecutionStartedCount: 0,
    commandExecutionCompletedCount: 0,
    fileChangeStartedCount: 0,
    fileChangeCompletedCount: 0,
    agentMessageCompletedCount: 0,
    turnCompletedCount: 0,
  };

  accept(event: object): void {
    this.increment('jsonlEventCount');
    const type = (event as { type?: unknown }).type;
    if (type === 'turn.completed') {
      this.increment('turnCompletedCount');
      return;
    }
    if (type !== 'item.started' && type !== 'item.completed') return;
    const item = (event as { item?: unknown }).item;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
    const itemType = (item as { type?: unknown }).type;
    if (itemType === 'command_execution') {
      this.increment(type === 'item.started'
        ? 'commandExecutionStartedCount'
        : 'commandExecutionCompletedCount');
    } else if (itemType === 'file_change') {
      this.increment(type === 'item.started'
        ? 'fileChangeStartedCount'
        : 'fileChangeCompletedCount');
    } else if (itemType === 'agent_message' && type === 'item.completed') {
      this.increment('agentMessageCompletedCount');
    }
  }

  acceptLine(line: string): void {
    if (new TextEncoder().encode(line).length > MAX_JSONL_LINE_BYTES) {
      throw new Error('Codex execution activity event is invalid');
    }
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new Error('Codex execution activity event is invalid');
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new Error('Codex execution activity event is invalid');
    }
    this.accept(event);
  }

  result(): CodexExecutionActivity {
    return { ...this.activity };
  }

  private increment(key: Exclude<keyof CodexExecutionActivity, 'schemaVersion'>): void {
    if (this.activity[key] >= MAX_ACTIVITY_COUNT) {
      throw new Error('Codex execution activity is oversized');
    }
    this.activity[key] += 1;
  }
}
