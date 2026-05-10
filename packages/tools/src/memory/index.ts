/**
 * Memory tools — SQLite reference implementation of MemoryStore + the three
 * canonical tools (memory_search, memory_write, memory_delete).
 *
 * Three canonical kinds:
 *   - "procedural" — skills, how-to, learned patterns
 *   - "semantic"   — facts about self / world / users (identity uses tags: ["identity"])
 *   - "episodic"   — events, what happened, when
 *
 * Custom kinds are allowed but break portability with tools that expect canonical values.
 *
 * Usage:
 *   import { createMemory } from "@cadmus/tools/memory";
 *   const memory = createMemory({ path: ".cadmus/memory.db" });
 *   defineAgent({ tools: { ...memory.tools }, ... });
 *
 * For direct backend access (rare — prefer tools), use memory.store.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool, memoryId } from "@cadmus/kernel";
import type {
  MemoryFilter,
  MemoryRecord,
  MemorySearchArgs,
  MemorySearchHit,
  MemoryStats,
  MemoryStore,
  MemoryWrite,
  Tool,
} from "@cadmus/kernel";

export interface CreateMemoryOptions {
  /** Path to the SQLite memory database. Default: ".cadmus/memory.db". Use ":memory:" for in-process testing. */
  path?: string;
}

export interface Memory {
  store: MemoryStore;
  tools: Record<string, Tool>;
}

export function createMemory(options: CreateMemoryOptions = {}): Memory {
  const store = createSqliteMemoryStore(options);
  const tools = createMemoryTools(store);
  return { store, tools };
}

// ──── SQLite-backed MemoryStore ───────────────────────────────────────────

type Row = {
  id: string;
  kind: string;
  content: string;
  scope_tenant_id: string | null;
  scope_agent_id: string | null;
  scope_session_id: string | null;
  tags: string;
  importance: number;
  created_at: string;
  last_accessed_at: string;
  expires_at: string | null;
  provenance: string;
};

function rowToRecord(row: Row): MemoryRecord {
  const scope: MemoryRecord["scope"] = {};
  if (row.scope_tenant_id) scope.tenant_id = row.scope_tenant_id;
  if (row.scope_agent_id) scope.agent_id = row.scope_agent_id;
  if (row.scope_session_id) scope.session_id = row.scope_session_id;
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    scope,
    tags: JSON.parse(row.tags) as string[],
    importance: row.importance,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    expires_at: row.expires_at ?? undefined,
    provenance: JSON.parse(row.provenance) as MemoryRecord["provenance"],
  };
}

