import { z } from 'zod';
import type { CodexModelUsage } from '../domain/quota.js';

const MAX_JSONL_LINE_BYTES = 64 * 1_024;
const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TurnCompletedSchema = z.object({
  type: z.literal('turn.completed'),
  usage: z.object({
    input_tokens: TokenCountSchema,
    cached_input_tokens: TokenCountSchema,
    output_tokens: TokenCountSchema,
    reasoning_output_tokens: TokenCountSchema,
  }).strict(),
}).passthrough();

/**
 * Projects Codex `exec --json` into the only four trusted usage scalars.
 * Agent messages, reasoning, command output, tool arguments, and thread IDs are
 * deliberately discarded instead of retained for later redaction.
 */
export class CodexUsageAccumulator {
  private completed: CodexModelUsage | null = null;

  acceptLine(line: string): void {
    if (new TextEncoder().encode(line).length > MAX_JSONL_LINE_BYTES) {
      throw new Error('Codex usage event is invalid');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new Error('Codex usage event is invalid');
    }
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) return;
    if ((raw as { type?: unknown }).type !== 'turn.completed') return;
    if (this.completed !== null) throw new Error('Codex usage event is invalid');
    const parsed = TurnCompletedSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Codex usage event is invalid');
    const usage = parsed.data.usage;
    if (
      usage.cached_input_tokens > usage.input_tokens ||
      usage.reasoning_output_tokens > usage.output_tokens
    ) throw new Error('Codex usage event is invalid');
    this.completed = {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      outputTokens: usage.output_tokens,
      reasoningOutputTokens: usage.reasoning_output_tokens,
    };
  }

  result(): CodexModelUsage | null {
    return this.completed === null ? null : { ...this.completed };
  }
}
