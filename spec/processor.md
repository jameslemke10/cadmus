# Processor

A processor is a unit that subscribes to event types via `filter` and emits new events. Vocabulary defined in [glossary.md](glossary.md). Event shapes defined in [events-v1.md](events-v1.md).

## Status

**v1 (draft).** The current kernel implementation in [packages/kernel/src/types.ts](../packages/kernel/src/types.ts) and [runtime.ts](../packages/kernel/src/runtime.ts) matches this spec.

## Processor interface

```ts
interface Processor {
  /** Unique name within the agent. */
  name: string;

  /** Execution model. */
  template: "llm_call" | "llm_loop" | "code";

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
   * synthesize emit_<type> tools for the llm_call template, and (for
   * llm_loop) to decide where the model's final text lands.
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
filter: ["input"]
filter: [{ type: "memory_retrieved", source: "processor:hippocampus" }]
filter: ["input", { type: "pfc_loop", source: "processor:executor" }]
```

**Why prefer source-constrained filters for processor chains:** the runtime auto-emits `tool_call` and `tool_result` events around every `ctx.callTool` invocation. Filtering on `tool_result` alone causes a processor to retrigger on its OWN tool calls. Either filter on a custom Tier 2 event or constrain by source.

## ProcessorContext

What's available to a `code` handler or to the `llm_*` templates at runtime:

```ts
interface ProcessorContext {
  agentId: string;
  processorName: string;
  triggerEvent: CadmusEvent;
  /** Read-only timeline access. */
  timeline: TimelineReader;
  /** Emit a new event onto the timeline. */
  emit: (type: string, data: Record<string, unknown>, opts?: EmitOptions) => Promise<CadmusEvent>;
  /** Invoke a tool by name. The only path to memory and other state-changing operations. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (msg: string, data?: unknown) => void;
}
```

**Architectural rule:** state-changing operations go through tools (`callTool`) or events (`emit`). Reads can be direct via `timeline`. The context does NOT expose memory stores, channel handles, or any other backend directly. Memory access is via the canonical tools `memory_search`, `memory_write`, `memory_delete` ([memory.md](memory.md)).

## Templates

### `code`

A pure TypeScript handler. Direct access to `ctx.emit`, `ctx.callTool`, and the read-only `ctx.timeline`. No LLM involvement.

### `llm_call`

A SINGLE provider turn per processor invocation. The framework synthesizes an `emit_<type>` tool for each entry in `outputEvents`; the model can call those plus its real tools in this turn.

The model does NOT see tool results within the same turn. The runtime auto-emits `tool_call` + `tool_result` events; the next event matching the processor's filter (typically `tool_result`) re-triggers the processor for the next turn.

This is the "loop is made of timeline events" pattern. Every step is observable, branchable, and replayable.

### `llm_loop`

A multi-turn provider session per processor invocation. The model calls tools, the runtime feeds the results back into the SAME provider session, and the model keeps going until it stops calling tools. Then the model's final text is emitted as a text-shaped `outputEvent` (heuristic: an output event whose schema declares `text: string`, else a name-matching `output|message|response`).

`tool_call` and `tool_result` events still appear on the timeline, but the processor invocation does NOT re-fire on `tool_result` — the loop happens inside one provider session.

This is the "Claude-style chat" pattern. Lower latency, fewer events on the timeline; coarser-grained inspection and branching.

`LLMTemplateConfig`:

```ts
interface LLMTemplateConfig {
  model?: string;              // auto-detects provider; e.g. "claude-sonnet-4-6"
  systemPrompt: string;        // required
  apiKey?: string;
  maxTokens?: number;          // default 4096
  contextEvents?: number;      // tail of timeline to include; default 50
  temperature?: number;        // default 0.7
  maxIterations?: number;      // llm_loop only; cap on provider turns per invocation. Default 10.
}
```

Both `llm_call` and `llm_loop` scope the visible timeline window to events at-or-after the most recent `event_boundary` (the boundary itself is included).

## Lifecycle

- **Stateless.** Each processor invocation is independent. There is no `init` / `teardown`.
- **Async fan-out.** When an event matches multiple processors' filters, all run concurrently via `Promise.all`.
- **Persistent state** goes in memory (the store), in tools, or in external storage. Don't keep mutable module-level state in a processor.

## Error semantics

- If a `code` handler or an `llm_*` template throws, the runtime catches the exception and emits an `error` event with `source: "kernel"` and `data.source: "processor"`.
- Other processors triggered by the same event continue to run.
- No automatic retry. Retry logic, if needed, lives inside the processor or in a wrapping processor.
- Tool errors do NOT throw to the caller in `llm_call` (they appear as `tool_result` events with `is_error: true`). For `llm_loop`, tool errors are returned to the provider session as error tool-results so the model can react.

## Conformance

A processor is considered conforming if:

- It declares `outputEvents` accurately. Emitting an undeclared type is a contract violation (warning in v1, error in v2).
- For `llm_*` templates: `templateConfig.systemPrompt` is set.
- For `code` template: `handler` is set.
- `name` is unique within the agent.

## Conventions

- **One processor, one job.** A processor's name should describe what it does (`hippocampus`, `pfc`, `vitals`), not what it is (`llm_processor_1`).
- **Inter-processor flow uses Tier 2 events.** Don't emit `output` from intermediate processors — it routes to channels. Use named events (`pfc_loop`, `working_memory_updated`) for chaining.
- **No direct memory access.** Always go through `ctx.callTool("memory_search" | "memory_write" | "memory_delete", ...)`.

## Deferred / not in v1

- **Init/teardown lifecycle.** Stateless-only is sufficient for v1.
- **Explicit dependencies.** A processor cannot say "wait for X before running." Causality is implicit through event types.
- **Retry / dead-letter strategies.** No framework support; processors implement their own.
- **Hot-reload.** Adding/removing processors requires a runtime restart in v1.
