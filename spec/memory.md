# Memory

A derived index over the timeline. Pluggable backends. Vocabulary defined in [glossary.md](glossary.md).

## Status

**v1 (draft, greenfield).** No `MemoryStore` primitive exists in the kernel yet. The `examples/cadmus` brain pipeline uses ad-hoc memory tools; those will move behind this contract.

## Core insight

The timeline is the source of truth. Memory is an index. If a memory store crashes, you can rebuild it by replaying the `memory_write` and `memory_delete` events from the timeline ([events-v1.md](events-v1.md)). This invariant is what makes memory backends interchangeable.

## Access pattern: tools only

**Processors do not hold a `MemoryStore` reference.** All memory operations go through tools — `memory_search`, `memory_write`, `memory_delete`. The memory backend is invisible to processors.

Why:

- **Single audit trail.** Every memory operation appears as `tool_call` → `tool_result` on the timeline. No hidden direct access.
- **Real backend swappability.** Processors don't bind to the backend interface; only the tool's handler does.
- **Permissions.** A processor's `tools: [...]` declaration becomes the boundary — "this processor can search memory but not delete."
- **Uniform with the LLM template.** The LLM template already calls memory through tools; code processors should match.

Reads (`memory_search`) and writes (`memory_write`, `memory_delete`) both go through tools. The `memory_search` tool's output surfaces on the timeline as a `tool_result` event — there is no separate `memory_recall` event.

## Memory kinds

Three canonical kinds for v1. The `kind` field is an open string — custom kinds are permitted — but the canonical three SHOULD be used when applicable, since portability and tooling depend on them.

| Kind | What it is | Example tags |
|---|---|---|
| `procedural` | Skills, how-to knowledge, learned patterns. Often tied to a tool or MCP server. | `mcp_github`, `tool_calendar_create`, `skill_refund_handling` |
| `semantic` | Facts about self / world / users. Identity facts use `tags: ["identity"]`. | `identity`, `preference`, `fact`, `user_alice` |
| `episodic` | Events, what happened, when. | `session_2026-04-12`, `incident_pricing_q3` |

Tag conventions:

- **Procedural memories tied to a specific tool or MCP server** SHOULD use `tags: ["tool_<name>"]` or `tags: ["mcp_<server>"]`. Lets retrieval target a capability ("show me procedural knowledge for the github MCP").
- **Identity / persona facts** are `kind: "semantic"` with `tags: ["identity"]`. They are not a separate kind.
- Tags are otherwise free-form snake_case.

## MemoryStore interface

```ts
interface MemoryStore {
  /** Search for matching records. Backends without embeddings degrade to full-text or LIKE. */
  search(args: SearchArgs): Promise<SearchHit[]>;

  /** Get one record by id. MUST update last_accessed_at. */
  get(id: string): Promise<MemoryRecord | null>;

  /**
   * Create or update a record. Same id → update; new/missing id → create.
   * Assigns timestamps. MUST emit memory_write before resolving.
   */
  write(input: MemoryWrite): Promise<MemoryRecord>;

  /**
   * Permanently delete records matching the filter. MUST emit memory_delete
   * before resolving. Returns count deleted. Refuses an empty filter.
   */
  delete(filter: MemoryFilter): Promise<number>;

  /** Optional: counts and totals for observability. */
  stats?(): Promise<MemoryStats>;
}

interface MemoryRecord {
  id: string;
  kind: string;                      // canonical: "procedural" | "semantic" | "episodic"; custom allowed
  content: string;
  scope: {
    tenant_id?: string;
    agent_id?: string;
    session_id?: string;
  };
  tags: string[];
  importance: number;                // 0..1
  created_at: string;
  last_accessed_at: string;
  expires_at?: string;
  provenance: {
    source_event_ids: string[];      // which timeline events produced this record
    writer: string;                  // e.g. "tool:memory_write" | "processor:hippocampus"
  };
}

interface MemoryWrite {
  id?: string;                       // optional; same id = update, new/missing = create
  kind: string;                      // required; canonical or custom
  content: string;
  scope?: Partial<MemoryRecord["scope"]>;
  tags?: string[];
  importance?: number;
  expires_at?: string;
  provenance: {                      // required
    source_event_ids: string[];
    writer: string;
  };
}

interface SearchArgs {
  query: string;
  kind?: string;
  scope?: Partial<MemoryRecord["scope"]>;
  tags?: string[];
  limit?: number;                    // default 10
  min_score?: number;                // default 0
}

interface SearchHit extends MemoryRecord {
  score: number;                     // 0..1; backend-defined ranking, normalized
}

interface MemoryFilter {
  ids?: string[];
  kind?: string;
  scope?: Partial<MemoryRecord["scope"]>;
  tags?: string[];
  expired?: boolean;
}

interface MemoryStats {
  count_by_kind: Record<string, number>;
  oldest?: string;
  newest?: string;
  total_bytes?: number;
}
```

## Mandatory contracts

A backend is conforming only if it satisfies all of these:

1. **`write()` MUST emit `memory_write`** before resolving. Without this, the timeline-as-source-of-truth invariant breaks.
2. **`delete()` MUST emit `memory_delete`** before resolving (one event per `delete()` call, even if multiple ids are deleted).
3. **`provenance.source_event_ids` is required on every record.** A memory record MUST trace to one or more timeline events. Backends MUST reject `write()` calls with empty `source_event_ids`.
4. **`scope` is required.** Every record MUST declare scope (even if all fields are absent — the empty object `{}` is the "global" scope). `search()` MUST honor the `scope` filter when provided.
5. **`get()` updates `last_accessed_at`.** Used for backend-internal decay and observability.
6. **IDs are stable and unique within the backend.** Once assigned, an id never refers to a different record. Updates preserve the id.

## Optional capabilities

Backends MAY support these, but are not required to:

- **Vector / embedding search.** Backends without embeddings degrade `search()` to full-text or substring match. `score` is whatever the backend produces, normalized to `0..1`.
- **`stats()`.** If absent, observability tools degrade gracefully.
- **`delete()` with non-id filters.** Some immutable backends may reject filter-based deletes and require explicit ids.

## Portability

Memory records are designed to round-trip across backends. The portable subset of `MemoryRecord` is:

- `id`, `kind`, `content`, `scope`, `tags`, `importance`, `created_at`, `expires_at`, `provenance`.

Backend-specific data (embeddings, internal indexes, `last_accessed_at`) is regenerated on the destination.

### Export format

Memory exports use NDJSON — one JSON record per line. Each line is a `MemoryRecord` minus backend-specific fields.

```ndjson
{"id":"mem_01J...","kind":"procedural","content":"When user asks about pricing, link the doc first.","scope":{"agent_id":"acme-support"},"tags":["skill_pricing"],"importance":0.7,"created_at":"2026-04-12T...","provenance":{"source_event_ids":["evt_abc"],"writer":"processor:hippocampus"}}
{"id":"mem_01J...","kind":"semantic","content":"Alice prefers email over Slack.","scope":{"agent_id":"acme-support"},"tags":["preference","user_alice"],"importance":0.5,"created_at":"...","provenance":{"source_event_ids":["evt_xyz"],"writer":"processor:hippocampus"}}
```

### Import semantics

- Records are written via the destination backend's `write()` (so each import emits `memory_write` events on the destination timeline).
- IDs MAY be preserved or reassigned at the destination's discretion. Conformance does NOT require id preservation.
- Embeddings are regenerated on the destination using its embedding model.
- Provenance source event ids may not resolve on the destination's timeline; that's expected. The provenance is preserved as informational.

### Importing from MCP / external sources

Procedural memory imported from an MCP server SHOULD use `tags: ["mcp_<server>"]`. The `writer` field in `provenance` SHOULD be `"mcp:<server>"`. This convention lets you re-import or refresh skills from an MCP without losing track of where they came from.

## Reference implementation (planned)

`@cadmus/memory/sqlite` — SQLite + FTS5 for full-text, optional `sqlite-vec` for embeddings. All mandatory contracts. No external dependencies beyond `better-sqlite3`.

Future backends (separate packages):

- `@cadmus/memory/json` — file-based, no embeddings, dev/tiny use only.
- `@cadmus/memory/postgres` — pgvector + tsvector for production / multi-tenant.

## Conformance

A `MemoryStore` is conforming if it passes the `assertMemoryStoreConforms(store)` test suite (planned; see [README.md](README.md)). The suite verifies:

- `write()` assigns id (if missing), timestamps, and emits `memory_write`.
- `write()` rejects records without `provenance.source_event_ids`.
- `write()` with same id updates rather than creates.
- `delete()` deletes matching records, emits `memory_delete`, and the records no longer appear in `search` / `get`.
- `get()` updates `last_accessed_at`.
- `search()` honors `scope`, `kind`, and `tags` filters.
- Replaying `memory_write` and `memory_delete` events into a fresh store produces an equivalent visible state (rebuildability).

## Conventions

- **Always go through tools.** `memory_search`, `memory_write`, `memory_delete` are the tool names. Processors do not access the backend directly.
- **Importance lives at write time.** The processor writing the memory decides importance based on context. Backends use it for ranking and decay; they don't try to infer it.
- **One write per source event when reasonable.** Don't bundle five conceptual memories into one `write()` call to save round-trips. The timeline becomes harder to audit.
- **Use canonical kinds when applicable.** Custom kinds are allowed but break portability with tools that expect canonical values.

## Deferred / not in v1

- **Multi-backend router.** Compose multiple stores under one tool surface (markdown for `procedural`, sqlite-vec for `episodic`). Defer until two backends exist and the need is concrete.
- **Capability flags / introspection.** `store.capabilities.has("vector_search")` for runtime checks. Defer until tools need to branch on capability.
- **Cross-agent shared memory.** Scope `{ tenant_id }` allows it conceptually; no enforcement story yet.
- **Compaction / summarization.** A backend that auto-summarizes on session end. Belongs in a processor, not the store.
- **`memory_recall` event** for non-tool recall paths. Searches/gets through tools surface as `tool_call` / `tool_result`. If a direct recall path with replay implications emerges later, name it `memory_recall`.