export function createSqliteMemoryStore(options: CreateMemoryOptions = {}): MemoryStore {
  const path = options.path ?? ".cadmus/memory.db";
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      scope_tenant_id TEXT,
      scope_agent_id TEXT,
      scope_session_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      expires_at TEXT,
      provenance TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_records(kind);
    CREATE INDEX IF NOT EXISTS idx_memory_scope_agent ON memory_records(scope_agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_scope_session ON memory_records(scope_session_id);
  `);
  db.pragma("user_version = 1");

  return {
    async search(args: MemorySearchArgs): Promise<MemorySearchHit[]> {
      const limit = args.limit ?? 10;
      const minScore = args.min_score ?? 0;
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (args.kind) {
        clauses.push("kind = ?");
        params.push(args.kind);
      }
      if (args.scope?.tenant_id) {
        clauses.push("scope_tenant_id = ?");
        params.push(args.scope.tenant_id);
      }
      if (args.scope?.agent_id) {
        clauses.push("scope_agent_id = ?");
        params.push(args.scope.agent_id);
      }
      if (args.scope?.session_id) {
        clauses.push("scope_session_id = ?");
        params.push(args.scope.session_id);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT * FROM memory_records ${where}`).all(...params) as Row[];

      // Score by token-match ratio + importance. (LIKE-style — full-text via FTS5 deferred to v1.x.)
      const tokens = args.query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1);
      const scored = rows.map((row) => {
        const haystack = (row.content + " " + (JSON.parse(row.tags) as string[]).join(" ")).toLowerCase();
        let matches = 0;
        for (const t of tokens) if (haystack.includes(t)) matches++;
        const matchScore = tokens.length > 0 ? matches / tokens.length : 0;
        // 70% query-match, 30% importance.
        const score = matchScore * 0.7 + row.importance * 0.3;
        return { row, score };
      });

      // Tag filter: every requested tag must be present.
      const filtered = args.tags && args.tags.length > 0
        ? scored.filter(({ row }) => {
            const rowTags = JSON.parse(row.tags) as string[];
            return args.tags!.every((t) => rowTags.includes(t));
          })
        : scored;

      filtered.sort((a, b) => b.score - a.score);
      return filtered
        .filter(({ score }) => score >= minScore)
        .slice(0, limit)
        .map(({ row, score }) => ({ ...rowToRecord(row), score }));
    },

    async get(id: string): Promise<MemoryRecord | null> {
      const row = db.prepare("SELECT * FROM memory_records WHERE id = ?").get(id) as Row | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      db.prepare("UPDATE memory_records SET last_accessed_at = ? WHERE id = ?").run(now, id);
      const rec = rowToRecord(row);
      rec.last_accessed_at = now;
      return rec;
    },

    async write(input: MemoryWrite): Promise<MemoryRecord> {
      if (
        !input.provenance ||
        !Array.isArray(input.provenance.source_event_ids) ||
        input.provenance.source_event_ids.length === 0
      ) {
        throw new Error("memory write rejected: provenance.source_event_ids is required and must be non-empty");
      }
      const id = input.id ?? memoryId();
      const now = new Date().toISOString();
      const existing = db
        .prepare("SELECT created_at FROM memory_records WHERE id = ?")
        .get(id) as { created_at: string } | undefined;
      const created_at = existing?.created_at ?? now;

      db.prepare(
        `INSERT INTO memory_records
          (id, kind, content, scope_tenant_id, scope_agent_id, scope_session_id,
           tags, importance, created_at, last_accessed_at, expires_at, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           content = excluded.content,
           scope_tenant_id = excluded.scope_tenant_id,
           scope_agent_id = excluded.scope_agent_id,
           scope_session_id = excluded.scope_session_id,
           tags = excluded.tags,
           importance = excluded.importance,
           last_accessed_at = excluded.last_accessed_at,
           expires_at = excluded.expires_at,
           provenance = excluded.provenance`,
      ).run(
        id,
        input.kind,
        input.content,
        input.scope?.tenant_id ?? null,
        input.scope?.agent_id ?? null,
        input.scope?.session_id ?? null,
        JSON.stringify(input.tags ?? []),
        input.importance ?? 0.5,
        created_at,
        now,
        input.expires_at ?? null,
        JSON.stringify(input.provenance),
      );

      return {
        id,
        kind: input.kind,
        content: input.content,
        scope: input.scope ?? {},
        tags: input.tags ?? [],
        importance: input.importance ?? 0.5,
        created_at,
        last_accessed_at: now,
        expires_at: input.expires_at,
        provenance: input.provenance,
      };
    },

    async forget(filter: MemoryFilter): Promise<number> {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.ids && filter.ids.length > 0) {
        clauses.push(`id IN (${filter.ids.map(() => "?").join(",")})`);
        params.push(...filter.ids);
      }
      if (filter.kind) {
        clauses.push("kind = ?");
        params.push(filter.kind);
      }
      if (filter.scope?.tenant_id) {
        clauses.push("scope_tenant_id = ?");
        params.push(filter.scope.tenant_id);
      }
      if (filter.scope?.agent_id) {
        clauses.push("scope_agent_id = ?");
        params.push(filter.scope.agent_id);
      }
      if (filter.scope?.session_id) {
        clauses.push("scope_session_id = ?");
        params.push(filter.scope.session_id);
      }
      if (filter.expired === true) {
        clauses.push("expires_at IS NOT NULL AND expires_at < ?");
        params.push(new Date().toISOString());
      }
      if (clauses.length === 0) {
        throw new Error("memory_delete: at least one filter required (refusing to delete all records)");
      }
      // Tag filter post-query (JSON in column; no native filter).
      if (filter.tags && filter.tags.length > 0) {
        const where = `WHERE ${clauses.join(" AND ")}`;
        const rows = db.prepare(`SELECT id, tags FROM memory_records ${where}`).all(...params) as {
          id: string;
          tags: string;
        }[];
        const matchingIds = rows
          .filter((r) => {
            const rowTags = JSON.parse(r.tags) as string[];
            return filter.tags!.every((t) => rowTags.includes(t));
          })
          .map((r) => r.id);
        if (matchingIds.length === 0) return 0;
        const result = db
          .prepare(`DELETE FROM memory_records WHERE id IN (${matchingIds.map(() => "?").join(",")})`)
          .run(...matchingIds);
        return Number(result.changes);
      }
      const where = `WHERE ${clauses.join(" AND ")}`;
      const result = db.prepare(`DELETE FROM memory_records ${where}`).run(...params);
      return Number(result.changes);
    },

    async stats(): Promise<MemoryStats> {
      const counts = db
        .prepare("SELECT kind, COUNT(*) as n FROM memory_records GROUP BY kind")
        .all() as { kind: string; n: number }[];
      const count_by_kind: Record<string, number> = {};
      for (const c of counts) count_by_kind[c.kind] = c.n;
      const oldest = (db.prepare("SELECT MIN(created_at) as t FROM memory_records").get() as {
        t: string | null;
      }).t;
      const newest = (db.prepare("SELECT MAX(created_at) as t FROM memory_records").get() as {
        t: string | null;
      }).t;
      return {
        count_by_kind,
        oldest: oldest ?? undefined,
        newest: newest ?? undefined,
      };
    },

    close() {
      db.close();
    },
  };
}

