import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redactUrlCredentials } from "@pi-cloud-agent/protocol";

/** Run one child process, bounding what it may print and scrubbing URL credentials. */

export const CLONE_DEPTH = 100;
const MAX_OUTPUT_CHARS = 1_000_000;

export interface CommandResult {
  code: number;
  output: string;
  stderr: string;
  outputTruncated: boolean;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export type OutputPosition = "head" | "tail";

export function trimCommandOutput(
  output: string,
  maxOutputChars: number,
  position: OutputPosition = "tail",
): { output: string; truncated: boolean } {
  if (output.length <= maxOutputChars) return { output, truncated: false };
  return {
    output:
      position === "head" ? output.slice(0, maxOutputChars) : output.slice(-maxOutputChars),
    truncated: true,
  };
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputChars?: number;
    outputPosition?: OutputPosition;
    includeStderr?: boolean;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const append = (stream: "stdout" | "stderr", text: string) => {
      if (!text) return;
      const maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
      const trimmed = trimCommandOutput(
        (stream === "stdout" ? stdout : stderr) + text,
        maxOutputChars,
        options.outputPosition,
      );
      if (stream === "stdout") {
        stdout = trimmed.output;
        stdoutTruncated ||= trimmed.truncated;
      } else {
        stderr = trimmed.output;
        stderrTruncated ||= trimmed.truncated;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", stderrDecoder.write(chunk)));

    const flush = () => {
      append("stdout", stdoutDecoder.end());
      append("stderr", stderrDecoder.end());
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    const finish = (code: number, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      flush();
      const cleanStdout = redactUrlCredentials(stdout);
      const cleanStderr = redactUrlCredentials(stderr).trim();
      resolve({
        code,
        output:
          options.includeStderr === false
            ? cleanStdout
            : [cleanStdout.trim(), cleanStderr].filter(Boolean).join("\n"),
        stderr: cleanStderr,
        outputTruncated:
          stdoutTruncated || (options.includeStderr !== false && stderrTruncated),
        signal,
        timedOut,
      });
    };

    child.on("error", (error) => {
      append("stderr", `\n${error.message}`);
      finish(1, null);
    });
    child.on("close", (code, signal) => {
      // A process closed by a signal has no exit code. It did not succeed.
      finish(code ?? (timedOut ? 124 : 1), signal);
    });
  });
}
