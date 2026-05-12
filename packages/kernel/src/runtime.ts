import { isAbsolute, resolve as resolvePath } from "node:path";
import { eventId } from "./id.js";
import { runLLMCallTemplate } from "./templates/llm_call.js";
import { runLLMLoopTemplate } from "./templates/llm_loop.js";
import { Timeline } from "./timeline.js";
import {
  eventMatchesFilter,
  filterTypes,
  type AgentConfig,
  type CadmusEvent,
  type Channel,
  type ChannelContext,
  type EmitOptions,
  type Processor,
  type ProcessorContext,
  type RuntimeOptions,
  type Tool,
} from "./types.js";

const DEFAULT_TIMELINE_PATH = ".cadmus/timeline.db";

/**
 * Resolve a storage path. Absolute paths and `:memory:` pass through; a
 * relative path is anchored to CADMUS_AGENT_DIR if set (CLI runner exports
 * it, pointing at the agent's install dir), otherwise to cwd. This is what
 * keeps the timeline DB inside the agent's directory regardless of where
 * the user launched `cadmus start` from — so uninstall / export / import
 * actually carry the data.
 */
function resolveStoragePath(p: string): string {
  if (p === ":memory:" || isAbsolute(p)) return p;
  const base = process.env.CADMUS_AGENT_DIR ?? process.cwd();
  return resolvePath(base, p);
}

/** Event types the runtime itself emits — used by validateWiring to suppress false-positive warnings. */
const FRAMEWORK_EMITTED = new Set<string>([
  "input",
  "tool_call",
  "tool_result",
  "memory_write",
  "memory_delete",
  "error",
  // Channels emit this to mark a divider in the stream. The LLM templates
  // scope their context window to events at-or-after the most recent boundary.
  "event_boundary",
  "timer_fired",
  "notification_received",
]);

export class Runtime {
  readonly timeline: Timeline;
  readonly agentId: string;
  readonly agentName: string;
  readonly processors: Processor[];
  readonly tools: Record<string, Tool>;
  readonly channels: Channel[];

  private running = false;
  private queue: CadmusEvent[] = [];
  private draining = false;
  private unsubscribe: (() => void) | null = null;
  private opts: RuntimeOptions;

  constructor(config: AgentConfig, opts: RuntimeOptions = {}) {
    this.agentId = config.agentId;
    this.agentName = config.name;
    this.processors = config.processors;
    this.tools = config.tools ?? {};
    this.channels = config.channels ?? [];
    this.timeline = new Timeline(resolveStoragePath(config.storage?.timelinePath ?? DEFAULT_TIMELINE_PATH));
    this.opts = opts;

    this.validate();
  }

