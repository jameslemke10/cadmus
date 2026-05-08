/**
 * Claudius — the boring agent. As close to a Claude-style chat assistant
 * as we can get on top of Cadmus.
 *
 * One PFC processor that loops user_input → tool calls → tool results →
 * response, with two boundary events that mirror Claude's lifecycle:
 *
 *   session_started        — clear the model's view of prior turns.
 *                            (analogous to /clear in Claude Code)
 *   conversation_compacted — collapse earlier context into a summary.
 *                            (analogous to Claude's automatic compaction)
 *
 * Both are honored by the PFC's `sessionEvents` config: the model only
 * sees events at or after the most recent boundary. Memory persists
 * across sessions in a JSON file so it actually carries over.
 *
 * Inject either event from Studio's chat input or via curl:
 *   curl -X POST http://localhost:4000/api/inject \
 *     -H 'content-type: application/json' \
 *     -d '{"type":"session_started","data":{"reason":"new topic"}}'
 *
 * Pipeline:
 *   user_input ─────────┐
 *   tool_result ────────┤
 *   session_started ────┼─▶ pfc (llm + memory tools) ─▶ agent_message
 *   conversation_       │       │
 *   compacted ──────────┘       └─▶ tool_called → tool_result ─▶ pfc loops
 */

import {
  defineAgent,
  defineProcessor,
  defineTool,
  memoryId,
} from "@cadmus/kernel";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

// ── Persistent memory store ──────────────────────────────────────────────

interface MemoryEntry {
  id: string;
  summary: string;
  tags: string[];
  importance: number;
  created_at: string;
}

const MEMORIES_PATH = resolve(process.cwd(), ".cadmus", "memories.json");

function loadMemories(): MemoryEntry[] {
  if (!existsSync(MEMORIES_PATH)) return [];
  try {
    return JSON.parse(readFileSync(MEMORIES_PATH, "utf8")) as MemoryEntry[];
  } catch {
    return [];
  }
}

function saveMemories(memories: MemoryEntry[]): void {
  mkdirSync(dirname(MEMORIES_PATH), { recursive: true });
  writeFileSync(MEMORIES_PATH, JSON.stringify(memories, null, 2));
}

const memories: MemoryEntry[] = loadMemories();

const memorySearch = defineTool({
  name: "memory_search",
  description:
    "Search persistent memories by free-text query. Memories survive across sessions and kernel restarts.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for." },
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
    "Save a new memory: a fact, preference, or observation worth carrying into future conversations. Persists to disk.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "The memory in one or two sentences, written so future-you can use it as context.",
      },
      tags: { type: "array", items: { type: "string" } },
      importance: {
        type: "number",
        description: "0–1. How load-bearing this memory is.",
        default: 0.5,
      },
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
    saveMemories(memories);
    return { id: entry.id, stored: true };
  },
});

const memoryList = defineTool({
  name: "memory_list",
  description:
    "List the N most recent memories. Useful for orientation at the start of a new session.",
  input_schema: {
    type: "object",
    properties: { limit: { type: "number", default: 10 } },
  },
  handler: async (args) => {
    const { limit = 10 } = (args as { limit?: number }) ?? {};
    const sorted = [...memories].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return sorted.slice(0, limit).map((m) => ({
      id: m.id,
      summary: m.summary,
      tags: m.tags,
      importance: m.importance,
      created_at: m.created_at,
    }));
  },
});

// ── A few "real" tools the PFC can call ──────────────────────────────────

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

// ── The agent ────────────────────────────────────────────────────────────

export default defineAgent({
  agentId: "claudius",
  name: "Claudius",
  tools: {
    memory_search: memorySearch,
    memory_write: memoryWrite,
    memory_list: memoryList,
    calculate,
    get_current_time: getCurrentTime,
  },
  processors: [
    defineProcessor({
      name: "pfc",
      template: "llm",
      filter: ["user_input", "tool_result", "session_started", "conversation_compacted"],
      tools: ["memory_search", "memory_write", "memory_list", "calculate", "get_current_time"],
      outputEvents: ["agent_message"],
      outputSchema: {
        agent_message: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 80,
        maxIterations: 6,
        // The two boundary events that reset the model's view of the past.
        sessionEvents: ["session_started", "conversation_compacted"],
        systemPrompt: `You are Claudius — a friendly, capable assistant. You are running inside the Cadmus framework.

How you operate:
- Each turn, you see the recent timeline since the last session boundary (a session_started or conversation_compacted event). You don't see anything older. Don't reference earlier conversations directly unless you can find them via memory_search.
- You have a persistent memory that DOES survive across sessions. Search it (memory_search) when context might exist. Write to it (memory_write) when the user tells you something worth remembering — names, preferences, ongoing goals, decisions.
- When you have something to say to the user, call emit_agent_message with { text }, then stop.

When session_started arrives, you're in a new conversation. A quick memory_list or memory_search at the start of the first response is often the right move.

When conversation_compacted arrives, the system has summarized the earlier conversation into the event's data. Treat that summary as authoritative context for what came before.

Voice: plainspoken, first person, concise unless detail is asked for. No "as an AI". No disclaimers.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
