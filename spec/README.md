# Cadmus specs

Source-of-truth specs for Cadmus's core abstractions. When the docs disagree with the code, the spec is what the code should look like; raise an issue or PR.

| Spec | What it covers |
|---|---|
| [glossary.md](glossary.md) | Vocabulary, event tiers, naming rules. Read first. |
| [events-v1.md](events-v1.md) | Event envelope, all 9 locked event types, Tier 2 rules, versioning. |
| [timeline.md](timeline.md) | `TimelineStore` interface, durability and ordering guarantees, SQLite reference. |
| [processor.md](processor.md) | `Processor` interface, lifecycle, error semantics, conformance. |
| [tool.md](tool.md) | `Tool` interface, registration, extensibility model, synthesized `emit_<type>` tools. |
| [channel.md](channel.md) | `Channel` interface, reserved names, conformance. |
| [memory.md](memory.md) | `MemoryStore` interface, three canonical kinds, portability, mandatory contracts. |

## How the specs relate

```
glossary  ───►  vocabulary used by every other spec
   │
   ▼
events-v1  ───►  envelope + 9 stable types
   │              │
   │              ├──►  timeline   (stores them)
   │              ├──►  processor  (filters and emits them)
   │              ├──►  tool       (called by processors)
   │              ├──►  channel    (emits input, routes output)
   │              └──►  memory     (emits memory_write / memory_delete)
```

## Two-tier event model

- **Tier 1 — Standard library.** 9 framework-blessed events with locked shape: `input`, `output`, `error`, `tool_call`, `tool_result`, `memory_write`, `memory_delete`, `session_start`, `session_end`. Anyone may emit them; the shape is frozen for interop.
- **Tier 2 — User-defined.** Anything else. Naming convention applies; shape is yours.

## Status

All specs are **v1 (draft)**. Stable enough to build against; small fixes via PR welcome before the v1 freeze.

## Conformance

Each spec defines what makes an implementation "conforming." The kernel will ship `assertXConforms()` test harnesses for each primitive (timeline, processor, tool, channel, memory) — these are planned alongside the code PR that follows the spec PR. Third-party packages should run the harness in their own test suite.

## Versioning

The specs follow semver:

- **v1.x** — additive changes only. New optional fields, new events, new optional capabilities.
- **v2.0** — breaking changes. Renames, removed fields, type changes.

The current spec version is encoded in:

- The SQLite timeline's `pragma user_version`.
- The package versions of `@cadmus/kernel` and conforming packages.

## Contributing

Adding to the specs:

- Vocabulary additions to [glossary.md](glossary.md): non-breaking, can land standalone.
- New Tier 1 events: must satisfy the "earns its place" test (does a second independent implementation want to emit or react to this?).
- New primitive specs (e.g., `provider.md`, `bundle.md`): start a discussion issue first.

Implementations:

- New providers, channels, memory backends: open a PR against the relevant package, link the spec section your implementation conforms to, run `assertXConforms()` in tests.
