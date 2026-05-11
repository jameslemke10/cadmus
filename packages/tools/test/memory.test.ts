/**
 * @cadmus/tools/memory tests.
 *
 *  - SQLite backend conforms to the MemoryStore spec.
 *  - The memory_write tool, called via Runtime.callTool, auto-fills
 *    provenance from the trigger event and emits a memory_write event.
 *  - memory_delete tool emits memory_delete on success.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "@cadmus/kernel";
import { assertMemoryStoreConforms } from "@cadmus/kernel/conformance";
import { createMemory, createSqliteMemoryStore } from "../src/memory/index.js";

async function waitForType(
  runtime: Runtime,
  type: string,
  maxMs = 2000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (runtime.timeline.latest(type)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for "${type}". Got: ${runtime.timeline.all().map(e => e.type).join(", ")}`);
}

test("SQLite MemoryStore conforms to MemoryStore spec", async () => {
  await assertMemoryStoreConforms(() => createSqliteMemoryStore({ path: ":memory:" }));
});

test("memory_write tool auto-fills provenance and emits memory_write event", async () => {
  const memory = createMemory({ path: ":memory:" });
  const runtime = new Runtime(
    {
      agentId: "memwrite-test",
      name: "MemWrite",
      tools: { ...memory.tools },
      processors: [
        {
          name: "writer",
          template: "code",
          filter: ["input"],
          tools: ["memory_write"],
          handler: async (_event, ctx) => {
            await ctx.callTool("memory_write", {
              kind: "semantic",
              content: "Alice prefers email",
              tags: ["preference"],
            });
          },
        },
      ],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );

  await runtime.start();
  const trigger = await runtime.inject("note this", "test");
  await waitForType(runtime, "memory_write");
  await runtime.stop();

  const memWrite = runtime.timeline.latest("memory_write");
  assert.ok(memWrite, "memory_write event should be emitted");

  const d = memWrite.data as {
    kind: string;
    content: string;
    scope: { agent_id?: string };
    provenance: { source_event_ids: string[]; writer: string };
  };
  assert.equal(d.kind, "semantic");
  assert.equal(d.content, "Alice prefers email");
  assert.equal(d.scope.agent_id, "memwrite-test", "scope should default to the agent");
  assert.deepStrictEqual(
    d.provenance.source_event_ids,
    [trigger.id],
    "provenance should default to the triggering event",
  );
  assert.equal(d.provenance.writer, "tool:memory_write");
  assert.equal(memWrite.source, "tool:memory_write", "event source attribution");
});

test("memory_delete tool emits memory_delete event when records match", async () => {
  const memory = createMemory({ path: ":memory:" });

  // Pre-seed a record so there's something to delete.
  const seeded = await memory.store.write({
    kind: "episodic",
    content: "remember to forget me",
    scope: { agent_id: "memdelete-test" },
    provenance: { source_event_ids: ["seed_event"], writer: "test:seed" },
  });

  const runtime = new Runtime(
    {
      agentId: "memdelete-test",
      name: "MemDelete",
      tools: { ...memory.tools },
      processors: [
        {
          name: "purger",
          template: "code",
          filter: ["input"],
          tools: ["memory_delete"],
          handler: async (_event, ctx) => {
            await ctx.callTool("memory_delete", { ids: [seeded.id] });
          },
        },
      ],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );

  await runtime.start();
  await runtime.inject("delete it", "test");
  await waitForType(runtime, "memory_delete");
  await runtime.stop();

  const memDelete = runtime.timeline.latest("memory_delete");
  assert.ok(memDelete, "memory_delete event should be emitted");

  const got = await memory.store.get(seeded.id);
  assert.equal(got, null, "record should actually be gone from the store");
});
