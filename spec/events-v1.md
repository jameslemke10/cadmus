# Events v1

This spec defines the event envelope, the locked event types, and naming rules for user-defined events. Vocabulary is defined in [glossary.md](glossary.md).

## Status

**v1 (draft).** Tier 1 event shapes are stable for v1.x. Adding new Tier 1 events is non-breaking. Changing a payload shape requires a major version bump.

## The envelope

Every event has the same envelope:

```ts
interface CadmusEvent {
  id: string;                      // unique event id; assigned on append
  seq: number;                     // monotonically increasing per-timeline; assigned on append
  timestamp: string;               // ISO 8601
  type: string;                    // event type
  agent_id: string;                // which agent owns this event
  source: string | null;           // attribution — who emitted this event (auto-set by runtime)
  tags: string[];                  // searchable labels
  data: Record<string, unknown>;   // payload; shape depends on type
}
```

Notes:

- `id` and `seq` are assigned by the kernel at append time. Callers must not set them.
- The v1 envelope is intentionally minimal. Causal threading and session/run scoping are not envelope fields — they belong in `data` for the events that need them, or in higher-level constructs (a `conversation` event, a `correlation_id` field) that future specs may bless.

### Source attribution

`source` answers "who emitted this event." The runtime sets it automatically; you almost never specify it directly.

| Emitter | source value |
| --- | --- |
| Processor's `ctx.emit` | `processor:<name>` (e.g., `processor:hippocampus`) |
| Tool handler's `ctx.emit` | `tool:<name>` (e.g., `tool:memory_write`) |
| Runtime auto-emits around `ctx.callTool` (`tool_call`, `tool_result`) | `processor:<calling-proc>` |
| Channel's `ctx.emit` | `channel:<name>` (e.g., `channel:cli`) |
| `runtime.inject(text, channel)` | `channel:<channel>` |
| Kernel's processor-error catcher | `kernel` |
| External code (tests, raw `runtime.appendEvent` with no source) | `null` |

Source is a string, not a structured object — convention-driven, not enforced. Implementations that don't follow the convention still work; downstream consumers that filter on source just won't match.

The primary use of source is in **filter constraints** — see [processor.md](processor.md) for the `{ type, source }` filter form. It lets you say "I want `memory_retrieved` events but only from the hippocampus processor" so adding a second hippocampus later doesn't break downstream wiring.

## Tier 1 — Standard library (locked shape)

Anyone may emit these (kernel, processors, tools, channels, memory backends). Shape is frozen so consumers across the ecosystem interoperate.

### `input`

External traffic arriving at the agent boundary. Emitted by channels (CLI, Studio, etc.) when their external system delivers something, or by `POST /api/inject`.

```ts
{
  type: "input",
  data: {
    channel: string;       // origin channel; e.g. "cli" | "studio"
    kind: string;          // payload variant; canonical values listed below
    text?: string;         // present when kind = "text"
  }
}
```

Canonical `kind` values for v1: `"text"`. Custom kinds are permitted; channels SHOULD prefer canonical kinds when applicable.

### `output`

Something destined for an external channel. Emitted by the **terminal** processor in a chain. Channels listen for `output` events and route based on `data.channel` (or "*" for broadcast).

```ts
{
  type: "output",
  data: {
    channel: string;       // target channel; or "*" for broadcast
    kind: string;
    text?: string;
  }
}
```

Convention: only the terminal processor in a chain should emit `output`. Inter-processor communication uses Tier 2 events.

### `error`

Something went wrong somewhere in the system. `source` field discriminates.

```ts
{
  type: "error",
  data: {
    source: string;             // "processor" | "channel" | "memory" | "tool" | "kernel" | etc.
    name?: string;
    message: string;
    stack?: string;
    triggering_event_id?: string;
  }
}
```

Tools have their own per-call failure mode via `is_error: true` inside `tool_result` — that's tool-protocol, used by the model to decide whether to retry. Use `error` events for genuine system-level failures.

### `tool_call`

A tool was invoked. Emitted by the runtime around every `ctx.callTool()`.

```ts
{
  type: "tool_call",
  data: {
    tool: string;
    args: Record<string, unknown>;
    call_id: string;                    // unique per call; pairs with tool_result
  }
}
```

### `tool_result`

A tool returned. Pairs with `tool_call` via `call_id`.

```ts
{
  type: "tool_result",
  data: {
    tool: string;
    call_id: string;
    result: unknown;
    is_error?: boolean;
    error_message?: string;
  }
}
```

### `memory_write`

A memory record was created or updated. **Mandatory for replay.**

```ts
{
  type: "memory_write",
  data: {
    memory_id: string;
    kind: string;                       // canonical: "procedural" | "semantic" | "episodic"; custom allowed
    content: string;
    scope: {
      tenant_id?: string;
      agent_id?: string;
    };
    tags?: string[];
    importance?: number;                // 0..1
    expires_at?: string;
    provenance: {
      source_event_ids: string[];
      writer: string;
    };
  }
}
```

### `memory_delete`

A memory record was permanently deleted.

```ts
{
  type: "memory_delete",
  data: {
    memory_ids: string[];
    reason?: string;
  }
}
```

### `event_boundary`

A divider in the stream. The LLM templates scope their context window to events at-or-after the most recent `event_boundary`. Used for "new conversation" / forget-prior semantics.

```ts
{
  type: "event_boundary",
  data: {
    type?: string;                      // free-form: "conversation" | "topic" | etc.
  }
}
```

## Tier 2 — User-defined

Anything else. The framework does not bless or enforce shape, but does enforce naming.

Naming rules:

- `snake_case`, lowercase only.
- Present tense / noun form: `query_complete`, `plan_draft`.
- Namespace events that ship in shared packages: `vitals_warning`, `scheduler_fired`.
- Do not shadow Tier 1 type names.

## Versioning

- **v1.x** — adding new Tier 1 events is non-breaking. Adding optional fields to existing payloads is non-breaking.
- **v2.0** — required for: removing or renaming events, changing required field types, removing required fields.

## Deferred / not in v1

- **Causal threading** (parent_event_id, correlation ids). The v1 envelope omits this; if and when it lands, it'll be in `data` for the specific event types that need it, or as a higher-level construct.
- **Session / run semantics** (session_id, lifecycle, scoping). The v1 envelope omits this. Future `spec/session.md` may add a session model.
- `usage_recorded` — depends on the vitals processor design.
- `processor_start` / `processor_stop` — lifecycle events. Lock when a use case demands them.
