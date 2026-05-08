/**
 * MCP meta-tools — search, list, call.
 *
 * Three tools that let an agent dynamically discover and call MCP tools at
 * runtime, instead of statically wrapping every server's tools at config time.
 *
 *   mcp_search(query)            → find MCP servers in the configured registry
 *   mcp_list(server)             → list tools exposed by a server
 *   mcp_call(server, tool, args) → invoke a tool on a server
 *
 * V0.1 status: STUBS. The plumbing is here so processors can be wired with
 * `mcp_*` tools today, but the actual MCP client implementation lives in a
 * follow-up PR (see issue: "Wire up real MCP client"). For now these tools
 * return shaped errors that explain the missing piece.
 *
 * Contributors: this is the spot. The kernel's tool execution model is
 * unchanged; we just need a real MCP client (likely @modelcontextprotocol/sdk)
 * and a registry connector. The shape of the three tools shouldn't change.
 */

import { defineTool } from "@cadmus/kernel";

const NOT_IMPLEMENTED = (tool: string): never => {
  throw new Error(
    `${tool} is not yet implemented. Cadmus's MCP support is a stub in V0.1 — ` +
      `track progress at https://github.com/jameslemke10/cadmus/issues (search "mcp").`,
  );
};

export interface McpToolsOptions {
  /**
   * Registry endpoint. Default: a stub that returns an empty list.
   * In production, point at smithery.ai, mcpm, or your own.
   */
  registry?: string;
  /**
   * Per-server connection config. Stub today.
   * Real impl will spawn stdio servers or connect to HTTP/WS endpoints.
   */
  servers?: Record<string, { command?: string; url?: string }>;
}

export function createMcpTools(_opts: McpToolsOptions = {}) {
  const mcpSearch = defineTool({
    name: "mcp_search",
    description:
      "Search the configured MCP registry for servers and tools matching a query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
    handler: async () => NOT_IMPLEMENTED("mcp_search"),
  });

  const mcpList = defineTool({
    name: "mcp_list",
    description:
      "List the tools exposed by a connected MCP server.",
    input_schema: {
      type: "object",
      properties: { server: { type: "string" } },
      required: ["server"],
    },
    handler: async () => NOT_IMPLEMENTED("mcp_list"),
  });

  const mcpCall = defineTool({
    name: "mcp_call",
    description:
      "Invoke a tool on a connected MCP server. Returns the tool's result.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        args: { type: "object" },
      },
      required: ["server", "tool", "args"],
    },
    handler: async () => NOT_IMPLEMENTED("mcp_call"),
  });

  return { mcpSearch, mcpList, mcpCall };
}
