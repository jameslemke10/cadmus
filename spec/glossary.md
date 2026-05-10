# Cadmus Glossary

This document locks the vocabulary used across Cadmus. When in doubt about what to call something, this is the source of truth. Other specs in this directory reference these terms as defined here.

## Core terms

**Agent** — a runnable Cadmus configuration: timeline + processors + tools + channels + memory. One agent per process.

**Timeline** — append-only log of typed events backed by SQLite (WAL mode). The single source of truth for everything that has happened in an agent.

**Event** — an immutable record on the timeline. Has an envelope (universal metadata) and a payload (`data`). The TypeScript type is `CadmusEvent` (the `Cadmus` prefix avoids shadowing the DOM `Event` global).

**Envelope** — universal metadata on every event: `id`, `seq`, `timestamp`, `type`, `agent_id`, `session_id`, `parent_event_id`, `tags`.

**Payload** — the `data` field of an event. Shape depends on event type.

**Processor** — a unit that subscribes to event types via `filter` and emits new events. Two flavors: `llm` (calls a model, can use tools) and `code` (a TypeScript handler).

**Tool** — a JSON-Schema'd function any processor can declare access to. Has `name`, `description`, `input_schema`, and `handler`.

**Channel** — a bridge between an external system (CLI, Studio, Slack, voice, HTTP) and the timeline. Channels emit `input` events from external sources and route `output` events back out.

**Memory** — a derived index over the timeline. Three canonical kinds (`procedural`, `semantic`, `episodic`); custom kinds allowed. Pluggable backends (SQLite, Postgres, vector DBs). Memory writes always emit `memory_write` events so the store is rebuildable from the log. Processors access memory through tools, never directly.

**Provider** — an LLM provider adapter (Anthropic, Google, OpenAI, Ollama, etc.). Implements a uniform `send()` interface.

**Template** — `llm` or `code`. The execution model a processor uses. The `llm` template handles tool-use loops and synthesizes `emit_<type>` tools.

**Session** — a logical conversation/run scope. Identified by `session_id` in the envelope. Used for context windowing and memory scoping. **v1 note:** treated as an opaque grouping key; lifecycle, multi-tenant scoping, and concurrency semantics are deferred to a future `spec/session.md`. Don't build production hosting on v1's session model — see [events-v1.md](events-v1.md#session-semantics--minimal-in-v1).

**Conformance test** — an importable test suite that verifies a third-party implementation (provider, channel, memory backend) satisfies the spec it claims to.

## Event tiers

Every event on the timeline falls into one of two tiers:

**Tier 1 — Standard library.** Framework-blessed events with locked shape. Anyone (kernel, processors, tools, channels, memory backends) may emit them; the shape is frozen so implementations across the ecosystem interoperate. Nine events: `input`, `output`, `error`, `tool_call`, `tool_result`, `memory_write`, `memory_delete`, `session_start`, `session_end`.

**Tier 2 — User-defined.** Anything else. Shape is up to the author. Naming convention applies. The brain example's `pfc_response`, `working_memory_updated`, etc. are Tier 2.

Per-event guidance (e.g. "the kernel emits `error` with `source: \"processor\"` when a handler throws") is documented in [events-v1.md](events-v1.md) per event, not as a tier-level rule.

## Naming rules

### Event types

- `snake_case`, lowercase only.
- **Present tense / noun form** preferred: `tool_call`, `memory_write`, `session_start`. Reads like the operation it represents and matches function-call vocabulary.
- Bare nouns are fine when the meaning is direct: `input`, `output`, `error`.
- Tier 2 events that ship in a shared package SHOULD be namespaced: `vitals_warning`, `scheduler_fired`.
- Don't shadow Tier 1 type names.

### TypeScript type names

- Drop `*Definition` suffix when there is no `*Instance` counterpart. Prefer `Processor` over `ProcessorDefinition`, `Tool` over `ToolDefinition`.
- Drop `Cadmus*` prefix unless the type shadows a host-environment global. `CadmusEvent` keeps the prefix because the DOM `Event` is a global; everything else drops it.
- Keep semantic suffixes that disambiguate: `TimelineReader` (read-only view), `ProcessorContext`, `AgentConfig`.

### Open enums

Several fields (`kind` on memory records, `kind` and `channel` on input/output payloads, `source` on error payloads) are open strings — typed as `string`, with canonical values documented in the relevant spec. Custom values are allowed but should follow snake_case.

## Status

This glossary is v1. Adding terms is non-breaking. Renaming or removing a term requires a spec bump and a migration note.
