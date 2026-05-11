/**
 * Core types for the Cadmus runtime.
 *
 * The model is intentionally generic. The "brain" example (hippocampus,
 * thalamus, PFC, executor) is just one configuration of these primitives.
 */

export interface CadmusEvent {
  id: string;
  seq: number;
  timestamp: string;
  type: string;
  agent_id: string;
  session_id: string | null;
  /**
   * Attribution: who emitted this event. Set automatically by the runtime.
   * Conventional values:
   *   "processor:<name>"  — emitted by a processor via ctx.emit
   *   "tool:<name>"       — emitted by a tool handler via ctx.emit
   *   "channel:<name>"    — emitted by a channel via ctx.emit, or by
   *                         runtime.inject(text, channel) for that channel
   *   "kernel"            — emitted by the runtime itself (e.g., error)
   *   null                — appended by external code (tests, runtime.appendEvent
   *                         with no source provided)
   */
  source: string | null;
  data: Record<string, unknown>;
  parent_event_id: string | null;
  tags: string[];
}

export type EmitOptions = {
  parentEventId?: string | null;
  sessionId?: string | null;
  tags?: string[];
  /** Override the auto-attributed source. Rare — usually omit and let the runtime fill it. */
  source?: string;
};

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  agentId: string;
  /** The event that triggered the processor that called this tool. Lets tools
   *  default things like memory provenance, session_id, parent_event_id. */
  triggerEvent: CadmusEvent;
  /** Emit a new event onto the timeline. By default, parent_event_id is the
   *  surrounding tool_call, session_id inherits from the trigger, and
   *  source is `tool:<this tool's name>`. */
  emit: (type: string, data: Record<string, unknown>, opts?: EmitOptions) => Promise<CadmusEvent>;
  log: (msg: string, data?: unknown) => void;
}

export interface TimelineFilter {
  types?: string[];
  agentId?: string;
  sessionId?: string;
  source?: string;
}

/** Input to TimelineStore.append. id, seq, and timestamp are assigned by the store. */
export interface AppendInput {
  type: string;
  agent_id: string;
  data: Record<string, unknown>;
  session_id?: string | null;
  parent_event_id?: string | null;
  source?: string | null;
  tags?: string[];
}

export interface TimelineReader {
  recent(limit: number, filter?: TimelineFilter): CadmusEvent[];
  byId(id: string): CadmusEvent | null;
  latest(type: string): CadmusEvent | null;
  all(filter?: TimelineFilter): CadmusEvent[];
  count(): number;
}

/**
 * The full timeline contract. Anything implementing this is a valid backend.
 * The default SQLite-backed Timeline is the reference implementation.
 */
export interface TimelineStore extends TimelineReader {
  /** Append an event. id, seq, and timestamp are assigned by the store. Resolves with the persisted event. */
  append(input: AppendInput): Promise<CadmusEvent>;

  /** Subscribe to all newly-appended events. Listeners fire after persistence. Returns an unsubscribe function. */
  subscribe(listener: (event: CadmusEvent) => void): () => void;

  /** Read events with seq > the given seq. Used for SSE catch-up. */
  since(seq: number, limit?: number): CadmusEvent[];

  /**
   * Permanently delete events matching the filter. Returns count deleted.
   * Refuses an empty filter (would delete everything).
   */
  forget(filter: TimelineFilter): Promise<number>;
}

// ──── Memory ──────────────────────────────────────────────────────────────

/**
 * Provenance — where a memory came from. Mandatory on every record so that
 * the timeline-as-source-of-truth invariant holds: every memory traces back
 * to events that produced it.
 */
export interface MemoryProvenance {
  /** Timeline events that produced this memory. Required, non-empty. */
  source_event_ids: string[];
  /** Who wrote it. Convention: "tool:<name>" | "processor:<name>" | "mcp:<server>". */
  writer: string;
}

export interface MemoryScope {
  tenant_id?: string;
  agent_id?: string;
  session_id?: string;
}

/**
 * A memory record. The portable subset of these fields round-trips across
 * backends; backend-specific data (embeddings, internal indexes) is not
 * exposed here.
 */
