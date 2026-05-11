import { createSession } from "../providers/index.js";
import type {
  ProviderToolDef,
} from "../providers/index.js";
import type {
  CadmusEvent,
  Processor,
  ProcessorContext,
  Tool,
} from "../types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_CONTEXT_EVENTS = 50;
const BOUNDARY_EVENT_TYPE = "event_boundary";

function asObjectSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) {
    return { type: "object", properties: {}, required: [] };
  }
  if (schema.type === "object") {
    return schema;
  }
  // Treat the schema as the shape of `data` directly — wrap it.
  return {
    type: "object",
    properties: { data: schema as Record<string, unknown> },
    required: ["data"],
  };
}

function formatEventForPrompt(event: CadmusEvent): string {
  return `[${event.seq}] ${event.type} (${event.id})
${JSON.stringify(event.data, null, 2)}`;
}

function buildContextMessage(
  proc: Processor,
  triggerEvent: CadmusEvent,
  recent: CadmusEvent[],
): string {
  const lines: string[] = [];
  lines.push(`# Trigger event`);
  lines.push(formatEventForPrompt(triggerEvent));
  lines.push("");

  const others = recent.filter((e) => e.id !== triggerEvent.id);
  if (others.length > 0) {
    lines.push(`# Recent timeline (${others.length} events, oldest first)`);
    for (const ev of others) {
      lines.push(formatEventForPrompt(ev));
      lines.push("");
    }
  }

  if (proc.outputEvents && proc.outputEvents.length > 0) {
    lines.push(`# Your job`);
    lines.push(
      `You can call any of the tools below. To emit an event onto the timeline, call the corresponding emit_<type> tool. You may emit zero, one, or multiple events. When you have nothing more to do, stop calling tools.`,
    );
  }

  return lines.join("\n");
}

/**
 * Run one LLM template invocation.
 *
 * Each invocation is a SINGLE provider turn. The model can call real tools
 * and emit tools in that turn; both kinds of calls become events on the
 * timeline (tool_call/tool_result auto-emitted by the runtime for real tools;
 * user-defined events emitted directly for emit tools). The model does not
 * see its own tool results within this invocation — the next invocation,
 * triggered by some downstream filter match, will see them in the JSON
 * context dump.
 *
 * Loops are external. A processor that wants to "keep thinking" emits an
 * event whose type its own filter matches; emitting a terminal event nothing
 * loops on (e.g. `output`) exits the cycle.
 */
