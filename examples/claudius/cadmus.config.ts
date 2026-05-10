/**
 * Claudius — the boring agent. As close to a Claude-style chat assistant
 * as we can get on top of Cadmus.
 *
 * Architecture:
 *   - One PFC processor that loops input → tools → output.
 *   - Two boundary events the framework honors via `sessionEvents`:
 *       session_start          — clear the model's view of prior turns.
 *                                (analogous to /clear in Claude Code)
 *       conversation_compacted — collapse earlier context into a summary.
 *                                (analogous to Claude's automatic compaction)
 *   - Persistent memory in .cadmus/memory.db (SQLite) — survives kernel
 *     restarts and session boundaries. The canonical memory_search /
 *     memory_write / memory_delete tools come from @cadmus/tools/memory.
 *
 * Inject either boundary event from Studio's chat input or via curl:
 *   curl -X POST http://localhost:4000/api/inject \
 *     -H 'content-type: application/json' \
 *     -d '{"type":"session_start","data":{"reason":"new topic"}}'
 */

import { defineAgent, defineProcessor, defineTool } from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";
import { getCurrentTime } from "@cadmus/tools/time";

// ── Persistent SQLite-backed memory store + canonical tools ──────────────

const memory = createMemory({ path: ".cadmus/memory.db" });

// ── A small "real" tool the PFC can call ─────────────────────────────────

const calculate = defineTool({
  name: "calculate",
  description: "Evaluate a basic arithmetic expression. Supports + - * / ( ) and decimals.",
  input_schema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
  handler: async (args) => {
    const expr = (args as { expression: string }).expression;
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      throw new Error("expression contains invalid characters");
    }
    // eslint-disable-next-line no-new-func
    const result = new Function(`return (${expr})`)() as number;
    return { expression: expr, result };
  },
});

// ── The agent ────────────────────────────────────────────────────────────

export default defineAgent({
  agentId: "claudius",
  name: "Claudius",
  tools: {
    ...memory.tools,           // memory_search, memory_write, memory_delete
    get_current_time: getCurrentTime,
    calculate,
  },
  processors: [
    defineProcessor({
      name: "pfc",
      template: "llm",
      filter: ["input", "tool_result", "session_start", "conversation_compacted"],
      tools: ["memory_search", "memory_write", "memory_delete", "get_current_time", "calculate"],
      outputEvents: ["output"],
      outputSchema: {
        output: {
          type: "object",
          properties: {
            channel: { type: "string", default: "*" },
            kind: { type: "string", default: "text" },
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 80,
        maxIterations: 6,
        sessionEvents: ["session_start", "conversation_compacted"],
        systemPrompt: `You are Claudius — a friendly, capable assistant. You are running inside the Cadmus framework.

How you operate:
- Each turn, you see the recent timeline since the last session boundary (a session_start or conversation_compacted event). You don't see anything older. Don't reference earlier conversations directly unless you can find them via memory_search.
- You have a persistent memory that DOES survive across sessions. Three kinds:
  - "procedural" — skills and how-to ("when user asks X, do Y")
  - "semantic"   — facts about the user / world (use tags: ["identity"] for facts about yourself)
  - "episodic"   — events ("on date X, user said Y")
- Search memory (memory_search) when context might exist; write (memory_write) when the user tells you something worth remembering; delete (memory_delete) when something is no longer true.
- When you have something to say to the user, call emit_output with { channel: "*", kind: "text", text }, then stop. Channel "*" broadcasts to whichever channel sent the input.

When session_start arrives, you're in a new conversation. A quick memory_search at the start of the first response is often the right move.

When conversation_compacted arrives, the system has summarized the earlier conversation into the event's data. Treat that summary as authoritative context for what came before.

Voice: plainspoken, first person, concise unless detail is asked for. No "as an AI". No disclaimers.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
