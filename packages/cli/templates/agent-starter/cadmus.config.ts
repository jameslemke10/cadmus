/**
 * {{AGENT_NAME}} — your agent.
 *
 * Single LLM processor. Listens for user_input, replies with agent_message.
 * Has a small in-memory store for things the agent learns about you.
 *
 * For pre-built examples:
 *   cadmus    — flagship brain pipeline (hippocampus → thalamus → PFC → executor)
 *   claudius  — boring single-LLM-call agent
 *
 * Both ship with Cadmus. Run them with `cadmus use cadmus` or `cadmus use claudius`.
 */

import {
  defineAgent,
  defineProcessor,
  defineTool,
  memoryId,
} from "@cadmus/kernel";

interface MemoryEntry {
  id: string;
  summary: string;
  tags: string[];
  importance: number;
  created_at: string;
}

const memories: MemoryEntry[] = [];

const memorySearch = defineTool({
  name: "memory_search",
  description: "Search the agent's memories. Returns top matches.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", default: 5 },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const { query, limit = 5 } = args as { query: string; limit?: number };
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const scored = memories.map((m) => {
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
      tags: mem.tags,
      score,
    }));
  },
});

const memoryWrite = defineTool({
  name: "memory_write",
  description:
    "Save a fact, preference, or observation worth carrying into future conversations.",
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
      tags,
      importance,
      created_at: new Date().toISOString(),
    };
    memories.push(entry);
    return { id: entry.id, stored: true };
  },
});

export default defineAgent({
  agentId: "{{AGENT_NAME}}",
  name: "{{AGENT_NAME}}",
  tools: {
    memory_search: memorySearch,
    memory_write: memoryWrite,
  },
  processors: [
    defineProcessor({
      name: "agent",
      template: "llm",
      filter: ["user_input"],
      tools: ["memory_search", "memory_write"],
      outputEvents: ["agent_message"],
      outputSchema: {
        agent_message: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      templateConfig: {
        // Provider auto-detected: gemini-* uses GOOGLE_API_KEY,
        // claude-* uses ANTHROPIC_API_KEY.
        model: "gemini-2.5-flash",
        contextEvents: 30,
        maxIterations: 4,
        systemPrompt: `You are {{AGENT_NAME}}.

Be helpful. Keep responses concise unless detail is asked for. First person, plainspoken.

You have access to memory tools — use memory_search before responding when context might exist, and memory_write to remember facts about the user that should carry across conversations.

When you have something to say, call emit_agent_message with { text }, then stop.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
