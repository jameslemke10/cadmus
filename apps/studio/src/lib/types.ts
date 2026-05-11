export interface CadmusEvent {
  id: string;
  seq: number;
  timestamp: string;
  type: string;
  agent_id: string;
  session_id: string | null;
  source: string | null;
  data: Record<string, unknown>;
  parent_event_id: string | null;
  tags: string[];
}

/** Matches the kernel's FilterEntry: a bare event-type string OR a {type, source} object. */
export type FilterEntry = string | { type: string; source?: string };

export interface ProcessorMeta {
  name: string;
  template: "llm" | "code";
  filter: FilterEntry[];
  outputEvents: string[];
  tools: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  templateConfig?: {
    model?: string;
    systemPrompt?: string;
    maxIterations?: number;
    contextEvents?: number;
    temperature?: number;
  };
  config?: Record<string, unknown>;
}

export interface ToolMeta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentMeta {
  id: string;
  name: string;
  processors: ProcessorMeta[];
  tools: ToolMeta[];
}
