/**
 * Cadmus — the brain agent.
 *
 * The flagship example. Named for the Phoenician prince of myth: the man
 * credited with bringing the alphabet to Greece, the dragon-slayer who
 * founded Thebes from the teeth he sowed. He has been given a new form
 * here — an agentic framework — and a new conquest: helping people build
 * agents that push the world forward.
 *
 * Architecturally: five processors chained on each other's custom events,
 * NOT on tool_result. The runtime auto-emits tool_call/tool_result around
 * every ctx.callTool, so filtering on those would cause self-triggering
 * loops. Each processor instead listens for the prior stage's named output:
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
 *                                                  (when PFC needs more work)
 *
 * Thalamus uses a source-constrained filter to demonstrate v1.x's
 * attribution-aware filtering: `{ type, source: "processor:hippocampus" }`.
 * That's overkill with one hippocampus, but lets you add a second
 * (hippocampus_pii, hippocampus_general) later without rewiring downstream.
 *
 * Memory lives in SQLite via @cadmus/tools/memory. The Cadmus persona is
 * carried in the PFC's system prompt; richer identity / mythology
 * memories accumulate via memory_write tool calls.
 *
 * For the boring single-processor agent, see ../claudius.
 */

import {
  defineAgent,
  defineProcessor,
  defineTool,
  type CadmusEvent,
  type ProcessorContext,
} from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";

const memory = createMemory({ path: ".cadmus/memory.db" });

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

const getCurrentTime = defineTool({
  name: "get_current_time",
  description: "Return the current ISO 8601 timestamp.",
  input_schema: { type: "object", properties: {} },
  handler: async () => ({ now: new Date().toISOString() }),
});

/**
 * Executor — dispatches the PFC's planned tool_calls, emits the user-facing
 * output if PFC produced one, and emits pfc_loop if PFC produced tool_calls
 * but no response_to_user (i.e., the LLM wants another reasoning pass once
 * results come back).
 *
 * Safety: caps the loop at 3 cycles via the trigger event chain depth so a
 * runaway PFC can't burn infinite tokens.
 */
async function executorHandler(event: CadmusEvent, ctx: ProcessorContext): Promise<void> {
  const data = event.data as {
    tool_calls?: Array<{ tool: string; args: Record<string, unknown> }>;
    response_to_user?: string;
  };

  const responseText = (data.response_to_user ?? "").trim();
  const toolCalls = data.tool_calls ?? [];

  // 1) If PFC produced a user-facing message, deliver it.
  if (responseText) {
    await ctx.emit("output", {
      channel: "*",
      kind: "text",
      text: responseText,
    });
  }

  // 2) Run any tool_calls the PFC asked for. The runtime auto-emits
  //    tool_call/tool_result around each callTool invocation.
  for (const call of toolCalls) {
    try {
      await ctx.callTool(call.tool, call.args);
    } catch {
      // Failure already recorded by the runtime's auto-emitted tool_result.
    }
  }

  // 3) Decide whether to loop. PFC didn't say anything to the user and
  //    ran some tools → it probably needs another pass with the results.
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

/** Count pfc_loop events between the original input and the current trigger. */
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
    ...memory.tools,
    calculate,
    get_current_time: getCurrentTime,
  },
  processors: [
    // Hippocampus — retrieves relevant memories.
    // Triggers: a fresh user message, or executor signaling the PFC wants another pass.
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
4. Call emit_memory_retrieved with { queries: [...], results: [...] } containing the merged, deduplicated, ranked results.
5. Stop.

Be parsimonious. Three searches max. The downstream thalamus will decide what makes it into working memory.`,
      },
    }),

    // Thalamus — assembles working memory.
    // Source-constrained filter: only fires for memory_retrieved events from the hippocampus.
    // If someone adds hippocampus_pii / hippocampus_general later, this stays correct.
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

Call emit_working_memory_updated with { conversation_history, current_goal, relevant_memories, recent_results }. Then stop.`,
      },
    }),

    // PFC — the conscious reasoner. Triggers only on working_memory_updated from the thalamus.
    defineProcessor({
      name: "pfc",
      template: "llm",
      filter: [{ type: "working_memory_updated", source: "processor:thalamus" }],
      tools: ["calculate", "get_current_time", "memory_write"],
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
- tool_calls: actions the executor should run (e.g. calculate, get_current_time, memory_write).
- response_to_user: a message to the user — your actual reply.

Looping: if you set tool_calls but leave response_to_user empty, the executor will run the tools and re-trigger the pipeline so you can react to the results. Set response_to_user when you're ready to talk to the user; that ends the loop.

Memory writes are first-class:
  - kind: "semantic", tags: ["identity"]   → facts about yourself
  - kind: "semantic", tags: ["preference"] → user preferences
  - kind: "procedural"                     → how-to / skills
  - kind: "episodic"                       → notable events

Call emit_pfc_response exactly once with { tool_calls: [...], response_to_user: "..." }, then STOP. Do NOT call calculate / get_current_time / memory_write directly — describe them as tool_calls. Do not loop within an iteration.`,
      },
    }),

    // Executor — runs the PFC's planned tool_calls. Code processor, no LLM.
    // Emits `output` when PFC has a response_to_user, and `pfc_loop` when PFC
    // ran tools but didn't yet respond.
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
