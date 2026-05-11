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
  session_id?: string;             // logical conversation/run scope
  source: string | null;           // attribution — who emitted this event (auto-set by runtime)
  parent_event_id?: string;        // causal link to a prior event
  tags: string[];                  // searchable labels
  data: Record<string, unknown>;   // payload; shape depends on type
}
```

Notes:

- `id` and `seq` are assigned by the kernel at append time. Callers must not set them.
- `session_id` is optional but recommended; many memory and channel features key on it. The runtime can default it from the triggering event's session.
- `parent_event_id` is the primary mechanism for causal traceability. Set it when emitting an event in response to another event.

### Source attribution

`source` answers "who emitted this event." The runtime sets it automatically; you almost never specify it directly.

| Emitter | source value |
| --- | --- |
| Processor's `ctx.emit` | `processor:<name>` (e.g., `processor:hippocampus`) |
| Tool handler's `ctx.emit` | `tool:<name>` (e.g., `tool:memory_write`) |
| Runtime auto-emits around `ctx.callTool` (`tool_call`, `tool_result`) | `processor:<calling-proc>` |
| Channel's `ctx.emit` | `channel:<name>` (e.g., `channel:cli`) |
| `runtime.inject(text, channel)` | `channel:<channel>` |
| Kernel's `processor_error` catcher | `kernel` |
| External code (tests, raw `runtime.appendEvent` with no source) | `null` |

Source is a string, not a structured object — convention-driven, not enforced. Implementations that don't follow the convention (e.g., a custom processor that emits with `source: "weirdo"`) still work; downstream consumers that filter on source just won't match.

The primary use of source is in **filter constraints** — see [processor.md](processor.md) for the `{ type, source }` filter form. It lets you say "I want `memory_retrieved` events but only from the hippocampus processor" so adding a second hippocampus later doesn't break downstream wiring.

## Session semantics — minimal in v1

`session_id` is treated as an opaque grouping key in v1. Used for context windowing and memory scoping.

The full design — lifecycle (who creates, who ends), multi-tenant scoping (interaction with `tenant_id`), concurrency (can one user have multiple in-flight sessions?), channel mapping (is a Telegram chat one session or many?) — is deferred to a future `spec/session.md`. The field is forward-compatible on the envelope; the semantics aren't locked.

**Don't build production hosting on v1's session model.** It's enough for single-user local agents and demos. Parallelization, multi-tenant cloud hosting, and concurrent-session orchestration need the deferred design first.

## Tier 1 — Standard library (9 events, locked shape)

Anyone may emit these (kernel, processors, tools, channels, memory backends). Shape is frozen so consumers across the ecosystem interoperate. Per-event guidance about who SHOULD emit a given event is noted inline.

### `input`

External traffic arriving at the agent boundary. Emitted by channels (CLI, Studio, Slack, etc.) when their external system delivers something, or by `POST /api/inject`.

```ts
{
  type: "input",
  data: {
    channel: string;       // origin channel; e.g. "cli" | "studio" | "telegram"
    kind: string;          // payload variant; canonical values listed below
    text?: string;         // present when kind = "text"
    // kind-specific fields go here
  }
}
```

Canonical `kind` values for v1:

- `"text"` — plain text input. `data.text` carries the message.

Custom `kind` values are permitted; channels SHOULD prefer canonical kinds when applicable. Future v1.x is expected to add `"voice"`, `"file"`, `"image"`.

### `output`

Something destined for an external channel. Emitted by the **terminal** processor in a chain. Channels listen for `output` events and route based on `channel` and `kind`.

```ts
{
  type: "output",
  data: {
    channel: string;       // target channel; or "*" for broadcast
    kind: string;          // payload variant; canonical values listed below
    text?: string;         // present when kind = "text"
  }
}
```

Canonical `kind` values for v1:

- `"text"` — plain text response.

Convention: only the terminal processor in a chain should emit `output`. Inter-processor communication uses Tier 2 events. If multiple processors emit `output` for the same logical response, channels will route all of them.

### `error`

Something went wrong somewhere in the system. Generic across components — processors throwing, channels failing to connect, memory backends hitting disk errors, tools encountering unrecoverable conditions. The `source` field discriminates.

```ts
{
  type: "error",
  data: {
    source: string;             // "processor" | "channel" | "memory" | "tool" | "kernel" | etc.
    name?: string;              // name of the source instance (e.g. "hippocampus", "telegram")
    message: string;
    stack?: string;
    triggering_event_id?: string;
  }
}
```

The kernel emits `error` with `source: "processor"` when a processor's handler throws. Channels emit `error` with `source: "channel"` when they hit unrecoverable conditions. Memory backends, custom code, and other components do the same with their own `source` values.

Note: tools have their own per-call failure mode via `is_error: true` inside `tool_result` ([tool.md](tool.md)) — that's tool-protocol, used by the model to decide whether to retry. Use `error` events for genuine system-level failures, not for routine tool errors.

### `tool_call`

A tool was invoked. Emitted by the runtime around every tool invocation (whether triggered by the LLM template's tool-use loop or a direct `ctx.callTool()` from a code processor).

```ts
{
  type: "tool_call",
  data: {
    tool: string;                       // tool name
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
    result: unknown;                    // tool's return value
    is_error?: boolean;
    error_message?: string;
  }
}
```

### `memory_write`

A memory record was created or updated. Emitted by the memory backend on every write (same `id` = update; new/missing `id` = create). **Mandatory for replay.** Replaying `memory_write` and `memory_delete` events into a fresh store reconstructs it.

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
      session_id?: string;
    };
    tags?: string[];
    importance?: number;                // 0..1
    expires_at?: string;                // ISO 8601, optional
    provenance: {
      source_event_ids: string[];       // which timeline events produced this record
      writer: string;                   // e.g. "tool:memory_write" | "processor:hippocampus"
    };
  }
}
```

