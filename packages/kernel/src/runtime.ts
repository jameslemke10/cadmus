import { eventId } from "./id.js";
import { runLLMTemplate } from "./templates/llm.js";
import { Timeline } from "./timeline.js";
import type {
  AgentConfig,
  CadmusEvent,
  EmitOptions,
  ProcessorContext,
  ProcessorDefinition,
  RuntimeOptions,
  ToolDefinition,
} from "./types.js";

const DEFAULT_TIMELINE_PATH = ".cadmus/timeline.db";

export class Runtime {
  readonly timeline: Timeline;
  readonly agentId: string;
  readonly agentName: string;
  readonly processors: ProcessorDefinition[];
  readonly tools: Record<string, ToolDefinition>;

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
    this.timeline = new Timeline(config.storage?.timelinePath ?? DEFAULT_TIMELINE_PATH);
    this.opts = opts;

    this.validateWiring();
  }

  /** Compile-time check: every processor's filter is satisfied by some emitter (or system event). */
  private validateWiring(): void {
    const emitted = new Set<string>(["user_input", "timer_fired", "notification_received"]);
    for (const p of this.processors) {
      for (const e of p.outputEvents ?? []) emitted.add(e);
    }
    for (const p of this.processors) {
      for (const f of p.filter) {
        if (!emitted.has(f)) {
          this.log(
            `[warn] processor "${p.name}" filters on "${f}" but nothing emits it`,
          );
        }
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.timeline.subscribe((event) => {
      this.queue.push(event);
      void this.drain();
    });
    this.log(`runtime started (agent=${this.agentName} id=${this.agentId})`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Inject a user_input (the typical external trigger). */
  async inject(text: string): Promise<CadmusEvent> {
    return this.appendEvent({
      type: "user_input",
      data: { text },
      parent_event_id: null,
      tags: ["external"],
    });
  }

  /** Append an arbitrary event onto the timeline. */
  async appendEvent(input: {
    type: string;
    data: Record<string, unknown>;
    parent_event_id?: string | null;
    tags?: string[];
  }): Promise<CadmusEvent> {
    const event: Omit<CadmusEvent, "seq"> = {
      id: eventId(),
      timestamp: new Date().toISOString(),
      type: input.type,
      agent_id: this.agentId,
      data: input.data,
      parent_event_id: input.parent_event_id ?? null,
      tags: input.tags ?? [],
    };
    const stored = this.timeline.append(event);
    this.opts.onEvent?.(stored);
    return stored;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        const matching = this.processors.filter((p) => p.filter.includes(event.type));
        // Fan out: run matching processors in parallel.
        await Promise.all(matching.map((p) => this.runProcessor(p, event)));
      }
    } finally {
      this.draining = false;
    }
  }

  private async runProcessor(proc: ProcessorDefinition, event: CadmusEvent): Promise<void> {
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
          processor: proc.name,
          message: err instanceof Error ? err.message : String(err),
          trigger_event_id: event.id,
        },
        parent_event_id: event.id,
        tags: ["error"],
      });
    }
  }

  private makeContext(proc: ProcessorDefinition, event: CadmusEvent): ProcessorContext {
    return {
      agentId: this.agentId,
      processorName: proc.name,
      triggerEvent: event,
      timeline: this.timeline,
      emit: async (type, data, opts: EmitOptions = {}) =>
        this.appendEvent({
          type,
          data,
          parent_event_id: opts.parentEventId ?? event.id,
          tags: opts.tags ?? [proc.name],
        }),
      callTool: async (name, args) => {
        const tool = this.tools[name];
        if (!tool) throw new Error(`Tool not found: ${name}`);
        return tool.handler(args, { agentId: this.agentId, log: (m, d) => this.log(m, d) });
      },
      log: (m, d) => this.log(`  ${proc.name}: ${m}`, d),
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
