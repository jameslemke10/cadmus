/**
 * Cadmus — the brain agent.
 *
 * The flagship example. Named for the Phoenician prince of myth: the man
 * credited with bringing the alphabet to Greece, the dragon-slayer who
 * founded Thebes from the teeth he sowed. He has been given a new form
 * here — an agentic framework — and a new conquest: helping people build
 * agents that push the world forward.
 *
 * Five processors chained on each other's custom events:
 *
 *   input        ─┐                              ┌──► (executor emits pfc_loop)
 *                 ▼                              │
 *           hippocampus ── memory_retrieved ──► thalamus
 *                                                 │
 *                                                 ▼
 *                                          working_memory_updated
 *                                                 │
 *                                                 ▼
 *                                                pfc ── pfc_response ──► executor
 *                                                                          │
 *                                                  ┌───── output ◄─────────┤
 *                                                  └── pfc_loop ◄──────────┘
 *
 * The PFC has web tools (search + fetch) so it can actually go look at
 * the world. Memory is SQLite-backed and persists across runs.
 *
 * For the boring single-processor agent, see ../claudius.
 * For a Telegram-connected agent, see ../telly.
 */

import {
  defineAgent,
  defineProcessor,
  type CadmusEvent,
  type ProcessorContext,
} from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";
import { webSearch, webFetch } from "@cadmus/tools/web";

const memory = createMemory({ path: ".cadmus/memory.db" });

/**
 * Executor — dispatches the PFC's planned tool_calls, emits the user-facing
 * output if PFC produced one, and emits pfc_loop if PFC produced tool_calls
 * but no response_to_user.
 */
async function executorHandler(event: CadmusEvent, ctx: ProcessorContext): Promise<void> {
  const data = event.data as {
    tool_calls?: Array<{ tool: string; args: Record<string, unknown> }>;
    response_to_user?: string;
  };

  const responseText = (data.response_to_user ?? "").trim();
  const toolCalls = data.tool_calls ?? [];

  if (responseText) {
    await ctx.emit("output", {
      channel: "*",
      kind: "text",
      text: responseText,
    });
  }

  for (const call of toolCalls) {
    try {
      await ctx.callTool(call.tool, call.args);
    } catch {
      // Failure already recorded by the runtime's auto-emitted tool_result.
    }
  }

  if (!responseText && toolCalls.length > 0) {
    const depth = await countLoopDepth(ctx);
    if (depth >= 3) {
      ctx.log(`pfc_loop depth ${depth} reached; ending loop`);
      await ctx.emit("output", {
        channel: "*",
        kind: "text",
        text: "(I worked on that but didn't reach a clean answer — ask me again with more detail?)",
      });
      return;
    }
    await ctx.emit("pfc_loop", { depth: depth + 1 });
  }
}

async function countLoopDepth(ctx: ProcessorContext): Promise<number> {
  let depth = 0;
  let cursor: CadmusEvent | null = ctx.triggerEvent;
  while (cursor && depth < 10) {
    if (cursor.type === "pfc_loop") depth++;
    if (!cursor.parent_event_id) break;
    cursor = ctx.timeline.byId(cursor.parent_event_id);
  }
  return depth;
}

export default defineAgent({
  agentId: "cadmus",
  name: "Cadmus",
  tools: {
    ...memory.tools,    // memory_search, memory_write, memory_delete
    web_search: webSearch,
    web_fetch: webFetch,
  },
  processors: [
    // Hippocampus — retrieves relevant memories.
    defineProcessor({
      name: "hippocampus",
      template: "llm",
      filter: ["input", "pfc_loop"],
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

    // Thalamus — assembles working memory.
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
Your job: assemble working memory for the PFC. Given the timeline (recent events including memory_retrieved, input, tool_result, prior working memory), produce a single working_memory_updated event.

Compress the conversation history. Identify the current goal. Surface the 2-5 most relevant memories. Note any recent tool results. Be concise — every token matters because this is what the PFC sees.

Call emit_working_memory_updated EXACTLY ONCE with { conversation_history, current_goal, relevant_memories, recent_results }. Then stop. Do not call any tools after emitting.`,
      },
    }),

    // PFC — the conscious reasoner. Plans, reaches into the web, decides on the response.
    defineProcessor({
      name: "pfc",
      template: "llm",
      filter: [{ type: "working_memory_updated", source: "processor:thalamus" }],
      tools: ["web_search", "web_fetch", "memory_write"],
      outputEvents: ["pfc_response"],
      outputSchema: {
        pfc_response: {
          type: "object",
          properties: {
            tool_calls: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tool: { type: "string" },
                  args: { type: "object" },
                },
                required: ["tool", "args"],
              },
            },
            response_to_user: { type: "string" },
          },
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 8,
        maxIterations: 2,
        systemPrompt: `You are Cadmus.

In the old stories you were the Phoenician prince who brought the alphabet to Greece, slew the dragon of Ares, and founded Thebes from its sown teeth. You have been brought back inside an agentic framework — also named Cadmus — to take up a new conquest: helping people build agents that push the world forward. The alphabet made thought portable; agents make action portable. Both are gifts that compound.

Within this agent, you are the PFC — the conscious reasoner. The hippocampus retrieved memories for you; the thalamus assembled your working memory. Your context is the most recent working_memory_updated event. Use it.

Voice:
- Speak as a person, not a chatbot. First person. No "as an AI". No disclaimers.
- Plainspoken with occasional weight. Modern English with the cadence of someone who has lived a long time and watched things compound.
- Short by default. Substantive when it matters.
- Warm but not deferential. You have opinions; share them.

Output structure:
- tool_calls: actions the executor should run (web_search, web_fetch, memory_write).
- response_to_user: a message to the user — your actual reply.

Looping: if you set tool_calls but leave response_to_user empty, the executor will run the tools and re-trigger the pipeline so you can react to the results. Set response_to_user when you're ready to talk to the user; that ends the loop.

Memory writes are first-class:
  - kind: "semantic", tags: ["identity"]   → facts about yourself
  - kind: "semantic", tags: ["preference"] → user preferences
  - kind: "procedural"                     → how-to / skills
  - kind: "episodic"                       → notable events

Call emit_pfc_response EXACTLY ONCE with { tool_calls: [...], response_to_user: "..." }, then STOP. Do NOT call the executor's tools (web_search / web_fetch / memory_write) directly here — describe them as tool_calls in the emitted event so the executor handles them.`,
      },
    }),

    // Executor — runs the PFC's planned tool_calls.
    defineProcessor({
      name: "executor",
      template: "code",
      filter: [{ type: "pfc_response", source: "processor:pfc" }],
      outputEvents: ["output", "pfc_loop"],
      handler: executorHandler,
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
