import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CadmusEvent, TimelineReader } from "./types.js";

type Row = {
  id: string;
  seq: number;
  timestamp: string;
  type: string;
  agent_id: string;
  session_id: string | null;
  data: string;
  parent_event_id: string | null;
  tags: string;
};

function rowToEvent(row: Row): CadmusEvent {
  return {
    id: row.id,
    seq: row.seq,
    timestamp: row.timestamp,
    type: row.type,
    agent_id: row.agent_id,
    session_id: row.session_id,
    data: JSON.parse(row.data) as Record<string, unknown>,
    parent_event_id: row.parent_event_id,
    tags: JSON.parse(row.tags) as string[],
  };
}

export class Timeline implements TimelineReader {
  private db: Database.Database;
  private listeners: Set<(event: CadmusEvent) => void> = new Set();

  constructor(public readonly path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        data TEXT NOT NULL,
        parent_event_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);
    `);
    // Migration: pre-v1 timelines did not have session_id. Try to add it.
    try {
      this.db.exec("ALTER TABLE events ADD COLUMN session_id TEXT");
    } catch {
      // column already exists — fine
    }
    this.db.pragma("user_version = 1");
  }

  append(event: Omit<CadmusEvent, "seq">): CadmusEvent {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, timestamp, type, agent_id, session_id, data, parent_event_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.id,
      event.timestamp,
      event.type,
      event.agent_id,
      event.session_id,
      JSON.stringify(event.data),
      event.parent_event_id,
      JSON.stringify(event.tags),
    );
    const stored: CadmusEvent = { ...event, seq: Number(result.lastInsertRowid) };
    queueMicrotask(() => {
      for (const listener of this.listeners) {
        try {
          listener(stored);
        } catch {
          // listener errors are isolated
        }
      }
    });
    return stored;
  }

  subscribe(callback: (event: CadmusEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  recent(limit: number, filter?: { types?: string[]; agentId?: string; sessionId?: string }): CadmusEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter?.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter?.types && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => "?").join(",")})`);
      params.push(...filter.types);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Row[];
    return rows.reverse().map(rowToEvent);
  }

  byId(id: string): CadmusEvent | null {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  latest(type: string): CadmusEvent | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1")
      .get(type) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  all(filter?: { types?: string[]; agentId?: string; sessionId?: string }): CadmusEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter?.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter?.types && filter.types.length > 0) {
      clauses.push(`type IN (${filter.types.map(() => "?").join(",")})`);
      params.push(...filter.types);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM events ${where} ORDER BY seq ASC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(rowToEvent);
  }

  since(seq: number, limit = 500): CadmusEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(seq, limit) as Row[];
    return rows.map(rowToEvent);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}
