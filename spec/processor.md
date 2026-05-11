# Processor

A processor is a unit that subscribes to event types via `filter` and emits new events. Vocabulary defined in [glossary.md](glossary.md). Event shapes defined in [events-v1.md](events-v1.md).

## Status

**v1 (draft).** The current kernel implementation in [packages/kernel/src/types.ts:89-110](../packages/kernel/src/types.ts#L89-L110) and [runtime.ts](../packages/kernel/src/runtime.ts) matches most of this spec. The TypeScript type currently named `ProcessorDefinition` is renamed to `Processor` per [glossary.md](glossary.md) naming rules — that rename happens in the same PR as this spec.

## Processor interface

```ts
interface Processor {
  /** Unique name within the agent. */
  name: string;

  /** Execution model. */
  template: "llm" | "code";

  /**
   * Events that trigger this processor. Each entry is either:
   *   - a bare event-type string ("input")
   *   - a {type, source?} object that also constrains by attribution
   *     ({ type: "memory_retrieved", source: "processor:hippocampus" })
   * The two forms can be mixed in the same filter list.
   */
  filter: FilterEntry[];   // FilterEntry = string | { type: string; source?: string }

  /** Tool names this processor has access to (resolved from the agent's tool registry). */
  tools?: string[];

  /**
   * Event types this processor may emit. The framework uses this to
   * synthesize emit_<type> tools for the llm template, and to validate
   * conformance: emitting an undeclared type is a contract violation.
   */
  outputEvents?: string[];

  /** Optional per-event-type input JSON Schemas. Used for documentation and validation. */
  inputSchema?: Record<string, JsonSchema>;

  /** Optional per-event-type output JSON Schemas. */
  outputSchema?: Record<string, JsonSchema>;

  /** Config for the chosen template. */
  templateConfig?: LLMTemplateConfig;

  /** Handler for the `code` template. Required when template = "code". */
  handler?: (event: CadmusEvent, ctx: ProcessorContext) => Promise<void>;

  /** Free-form per-instance config the handler/template can read. */
  config?: Record<string, unknown>;
}
```

## Filter syntax

Filters match by event type and optionally by event source (attribution).

```ts
type FilterEntry = string | { type: string; source?: string };
```

Examples:

```ts
// Match every event of type "input" (any source).
filter: ["input"]

// Match memory_retrieved events ONLY when emitted by the hippocampus processor.
// Lets you add a second hippocampus (hippocampus_pii, hippocampus_general)
// without retriggering downstream stages on the wrong one.
filter: [{ type: "memory_retrieved", source: "processor:hippocampus" }]

// Mixed: trigger on any user input, plus pfc_loop events emitted by the executor.
filter: ["input", { type: "pfc_loop", source: "processor:executor" }]
```

**Why prefer source-constrained filters for processor chains:** the runtime auto-emits `tool_call` and `tool_result` events around every `ctx.callTool` invocation. Filtering on `tool_result` alone causes a processor to retrigger on its OWN tool calls (e.g., a hippocampus that calls `memory_search` would loop). Either filter on a custom Tier 2 event (`pfc_loop`, `working_memory_updated`) or constrain by source.

## ProcessorContext

What's available to a `code` handler or to the `llm` template at runtime:

```ts
interface ProcessorContext {
  agentId: string;
  processorName: string;
  triggerEvent: CadmusEvent;
  /** Read-only timeline access. */
  timeline: TimelineReader;
  /** Emit a new event onto the timeline. parent_event_id defaults to triggerEvent.id. */
  emit: (type: string, data: Record<string, unknown>, opts?: EmitOptions) => Promise<CadmusEvent>;
  /** Invoke a tool by name. The only path to memory and other state-changing operations. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (msg: string, data?: unknown) => void;
}
```

**Architectural rule:** state-changing operations go through tools (`callTool`) or events (`emit`). Reads can be direct via `timeline`. The context does NOT expose memory stores, channel handles, or any other backend directly. Memory access is via the canonical tools `memory_search`, `memory_write`, `memory_delete` ([memory.md](memory.md)).

This makes:

- The audit trail uniform — every memory operation appears as `tool_call` → `tool_result` on the timeline.
- Backends actually swappable — processors don't bind to backend interfaces.
- Permissions enforceable — a processor's `tools: [...]` declaration is the boundary.

## Templates

### `code`

A pure TypeScript handler. Direct access to `ctx.emit`, `ctx.callTool`, and the read-only `ctx.timeline`. No LLM involvement.

### `llm`

The framework runs a tool-use loop against the configured model. For each entry in `outputEvents`, the template synthesizes an `emit_<type>` tool the model can call. See [tool.md](tool.md) for synthesis details.

`LLMTemplateConfig` (from [types.ts:60-87](../packages/kernel/src/types.ts#L60-L87)):

```ts
interface LLMTemplateConfig {
  model?: string;              // auto-detects provider; e.g. "claude-sonnet-4-6"
  systemPrompt: string;        // required
  apiKey?: string;
  maxTokens?: number;          // default 4096
  maxIterations?: number;      // default 5
  contextEvents?: number;      // tail of timeline to include; default 30
  temperature?: number;        // default 0.7
  sessionEvents?: string[];    // boundary types; only events at-or-after the most recent are included
}
```

## Lifecycle

- **Stateless.** Each processor invocation is independent. There is no `init` / `teardown`.
- **Async fan-out.** When an event matches multiple processors' filters, all run concurrently via `Promise.all`.
- **Persistent state** goes in memory (the store), in tools, or in external storage. Don't keep mutable module-level state in a processor.

## Error semantics

- If a `code` handler or `llm` template throws, the runtime catches the exception and emits an `error` event with `source: "processor"` ([events-v1.md](events-v1.md#error)).
- Other processors triggered by the same event continue to run.
- No automatic retry. Retry logic, if needed, lives inside the processor or in a wrapping processor.
- Tool errors do NOT throw — tools return `{ is_error: true, error_message }` ([tool.md](tool.md)).

## Conformance

A processor is considered conforming if:

- It declares `outputEvents` accurately. Emitting an undeclared type is a contract violation (warning in v1, error in v2).
- For `llm` template: `templateConfig.systemPrompt` is set.
- For `code` template: `handler` is set.
- `inputSchema`, when declared, validates the trigger event's `data` against the schema. The kernel does not enforce this in v1; planned for v1.x.
- `name` is unique within the agent.

## Conventions

- **One processor, one job.** A processor's name should describe what it does (`hippocampus`, `executor`, `vitals`), not what it is (`llm_processor_1`).
- **Inter-processor flow uses Tier 2 events.** Don't emit `output` from intermediate processors — it routes to channels. Use named events (`pfc_response`, `query_complete`) for chaining.
- **Processors that do I/O should declare narrow filters.** A processor that filters `["*"]` is almost always wrong.
- **No direct memory access.** Always go through `ctx.callTool("memory_search" | "memory_write" | "memory_delete", ...)`.

## Deferred / not in v1

- **Init/teardown lifecycle.** Stateless-only is sufficient for v1.
- **Explicit dependencies.** A processor cannot say "wait for X before running." Causality is implicit through event types.
- **Retry / dead-letter strategies.** No framework support; processors implement their own.
- **Hot-reload.** Adding/removing processors requires a runtime restart in v1.
