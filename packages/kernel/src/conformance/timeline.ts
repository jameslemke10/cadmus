/**
 * Conformance test harness for TimelineStore.
 *
 * Usage in a test suite:
 *   import { assertTimelineConforms } from "@cadmus/kernel/conformance";
 *   import { Timeline } from "@cadmus/kernel";
 *
 *   test("SQLite timeline conforms", async () => {
 *     await assertTimelineConforms(() => new Timeline(":memory:"));
 *   });
 *
 * The harness exercises every contract in spec/timeline.md. Throws on the
 * first violation with a descriptive message; returns silently on success.
 *
 * The factory must produce a fresh, empty store on each call.
 */

import type { TimelineStore } from "../types.js";

class ConformanceError extends Error {
  constructor(message: string) {
    super(`TimelineStore conformance: ${message}`);
    this.name = "ConformanceError";
  }
}

export async function assertTimelineConforms(
  factory: () => TimelineStore | Promise<TimelineStore>,
): Promise<void> {
  const store = await factory();

  // ── 1. Fresh store starts empty
  if (store.count() !== 0) {
    throw new ConformanceError(`fresh store should have count 0, got ${store.count()}`);
  }

  // ── 2. append() assigns id, seq, timestamp
  const e1 = await store.append({
    type: "conformance.test",
    agent_id: "test-agent",
    data: { x: 1 },
  });
  if (!e1.id) throw new ConformanceError("append() didn't assign id");
  if (typeof e1.seq !== "number") {
    throw new ConformanceError("append() didn't assign numeric seq");
  }
  if (!e1.timestamp || isNaN(Date.parse(e1.timestamp))) {
    throw new ConformanceError("append() didn't assign valid ISO timestamp");
  }
  if (e1.agent_id !== "test-agent") {
    throw new ConformanceError("append() didn't preserve agent_id");
  }

  // ── 3. session_id round-trips
  const e2 = await store.append({
    type: "conformance.test",
    agent_id: "test-agent",
    session_id: "sess-1",
    data: { x: 2 },
  });
  if (e2.session_id !== "sess-1") {
    throw new ConformanceError("session_id didn't round-trip through append");
  }

  // ── 4. seq is monotonically increasing
  if (e2.seq <= e1.seq) {
    throw new ConformanceError(`seq not monotonic: ${e1.seq} then ${e2.seq}`);
  }

  // ── 5. count() reflects appends
  if (store.count() !== 2) {
    throw new ConformanceError(`expected count 2, got ${store.count()}`);
  }

  // ── 6. byId() returns the persisted event
  const got = store.byId(e1.id);
  if (!got) throw new ConformanceError("byId() returned null for known id");
  if (got.id !== e1.id || got.seq !== e1.seq) {
    throw new ConformanceError("byId() returned wrong record");
  }

  // ── 7. latest(type) returns most recent of type
  const latest = store.latest("conformance.test");
  if (!latest) throw new ConformanceError("latest() returned null with matching events present");
  if (latest.id !== e2.id) {
    throw new ConformanceError("latest() didn't return the most recent event");
  }

  // ── 8. recent(limit) returns events in append order, newest at end
  const recent = store.recent(10);
  if (recent.length !== 2) throw new ConformanceError(`recent(10) returned ${recent.length}, expected 2`);
  if (recent[0].seq > recent[1].seq) {
    throw new ConformanceError("recent() should return events in seq-ascending order");
  }

  // ── 9. recent() honors session_id filter
  const recentScoped = store.recent(10, { sessionId: "sess-1" });
  if (recentScoped.length !== 1 || recentScoped[0].id !== e2.id) {
    throw new ConformanceError("recent() with sessionId filter returned wrong events");
  }

  // ── 10. all() honors type filter
  const allTyped = store.all({ types: ["conformance.test"] });
  if (allTyped.length !== 2) {
    throw new ConformanceError("all() with type filter returned wrong count");
  }

  // ── 11. since(seq) returns events strictly greater than seq
  const since = store.since(e1.seq);
  if (since.length === 0) throw new ConformanceError("since() returned no events");
  if (since.some((e) => e.seq <= e1.seq)) {
    throw new ConformanceError("since(seq) returned events with seq <= input");
  }

  // ── 12. subscribe() listener fires on new events, after persistence
  let firedWith: string | null = null;
  const unsub = store.subscribe((event) => {
    firedWith = event.id;
  });
  const e3 = await store.append({
    type: "conformance.test",
    agent_id: "test-agent",
    data: {},
  });
  // Allow microtask flush for async listener dispatch.
  await new Promise((r) => setTimeout(r, 20));
  if (firedWith !== e3.id) {
    throw new ConformanceError(`subscribe listener fired with ${firedWith}, expected ${e3.id}`);
  }
  unsub();
  // After unsubscribe, listener should not fire.
  firedWith = null;
  await store.append({ type: "conformance.test", agent_id: "test-agent", data: {} });
  await new Promise((r) => setTimeout(r, 20));
  if (firedWith !== null) {
    throw new ConformanceError("listener fired after unsubscribe");
  }

  // ── 13. delete() refuses an empty filter
  let didThrow = false;
  try {
    await store.forget({});
  } catch {
    didThrow = true;
  }
  if (!didThrow) {
    throw new ConformanceError("forget({}) should throw to prevent accidental full wipe");
  }

  // ── 14. forget(filter) deletes matching events
  const beforeCount = store.count();
  const removed = await store.forget({ sessionId: "sess-1" });
  if (removed === 0) {
    throw new ConformanceError("forget() with matching filter returned 0 deleted");
  }
  if (store.count() !== beforeCount - removed) {
    throw new ConformanceError(
      `count after forget should be ${beforeCount - removed}, got ${store.count()}`,
    );
  }
  if (store.byId(e2.id) !== null) {
    throw new ConformanceError("forget() didn't actually remove the event");
  }
}
