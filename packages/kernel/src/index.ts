/**
 * @cadmus/kernel — event-driven runtime for AI agents.
 *
 * Concepts:
 *   - Timeline: an append-only log of typed events. The agent's lived experience.
 *   - Processor: a unit that subscribes to event types and emits new events.
 *     Templates: `llm` (calls an LLM, can use tools, emits via synthesized
 *     emit_<type> tools) and `code` (a developer-supplied handler).
 *   - Tools: ordinary callable functions. Any processor can declare which
 *     tools it has access to.
 *
 * The "brain" preset (hippocampus -> thalamus -> PFC -> executor) is one
 * configuration on top of these primitives. The framework knows nothing
 * about brain regions.
 */

export { Timeline } from "./timeline.js";
export { Runtime } from "./runtime.js";
export { eventId, memoryId } from "./id.js";
export type {
  AgentConfig,
  CadmusEvent,
  EmitOptions,
  LLMTemplateConfig,
  ProcessorContext,
  ProcessorDefinition,
  ProcessorTemplate,
  RuntimeOptions,
  TimelineReader,
  ToolContext,
  ToolDefinition,
} from "./types.js";

export { startServer } from "./server.js";
export type { ServerOptions } from "./server.js";

/**
 * Helper for defining a processor with type narrowing.
 */
import type { ProcessorDefinition } from "./types.js";
export function defineProcessor(p: ProcessorDefinition): ProcessorDefinition {
  return p;
}

import type { ToolDefinition } from "./types.js";
export function defineTool(t: ToolDefinition): ToolDefinition {
  return t;
}

import type { AgentConfig } from "./types.js";
export function defineAgent(c: AgentConfig): AgentConfig {
  return c;
}
