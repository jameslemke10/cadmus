# Tool

A JSON-Schema'd function any processor can call. Vocabulary defined in [glossary.md](glossary.md).

## Status

**v1 (draft).** Current implementation at [packages/kernel/src/types.ts:24-29](../packages/kernel/src/types.ts#L24-L29). The TypeScript type currently named `ToolDefinition` is renamed to `Tool` per glossary naming rules in the same PR as this spec.

## Tool interface

```ts
interface Tool {
  /** Tool name. snake_case. Namespaced when shared in a package: web_fetch, memory_search. */
  name: string;

  /** Human-readable description. Surfaced to the model in the llm template. */
  description: string;

  /**
   * JSON Schema describing the tool's arguments. MUST be an object schema.
   * Both Anthropic and Google accept this shape directly.
   */
  input_schema: JsonSchema;

  /** The tool's implementation. */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

interface ToolContext {
  agentId: string;
  log: (msg: string, data?: unknown) => void;
}
```

## Extensibility model

Cadmus uses an **open tool registry with strong conventions**. Three sources of tools, in order of preference:

1. **Framework-shipped tools** — `@cadmus/tools/memory`, `@cadmus/tools/web`, `@cadmus/tools/calendar`, etc. Canonical names. Frozen interfaces. The boring, well-tested core.
2. **Package-shipped tools** — third-party packages following Cadmus conventions. Namespaced names (`vitals_check`, `myco_search`).
3. **User-defined tools** — declared inline in the user's `AgentConfig.tools`. Free-form names, but the kernel SHOULD warn when a user-defined name collides with a framework or known package tool.

For sharing tools across agents (especially across organizations), the recommended path is **MCP** — see issue #1. MCP tools are discovered at runtime via `mcp_search` / `mcp_list` / `mcp_call` and don't require pre-registration in `AgentConfig`.

The audit boundary is the timeline, not the registry. Every tool invocation produces `tool_call` and `tool_result` events; reviewers can audit any tool's effects without trusting the registry composition.

## Registration

Tools live in [`AgentConfig.tools`](../packages/kernel/src/types.ts#L116) as a `Record<string, Tool>` keyed by name. Processors declare access via the `tools: ["search", "calc"]` field on `Processor`.

```ts
const agent: AgentConfig = {
  agentId: "claudius",
  tools: {
    memory_search: { ... },
    memory_write: { ... },
    memory_delete: { ... },
    search: { name: "search", description: "...", input_schema: {...}, handler: async (args) => {...} },
  },
  processors: [
    { name: "main", template: "llm", filter: ["input"], tools: ["memory_search", "search"], ... },
  ],
};
```

## Naming conventions

- `snake_case`, lowercase.
- **Framework-shipped:** bare names — `memory_search`, `web_fetch`, `calendar_list`.
- **Package-shipped:** namespaced — `vitals_check`, `<package>_<verb>_<noun>`.
- **MCP-discovered:** `mcp_*` — the meta-tools for runtime discovery.
- **Reserved prefixes:**
  - `emit_*` — reserved for the LLM template's synthesized event-emission tools. User code MUST NOT register tools with this prefix.

## LLM-synthesized emit tools

For each entry in a processor's `outputEvents`, the `llm` template auto-creates an `emit_<type>` tool whose handler routes to `ctx.emit(type, args)`. Authors do NOT register `emit_<type>` tools manually.

The synthesis logic ([packages/kernel/src/templates/llm.ts](../packages/kernel/src/templates/llm.ts)):

- If `outputSchema[type]` is an object schema, it's used directly as the synthesized tool's `input_schema`.
- If it's a non-object schema (e.g., a string schema), it's wrapped as `{ type: "object", properties: { data: <schema> }, required: ["data"] }`.

## Tool errors

Tools must NOT throw exceptions for "expected" failure modes (network errors, validation failures, bad input). Instead return:

```ts
{ is_error: true, error_message: "<human-readable message>" }
```

Throwing bubbles up as an `error` event with `source: "processor"` and may abort the processor's tool-use loop. Returning `is_error` lets the model see the error and recover.

## tool_call / tool_result events

The runtime emits these around every tool invocation. See [events-v1.md](events-v1.md). Both events share a `call_id` so paired calls can be reconstructed when tools run in parallel.

## Conformance

A tool is considered conforming if:

- `input_schema` is a JSON Schema object type (`{ type: "object", ... }`).
- `handler` validates `args` against `input_schema` before processing. The kernel does not enforce this in v1 (planned for v1.x); for now, validate inside your handler.
- `name` is unique within the agent's tool registry.
- `name` is `snake_case`.
- `name` does NOT begin with `emit_` (reserved for the LLM template's synthesized tools).

## Conventions

- **Namespace shared tools.** `web_fetch`, `memory_search`, `calendar_list` — not bare `fetch`, `search`, `list`.
- **Pure or idempotent where possible.** Tools that do I/O should be designed so the model can retry safely.
- **Small input surface.** A tool with 12 optional arguments is hard for a model to call correctly. Split it.
- **Document side effects.** If a tool writes to memory or sends a message, say so in the description.

## Deferred / not in v1

- **Per-tool permissions / approval gates.** No notion of "this tool requires user approval." Future work.
- **Versioning of tool inputs.** No `version` field on `input_schema`. If you need to evolve a tool's signature, add a new tool name.
- **Streaming tool results.** Tools return one result; no incremental streaming.
- **Tool registry introspection from the timeline.** Currently you have to know which tools exist; runtime discovery is via `mcp_*` for MCP only.
