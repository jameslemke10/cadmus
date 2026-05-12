/**
 * Claud — a Claude-style chat assistant using llm_loop.
 *
 * One processor, one provider session per user input. The model calls
 * tools, the runtime feeds tool results back into the SAME session, and
 * the model keeps going until it stops calling tools — then the final
 * text becomes an `output` event on the timeline.
 *
 *   input ──► pfc (one provider session: call → result → call → result → text)
 *               └─► output
 *
 * This is the shape most people think of when they imagine "talking to
 * Claude" — the SDK loop is hidden inside one processor invocation.
 *
 * Compare with examples/claudius — same end-user behavior, but built with
 * llm_call where the loop is made of timeline events. Same agent, two
 * different shapes; pick whichever fits your introspection needs:
 *   - llm_loop  → fewer events on the timeline, lower latency, the
 *                  provider session keeps short-term context.
 *   - llm_call  → every step is a separate event you can inspect, replay,
 *                  or branch from. The timeline IS the conversation.
 */

import { defineAgent, defineProcessor } from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";
import { webSearch, webFetch } from "@cadmus/tools/web";

const memory = createMemory({ path: ".cadmus/memory.db" });

export default defineAgent({
  agentId: "claud",
  name: "Claud",
  tools: {
    ...memory.tools,
    web_search: webSearch,
    web_fetch: webFetch,
  },
  processors: [
    defineProcessor({
      name: "pfc",
      template: "llm_loop",
      filter: ["input"],
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
        maxIterations: 8,
        systemPrompt: `You are Claud — a friendly, capable assistant. Plainspoken, first person, concise unless detail is asked for. No "as an AI". No disclaimers.

This invocation is a multi-turn provider session: when you call a tool, the result will come back to you in the same session and you can keep going. When you have nothing more to do, just reply in plain text — that text becomes your final answer to the user.

Tools available:
  memory_search   — look up persistent memory before answering when context might exist
  memory_write    — save something the user told you that's worth carrying forward
                      kind: "procedural"                       → skills / how-to
                      kind: "semantic", tags: ["preference"]   → preferences
                      kind: "semantic", tags: ["identity"]     → facts about yourself
                      kind: "episodic"                          → notable events
  memory_delete   — forget something that's no longer true
  web_search      — look something up on the web
  web_fetch       — pull a specific URL`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
