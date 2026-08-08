import { spawn } from 'node:child_process';
import {
  SensitiveDataRedactor,
  isSensitiveFieldName,
} from '../security/redaction.js';

const MAX_STDERR_BYTES = 8_192;
const MAX_STDOUT_LINE_BYTES = 64 * 1_024;
const MAX_OMITTABLE_STDOUT_LINE_BYTES = 2 * 1_024 * 1_024;
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
  /**
   * Receives at most a 64 KiB prefix when one physical line exceeds the JSONL
   * parser boundary. Return a fixed bounded replacement to discard that line,
   * or undefined to fail closed. Raw overflow bytes are never forwarded.
   */
  onOversizedStdoutLine?: (prefix: string) => string | undefined;
}

export interface CommandExecutionResult {
  exitCode: number;
  /** The runtime deadline fired, even if the child handled SIGTERM and exited zero. */
  timedOut?: true;
  /** The bounded stdout observer rejected a line or line fragment. */
  stdoutInvalid?: true;
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
  let stdoutOverflowBytes = 0;
  let stdoutOverflowReplacement: string | undefined;
  let stdoutFailed = false;
  let timedOut = false;
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR_BYTES) {
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    }
  });
  if (request.onStdoutLine !== undefined && child.stdout !== null) {
    child.stdout.setEncoding('utf8');
    const byteLength = (value: string): number => new TextEncoder().encode(value).length;
    const failStdout = (): void => {
      stdoutFailed = true;
      child.kill('SIGTERM');
    };
    const emitLine = (line: string): void => {
      if (line.length === 0 || stdoutFailed) return;
      try {
        request.onStdoutLine!(line);
      } catch {
        failStdout();
      }
    };
    const boundedPrefix = (line: string): string => {
      const bytes = new TextEncoder().encode(line);
      return new TextDecoder().decode(bytes.slice(0, MAX_STDOUT_LINE_BYTES));
    };
    const replacementFor = (line: string): string | undefined => {
      if (request.onOversizedStdoutLine === undefined) return undefined;
      let replacement: string | undefined;
      try {
        replacement = request.onOversizedStdoutLine(boundedPrefix(line));
      } catch {
        return undefined;
      }
      if (
        replacement === undefined || replacement.length === 0 ||
        replacement.includes('\n') || byteLength(replacement) > MAX_STDOUT_LINE_BYTES
      ) return undefined;
      return replacement;
    };
    const acceptCompleteLine = (line: string): void => {
      const normalized = line.replace(/\r$/, '');
      const bytes = byteLength(normalized);
      if (bytes <= MAX_STDOUT_LINE_BYTES) {
        emitLine(normalized);
        return;
      }
      if (bytes > MAX_OMITTABLE_STDOUT_LINE_BYTES) {
        failStdout();
        return;
      }
      const replacement = replacementFor(normalized);
      if (replacement === undefined) {
        failStdout();
        return;
      }
      emitLine(replacement);
    };
    child.stdout.on('data', (chunk: string) => {
      if (stdoutFailed) return;
      let remaining = chunk;
      while (remaining.length > 0 && !stdoutFailed) {
        if (stdoutOverflowReplacement !== undefined) {
          const newline = remaining.indexOf('\n');
          const fragment = newline < 0 ? remaining : remaining.slice(0, newline);
          stdoutOverflowBytes += byteLength(fragment);
          if (stdoutOverflowBytes > MAX_OMITTABLE_STDOUT_LINE_BYTES) {
            failStdout();
            return;
          }
          if (newline < 0) return;
          emitLine(stdoutOverflowReplacement);
          stdoutOverflowReplacement = undefined;
          stdoutOverflowBytes = 0;
          remaining = remaining.slice(newline + 1);
          continue;
        }

        const newline = remaining.indexOf('\n');
        if (newline >= 0) {
          stdoutBuffer += remaining.slice(0, newline);
          acceptCompleteLine(stdoutBuffer);
          stdoutBuffer = '';
          remaining = remaining.slice(newline + 1);
          continue;
        }

        stdoutBuffer += remaining;
        const bytes = byteLength(stdoutBuffer);
        if (bytes > MAX_STDOUT_LINE_BYTES) {
          const replacement = replacementFor(stdoutBuffer);
          if (replacement === undefined || bytes > MAX_OMITTABLE_STDOUT_LINE_BYTES) {
            failStdout();
            return;
          }
          stdoutOverflowReplacement = replacement;
          stdoutOverflowBytes = bytes;
          stdoutBuffer = '';
        }
        return;
      }
    });

    child.once('close', () => {
      if (stdoutFailed) return;
      if (stdoutOverflowReplacement !== undefined) {
        emitLine(stdoutOverflowReplacement);
        stdoutOverflowReplacement = undefined;
        stdoutOverflowBytes = 0;
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
      if (
        !stdoutFailed && request.onStdoutLine !== undefined &&
        stdoutOverflowReplacement === undefined && stdoutBuffer.length > 0
      ) {
        try {
          const line = stdoutBuffer.replace(/\r$/, '');
          if (new TextEncoder().encode(line).length > MAX_STDOUT_LINE_BYTES) {
            stdoutFailed = true;
          } else {
            request.onStdoutLine(line);
          }
        } catch {
          stdoutFailed = true;
        }
      }
      resolvePromise({
        // Preserve a non-success process contract for every caller. A child may
        // handle the runtime SIGTERM and report zero, but the requested command
        // still exceeded its trusted deadline.
        exitCode: timedOut ? 124 : stdoutFailed ? 1 : (code ?? 1),
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(stdoutFailed ? { stdoutInvalid: true as const } : {}),
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

  const timeout = setTimeout(() => {
    timedOut = true;
    void interrupt();
  }, request.timeoutMs);
  void completion.finally(() => clearTimeout(timeout)).catch(() => undefined);
  child.stdin!.end(request.stdin);
  return { completion, interrupt };
}

export async function executeCommand(
  request: CommandExecutionRequest,
): Promise<CommandExecutionResult> {
  return await launchCommand(request).completion;
}
