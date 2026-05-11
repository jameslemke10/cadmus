/**
 * HTTP API tests — boot the kernel server on a random port, exercise
 * /api/inject, /api/events, and /api/agent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

function pickPort(): number {
  // Random port in the high range; collisions are unlikely.
  return 14000 + Math.floor(Math.random() * 1000);
}

test("POST /api/inject creates an input event with channel + kind", async () => {
  const runtime = new Runtime(
    {
      agentId: "server-test",
      name: "Server Test",
      processors: [],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );
  await runtime.start();
  const port = pickPort();
  const { close } = startServer(runtime, { port });

  try {
    // Wait a tick for the server to actually listen.
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/api/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", channel: "ci" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      event: { type: string; data: { channel: string; kind: string; text: string }; source: string };
    };
    assert.equal(body.event.type, "input");
    assert.equal(body.event.data.channel, "ci");
    assert.equal(body.event.data.kind, "text");
    assert.equal(body.event.data.text, "hello");
    assert.equal(body.event.source, "channel:ci");

    const eventsRes = await fetch(`http://127.0.0.1:${port}/api/events/all`);
    const { events } = (await eventsRes.json()) as { events: { type: string }[] };
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "input");
  } finally {
    await close();
    await runtime.stop();
  }
});

test("GET /api/agent returns processor + tool metadata", async () => {
  const runtime = new Runtime(
    {
      agentId: "agent-meta-test",
      name: "Agent Meta",
      tools: {
        noop: {
          name: "noop",
          description: "does nothing",
          input_schema: { type: "object", properties: {} },
          handler: async () => ({}),
        },
      },
      processors: [
        {
          name: "main",
          template: "code",
          filter: ["input"],
          tools: ["noop"],
          outputEvents: ["output"],
          handler: async () => undefined,
        },
      ],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );
  await runtime.start();
  const port = pickPort();
  const { close } = startServer(runtime, { port });

  try {
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`http://127.0.0.1:${port}/api/agent`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      processors: { name: string; filter: unknown[]; outputEvents: string[]; tools: string[] }[];
      tools: { name: string }[];
    };
    assert.equal(body.id, "agent-meta-test");
    assert.equal(body.name, "Agent Meta");
    assert.equal(body.processors.length, 1);
    assert.equal(body.processors[0].name, "main");
    assert.deepStrictEqual(body.processors[0].outputEvents, ["output"]);
    assert.deepStrictEqual(body.processors[0].tools, ["noop"]);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, "noop");
  } finally {
    await close();
    await runtime.stop();
  }
});

test("POST /api/inject with arbitrary { type, data } emits that type", async () => {
  const runtime = new Runtime(
    {
      agentId: "arbitrary-inject-test",
      name: "Arbitrary",
      processors: [],
      storage: { timelinePath: ":memory:" },
    },
    { verbose: false },
  );
  await runtime.start();
  const port = pickPort();
  const { close } = startServer(runtime, { port });

  try {
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`http://127.0.0.1:${port}/api/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "session_start", data: { session_id: "s1" } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { event: { type: string; data: { session_id: string } } };
    assert.equal(body.event.type, "session_start");
    assert.equal(body.event.data.session_id, "s1");
  } finally {
    await close();
    await runtime.stop();
  }
});
