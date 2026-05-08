/**
 * @cadmus/tools — built-in tools for Cadmus agents.
 *
 * Import a sub-module:
 *   import { createMemoryStore } from "@cadmus/tools/memory";
 *   import { webSearch, webFetch } from "@cadmus/tools/web";
 *   import { createFsTools } from "@cadmus/tools/fs";
 *   import { createShellTool } from "@cadmus/tools/shell";
 *   import { getCurrentTime, sleep } from "@cadmus/tools/time";
 *   import { createMcpTools } from "@cadmus/tools/mcp";
 *
 * Or grab the whole grab-bag from the root:
 *   import { webSearch, getCurrentTime } from "@cadmus/tools";
 */

export { createMemoryStore, type MemoryEntry, type MemoryStoreOptions } from "./memory/index.js";
export { webSearch, webFetch } from "./web/index.js";
export { createFsTools, type FsToolOptions } from "./fs/index.js";
export { createShellTool, type ShellToolOptions } from "./shell/index.js";
export { getCurrentTime, sleep } from "./time/index.js";
export { createMcpTools, type McpToolsOptions } from "./mcp/index.js";