// ──── Canonical tools wrapping any MemoryStore ────────────────────────────

export function createMemoryTools(store: MemoryStore): Record<string, Tool> {
  const memory_search = defineTool({
    name: "memory_search",
    description:
      "Search persistent memories by free-text query. Memories are scoped to this agent by default and survive across sessions. Use kind to filter by 'procedural' (skills/how-to), 'semantic' (facts), or 'episodic' (events).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query." },
        kind: {
          type: "string",
          description: "Optional: 'procedural' | 'semantic' | 'episodic' (or custom).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional: tags that must all be present on a record.",
        },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
    handler: async (args, ctx) => {
      const a = args as { query: string; kind?: string; tags?: string[]; limit?: number };
      const hits = await store.search({
        query: a.query,
        kind: a.kind,
        tags: a.tags,
        scope: { agent_id: ctx.agentId },
        limit: a.limit ?? 10,
      });
      return hits.map((h) => ({
        id: h.id,
        kind: h.kind,
        content: h.content,
        tags: h.tags,
        importance: h.importance,
        score: h.score,
      }));
    },
  });

  const memory_write = defineTool({
    name: "memory_write",
    description:
      "Write a memory record. Use 'procedural' for skills/how-to, 'semantic' for facts about self/world/users (use tags: ['identity'] for self-facts), 'episodic' for events. Same id = update, omit id = create.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional: existing memory id to update." },
        kind: {
          type: "string",
          description: "'procedural' | 'semantic' | 'episodic' (or custom).",
        },
        content: { type: "string", description: "The textual representation of the memory." },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number", description: "0..1. Default 0.5." },
        expires_at: { type: "string", description: "Optional ISO 8601 expiry." },
      },
      required: ["kind", "content"],
    },
    handler: async (args, ctx) => {
      const a = args as {
        id?: string;
        kind: string;
        content: string;
        tags?: string[];
        importance?: number;
        expires_at?: string;
      };
      const record = await store.write({
        id: a.id,
        kind: a.kind,
        content: a.content,
        tags: a.tags,
        importance: a.importance,
        expires_at: a.expires_at,
        scope: {
          agent_id: ctx.agentId,
          session_id: ctx.triggerEvent.session_id ?? undefined,
        },
        provenance: {
          source_event_ids: [ctx.triggerEvent.id],
          writer: "tool:memory_write",
        },
      });
      // Emit memory_write event so the timeline is the source of truth and
      // the store is rebuildable from replay.
      await ctx.emit("memory_write", {
        memory_id: record.id,
        kind: record.kind,
        content: record.content,
        scope: record.scope,
        tags: record.tags,
        importance: record.importance,
        expires_at: record.expires_at,
        provenance: record.provenance,
      });
      return { id: record.id, kind: record.kind, stored: true };
    },
  });

  const memory_delete = defineTool({
    name: "memory_delete",
    description:
      "Delete memory records. Provide ids, or filter by kind / tags / expired. Refuses an empty filter.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        kind: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        expired: { type: "boolean", description: "Delete records past expires_at." },
      },
    },
    handler: async (args, ctx) => {
      const a = args as { ids?: string[]; kind?: string; tags?: string[]; expired?: boolean };
      const removed = await store.forget({
        ids: a.ids,
        kind: a.kind,
        tags: a.tags,
        expired: a.expired,
        scope: { agent_id: ctx.agentId },
      });
      if (removed > 0) {
        await ctx.emit("memory_delete", {
          memory_ids: a.ids ?? [],
          reason: "user_request",
        });
      }
      return { deleted: removed };
    },
  });

  return { memory_search, memory_write, memory_delete };
}
