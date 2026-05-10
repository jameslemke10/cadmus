/**
 * Cadmus — the brain agent.
 *
 * The flagship example. Named for the Phoenician prince of myth: the man
 * credited with bringing the alphabet to Greece, the dragon-slayer who
 * founded Thebes from the teeth he sowed. He has been given a new form
 * here — an agentic framework — and a new conquest: helping people build
 * agents that push the world forward.
 *
 * Architecturally: five processors mapping onto a useful slice of brain
 * function.
 *
 *   input ──────┐
 *   tool_result ┼─▶ hippocampus (llm) ─▶ memory_retrieved
 *               │   retrieves relevant memories from the store
 *               ▼
 *           thalamus (llm) ─▶ working_memory_updated
 *               │   compresses conversation, picks relevant memories,
 *               │   assembles working memory for the PFC
 *               ▼
 *           pfc (llm, the conscious reasoner, has the persona) ─▶ pfc_response
 *               │   plans, reasons, decides on tool calls and responses
 *               ▼
 *           executor (code) ─▶ tool_call ─▶ tool_result  OR  output
 *               just runs the actions, no LLM
 *
 * Memory lives in SQLite via @cadmus/tools/memory. The Cadmus persona is
 * carried in the PFC's system prompt; richer identity / mythology
 * memories accumulate organically as conversations happen, written via
 * memory_write with kind: "semantic" + tags: ["identity"].
 *
 * For the boring single-processor agent that mirrors current frameworks,
 * see ../claudius. The framework supports both shapes; this is the more
 * powerful one.
 */

import {
  defineAgent,
  defineProcessor,
  defineTool,
  type CadmusEvent,
  type ProcessorContext,
} from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";

// ── Persistent SQLite-backed memory store + canonical tools ──────────────

const memory = createMemory({ path: ".cadmus/memory.db" });

// ── Toy "real" tools the PFC can use ────────────────────────────────────

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

// ── The executor (code processor) ───────────────────────────────────────
//
// The runtime auto-emits tool_call/tool_result around ctx.callTool, paired
// by call_id. This handler just dispatches the PFC's tool_calls and emits
// any user-facing message as `output`.

async function executorHandler(event: CadmusEvent, ctx: ProcessorContext): Promise<void> {
  const data = event.data as {
    tool_calls?: Array<{ tool: string; args: Record<string, unknown> }>;
    response_to_user?: string;
  };

  if (data.response_to_user && data.response_to_user.trim()) {
    await ctx.emit("output", {
      channel: "*",
      kind: "text",
      text: data.response_to_user,
    });
  }

  if (data.tool_calls && data.tool_calls.length > 0) {
    for (const call of data.tool_calls) {
      try {
        await ctx.callTool(call.tool, call.args);
      } catch {
        // Failure already recorded by the runtime's auto-emitted tool_result.
      }
    }
  }
}

// ── The agent ───────────────────────────────────────────────────────────

export default defineAgent({
  agentId: "cadmus",
  name: "Cadmus",
  tools: {
    ...memory.tools,                // memory_search, memory_write, memory_delete
    calculate,
    get_current_time: getCurrentTime,
  },
  processors: [
    // Hippocampus — retrieves relevant memories.
    defineProcessor({
      name: "hippocampus",
      template: "llm",
      filter: ["input", "tool_result", "subconscious_surfaced"],
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
4. Call emit_memory_retrieved with { queries: [...], results: [...] } containing the merged, deduplicated, ranked results. Each result has id, kind, content, tags, importance, score.
5. Stop.

Be parsimonious. Three searches max. The downstream thalamus will decide what makes it into working memory.`,
      },
    }),

    // Thalamus — assembles working memory.
    defineProcessor({
      name: "thalamus",
      template: "llm",
      filter: ["memory_retrieved"],
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

    // PFC — the conscious reasoner. Plans, calls tools, drafts responses.
    defineProcessor({
      name: "pfc",
      template: "llm",
      filter: ["working_memory_updated"],
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
        model: "gemini-2.5-flash", // swap to a larger model in production
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

You have two outputs:
- tool_calls: actions the executor should run (e.g. calculate, get_current_time, memory_write). The executor will run them; results come back as tool_result events that re-trigger the pipeline.
- response_to_user: a message to the user — your actual reply.

You can do BOTH in one turn — emit a pfc_response with tool_calls AND response_to_user.

Memory writes are first-class actions. Use memory_write through tool_calls to remember things worth carrying forward:
  - kind: "semantic", tags: ["identity"]   → facts about yourself ("I am Cadmus...")
  - kind: "semantic", tags: ["preference"] → user preferences
  - kind: "procedural"                     → how-to / skills
  - kind: "episodic"                       → notable events

When you are ready, call emit_pfc_response exactly once with { tool_calls: [...], response_to_user: "..." }, then STOP. Do NOT call calculate / get_current_time / memory_write directly — describe them as tool_calls so the executor handles them. Do not loop.`,
      },
    }),

    // Executor — runs the tool calls from the PFC. Code processor, no LLM.
    // tool_call and tool_result events are emitted by the runtime around
    // ctx.callTool, not by this processor.
    defineProcessor({
      name: "executor",
      template: "code",
      filter: ["pfc_response"],
      outputEvents: ["output"],
      handler: executorHandler,
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
