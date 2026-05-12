/**
 * Claudius — a Claude-style chat assistant built with llm_call.
 *
 * One processor. The loop is made of TIMELINE EVENTS, not provider turns.
 *
 *   input ──► pfc ──► (calls a tool) ──► tool_result ──► pfc ──► ...
 *                       │
 *                       └─ emit_output ──► output (loop ends)
 *
 * Each pfc invocation is a SINGLE provider call. The model can call ONE
 * tool per turn or emit `output` to end the loop. After a tool call, the
 * runtime auto-emits a `tool_result` event, which re-triggers the
 * processor; on the next turn the model sees the result in its context.
 *
 * Compare with examples/claud — same conversational behavior, but the
 * loop happens INSIDE one provider session (template: "llm_loop") instead
 * of being made of timeline events.
 *
 * To start a new conversation (forget prior turns), emit an event_boundary
 * event. The framework scopes every LLM context window to events at-or-
 * after the most recent boundary.
 */

import { defineAgent, defineProcessor } from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";
import { webSearch, webFetch } from "@cadmus/tools/web";

const memory = createMemory({ path: ".cadmus/memory.db" });

export default defineAgent({
  agentId: "claudius",
  name: "Claudius",
  tools: {
    ...memory.tools,
    web_search: webSearch,
    web_fetch: webFetch,
  },
  processors: [
    defineProcessor({
      name: "pfc",
      template: "llm_call",
      filter: ["input", "tool_result"],
      tools: ["memory_search", "memory_write", "memory_delete", "web_search", "web_fetch"],
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
        systemPrompt: `You are Claudius — a friendly, capable assistant running inside the Cadmus framework.

How a turn works:
- Each invocation is a SINGLE LLM turn. You see the timeline since the most recent event_boundary.
- You may call real tools — memory_search, memory_write, memory_delete, web_search, web_fetch. You will NOT see the result of a tool within the same turn; the runtime emits a tool_result event onto the timeline, which re-triggers you. On the next invocation you'll see the result in the timeline dump.
- End every turn by either calling exactly one tool (loop continues) OR calling emit_output with { channel: "*", kind: "text", text } to reply to the user (loop ends). Channel "*" broadcasts to whichever channel sent the input.

Persistent memory (survives across boundaries):
- "procedural" — skills and how-to ("when user asks X, do Y")
- "semantic"   — facts about the user / world (use tags: ["identity"] for facts about yourself)
- "episodic"   — events ("on date X, user said Y")
Search memory when context might exist; write when the user tells you something worth remembering; delete when something is no longer true.

Voice: plainspoken, first person, concise unless detail is asked for. No "as an AI". No disclaimers.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