export async function runLLMTemplate(
  proc: Processor,
  event: CadmusEvent,
  ctx: ProcessorContext,
  toolRegistry: Record<string, Tool>,
): Promise<void> {
  const cfg = proc.templateConfig;
  if (!cfg?.systemPrompt) {
    throw new Error(`Processor ${proc.name} (llm) is missing templateConfig.systemPrompt`);
  }

  const recent = collectRecentEvents(ctx, cfg.contextEvents ?? DEFAULT_CONTEXT_EVENTS);

  // Build the tool list: real tools + synthetic emit_<type> tools.
  const tools: ProviderToolDef[] = [];
  const realToolNames = new Set<string>();
  for (const toolName of proc.tools ?? []) {
    const tool = toolRegistry[toolName];
    if (!tool) {
      throw new Error(`Processor ${proc.name} references unknown tool: ${toolName}`);
    }
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    });
    realToolNames.add(tool.name);
  }

  for (const eventType of proc.outputEvents ?? []) {
    const schema = proc.outputSchema?.[eventType];
    tools.push({
      name: `emit_${eventType}`,
      description: `Append a ${eventType} event to the timeline.`,
      input_schema: asObjectSchema(schema),
    });
  }

  const userMessage = buildContextMessage(proc, event, recent);
  const session = createSession({
    model: cfg.model ?? DEFAULT_MODEL,
    systemPrompt: cfg.systemPrompt,
    initialUserMessage: userMessage,
    tools,
    maxTokens: cfg.maxTokens ?? 4096,
    temperature: cfg.temperature ?? 0.7,
    apiKey: cfg.apiKey,
  });

  const turn = await session.send();

  if (turn.toolCalls.length === 0) {
    // Forgiving fallback: if the model returned plain text but didn't call
    // any tool (some models — Gemini in particular — sometimes ignore the
    // emit_<type> tool and just answer in text), and this processor has a
    // text-shaped output event, emit the text as that event so the user
    // sees a response in the UI.
    if (turn.text.trim()) {
      const fallbackEvent = pickTextOutputEvent(proc);
      if (fallbackEvent) {
        await ctx.emit(fallbackEvent, {
          channel: "*",
          kind: "text",
          text: turn.text.trim(),
        });
        ctx.log(`(${proc.name}) auto-emitted ${fallbackEvent} from text-only response`);
        return;
      }
      ctx.log(`(${proc.name} note) ${turn.text.slice(0, 200)}`);
    }
    return;
  }

  // Dedupe emit_<type> within a single turn: if the model batches three
  // calls to emit_working_memory_updated (Gemini sometimes does this),
  // only the first one actually emits.
  const emittedTypesThisTurn = new Set<string>();

  for (const tc of turn.toolCalls) {
    try {
      if (tc.name.startsWith("emit_")) {
        const eventType = tc.name.slice("emit_".length);

        if (emittedTypesThisTurn.has(eventType)) {
          ctx.log(`(${proc.name}) duplicate emit_${eventType} in same turn — skipping`);
          continue;
        }
        emittedTypesThisTurn.add(eventType);

        const data =
          tc.input && typeof tc.input === "object" && "data" in tc.input && Object.keys(tc.input).length === 1
            ? (tc.input.data as Record<string, unknown>)
            : tc.input;
        await ctx.emit(eventType, data ?? {});
      } else if (realToolNames.has(tc.name)) {
        // Runtime auto-emits tool_call + tool_result events on the timeline.
        // The result is not fed back to this LLM turn; the next invocation
        // sees it as events in the JSON context dump.
        await ctx.callTool(tc.name, tc.input);
      } else {
        ctx.log(`(${proc.name}) ignoring unknown tool: ${tc.name}`);
      }
    } catch (err) {
      ctx.log(`(${proc.name}) tool ${tc.name} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Collect timeline events for context. Always scopes the window to events
 * at-or-after the most recent `event_boundary`, capped at `count` events.
 *
 * Channels (or external code) emit `event_boundary` events to mark dividers
 * in the stream — typically a new conversation. The boundary itself is
 * included in the returned slice so the model can see why it just lost
 * earlier context.
 */
function collectRecentEvents(ctx: ProcessorContext, count: number): CadmusEvent[] {
  const boundary = ctx.timeline.latest(BOUNDARY_EVENT_TYPE);
  if (!boundary) {
    return ctx.timeline.recent(count);
  }
  const tail = ctx.timeline.recent(count);
  if (tail.length > 0 && tail[0].seq <= boundary.seq) {
    return tail.filter((e) => e.seq >= boundary.seq);
  }
  return ctx.timeline.all().filter((e) => e.seq >= boundary.seq).slice(-count);
}

/**
 * Pick the best output event to use as a fallback when the model returned text
 * without tool-calling. Heuristic:
 *   1. An output event whose schema declares a `text: string` property.
 *   2. Otherwise, an output event named like a message (output, message, response).
 *   3. Otherwise, null — caller logs the text as a note.
 */
function pickTextOutputEvent(proc: Processor): string | null {
  const outputs = proc.outputEvents ?? [];
  if (outputs.length === 0) return null;

  for (const eventType of outputs) {
    const schema = proc.outputSchema?.[eventType];
    if (
      schema &&
      typeof schema === "object" &&
      schema !== null &&
      "properties" in schema
    ) {
      const props = (schema as { properties?: Record<string, { type?: string }> }).properties;
      if (props && props.text && props.text.type === "string") {
        return eventType;
      }
    }
  }

  const messageLikely = outputs.find((e) =>
    /^(output|message|response)$/.test(e),
  );
  return messageLikely ?? null;
}
