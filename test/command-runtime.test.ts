import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/agent/command-runtime.js';

describe('Agent command runtime stdout boundary', () => {
  it('replaces one explicitly recognized oversized JSONL line without exposing its body', async () => {
    const lines: string[] = [];
    const result = await executeCommand({
      command: process.execPath,
      args: ['-e', [
        'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"CANARY_"+"x".repeat(96*1024)}})+"\\n")',
        'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}})+"\\n")',
      ].join(';')],
      cwd: tmpdir(),
      stdin: '',
      timeoutMs: 10_000,
      onOversizedStdoutLine: (prefix) => prefix.includes('"type":"agent_message"')
        ? JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: '[PATCH_PROPOSAL_OMITTED]' },
          })
        : undefined,
      onStdoutLine: (line) => { lines.push(line); },
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[PATCH_PROPOSAL_OMITTED]');
    expect(lines[1]).toContain('turn.completed');
    expect(lines.join('\n')).not.toContain('CANARY_');
  });

  it('fails closed for an oversized line that is not explicitly recognized', async () => {
    const result = await executeCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(96*1024)+"\\n")'],
      cwd: tmpdir(),
      stdin: '',
      timeoutMs: 10_000,
      onOversizedStdoutLine: () => undefined,
      onStdoutLine: () => undefined,
    });

    expect(result).toMatchObject({ exitCode: 1, stdoutInvalid: true });
  });

  it('returns only the fixed stdoutInvalid flag when the bounded observer rejects JSONL', async () => {
    const result = await executeCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({type:"unsafe"})+"\\n")'],
      cwd: tmpdir(),
      stdin: '',
      timeoutMs: 10_000,
      onStdoutLine: () => { throw new Error('CANARY_RAW_OBSERVER_FAILURE'); },
    });

    expect(result).toMatchObject({ exitCode: 1, stdoutInvalid: true });
    expect(JSON.stringify(result)).not.toContain('CANARY_RAW_OBSERVER_FAILURE');
  });
});
