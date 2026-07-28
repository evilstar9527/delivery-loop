import { spawn } from 'node:child_process';
import {
  SensitiveDataRedactor,
  isSensitiveFieldName,
} from '../security/redaction.js';

const MAX_STDERR_BYTES = 8_192;
const MAX_STDOUT_LINE_BYTES = 64 * 1_024;
const INTERRUPT_GRACE_MS = 1_000;

export interface CommandExecutionRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  /** Streaming JSONL observer. Raw stdout is never retained or returned. */
  onStdoutLine?: (line: string) => void;
}

export interface CommandExecutionResult {
  exitCode: number;
  stderr?: string;
}

export interface CommandProcessHandle {
  completion: Promise<CommandExecutionResult>;
  interrupt(): Promise<void>;
}

export type CommandExecutor = (
  request: CommandExecutionRequest,
) => Promise<CommandExecutionResult>;

export type CommandProcessLauncher = (
  request: CommandExecutionRequest,
) => CommandProcessHandle;

function environmentRedactor(): SensitiveDataRedactor {
  const environmentSecrets = Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && isSensitiveFieldName(key))
    .map(([, value]) => value!);
  return new SensitiveDataRedactor({ secrets: environmentSecrets });
}

/** Bounded, redact-before-return process runtime shared by all Agent adapters. */
export function launchCommand(request: CommandExecutionRequest): CommandProcessHandle {
  const redactor = environmentRedactor();
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.environment ?? process.env,
    shell: false,
    stdio: ['pipe', request.onStdoutLine === undefined ? 'ignore' : 'pipe', 'pipe'],
  });
  let stderr = '';
  let settled = false;
  let interruptPromise: Promise<void> | undefined;
  let stdoutBuffer = '';
  let stdoutFailed = false;
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR_BYTES) {
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    }
  });
  if (request.onStdoutLine !== undefined && child.stdout !== null) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdoutFailed) return;
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          request.onStdoutLine!(line);
        } catch {
          stdoutFailed = true;
          child.kill('SIGTERM');
          return;
        }
      }
      if (new TextEncoder().encode(stdoutBuffer).length > MAX_STDOUT_LINE_BYTES) {
        stdoutFailed = true;
        child.kill('SIGTERM');
      }
    });
  }

  const completion = new Promise<CommandExecutionResult>((resolvePromise, rejectPromise) => {
    child.once('error', (error) => {
      settled = true;
      rejectPromise(error);
    });
    child.once('close', (code) => {
      settled = true;
      if (!stdoutFailed && request.onStdoutLine !== undefined && stdoutBuffer.length > 0) {
        try {
          request.onStdoutLine(stdoutBuffer.replace(/\r$/, ''));
        } catch {
          stdoutFailed = true;
        }
      }
      resolvePromise({
        exitCode: stdoutFailed ? 1 : (code ?? 1),
        ...(stderr.length === 0 ? {} : { stderr: redactor.redactText(stderr) }),
      });
    });
  });

  const interrupt = async (): Promise<void> => {
    if (interruptPromise !== undefined) return await interruptPromise;
    interruptPromise = (async () => {
      if (settled) {
        await completion.catch(() => undefined);
        return;
      }
      child.kill('SIGTERM');
      await Promise.race([
        completion.catch(() => undefined),
        new Promise<void>((resolvePromise) => setTimeout(resolvePromise, INTERRUPT_GRACE_MS)),
      ]);
      if (!settled) child.kill('SIGKILL');
      await completion.catch(() => undefined);
    })();
    return await interruptPromise;
  };

  const timeout = setTimeout(() => void interrupt(), request.timeoutMs);
  void completion.finally(() => clearTimeout(timeout)).catch(() => undefined);
  child.stdin!.end(request.stdin);
  return { completion, interrupt };
}

export async function executeCommand(
  request: CommandExecutionRequest,
): Promise<CommandExecutionResult> {
  return await launchCommand(request).completion;
}
