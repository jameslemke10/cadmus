/**
 * @cadmus/kernel — event-driven runtime for AI agents.
 *
 * Concepts:
 *   - Timeline: an append-only log of typed events. The agent's lived experience.
 *   - Processor: a unit that subscribes to event types and emits new events.
 *     Templates: `llm_call` (one provider turn, emits events), `llm_loop`
 *     (multi-turn provider session that loops on tool results), and `code`
 *     (a developer-supplied handler).
 *   - Tools: ordinary callable functions. Any processor can declare which
 *     tools it has access to.
 *   - Channels: bridges between an external system (CLI, Studio, etc.) and
 *     the timeline. Emit `input`, route `output`.
 *   - Memory: a derived index over the timeline. Pluggable backends.
 */

export { Timeline } from "./timeline.js";
export { Runtime } from "./runtime.js";
export { eventId, memoryId } from "./id.js";
export { createCliChannel } from "./channels/cli.js";
export type { CliChannelOptions } from "./channels/cli.js";
export { createSchedulerChannel } from "./channels/scheduler.js";
export type { SchedulerChannelOptions } from "./channels/scheduler.js";
export { createStudioChannel } from "./channels/studio.js";
export type { StudioChannelOptions } from "./channels/studio.js";
export { eventMatchesFilter, filterTypes } from "./types.js";
export type {
  AgentConfig,
  AppendInput,
  CadmusEvent,
  Channel,
  ChannelContext,
  EmitOptions,
  FilterEntry,
  LLMTemplateConfig,
  MemoryFilter,
  MemoryProvenance,
  MemoryRecord,
  MemoryScope,
  MemorySearchArgs,
  MemorySearchHit,
  MemoryStats,
  MemoryStore,
  MemoryWrite,
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
