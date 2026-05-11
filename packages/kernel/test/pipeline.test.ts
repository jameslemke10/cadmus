/**
 * End-to-end pipeline tests. Use code processors (no LLM) so the tests
 * are fast, deterministic, and don't require an API key.
 *
 * Covers:
 *  - input → output flow with multiple processors chained on each other
 *  - source-constrained filters
 *  - auto-emitted tool_call / tool_result with call_id pairing
 *  - source attribution on every emit path
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../src/runtime.js";
import type { CadmusEvent } from "../src/types.js";

async function waitForType(
  runtime: Runtime,
  type: string,
  maxMs = 2000,
): Promise<CadmusEvent> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ev = runtime.timeline.latest(type);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for event type "${type}". Got: ${runtime.timeline.all().map(e => e.type).join(", ")}`);
}

test("input → step → output flows end-to-end via code processors", async () => {
  const runtime = new Runtime(
    {
      agentId: "pipeline-test",
      name: "pipeline-test",
      processors: [
        {
          name: "shouter",
          template: "code",
          filter: ["input"],
          outputEvents: ["step1"],
          handler: async (event, ctx) => {
            const text = (event.data as { text?: string }).text ?? "";
            await ctx.emit("step1", { processed: text.toUpperCase() });
          },
        },
        {
          name: "responder",
          template: "code",
          // Source-constrained: only fires for step1 events from the shouter.
          filter: [{ type: "step1", source: "processor:shouter" }],
          outputEvents: ["output"],
          handler: async (event, ctx) => {
            const processed = (event.data as { processed: string }).processed;
            await ctx.emit("output", { channel: "*", kind: "text", text: `echo: ${processed}` });
          },
        },
      ],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );

  await runtime.start();
  await runtime.inject("hi", "test");
  const output = await waitForType(runtime, "output");
  await runtime.stop();

  // Output payload is right.
  const data = output.data as { channel?: string; kind?: string; text?: string };
  assert.equal(data.channel, "*");
  assert.equal(data.kind, "text");
  assert.equal(data.text, "echo: HI");

  // Attribution is correct end-to-end.
  const events = runtime.timeline.all();
  const byType = (t: string) => events.find((e) => e.type === t);
  assert.equal(byType("input")?.source, "channel:test");
  assert.equal(byType("step1")?.source, "processor:shouter");
  assert.equal(byType("output")?.source, "processor:responder");
});

test("source-constrained filter doesn't match the wrong source", async () => {
  // Two emitters both produce a "ping"; the consumer only wants ping from one of them.
  const runtime = new Runtime(
    {
      agentId: "source-filter-test",
      name: "source-filter-test",
      processors: [
        {
          name: "ping_a",
          template: "code",
          filter: ["input"],
          outputEvents: ["ping"],
          handler: async (_e, ctx) => {
            await ctx.emit("ping", { from: "a" });
          },
        },
        {
          name: "ping_b",
          template: "code",
          filter: ["input"],
          outputEvents: ["ping"],
          handler: async (_e, ctx) => {
            await ctx.emit("ping", { from: "b" });
          },
        },
        {
          name: "consumer",
          template: "code",
          filter: [{ type: "ping", source: "processor:ping_a" }],
          outputEvents: ["consumed"],
          handler: async (event, ctx) => {
            await ctx.emit("consumed", { from: (event.data as { from?: string }).from });
          },
        },
      ],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );

  await runtime.start();
  await runtime.inject("go", "test");
  await waitForType(runtime, "consumed");
  await runtime.stop();

  const consumed = runtime.timeline.all().filter((e) => e.type === "consumed");
  assert.equal(consumed.length, 1, "consumer should fire exactly once");
  assert.equal(
    (consumed[0].data as { from?: string }).from,
    "a",
    "consumer should only fire on ping_a's emission",
  );
});

test("ctx.callTool auto-emits paired tool_call and tool_result", async () => {
  const runtime = new Runtime(
    {
      agentId: "tool-pairing-test",
      name: "tool-pairing-test",
      tools: {
        add_one: {
          name: "add_one",
          description: "n + 1",
          input_schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
          handler: async (args) => ({ result: (args as { n: number }).n + 1 }),
        },
      },
      processors: [
        {
          name: "caller",
          template: "code",
          filter: ["input"],
          tools: ["add_one"],
          handler: async (_event, ctx) => {
            await ctx.callTool("add_one", { n: 41 });
          },
        },
      ],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );

  await runtime.start();
  await runtime.inject("go", "test");
  await waitForType(runtime, "tool_result");
  await runtime.stop();

  const events = runtime.timeline.all();
  const call = events.find((e) => e.type === "tool_call");
  const result = events.find((e) => e.type === "tool_result");

  assert.ok(call, "tool_call should be emitted");
  assert.ok(result, "tool_result should be emitted");

  const callData = call.data as { call_id: string; tool: string };
  const resultData = result.data as { call_id: string; tool: string; result: unknown; is_error: boolean };

  assert.equal(callData.tool, "add_one");
  assert.equal(resultData.tool, "add_one");
  assert.equal(callData.call_id, resultData.call_id, "call_id must pair");
  assert.equal(resultData.is_error, false);
  assert.deepStrictEqual(resultData.result, { result: 42 });
  // Both attributed to the calling processor, not the tool.
  assert.equal(call.source, "processor:caller");
  assert.equal(result.source, "processor:caller");
});

test("processor throw emits an error event with source: kernel", async () => {
  const runtime = new Runtime(
    {
      agentId: "error-test",
      name: "error-test",
      processors: [
        {
          name: "boom",
          template: "code",
          filter: ["input"],
          handler: async () => {
            throw new Error("scripted failure");
          },
        },
      ],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );

  await runtime.start();
  await runtime.inject("trigger", "test");
  const err = await waitForType(runtime, "error");
  await runtime.stop();

  assert.equal(err.source, "kernel");
  const d = err.data as { source?: string; name?: string; message?: string };
  assert.equal(d.source, "processor");
  assert.equal(d.name, "boom");
  assert.equal(d.message, "scripted failure");
});
