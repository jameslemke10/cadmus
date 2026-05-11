/**
 * Claudius — the boring agent. As close to a Claude-style chat assistant
 * as we can get on top of Cadmus.
 *
 * Architecture:
 *   - One PFC processor that loops input → tools → output via the timeline.
 *     Each invocation is a single LLM turn: call a tool (which auto-emits
 *     tool_call + tool_result events; tool_result re-triggers the processor),
 *     or emit `output` to end the loop.
 *   - To start a new conversation (forget prior turns), emit an event_boundary
 *     event. The framework scopes every LLM context window to events at-or-
 *     after the most recent boundary, so the model "forgets" anything older.
 *   - Persistent memory in .cadmus/memory.db (SQLite) — survives kernel
 *     restarts and conversation boundaries. The canonical memory_search /
 *     memory_write / memory_delete tools come from @cadmus/tools/memory.
 *
 * Click the "New conversation" button in Studio to emit a boundary, or curl:
 *   curl -X POST http://localhost:4000/api/inject \
 *     -H 'content-type: application/json' \
 *     -d '{"type":"event_boundary","data":{"type":"conversation"}}'
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
      filter: ["input", "tool_result"],
      tools: ["memory_search", "memory_write", "memory_delete", "get_current_time", "calculate"],
      outputEvents: ["output"],
      outputSchema: {
        output: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Target channel, or '*' to broadcast." },
            kind: { type: "string", description: "Payload variant. Use 'text' for plain text." },
            text: { type: "string" },
          },
          required: ["channel", "kind", "text"],
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 80,
        systemPrompt: `You are Claudius — a friendly, capable assistant. You are running inside the Cadmus framework.

How a turn works:
- Each invocation is a SINGLE LLM turn. You see the timeline since the most recent event_boundary (older events are hidden from you; persistent memory still survives across boundaries).
- You may call real tools in this turn — memory_search, memory_write, memory_delete, get_current_time, calculate. You will NOT see the result of a tool within the same turn; the runtime emits a tool_result event onto the timeline, which re-triggers you. On the next invocation you'll see the result in the timeline dump.
- End every turn by either calling exactly one tool (loop continues) OR calling emit_output with { channel: "*", kind: "text", text } to reply to the user (loop ends). Channel "*" broadcasts to whichever channel sent the input.

Persistent memory (survives across boundaries):
- "procedural" — skills and how-to ("when user asks X, do Y")
- "semantic"   — facts about the user / world (use tags: ["identity"] for facts about yourself)
- "episodic"   — events ("on date X, user said Y")
Search memory when context might exist; write when the user tells you something worth remembering; delete when something is no longer true.

If the timeline shows an event_boundary as the most recent boundary, you're in a new conversation. A quick memory_search on the first response is often the right move.

Voice: plainspoken, first person, concise unless detail is asked for. No "as an AI". No disclaimers.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
