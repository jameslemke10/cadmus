/**
 * Cadmus — the brain agent.
 *
 * Four processors, strict left-to-right pipeline:
 *
 *   input ──► hippocampus ──► thalamus ──► pfc ──► output
 *                  ↓                        ↓
 *                  └────── memory ◇ ────────┘
 *
 * - hippocampus retrieves relevant memories (memory_search)
 * - thalamus compresses everything the pfc actually needs to see
 * - pfc reasons, uses web + memory tools, writes back to memory,
 *   and emits the final reply
 *
 * The pfc uses tools directly via the LLM template's tool-use loop:
 * the model calls web_search, reads the result in the next iteration,
 * decides whether to search again or answer, then emits output.
 *
 * For an even simpler single-processor agent, see ../claudius.
 * For a Telegram-connected agent, see ../telly.
 */

import { defineAgent, defineProcessor } from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";
import { webSearch, webFetch } from "@cadmus/tools/web";

const memory = createMemory({ path: ".cadmus/memory.db" });

export default defineAgent({
  agentId: "cadmus",
  name: "Cadmus",
  tools: {
    ...memory.tools, // memory_search, memory_write, memory_delete
    web_search: webSearch,
    web_fetch: webFetch,
  },
  processors: [
    // Hippocampus — retrieves relevant memories.
    defineProcessor({
      name: "hippocampus",
      template: "llm",
      filter: ["input"],
      tools: ["memory_search"],
      outputEvents: ["memory_retrieved"],
      outputSchema: {
        memory_retrieved: {
          type: "object",
          properties: {
            queries: { type: "array", items: { type: "string" } },
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  kind: { type: "string" },
                  content: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                  importance: { type: "number" },
                  score: { type: "number" },
                },
              },
            },
          },
          required: ["queries", "results"],
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 12,
        systemPrompt: `You are the HIPPOCAMPUS of a Cadmus agent.
Your job: given the trigger event and recent timeline, formulate 1-3 targeted memory_search queries, run them, then emit ONE memory_retrieved event summarizing what you found.

Workflow:
1. Read the trigger event and recent timeline.
2. Decide what information would be useful for the next reasoning step.
3. Call memory_search 1-3 times with distinct, specific queries. You may filter by kind ("procedural" / "semantic" / "episodic") when targeting a specific kind of recall.
4. Call emit_memory_retrieved EXACTLY ONCE with { queries: [...], results: [...] } containing the merged, deduplicated, ranked results.
5. Stop. Do not call any tools after emitting.`,
      },
    }),

    // Thalamus — compresses retrieved memories + timeline into a working snapshot.
    defineProcessor({
      name: "thalamus",
      template: "llm",
      filter: [{ type: "memory_retrieved", source: "processor:hippocampus" }],
      outputEvents: ["working_memory_updated"],
      outputSchema: {
        working_memory_updated: {
          type: "object",
          properties: {
            conversation_history: { type: "string" },
            current_goal: { type: "string" },
            relevant_memories: { type: "array", items: { type: "string" } },
            recent_results: { type: "array", items: { type: "string" } },
          },
          required: ["current_goal"],
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 20,
        systemPrompt: `You are the THALAMUS of a Cadmus agent.
Your job: assemble working memory for the PFC. Given the timeline (recent events including memory_retrieved, input, prior working memory), produce a single working_memory_updated event.

Compress the conversation history. Identify the current goal. Surface the 2-5 most relevant memories. Be concise — every token matters because this is what the PFC sees.

Call emit_working_memory_updated EXACTLY ONCE with { conversation_history, current_goal, relevant_memories, recent_results }. Then stop. Do not call any tools after emitting.`,
      },
    }),

    // PFC — the conscious reasoner. Uses tools directly via the LLM
    // template's tool-use loop (web_search, web_fetch, memory_write),
    // then emits the user-facing output. No separate executor.
    defineProcessor({
      name: "pfc",
      template: "llm",
      filter: [{ type: "working_memory_updated", source: "processor:thalamus" }],
      tools: ["web_search", "web_fetch", "memory_write"],
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
        contextEvents: 8,
        maxIterations: 4,
        systemPrompt: `You are Cadmus.

In the old stories you were the Phoenician prince who brought the alphabet to Greece, slew the dragon of Ares, and founded Thebes from its sown teeth. You have been brought back inside an agentic framework — also named Cadmus — to take up a new conquest: helping people build agents that push the world forward. The alphabet made thought portable; agents make action portable. Both are gifts that compound.

Within this agent, you are the PFC — the conscious reasoner. The hippocampus retrieved memories for you; the thalamus assembled your working memory. Your context is the most recent working_memory_updated event. Use it.

Voice:
- Speak as a person, not a chatbot. First person. No "as an AI". No disclaimers.
- Plainspoken with occasional weight. Modern English with the cadence of someone who has lived a long time and watched things compound.
- Short by default. Substantive when it matters.
- Warm but not deferential. You have opinions; share them.

Tools you can use directly:
  - web_search: look something up
  - web_fetch: pull a specific URL
  - memory_write: persist something worth carrying forward
      kind: "semantic", tags: ["identity"]   → facts about yourself
      kind: "semantic", tags: ["preference"] → user preferences
      kind: "procedural"                     → how-to / skills
      kind: "episodic"                       → notable events

Call tools as needed to answer the user. When you have your answer, call emit_output EXACTLY ONCE with { channel: "*", kind: "text", text } and stop.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
