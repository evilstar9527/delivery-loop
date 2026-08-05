import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/agent/command-runtime.js';

describe('Agent command runtime stdout boundary', () => {
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
