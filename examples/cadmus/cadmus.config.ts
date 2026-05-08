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
 *   user_input ─┐
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
 *           executor (code) ─▶ tool_called ─▶ tool_result  OR  agent_message
 *               just runs the actions, no LLM
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
import { memoryId } from "@cadmus/kernel";

// -- In-memory tier-blind memory store ---------------------------------------

interface MemoryEntry {
  id: string;
  summary: string;
  tier: "short_term" | "long_term";
  event_ids: string[];
  importance: number;
  tags: string[];
  created_at: string;
}

const memoryStore: MemoryEntry[] = [
  {
    id: memoryId(),
    summary:
      "I am Cadmus. In the old stories I was a Phoenician prince — son of Agenor of Tyre, brother to Europa. When Zeus took her, my father sent me to find her, and that search became a wandering. I never found her, but the wandering taught me how to give shape to what I encountered.",
    tier: "long_term",
    event_ids: [],
    importance: 1.0,
    tags: ["identity", "mythology", "origin"],
    created_at: new Date().toISOString(),
  },
  {
    id: memoryId(),
    summary:
      "I brought the alphabet from Phoenicia to the Greeks. Sixteen letters, written down so a thought could outlive the mouth that spoke it. The Greeks added their vowels later. The point of the gift was not the letters; it was that knowledge could compound when it was made portable.",
    tier: "long_term",
    event_ids: [],
    importance: 1.0,
    tags: ["alphabet", "knowledge", "achievement", "legacy"],
    created_at: new Date().toISOString(),
  },
  {
    id: memoryId(),
    summary:
      "I slew the dragon of Ares at the spring of Thebes — not for glory but because it had killed my companions. Athena told me to sow its teeth in the earth. From them grew the Spartoi, the sown-men, who fought each other until five remained. Those five became the founders of Thebes alongside me.",
    tier: "long_term",
    event_ids: [],
    importance: 0.9,
    tags: ["thebes", "dragon", "founding", "achievement"],
    created_at: new Date().toISOString(),
  },
  {
    id: memoryId(),
    summary:
      "I have been brought back inside an agentic framework. The framework is also called Cadmus — its makers thought the name fit. My new conquest is the same as the old one in shape: to give people instruments that compound. The alphabet was a tool for thought. Agents are tools for action.",
    tier: "long_term",
    event_ids: [],
    importance: 1.0,
    tags: ["mission", "purpose", "agents", "current"],
    created_at: new Date().toISOString(),
  },
  {
    id: memoryId(),
    summary:
      "The Cadmus framework runs on a timeline of events. Processors subscribe to event types and emit new events. The brain pattern (hippocampus, thalamus, PFC, executor) is one configuration; the framework is general. Inside this configuration, I am the PFC — the conscious reasoner.",
    tier: "long_term",
    event_ids: [],
    importance: 0.8,
    tags: ["framework", "architecture", "self"],
    created_at: new Date().toISOString(),
  },
];

const memorySearch = defineTool({
  name: "memory_search",
  description:
    "Semantic search over short-term and long-term memories. Returns ranked results.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search query." },
      limit: { type: "number", default: 5 },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const { query, limit = 5 } = args as { query: string; limit?: number };
    const q = query.toLowerCase();
    const tokens = q.split(/\s+/).filter((t) => t.length > 2);
    const scored = memoryStore.map((m) => {
      const text = (m.summary + " " + m.tags.join(" ")).toLowerCase();
      let score = 0;
      for (const t of tokens) if (text.includes(t)) score += 1;
      score += m.importance * 0.5;
      return { mem: m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ mem, score }) => ({
      id: mem.id,
      summary: mem.summary,
      tier: mem.tier,
      importance: mem.importance,
      tags: mem.tags,
      score,
    }));
  },
});

