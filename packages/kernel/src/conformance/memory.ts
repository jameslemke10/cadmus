/**
 * Conformance test harness for MemoryStore.
 *
 * Usage:
 *   import { assertMemoryStoreConforms } from "@cadmus/kernel/conformance";
 *   import { createSqliteMemoryStore } from "@cadmus/tools/memory";
 *
 *   test("SQLite memory store conforms", async () => {
 *     await assertMemoryStoreConforms(() =>
 *       createSqliteMemoryStore({ path: ":memory:" })
 *     );
 *   });
 *
 * Exercises every mandatory contract in spec/memory.md. Throws on the
 * first violation; returns silently on success.
 *
 * The factory must produce a fresh, empty store on each call.
 *
 * NOTE: this harness does NOT verify the memory_write / memory_delete
 * timeline event emission — that's the canonical tool layer's job, not
 * the store's. To verify the full tool path, run the tools through a
 * Runtime and inspect the timeline.
 */

import type { MemoryStore } from "../types.js";

class ConformanceError extends Error {
  constructor(message: string) {
    super(`MemoryStore conformance: ${message}`);
    this.name = "ConformanceError";
  }
}

export async function assertMemoryStoreConforms(
  factory: () => MemoryStore | Promise<MemoryStore>,
): Promise<void> {
  const store = await factory();

  // ── 1. write() rejects empty source_event_ids
  let didThrow = false;
  try {
    await store.write({
      kind: "semantic",
      content: "no provenance",
      provenance: { source_event_ids: [], writer: "test" },
    });
  } catch {
    didThrow = true;
  }
  if (!didThrow) {
    throw new ConformanceError("write() should reject empty provenance.source_event_ids");
  }

  // ── 2. write() assigns id, created_at, last_accessed_at
  const r1 = await store.write({
    kind: "semantic",
    content: "Alice prefers email",
    tags: ["preference", "user_alice"],
    importance: 0.7,
    scope: { agent_id: "test-agent" },
    provenance: { source_event_ids: ["evt_1"], writer: "test" },
  });
  if (!r1.id) throw new ConformanceError("write() didn't assign id");
  if (!r1.created_at) throw new ConformanceError("write() didn't assign created_at");
  if (!r1.last_accessed_at) throw new ConformanceError("write() didn't assign last_accessed_at");
  if (r1.kind !== "semantic") throw new ConformanceError("write() lost kind");
  if (r1.content !== "Alice prefers email") throw new ConformanceError("write() lost content");

  // ── 3. write() with same id updates (not creates) and preserves created_at
  // Wait a tick so timestamps differ.
  await new Promise((r) => setTimeout(r, 10));
  const r2 = await store.write({
    id: r1.id,
    kind: "semantic",
    content: "Alice prefers email (updated)",
    provenance: { source_event_ids: ["evt_2"], writer: "test" },
  });
  if (r2.id !== r1.id) throw new ConformanceError("write() with existing id should not change id");
  if (r2.created_at !== r1.created_at) {
    throw new ConformanceError("write() update should preserve created_at");
  }

  // ── 4. get() returns the record byte-for-byte (modulo last_accessed_at)
  const got = await store.get(r1.id);
  if (!got) throw new ConformanceError("get() returned null for known id");
  if (got.id !== r1.id) throw new ConformanceError("get() returned wrong record");
  if (got.content !== r2.content) throw new ConformanceError("get() returned stale content after update");
  if (got.created_at !== r1.created_at) throw new ConformanceError("get() lost created_at");

  // ── 5. get() updates last_accessed_at on hit
  await new Promise((r) => setTimeout(r, 10));
  const before = await store.get(r1.id);
  if (!before) throw new ConformanceError("get() returned null on second call");
  await new Promise((r) => setTimeout(r, 10));
  const after = await store.get(r1.id);
  if (!after) throw new ConformanceError("get() returned null on third call");
  if (after.last_accessed_at <= before.last_accessed_at) {
    throw new ConformanceError(
      "get() must update last_accessed_at on each hit (got same or earlier timestamp)",
    );
  }

  // ── 6. get() returns null for unknown id
  const missing = await store.get("nonexistent_id_xyz");
  if (missing !== null) throw new ConformanceError("get() of unknown id should return null");

  // ── 7. search() honors scope filter
  const otherScope = await store.write({
    kind: "semantic",
    content: "Bob in another agent",
    scope: { agent_id: "other-agent" },
    provenance: { source_event_ids: ["evt_3"], writer: "test" },
  });
  const scoped = await store.search({
    query: "Bob",
    scope: { agent_id: "test-agent" },
  });
  if (scoped.some((h) => h.id === otherScope.id)) {
    throw new ConformanceError("search() with scope filter returned a record from a different scope");
  }

  // ── 8. search() honors kind filter
  const procedural = await store.write({
    kind: "procedural",
    content: "How to handle refunds",
    scope: { agent_id: "test-agent" },
    provenance: { source_event_ids: ["evt_4"], writer: "test" },
  });
  const kindFiltered = await store.search({
    query: "refunds",
    kind: "procedural",
    scope: { agent_id: "test-agent" },
  });
  if (kindFiltered.length === 0 || !kindFiltered.some((h) => h.id === procedural.id)) {
    throw new ConformanceError("search() with kind filter didn't return matching procedural record");
  }
  const wrongKind = await store.search({
    query: "refunds",
    kind: "episodic",
    scope: { agent_id: "test-agent" },
  });
  if (wrongKind.some((h) => h.id === procedural.id)) {
    throw new ConformanceError("search() with kind filter returned record of different kind");
  }

  // ── 9. search() honors tags filter (all-must-match)
  await store.write({
    kind: "semantic",
    content: "tagged record",
    tags: ["a", "b"],
    scope: { agent_id: "test-agent" },
    provenance: { source_event_ids: ["evt_5"], writer: "test" },
  });
  const tagsAll = await store.search({
    query: "tagged",
    tags: ["a", "b"],
    scope: { agent_id: "test-agent" },
  });
  if (tagsAll.length === 0) throw new ConformanceError("search with all-match tags returned nothing");
  const tagsMissing = await store.search({
    query: "tagged",
    tags: ["a", "missing"],
    scope: { agent_id: "test-agent" },
  });
  if (tagsMissing.length > 0) {
    throw new ConformanceError("search with non-matching tags should return nothing");
  }

  // ── 10. SearchHit.score is a number in [0, 1]
  const someHits = await store.search({ query: "Alice", scope: { agent_id: "test-agent" } });
  for (const h of someHits) {
    if (typeof h.score !== "number") throw new ConformanceError("hit.score not a number");
    if (h.score < 0 || h.score > 1) {
      throw new ConformanceError(`hit.score out of [0,1]: ${h.score}`);
    }
  }

  // ── 11. delete() refuses empty filter
  didThrow = false;
  try {
    await store.delete({});
  } catch {
    didThrow = true;
  }
  if (!didThrow) {
    throw new ConformanceError("delete({}) should throw to prevent accidental full wipe");
  }

  // ── 12. delete() removes records and they don't appear in get/search
  const removed = await store.delete({ ids: [r1.id] });
  if (removed === 0) throw new ConformanceError("delete() with matching ids returned 0");
  const gone = await store.get(r1.id);
  if (gone !== null) throw new ConformanceError("delete() didn't actually remove the record");

  // ── 13. stats() (if implemented) returns expected shape
  if (store.stats) {
    const s = await store.stats();
    if (typeof s.count_by_kind !== "object" || s.count_by_kind === null) {
      throw new ConformanceError("stats().count_by_kind must be an object");
    }
  }

  // ── 14. close() (if implemented) doesn't throw
  if (store.close) {
    store.close();
  }
}
