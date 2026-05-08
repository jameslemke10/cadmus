/**
 * Filesystem tools — read, write, list, edit.
 *
 * Operate relative to the agent's working directory (process.cwd()) by default.
 * Refuse paths outside the agent's root unless `allowAbsolute: true` is set
 * when creating the tool factory.
 */

import { defineTool } from "@cadmus/kernel";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface FsToolOptions {
  /** Root directory tools are sandboxed to. Default: process.cwd(). */
  root?: string;
  /** Allow paths outside the root. Default: false. */
  allowAbsolute?: boolean;
}

export function createFsTools(opts: FsToolOptions = {}) {
  const root = resolve(opts.root ?? process.cwd());

  const safe = (path: string): string => {
    const abs = isAbsolute(path) ? path : resolve(root, path);
    if (opts.allowAbsolute) return abs;
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path is outside the agent's root (${root}): ${path}`);
    }
    return abs;
  };

  const readFile = defineTool({
    name: "read_file",
    description: "Read a file's contents as UTF-8 text.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_chars: { type: "number", default: 50000 },
      },
      required: ["path"],
    },
    handler: async (args) => {
      const { path, max_chars = 50000 } = args as { path: string; max_chars?: number };
      const abs = safe(path);
      const content = readFileSync(abs, "utf8");
      return {
        path,
        content: content.slice(0, max_chars),
        truncated: content.length > max_chars,
        bytes: Buffer.byteLength(content, "utf8"),
      };
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description: "Write text content to a file. Creates parent directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    handler: async (args) => {
      const { path, content } = args as { path: string; content: string };
      const abs = safe(path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return { path, bytes: Buffer.byteLength(content, "utf8") };
    },
  });

  const listDir = defineTool({
    name: "list_dir",
    description: "List entries in a directory. Returns name, type (file|dir), size for files.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", default: "." } },
    },
    handler: async (args) => {
      const { path = "." } = (args as { path?: string }) ?? {};
      const abs = safe(path);
      if (!existsSync(abs)) throw new Error(`not found: ${path}`);
      const entries = readdirSync(abs).map((name) => {
        const entryAbs = resolve(abs, name);
        const stat = statSync(entryAbs);
        return {
          name,
          type: stat.isDirectory() ? ("dir" as const) : ("file" as const),
          size: stat.isFile() ? stat.size : undefined,
        };
      });
      return { path, entries };
    },
  });

  return { readFile, writeFile, listDir };
}