### `memory_delete`

A memory record was permanently deleted. Emitted by the memory backend on every successful `forget()` call (one event per call, even if multiple ids are deleted).

```ts
{
  type: "memory_delete",
  data: {
    memory_ids: string[];               // ids of records deleted
    reason?: string;                    // "user_request" | "expired" | "scope_purge" | etc.
  }
}
```

### `session_start`

A new logical session began. Emitted by anyone managing sessions (typically a session manager processor or the runtime). The new session's id appears on both the envelope (`session_id`) and the payload.

```ts
{
  type: "session_start",
  data: {
    session_id: string;
    started_by?: string;                // "user" | "scheduler" | "system" | ...
  }
}
```

See "Session semantics — minimal in v1" above for the v1 caveat.

### `session_end`

A session ended.

```ts
{
  type: "session_end",
  data: {
    session_id: string;
    reason?: string;                    // "timeout" | "explicit" | "error" | ...
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

Payload guidance:

- Use a clear, JSON-Schemable shape.
- Set `parent_event_id` when emitting in response to another event.
- Document your event types in your processor or package README.

## Versioning

The spec follows semver:

- **v1.x** — adding new Tier 1 events is non-breaking. Adding optional fields to existing payloads is non-breaking.
- **v2.0** — required for: removing or renaming events, changing required field types, removing required fields.

Per-payload versioning: if a payload shape needs to evolve mid-version, add a `version: number` field to `data` and document the migration.

## Deferred / not in v1

Considered and intentionally deferred:

- **Full session semantics** — see "Session semantics — minimal in v1" above. Lifecycle, scoping, concurrency to be designed in `spec/session.md`.
- `conversation_compacted` — only one current example uses it; shape will evolve when memory compaction lands. Treat as Tier 2 for now.
- `usage_recorded` — depends on the vitals processor design (issue #7). Lock when that processor lands.
- `processor_start` / `processor_stop` — lifecycle events. Lock when a use case demands them.
- `memory_recall` event — searches and gets are read-only and surface via `tool_call` / `tool_result`. If a non-tool recall path with replay implications emerges, name it `memory_recall`.
- Channel-typed events (`channel_inbound` / `channel_outbound`) — rejected. Direction is encoded in the type (`input` vs `output`); origin/destination is in the payload (`data.channel`).
- `kind` as an envelope-level field — rejected. `kind` is a payload-level discriminator on `input`, `output`, and memory records.
- `channel` as an envelope-level field — rejected for v1. May be revisited in v2 if cross-event channel propagation becomes valuable.

## Migration from pre-v1

The pre-v1 codebase used `user_input`, `agent_message`, and `error`. v1 renames and reshapes:

| Pre-v1 type      | v1 type            | Notes                                                                        |
| ---------------- | ------------------ | ---------------------------------------------------------------------------- |
| `user_input`     | `input`            | Payload: `{ text }` → `{ channel, kind: "text", text }`                      |
| `agent_message`  | `output`           | Payload: `{ text }` → `{ channel, kind: "text", text }`                      |
| `error`          | `error`            | Payload generalized: gains `source` discriminator, `name`, `triggering_event_id` |

Both bundled examples (`examples/cadmus`, `examples/claudius`) require updates in the same PR that lands the kernel rename.
