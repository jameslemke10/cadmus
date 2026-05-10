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
 *   - Channels: bridges between an external system (CLI, Studio, Slack,
 *     etc.) and the timeline. Emit `input`, route `output`.
 *
 * The "brain" preset (hippocampus -> thalamus -> PFC -> executor) is one
 * configuration on top of these primitives. The framework knows nothing
 * about brain regions.
 */

export { Timeline } from "./timeline.js";
export { Runtime } from "./runtime.js";
export { eventId, memoryId } from "./id.js";
export { createCliChannel } from "./channels/cli.js";
export type { CliChannelOptions } from "./channels/cli.js";
export type {
  AgentConfig,
  AppendInput,
  CadmusEvent,
  Channel,
  ChannelContext,
  EmitOptions,
  LLMTemplateConfig,
  Processor,
  ProcessorContext,
  ProcessorTemplate,
  RuntimeOptions,
  TimelineFilter,
  TimelineReader,
  TimelineStore,
  Tool,
  ToolContext,
} from "./types.js";

export { startServer } from "./server.js";
export type { ServerOptions } from "./server.js";

import type { Processor } from "./types.js";
export function defineProcessor(p: Processor): Processor {
  return p;
}

import type { Tool } from "./types.js";
export function defineTool(t: Tool): Tool {
  return t;
}

import type { AgentConfig } from "./types.js";
export function defineAgent(c: AgentConfig): AgentConfig {
  return c;
}