export interface MemoryRecord {
  id: string;
  /** Canonical: "procedural" | "semantic" | "episodic". Custom kinds allowed. */
  kind: string;
  content: string;
  scope: MemoryScope;
  tags: string[];
  /** 0..1. Used for ranking and decay. */
  importance: number;
  created_at: string;
  last_accessed_at: string;
  expires_at?: string;
  provenance: MemoryProvenance;
}

/** Input to MemoryStore.write. id is optional (omit to create, supply to update). */
export interface MemoryWrite {
  id?: string;
  kind: string;
  content: string;
  scope?: MemoryScope;
  tags?: string[];
  importance?: number;
  expires_at?: string;
  provenance: MemoryProvenance;
}

export interface MemorySearchArgs {
  query: string;
  kind?: string;
  scope?: MemoryScope;
  tags?: string[];
  /** Default 10. */
  limit?: number;
  /** Default 0. Score is normalized 0..1. */
  min_score?: number;
}

export interface MemorySearchHit extends MemoryRecord {
  /** 0..1, backend-defined ranking, normalized. */
  score: number;
}

export interface MemoryFilter {
  ids?: string[];
  kind?: string;
  scope?: MemoryScope;
  tags?: string[];
  /** Match records whose expires_at is in the past. */
  expired?: boolean;
}

export interface MemoryStats {
  count_by_kind: Record<string, number>;
  oldest?: string;
  newest?: string;
  total_bytes?: number;
}

/**
 * The memory contract. Backends implement this; canonical tools
 * (memory_search / memory_write / memory_delete) wrap it.
 *
 * Mandatory invariants enforced by conforming backends:
 *  - write() rejects records without provenance.source_event_ids
 *  - same id = update; new id = create
 *  - get() updates last_accessed_at
 *  - ids are stable
 *
 * The associated memory_write / memory_delete TIMELINE events are emitted
 * by the canonical tool layer (not the store), so replaying those events
 * reconstructs the store from the timeline.
 */
export interface MemoryStore {
  search(args: MemorySearchArgs): Promise<MemorySearchHit[]>;
  /** Returns null if not found. MUST update last_accessed_at on hit. */
  get(id: string): Promise<MemoryRecord | null>;
  /** Create or update. Same id = update, new/missing = create. */
  write(input: MemoryWrite): Promise<MemoryRecord>;
  /** Delete records matching the filter. Returns count deleted. Refuses an empty filter. */
  delete(filter: MemoryFilter): Promise<number>;
  /** Optional observability. */
  stats?(): Promise<MemoryStats>;
  /** Optional cleanup. */
  close?(): void;
}

// ──── Processor ───────────────────────────────────────────────────────────

/**
 * A filter entry. Either a bare event type (match by type only) or a
 * structured form that also constrains by source attribution.
 *
 * Examples:
 *   filter: ["input"]
 *   filter: [{ type: "memory_retrieved", source: "processor:hippocampus" }]
 *   filter: ["input", { type: "pfc_loop", source: "processor:executor" }]
 */
export type FilterEntry = string | { type: string; source?: string };

export interface ProcessorContext {
  agentId: string;
  processorName: string;
  triggerEvent: CadmusEvent;
  timeline: TimelineReader;
  emit: (
    type: string,
    data: Record<string, unknown>,
    opts?: EmitOptions,
  ) => Promise<CadmusEvent>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  log: (msg: string, data?: unknown) => void;
}

export type ProcessorTemplate = "llm" | "code";

export interface LLMTemplateConfig {
  /** Model id. Provider auto-detected: gemini-* → Google, claude-* → Anthropic. */
  model?: string;
  /** System prompt. Required. */
  systemPrompt: string;
  /** Override API key (otherwise reads GOOGLE_API_KEY or ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Max tokens per LLM call. Default 4096. */
  maxTokens?: number;
  /** Max tool-use iterations within one trigger. Default 5. */
  maxIterations?: number;
  /** How many tail events to include as context. Default 30. */
  contextEvents?: number;
  /** Temperature. Default 0.7. */
  temperature?: number;
  /**
   * Event types that act as session boundaries. When set, the template
   * only includes events at or after the most recent occurrence of any
   * of these types in the context window.
   *
   * Common usage:
   *   sessionEvents: ["session_start", "conversation_compacted"]
   */
  sessionEvents?: string[];
}

