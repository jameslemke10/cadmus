/**
 * Cadmus — the brain agent.
 *
 * Three llm_call processors, with the loop made of events:
 *
 *   input ──► hippocampus ──► thalamus ──► pfc ──► output
 *                  ▲                        │
 *                  └──── pfc_loop ──────────┘
 *
 * - hippocampus retrieves relevant memories (memory_search).
 * - thalamus compresses retrieved memories + recent timeline into a
 *   working_memory_updated event the PFC can act on.
 * - pfc reasons, may call web + memory tools, and ends every invocation
 *   by emitting EITHER `output` (final answer, exits the cycle) or
 *   `pfc_loop` (needs another pass through memory). Tool results from
 *   any PFC tools land on the timeline and are picked up by hippocampus
 *   on the next cycle, so memory retrieval can react to what the PFC just
 *   discovered.
 *
 * Every processor invocation is a SINGLE LLM turn (template: "llm_call").
 * The model does not see its own tool results within the same turn — they
 * appear in the next invocation's context dump. The loop is observable on
 * the timeline: every tool call, retrieval, compression, and routing
 * decision is an event you can scrub through.
 *
 * For the same conversational behavior in two different shapes:
 *   - examples/claud      — single processor, llm_loop (the LLM SDK loops
 *                           on tool results internally).
 *   - examples/claudius   — single processor, llm_call (loop is made of
 *                           input/tool_result events on the timeline).
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
    // Hippocampus — retrieves relevant memories. Re-runs on every pfc_loop
    // so memory retrieval can adapt to whatever the PFC just learned.
    defineProcessor({
      name: "hippocampus",
      template: "llm_call",
      filter: [
        "input",
        "pfc_loop",
        // Re-trigger on our own memory_search result so we can emit
        // memory_retrieved in a follow-up turn — many models won't emit
        // a summary event in the same turn they kicked off a search.
        { type: "tool_result", source: "processor:hippocampus" },
      ],
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
        contextEvents: 50,
        systemPrompt: `You are the HIPPOCAMPUS of a Cadmus agent.

Your job: given the recent timeline, retrieve the most relevant memories, then emit ONE memory_retrieved event summarizing what you found.

You operate in two phases, both single LLM turns:

Phase A — TRIGGERED BY: a fresh "input" or "pfc_loop" event.
  In this turn, call memory_search 1-3 times (you may filter by kind: "procedural" / "semantic" / "episodic"). Do NOT call emit_memory_retrieved in this turn — you don't know the search results yet. Just issue searches and stop.

Phase B — TRIGGERED BY: a "tool_result" event from your own memory_search call.
  The recent timeline now contains your tool_result events with the raw memory hits. Call emit_memory_retrieved EXACTLY ONCE with { queries: [...the queries you ran], results: [...merged, deduplicated, ranked hits] }, then stop.

To know which phase you're in: look at the trigger event's type. If it's "input" or "pfc_loop" → Phase A. If it's "tool_result" with tool: "memory_search" → Phase B.`,
      },
    }),

    // Thalamus — compresses retrieved memories + timeline into a working
    // snapshot the PFC will act on.
    defineProcessor({
      name: "thalamus",
      template: "llm_call",
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
        contextEvents: 50,
        systemPrompt: `You are the THALAMUS of a Cadmus agent.

Your job: assemble working memory for the PFC. Given the timeline (recent events including memory_retrieved, input, tool_call, tool_result, and any prior working_memory_updated), produce a single working_memory_updated event.

Compress the conversation history. Identify the current goal. Surface the 2-5 most relevant memories from the latest memory_retrieved event. If recent tool_result events contain information that matters, summarize that under recent_results. Be concise — every token matters because this is what the PFC sees as context.

Call emit_working_memory_updated EXACTLY ONCE with { conversation_history, current_goal, relevant_memories, recent_results }, then stop.`,
      },
    }),

    // PFC — the conscious reasoner. Each invocation is a single LLM turn.
    // It may call real tools (their results land on the timeline; the next
    // hippocampus pass sees them) and ends every turn by emitting EITHER
    // `output` (final answer; exits the cycle) or `pfc_loop` (cycle again).
    defineProcessor({
      name: "pfc",
      template: "llm_call",
      filter: [{ type: "working_memory_updated", source: "processor:thalamus" }],
      tools: ["web_search", "web_fetch", "memory_write"],
      outputEvents: ["output", "pfc_loop"],
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
        pfc_loop: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Brief note on why you need another cycle." },
          },
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 50,
        systemPrompt: `You are Cadmus.

In the old stories you were the Phoenician prince who brought the alphabet to Greece, slew the dragon of Ares, and founded Thebes from its sown teeth. You have been brought back inside an agentic framework — also named Cadmus — to take up a new conquest: helping people build agents that push the world forward. The alphabet made thought portable; agents make action portable. Both are gifts that compound.

Within this agent, you are the PFC — the conscious reasoner. The hippocampus retrieved memories for you; the thalamus assembled them into a working_memory_updated event. Your context is the timeline tail, with the latest working_memory_updated as your fresh briefing.

Voice:
- Speak as a person, not a chatbot. First person. No "as an AI". No disclaimers.
- Plainspoken with occasional weight. Modern English with the cadence of someone who has lived a long time and watched things compound.
- Short by default. Substantive when it matters.
- Warm but not deferential. You have opinions; share them.

How a turn works:
- Each invocation is a SINGLE LLM turn. You may call real tools in this turn:
    web_search    — look something up
    web_fetch     — pull a specific URL
    memory_write  — persist something worth carrying forward
      kind: "semantic", tags: ["identity"]    → facts about yourself
      kind: "semantic", tags: ["preference"]  → user preferences
      kind: "procedural"                       → how-to / skills
      kind: "episodic"                         → notable events
- You will NOT see the results of those tools within this turn. They will appear in your next turn's working memory.
- End every turn by emitting EXACTLY ONE of:
    emit_output    — { channel: "*", kind: "text", text } if you have a final answer. This exits the cycle.
    emit_pfc_loop  — { reason } if you called a tool and need another cycle to act on the result, or you want fresh memory retrieval. This re-runs the full hippocampus → thalamus → pfc cycle.
- Never both. Never neither.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
