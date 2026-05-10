# Timeline

The append-only log of typed events. The single source of truth for everything that has happened in an agent. Vocabulary defined in [glossary.md](glossary.md). Event shapes defined in [events-v1.md](events-v1.md).

## Status

**v1 (draft).** The current kernel timeline ([packages/kernel/src/timeline.ts](../packages/kernel/src/timeline.ts)) implements most of this contract; gaps are flagged inline.

## TimelineStore interface

```ts
interface TimelineStore extends TimelineReader {
  /** Append an event. id, seq, and timestamp are assigned by the store. Resolves with the persisted event. */
  append(input: AppendInput): Promise<CadmusEvent>;

  /** Subscribe to all newly-appended events. Listeners fire after persistence. Returns an unsubscribe function. */
  subscribe(listener: (event: CadmusEvent) => void): () => void;

  /** Read events with seq > the given seq. Used for SSE catch-up. */
  since(seq: number): CadmusEvent[];

  /** Permanently delete events matching the filter. Returns count deleted. */
  forget(filter: TimelineFilter): Promise<number>;
}

interface TimelineReader {
  recent(limit: number, filter?: TimelineFilter): CadmusEvent[];
  byId(id: string): CadmusEvent | null;
  latest(type: string): CadmusEvent | null;
  all(filter?: TimelineFilter): CadmusEvent[];
  count(): number;
}

interface TimelineFilter {
  types?: string[];
  agentId?: string;
  sessionId?: string;
}

interface AppendInput {
  type: string;
  agent_id: string;
  data: Record<string, unknown>;
  session_id?: string;
  parent_event_id?: string | null;
  tags?: string[];
}
```

## Guarantees

- **Durability.** `append()` resolves only after the event is persisted to disk.
- **Ordering.** `seq` is monotonically increasing per timeline. Events with lower `seq` are causally-or-temporally-earlier.
- **Immutability.** Events are immutable once appended. `forget()` is the only legitimate path to remove an event.
- **Subscribe ordering.** Listeners fire in `seq` order. A listener may miss events from before subscription; use `since(seq)` to catch up.

## Reference implementation: SQLite

Default backend. SQLite in WAL mode: single file, ACID, portable, no daemon. See [packages/kernel/src/timeline.ts](../packages/kernel/src/timeline.ts).

Schema requirements:

- `pragma user_version` set to the spec version (currently `1`). Used for migrations.
- Events table columns match the envelope: `id`, `seq`, `timestamp`, `type`, `agent_id`, `session_id`, `parent_event_id`, `tags` (JSON), `data` (JSON).
- Indexes: `(type)`, `(agent_id)`, `(session_id)`, `(parent_event_id)`, `(timestamp)`. The `session_id` index is new in v1 — current kernel does not have it; the migration adds it.

## Pluggable backends

Anything implementing `TimelineStore` is a valid backend. Likely candidates:

- **Postgres** — for hosted/multi-tenant. Same schema, indexes via SQL.
- **DuckDB** — for analytics-heavy workloads.
- **IndexedDB** — for in-browser agents.
- **Litestream-replicated SQLite** — for HA without a Postgres dependency.

The kernel does not ship these; they live in separate `@cadmus/timeline-*` packages.

## Conformance

A `TimelineStore` implementation is considered conforming if it passes the `assertTimelineConforms(store)` test suite. The suite verifies (at minimum):

- `append()` is durable across process restart.
- `seq` is monotonically increasing.
- `subscribe()` fires listeners in `seq` order, after persistence.
- `since(seq)` returns the correct slice.
- `byId()` returns the appended event byte-for-byte.
- `forget()` deletes matching events and decrements `count()`.

Some backends may be append-only (no `forget`). Such backends MUST throw a clear error from `forget()` rather than silently no-op.

## Deferred / not in v1

- **Forking / branching timelines.** The envelope's `parent_event_id` allows DAG traversal in principle, but no first-class fork API exists yet.
- **Compaction policy.** Per-session retention, archival on `session_ended`, prune-with-receipt — all deferred. Compaction is a processor concern, not a store concern.
- **Cross-event channel propagation.** A query like "all events for Slack traffic" would need `channel` propagated from `input_received` through the causal chain. Deferred to v2.