export interface Processor {
  /** Unique name. */
  name: string;
  /** "llm" or "code". */
  template: ProcessorTemplate;
  /**
   * Event types that trigger this processor. Use a plain string to match
   * by event type, or an object {type, source} to also constrain by
   * attribution. See FilterEntry.
   */
  filter: FilterEntry[];
  /** Tool names this processor has access to (resolved from agent's tool registry). */
  tools?: string[];
  /** Event types this processor emits. The framework synthesizes emit_<type> tools for LLM processors. */
  outputEvents?: string[];
  /** Per-event-type input schema (JSON Schema fragments). Used for documentation + validation. */
  inputSchema?: Record<string, Record<string, unknown>>;
  /** Per-event-type output schema. */
  outputSchema?: Record<string, Record<string, unknown>>;
  /** Config for the chosen template. */
  templateConfig?: LLMTemplateConfig;
  /** Handler for `code` template. */
  handler?: (event: CadmusEvent, ctx: ProcessorContext) => Promise<void>;
  /** Free-form per-instance config the handler/template can read. */
  config?: Record<string, unknown>;
}

/** Returns true if the event matches at least one entry in the filter list. */
export function eventMatchesFilter(event: CadmusEvent, filter: FilterEntry[]): boolean {
  for (const f of filter) {
    if (typeof f === "string") {
      if (f === event.type) return true;
    } else {
      if (f.type !== event.type) continue;
      if (f.source !== undefined && f.source !== event.source) continue;
      return true;
    }
  }
  return false;
}

/** Extract the event types referenced by a filter (for wiring validation). */
export function filterTypes(filter: FilterEntry[]): string[] {
  return filter.map((f) => (typeof f === "string" ? f : f.type));
}

// ──── Channel ─────────────────────────────────────────────────────────────

/**
 * What a Channel sees from the runtime: emit, subscribe, read-only timeline,
 * and a logger. Channels do NOT have direct callTool access — they interact
 * with the agent purely through events.
 */
export interface ChannelEmitOptions {
  /** Stamp the emitted event with a session_id so descendants inherit it. Channels use this for stateless reply routing. */
  sessionId?: string | null;
  /** Override the auto-attributed source (usually leave undefined). */
  source?: string;
}

export interface ChannelContext {
  agentId: string;
  timeline: TimelineReader;
  /** Emit an event onto the timeline. The runtime fills in agent_id / id / seq / timestamp / source. */
  emit: (
    type: string,
    data: Record<string, unknown>,
    opts?: ChannelEmitOptions,
  ) => Promise<CadmusEvent>;
  /** Subscribe to all newly-appended events. Returns an unsubscribe function. */
  subscribe: (listener: (event: CadmusEvent) => void) => () => void;
  log: (msg: string, data?: unknown) => void;
}

/**
 * A Channel bridges between an external system (CLI, Studio, Slack, etc.)
 * and the timeline. Channels emit `input` events when external traffic
 * arrives and route `output` events whose `data.channel` matches their name
 * (or is "*") back to the external system.
 *
 * See spec/channel.md for the full contract.
 */
export interface Channel {
  /** Unique name. Used as the `channel` field on input/output events and as the source prefix. */
  name: string;
  /** Event types this channel emits onto the timeline. Typically ["input"]. */
  inboundEvents?: string[];
  /** Event types this channel routes off the timeline. Typically ["output"]. */
  outboundEvents?: string[];
  /** Begin listening to the external system. Idempotent. */
  start: (ctx: ChannelContext) => Promise<void>;
  /** Stop and disconnect. Should drain in-flight work where reasonable. */
  stop: () => Promise<void>;
  /** Free-form per-instance config. */
  config?: Record<string, unknown>;
}

export interface AgentConfig {
  agentId: string;
  name: string;
  /** Map of tool name -> Tool. */
  tools?: Record<string, Tool>;
  processors: Processor[];
  /** Channels that bridge this agent to external systems. Started at runtime.start(). */
  channels?: Channel[];
  storage?: {
    /** Path to the SQLite timeline file. Default: .cadmus/timeline.db */
    timelinePath?: string;
  };
}

export interface RuntimeOptions {
  /** Verbose logging to stdout. */
  verbose?: boolean;
  /** Called for every emitted event (after persistence). */
  onEvent?: (event: CadmusEvent) => void;
}
