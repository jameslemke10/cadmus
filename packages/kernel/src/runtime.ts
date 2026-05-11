import { eventId } from "./id.js";
import { runLLMTemplate } from "./templates/llm.js";
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

/** Event types that the runtime itself emits — used by validateWiring to suppress false-positive warnings. */
const FRAMEWORK_EMITTED = new Set<string>([
  "input",
  "tool_call",
  "tool_result",
  "memory_write",
  "memory_delete",
  "error",
  // External/system events that aren't strictly framework-emitted but conventionally exist.
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
    this.timeline = new Timeline(config.storage?.timelinePath ?? DEFAULT_TIMELINE_PATH);
    this.opts = opts;

    this.validate();
  }

  /** Runs once at construct time. Throws on hard errors; warns on soft issues. */
  private validate(): void {
    // Hard error: tool name uses the reserved emit_ prefix.
    for (const name of Object.keys(this.tools)) {
      if (name.startsWith("emit_")) {
        throw new Error(
          `Tool name "${name}" uses reserved prefix "emit_" (synthesized by the LLM template).`,
        );
      }
    }

    // Hard error: duplicate channel names.
    const seenChannels = new Set<string>();
    for (const ch of this.channels) {
      if (seenChannels.has(ch.name)) {
        throw new Error(`Duplicate channel name "${ch.name}".`);
      }
      seenChannels.add(ch.name);
    }

    // Hard error: duplicate processor names.
    const seenProcs = new Set<string>();
    for (const p of this.processors) {
      if (seenProcs.has(p.name)) {
        throw new Error(`Duplicate processor name "${p.name}".`);
      }
      seenProcs.add(p.name);
    }

    // Soft warn: a processor filters on an event type nothing emits.
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

    // Start channels.
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

    // Stop channels first so they release resources before we tear down the queue.
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

  /** Inject an input event (the typical external trigger). source defaults to `channel:<channel>`. */
  async inject(text: string, channel: string = "app", kind: string = "text"): Promise<CadmusEvent> {
    return this.appendEvent({
      type: "input",
      data: { channel, kind, text },
      source: `channel:${channel}`,
      parent_event_id: null,
      tags: ["external"],
    });
  }

  /** Append an arbitrary event onto the timeline. */
  async appendEvent(input: {
    type: string;
    data: Record<string, unknown>;
    session_id?: string | null;
    parent_event_id?: string | null;
    source?: string | null;
    tags?: string[];
  }): Promise<CadmusEvent> {
    const stored = await this.timeline.append({
      type: input.type,
      agent_id: this.agentId,
      data: input.data,
      session_id: input.session_id ?? null,
      parent_event_id: input.parent_event_id ?? null,
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
      if (proc.template === "llm") {
        await runLLMTemplate(proc, event, ctx, this.tools);
      } else if (proc.template === "code") {
        if (!proc.handler) {
          throw new Error(`Processor ${proc.name} (code) has no handler`);
        }
        await proc.handler(event, ctx);
      } else {
        throw new Error(`Unknown template ${proc.template} for ${proc.name}`);
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
        session_id: event.session_id,
        parent_event_id: event.id,
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
          session_id: opts.sessionId ?? event.session_id,
          parent_event_id: opts.parentEventId ?? event.id,
          source: opts.source ?? procSource,
          tags: opts.tags ?? [proc.name],
        }),
      callTool: async (name, args) => {
        const tool = this.tools[name];
        if (!tool) throw new Error(`Tool not found: ${name}`);

        // Auto-emit tool_call before invocation, tool_result after.
        // Both pair via call_id, and both are attributed to the processor that called the tool.
        const callId = eventId();
        const callEvent = await this.appendEvent({
          type: "tool_call",
          data: { tool: name, args, call_id: callId },
          source: procSource,
          session_id: event.session_id,
          parent_event_id: event.id,
          tags: [proc.name, "tool"],
        });

        try {
          const result = await tool.handler(args, {
            agentId: this.agentId,
            triggerEvent: event,
            // Emits from inside a tool handler attribute to the tool itself.
            emit: async (type, data, opts: EmitOptions = {}) =>
              this.appendEvent({
                type,
                data,
                session_id: opts.sessionId ?? event.session_id,
                parent_event_id: opts.parentEventId ?? callEvent.id,
                source: opts.source ?? `tool:${name}`,
                tags: opts.tags ?? [`tool:${name}`],
              }),
            log: (m, d) => this.log(m, d),
          });
          await this.appendEvent({
            type: "tool_result",
            data: { tool: name, call_id: callId, result, is_error: false },
            source: procSource,
            session_id: event.session_id,
            parent_event_id: callEvent.id,
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
            session_id: event.session_id,
            parent_event_id: callEvent.id,
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
          session_id: opts.sessionId ?? null,
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
