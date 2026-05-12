/**
 * Core types for the Cadmus runtime.
 *
 * The model is intentionally generic. The "brain" example (hippocampus,
 * thalamus, PFC) is just one configuration of these primitives.
 */

export interface CadmusEvent {
  id: string;
  seq: number;
  timestamp: string;
  type: string;
  agent_id: string;
  /**
   * Attribution: who emitted this event. Set automatically by the runtime.
   * Conventional values:
   *   "processor:<name>"  — emitted by a processor via ctx.emit
   *   "tool:<name>"       — emitted by a tool handler via ctx.emit
   *   "channel:<name>"    — emitted by a channel via ctx.emit, or by
   *                         runtime.inject(text, channel) for that channel
   *   "kernel"            — emitted by the runtime itself (e.g., error)
   *   null                — appended by external code with no source
   */
  source: string | null;
  data: Record<string, unknown>;
  tags: string[];
}

export type EmitOptions = {
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
  /** The event that triggered the processor that called this tool. */
  triggerEvent: CadmusEvent;
  /** Emit a new event onto the timeline. Source is `tool:<this tool's name>`. */
  emit: (type: string, data: Record<string, unknown>, opts?: EmitOptions) => Promise<CadmusEvent>;
  log: (msg: string, data?: unknown) => void;
}

export interface TimelineFilter {
  types?: string[];
  agentId?: string;
  source?: string;
}

/** Input to TimelineStore.append. id, seq, and timestamp are assigned by the store. */
export interface AppendInput {
  type: string;
  agent_id: string;
  data: Record<string, unknown>;
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
  /** Append an event. id, seq, and timestamp are assigned by the store. */
  append(input: AppendInput): Promise<CadmusEvent>;

  /** Subscribe to all newly-appended events. Listeners fire after persistence. */
  subscribe(listener: (event: CadmusEvent) => void): () => void;

  /** Read events with seq > the given seq. Used for SSE catch-up. */
  since(seq: number, limit?: number): CadmusEvent[];

  /** Permanently delete events matching the filter. Refuses an empty filter. */
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
  limit?: number;
  min_score?: number;
}

export interface MemorySearchHit extends MemoryRecord {
  score: number;
}

export interface MemoryFilter {
  ids?: string[];
  kind?: string;
  scope?: MemoryScope;
  tags?: string[];
  expired?: boolean;
}

export interface MemoryStats {
  count_by_kind: Record<string, number>;
  oldest?: string;
  newest?: string;
  total_bytes?: number;
}

export interface MemoryStore {
  search(args: MemorySearchArgs): Promise<MemorySearchHit[]>;
  get(id: string): Promise<MemoryRecord | null>;
  write(input: MemoryWrite): Promise<MemoryRecord>;
  delete(filter: MemoryFilter): Promise<number>;
  stats?(): Promise<MemoryStats>;
  close?(): void;
}

// ──── Processor ───────────────────────────────────────────────────────────

/**
 * A filter entry. Either a bare event type (match by type only) or a
 * structured form that also constrains by source attribution.
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

/**
 * Three execution models:
 *   - "llm_call": one provider turn. The model can call tools and emit events,
 *     but does NOT see tool results within the same turn. Loops are external —
 *     the next event on the timeline (e.g. tool_result) re-triggers the
 *     processor for the next turn.
 *   - "llm_loop": a multi-turn provider session. The model calls tools, the
 *     runtime feeds the results back into the SAME provider session, and the
 *     model keeps going until it stops calling tools. Then its final text is
 *     emitted as one of the declared outputEvents.
 *   - "code": a TypeScript handler.
 */
export type ProcessorTemplate = "llm_call" | "llm_loop" | "code";

export interface LLMTemplateConfig {
  /** Model id. Provider auto-detected: gemini-* → Google, claude-* → Anthropic. */
  model?: string;
  /** System prompt. Required. */
  systemPrompt: string;
  /** Override API key (otherwise reads GOOGLE_API_KEY or ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Max tokens per LLM call. Default 4096. */
  maxTokens?: number;
  /** How many tail events to include as context. Default 50. */
  contextEvents?: number;
  /** Temperature. Default 0.7. */
  temperature?: number;
  /** llm_loop only: cap on provider turns per invocation. Default 10. */
  maxIterations?: number;
}

export interface Processor {
  name: string;
  template: ProcessorTemplate;
  filter: FilterEntry[];
  /** Tool names this processor has access to (resolved from agent's tool registry). */
  tools?: string[];
  /** Event types this processor emits. */
  outputEvents?: string[];
  inputSchema?: Record<string, Record<string, unknown>>;
  outputSchema?: Record<string, Record<string, unknown>>;
  templateConfig?: LLMTemplateConfig;
  /** Handler for `code` template. */
  handler?: (event: CadmusEvent, ctx: ProcessorContext) => Promise<void>;
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

export interface ChannelEmitOptions {
  /** Override the auto-attributed source (usually leave undefined). */
  source?: string;
}

export interface ChannelContext {
  agentId: string;
  timeline: TimelineReader;
  emit: (
    type: string,
    data: Record<string, unknown>,
    opts?: ChannelEmitOptions,
  ) => Promise<CadmusEvent>;
  subscribe: (listener: (event: CadmusEvent) => void) => () => void;
  log: (msg: string, data?: unknown) => void;
}

/**
 * A Channel bridges between an external system (CLI, Studio, etc.) and the
 * timeline. Channels emit `input` events when external traffic arrives and
 * route `output` events whose `data.channel` matches their name (or is "*")
 * back to the external system.
 */
export interface Channel {
  name: string;
  inboundEvents?: string[];
  outboundEvents?: string[];
  start: (ctx: ChannelContext) => Promise<void>;
  stop: () => Promise<void>;
  config?: Record<string, unknown>;
}

export interface AgentConfig {
  agentId: string;
  name: string;
  tools?: Record<string, Tool>;
  processors: Processor[];
  channels?: Channel[];
  storage?: {
    /** Path to the SQLite timeline file. Default: .cadmus/timeline.db */
    timelinePath?: string;
  };
}

export interface RuntimeOptions {
  verbose?: boolean;
  onEvent?: (event: CadmusEvent) => void;
}
