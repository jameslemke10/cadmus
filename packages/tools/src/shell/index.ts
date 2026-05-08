/**
 * Shell tool — run a command and return stdout/stderr.
 *
 * Disabled by default for safety. Pass `{ enabled: true }` to createShellTool
 * to opt in. Set a `timeout` (default 30s) and an `allowList` to restrict
 * which commands are runnable.
 */

import { defineTool } from "@cadmus/kernel";
import { spawn } from "node:child_process";

export interface ShellToolOptions {
  /** Must be true to actually execute commands. Default: false (returns an error). */
  enabled?: boolean;
  /** Hard ms cap on a single command. Default: 30000. */
  timeout?: number;
  /** Optional allow-list. If set, only these argv[0] values are runnable. */
  allowList?: string[];
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
}

export function createShellTool(opts: ShellToolOptions = {}) {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command. Returns stdout, stderr, and the exit code. Capped at a timeout.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    handler: async (args) => {
      if (!opts.enabled) {
        throw new Error(
          "bash tool is disabled. Pass { enabled: true } to createShellTool to opt in.",
        );
      }
      const { command } = args as { command: string };

      if (opts.allowList && opts.allowList.length > 0) {
        const head = command.trim().split(/\s+/)[0];
        if (!opts.allowList.includes(head)) {
          throw new Error(`command not in allowList: ${head}`);
        }
      }

      return new Promise<{
        stdout: string;
        stderr: string;
        exit_code: number;
        timed_out: boolean;
      }>((resolveResult, reject) => {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd: opts.cwd ?? process.cwd(),
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeout ?? 30000);

        child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
        child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolveResult({
            stdout: stdout.slice(0, 30000),
            stderr: stderr.slice(0, 8000),
            exit_code: code ?? -1,
            timed_out: timedOut,
          });
        });
      });
    },
  });
}
