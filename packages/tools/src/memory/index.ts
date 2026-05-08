/**
 * Memory tools — search, write, list against a JSON-backed persistent store.
 *
 * Designed to be the default. Swap the storage backend with a vector DB or
 * Postgres later by reimplementing the same three tool surfaces.
 */

import { defineTool, memoryId } from "@cadmus/kernel";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface MemoryEntry {
  id: string;
  summary: string;
  tags: string[];
  importance: number;
  created_at: string;
}

export interface MemoryStoreOptions {
  /** Path to the JSON file used for storage. Default: ./.cadmus/memories.json */
  path?: string;
}

export function createMemoryStore(options: MemoryStoreOptions = {}) {
  const path = resolve(options.path ?? ".cadmus/memories.json");
  let memories: MemoryEntry[] = load();

  function load(): MemoryEntry[] {
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as MemoryEntry[];
    } catch {
      return [];
    }
  }
  function save(): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(memories, null, 2));
  }

  const memorySearch = defineTool({
    name: "memory_search",
    description:
      "Search persistent memories by free-text query. Memories survive across sessions.",
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
      "Save a new memory: a fact, preference, or observation worth carrying into future conversations.",
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
      save();
      return { id: entry.id, stored: true };
    },
  });

  const memoryList = defineTool({
    name: "memory_list",
    description: "List the N most recent memories.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", default: 10 } },
    },
    handler: async (args) => {
      const { limit = 10 } = (args as { limit?: number }) ?? {};
      const sorted = [...memories].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return sorted.slice(0, limit);
    },
  });

  return { memorySearch, memoryWrite, memoryList };
}