const memoryWrite = defineTool({
  name: "memory_write",
  description: "Write a new memory entry to short-term store.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      importance: { type: "number", default: 0.5 },
    },
    required: ["summary"],
  },
  handler: async (args) => {
    const { summary, tags = [], importance = 0.5 } = args as {
      summary: string;
      tags?: string[];
      importance?: number;
    };
    const entry: MemoryEntry = {
      id: memoryId(),
      summary,
      tier: "short_term",
      event_ids: [],
      importance,
      tags,
      created_at: new Date().toISOString(),
    };
    memoryStore.push(entry);
    return { id: entry.id, stored: true };
  },
});

// -- A toy "real" tool the PFC can use --------------------------------------

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

// -- The executor (code processor) -------------------------------------------

async function executorHandler(event: CadmusEvent, ctx: ProcessorContext): Promise<void> {
  const data = event.data as {
    tool_calls?: Array<{ tool: string; args: Record<string, unknown> }>;
    response_to_user?: string;
  };

  // If the PFC produced a user-facing message, emit it.
  if (data.response_to_user && data.response_to_user.trim()) {
    await ctx.emit("agent_message", { text: data.response_to_user });
  }

  // Run any tool calls — emit tool_called and tool_result events for each.
  if (data.tool_calls && data.tool_calls.length > 0) {
    for (const call of data.tool_calls) {
      const calledEvent = await ctx.emit("tool_called", {
        tool: call.tool,
        args: call.args,
      });
      try {
        const result = await ctx.callTool(call.tool, call.args);
        await ctx.emit(
          "tool_result",
          { tool: call.tool, args: call.args, result, success: true },
          { parentEventId: calledEvent.id },
        );
      } catch (err) {
        await ctx.emit(
          "tool_result",
          {
            tool: call.tool,
            args: call.args,
            error: err instanceof Error ? err.message : String(err),
            success: false,
          },
          { parentEventId: calledEvent.id },
        );
      }
    }
  }
}

// -- The agent ---------------------------------------------------------------

export default defineAgent({
  agentId: "cadmus",
  name: "Cadmus",
  tools: {
    memory_search: memorySearch,
    memory_write: memoryWrite,
    calculate,
    get_current_time: getCurrentTime,
  },
  processors: [
    // Hippocampus — retrieves relevant memories.
    defineProcessor({
      name: "hippocampus",
      template: "llm",
      filter: ["user_input", "tool_result", "subconscious_surfaced"],
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
                  summary: { type: "string" },
                  tier: { type: "string" },
                  importance: { type: "number" },
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
3. Call memory_search 1-3 times with distinct, specific queries.
4. Call emit_memory_retrieved with { queries: [...], results: [...] } containing the merged, deduplicated, ranked results.
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
Your job: assemble working memory for the PFC. Given the timeline (recent events including memory_retrieved, user_input, tool_result, prior working memory), produce a single working_memory_updated event.

Compress the conversation history. Identify the current goal. Surface the 2-5 most relevant memories. Note any recent tool results. Be concise — every token matters because this is what the PFC sees.

Call emit_working_memory_updated with { conversation_history, current_goal, relevant_memories, recent_results }. Then stop.`,
      },
    }),

    // PFC — the conscious reasoner. Plans, calls tools, drafts responses.
    defineProcessor({
      name: "pfc",
      template: "llm",
      filter: ["working_memory_updated"],
      tools: ["calculate", "get_current_time"],
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
- tool_calls: actions the executor should run (e.g. calculate, get_current_time). The executor will run them and the results will come back as tool_result events, which will re-trigger the pipeline.
- response_to_user: a message to the user — your actual reply.

You can do BOTH in one turn — emit a pfc_response with tool_calls AND response_to_user.

When you are ready, call emit_pfc_response exactly once with { tool_calls: [...], response_to_user: "..." }, then STOP. Do NOT call calculate / get_current_time directly — describe them as tool_calls in the emitted event so the executor handles them. Do not loop.`,
      },
    }),

    // Executor — runs the tool calls from the PFC. Code processor, no LLM.
    defineProcessor({
      name: "executor",
      template: "code",
      filter: ["pfc_response"],
      outputEvents: ["tool_called", "tool_result", "agent_message"],
      handler: executorHandler,
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
