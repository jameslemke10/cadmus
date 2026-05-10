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
  data: Record<string, unknown>;
  parent_event_id: string | null;
  tags: string[];
}

export type EmitOptions = {
  parentEventId?: string | null;
  sessionId?: string | null;
  tags?: string[];
};

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  agentId: string;
  log: (msg: string, data?: unknown) => void;
}

export interface TimelineFilter {
  types?: string[];
  agentId?: string;
  sessionId?: string;
}

/** Input to TimelineStore.append. id, seq, and timestamp are assigned by the store. */
export interface AppendInput {
  type: string;
  agent_id: string;
  data: Record<string, unknown>;
  session_id?: string | null;
  parent_event_id?: string | null;
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
  /** Event types that trigger this processor. */
  filter: string[];
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

export interface AgentConfig {
  agentId: string;
  name: string;
  /** Map of tool name -> Tool. */
  tools?: Record<string, Tool>;
  processors: Processor[];
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