  /** Runs once at construct time. Throws on hard errors; warns on soft issues. */
  private validate(): void {
    for (const name of Object.keys(this.tools)) {
      if (name.startsWith("emit_")) {
        throw new Error(
          `Tool name "${name}" uses reserved prefix "emit_" (synthesized by the LLM template).`,
        );
      }
    }

    const seenChannels = new Set<string>();
    for (const ch of this.channels) {
      if (seenChannels.has(ch.name)) {
        throw new Error(`Duplicate channel name "${ch.name}".`);
      }
      seenChannels.add(ch.name);
    }

    const seenProcs = new Set<string>();
    for (const p of this.processors) {
      if (seenProcs.has(p.name)) {
        throw new Error(`Duplicate processor name "${p.name}".`);
      }
      seenProcs.add(p.name);
    }

    const emitted = new Set<string>(FRAMEWORK_EMITTED);
    for (const p of this.processors) {
      for (const e of p.outputEvents ?? []) emitted.add(e);
    }
    for (const p of this.processors) {
      for (const t of filterTypes(p.filter)) {
        if (!emitted.has(t)) {
          this.log(`[warn] processor "${p.name}" filters on "${t}" but nothing emits it`);
        }
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.timeline.subscribe((event) => {
      this.queue.push(event);
      void this.drain();
    });

    for (const ch of this.channels) {
      try {
        await ch.start(this.makeChannelContext(ch));
        this.log(`channel "${ch.name}" started`);
      } catch (err) {
        this.log(`channel "${ch.name}" failed to start: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.log(`runtime started (agent=${this.agentName} id=${this.agentId})`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    for (const ch of this.channels) {
      try {
        await ch.stop();
      } catch (err) {
        this.log(`channel "${ch.name}" stop error: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Inject an input event (the typical external trigger). */
  async inject(text: string, channel: string = "app", kind: string = "text"): Promise<CadmusEvent> {
    return this.appendEvent({
      type: "input",
      data: { channel, kind, text },
      source: `channel:${channel}`,
      tags: ["external"],
    });
  }

  async appendEvent(input: {
    type: string;
    data: Record<string, unknown>;
    source?: string | null;
    tags?: string[];
  }): Promise<CadmusEvent> {
    const stored = await this.timeline.append({
      type: input.type,
      agent_id: this.agentId,
      data: input.data,
      source: input.source ?? null,
      tags: input.tags ?? [],
    });
    this.opts.onEvent?.(stored);
    return stored;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        const matching = this.processors.filter((p) => eventMatchesFilter(event, p.filter));
        // Fan out: run matching processors in parallel.
        await Promise.all(matching.map((p) => this.runProcessor(p, event)));
      }
    } finally {
      this.draining = false;
    }
  }

  private async runProcessor(proc: Processor, event: CadmusEvent): Promise<void> {
    const ctx = this.makeContext(proc, event);
    this.log(`▶ ${proc.name} <- ${event.type}`);
    try {
      switch (proc.template) {
        case "llm_call":
          await runLLMCallTemplate(proc, event, ctx, this.tools);
          break;
        case "llm_loop":
          await runLLMLoopTemplate(proc, event, ctx, this.tools);
          break;
        case "code":
          if (!proc.handler) {
            throw new Error(`Processor ${proc.name} (code) has no handler`);
          }
          await proc.handler(event, ctx);
          break;
        default: {
          const t: never = proc.template;
          throw new Error(`Unknown template ${String(t)} for ${proc.name}`);
        }
      }
    } catch (err) {
      this.log(`✗ ${proc.name} threw: ${err instanceof Error ? err.message : String(err)}`);
      await this.appendEvent({
        type: "error",
        data: {
          source: "processor",
          name: proc.name,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          triggering_event_id: event.id,
        },
        source: "kernel",
        tags: ["error"],
      });
    }
  }

  private makeContext(proc: Processor, event: CadmusEvent): ProcessorContext {
    const procSource = `processor:${proc.name}`;
    return {
      agentId: this.agentId,
      processorName: proc.name,
      triggerEvent: event,
      timeline: this.timeline,
      emit: async (type, data, opts: EmitOptions = {}) =>
        this.appendEvent({
          type,
          data,
          source: opts.source ?? procSource,
          tags: opts.tags ?? [proc.name],
        }),
      callTool: async (name, args) => {
        const tool = this.tools[name];
        if (!tool) throw new Error(`Tool not found: ${name}`);

        const callId = eventId();
        await this.appendEvent({
          type: "tool_call",
          data: { tool: name, args, call_id: callId },
          source: procSource,
          tags: [proc.name, "tool"],
        });

        try {
          const result = await tool.handler(args, {
            agentId: this.agentId,
            triggerEvent: event,
            emit: async (type, data, opts: EmitOptions = {}) =>
              this.appendEvent({
                type,
                data,
                source: opts.source ?? `tool:${name}`,
                tags: opts.tags ?? [`tool:${name}`],
              }),
            log: (m, d) => this.log(m, d),
          });
          await this.appendEvent({
            type: "tool_result",
            data: { tool: name, call_id: callId, result, is_error: false },
            source: procSource,
            tags: [proc.name, "tool"],
          });
          return result;
        } catch (err) {
          await this.appendEvent({
            type: "tool_result",
            data: {
              tool: name,
              call_id: callId,
              error_message: err instanceof Error ? err.message : String(err),
              is_error: true,
            },
            source: procSource,
            tags: [proc.name, "tool"],
          });
          throw err;
        }
      },
      log: (m, d) => this.log(`  ${proc.name}: ${m}`, d),
    };
  }

  private makeChannelContext(channel: Channel): ChannelContext {
    const chSource = `channel:${channel.name}`;
    return {
      agentId: this.agentId,
      timeline: this.timeline,
      emit: async (type, data, opts = {}) =>
        this.appendEvent({
          type,
          data,
          source: opts.source ?? chSource,
          tags: [`channel:${channel.name}`],
        }),
      subscribe: (listener) => this.timeline.subscribe(listener),
      log: (m, d) => this.log(`  channel:${channel.name}: ${m}`, d),
    };
  }

  private log(msg: string, data?: unknown): void {
    if (!this.opts.verbose) return;
    if (data !== undefined) {
      console.log(`[cadmus] ${msg}`, data);
    } else {
      console.log(`[cadmus] ${msg}`);
    }
  }
}
