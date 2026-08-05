import { z } from 'zod';

const MAX_JSONL_LINE_BYTES = 64 * 1_024;

const CompletedCommandEventSchema = z.object({
  type: z.literal('item.completed'),
  item: z.object({
    id: z.string().min(1).max(200),
    type: z.literal('command_execution'),
    command: z.string().min(1).max(16 * 1_024),
    aggregated_output: z.string().max(MAX_JSONL_LINE_BYTES),
    exit_code: z.number().int().nullable(),
    status: z.enum(['in_progress', 'completed', 'failed', 'declined']),
  }).strict(),
}).strict();

/**
 * Parses an optional Codex command observation for diagnostics. Command text
 * and output are parsed in memory and immediately discarded. This projection
 * is deliberately not wired into Plan acceptance: models are not required to
 * choose a shell tool in order to return a valid context-bound Plan.
 */
export class CodexContextAccessAccumulator {
  private readonly contextFilePath: string;
  private readonly expectedDigest: string;
  private matches = 0;

  constructor(contextFilePath: string, expectedDigest: string) {
    this.contextFilePath = contextFilePath;
    this.expectedDigest = expectedDigest;
  }

  acceptLine(line: string): void {
    if (new TextEncoder().encode(line).length > MAX_JSONL_LINE_BYTES) {
      throw new Error('Codex context access event is invalid');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new Error('Codex context access event is invalid');
    }
    if (
      typeof raw !== 'object' || raw === null ||
      (raw as { type?: unknown }).type !== 'item.completed'
    ) return;
    const item = (raw as { item?: unknown }).item;
    if (
      typeof item !== 'object' || item === null ||
      (item as { type?: unknown }).type !== 'command_execution'
    ) return;
    const parsed = CompletedCommandEventSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Codex context access event is invalid');
    const command = parsed.data.item;
    if (
      command.status === 'completed' &&
      command.exit_code === 0 &&
      command.command.includes(this.contextFilePath) &&
      command.aggregated_output.trim() === this.expectedDigest
    ) {
      this.matches += 1;
      if (this.matches > 1) throw new Error('Codex context access event is invalid');
    }
  }

  result(): boolean {
    return this.matches === 1;
  }
}
