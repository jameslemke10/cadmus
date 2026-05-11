import { createSession } from "../providers/index.js";
import type {
  ProviderToolDef,
  ProviderToolResult,
} from "../providers/index.js";
import type {
  CadmusEvent,
  Processor,
  ProcessorContext,
  Tool,
} from "../types.js";

const DEFAULT_MODEL = "gemini-2.5-flash";

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

  const recent = collectRecentEvents(ctx, cfg.contextEvents ?? 30, cfg.sessionEvents);

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

  const maxIterations = cfg.maxIterations ?? 5;
  let toolResults: ProviderToolResult[] | undefined;
  let totalEmissions = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    const turn = await session.send(toolResults);

    if (turn.toolCalls.length === 0) {
      // Forgiving fallback: if the model returned plain text but didn't call
      // any tool (some models — Gemini in particular — sometimes ignore the
      // emit_<type> tool and just answer in text), and this processor has a
      // text-shaped output event, emit the text as that event so the user
      // sees a response in the UI.
      if (totalEmissions === 0 && turn.text.trim()) {
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

    toolResults = [];
    // Dedupe emit_<type> within a single turn: if the model batches three
    // calls to emit_working_memory_updated (Gemini sometimes does this),
    // only the first one actually emits — the rest get acknowledged with
    // a "skipped" tool result so the model can self-correct.
    const emittedTypesThisTurn = new Set<string>();
    let emittedThisTurn = 0;

    for (const tc of turn.toolCalls) {
      try {
        if (tc.name.startsWith("emit_")) {
          const eventType = tc.name.slice("emit_".length);

          if (emittedTypesThisTurn.has(eventType)) {
            ctx.log(`(${proc.name}) duplicate emit_${eventType} in same turn — skipping`);
            toolResults.push({
              id: tc.id,
              name: tc.name,
              content: `skipped: already emitted ${eventType} this turn`,
              isError: true,
            });
            continue;
          }
          emittedTypesThisTurn.add(eventType);

          const data =
            tc.input && typeof tc.input === "object" && "data" in tc.input && Object.keys(tc.input).length === 1
              ? (tc.input.data as Record<string, unknown>)
              : tc.input;
          const emitted = await ctx.emit(eventType, data ?? {});
          totalEmissions++;
          emittedThisTurn++;
          toolResults.push({
            id: tc.id,
            name: tc.name,
            content: `emitted ${emitted.id}`,
          });
        } else if (realToolNames.has(tc.name)) {
          const result = await ctx.callTool(tc.name, tc.input);
          toolResults.push({
            id: tc.id,
            name: tc.name,
            content:
              typeof result === "string"
                ? result
                : JSON.stringify(result ?? null).slice(0, 8000),
          });
        } else {
          toolResults.push({
            id: tc.id,
            name: tc.name,
            content: `unknown tool: ${tc.name}`,
            isError: true,
          });
        }
      } catch (err) {
        toolResults.push({
          id: tc.id,
          name: tc.name,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      }
    }

    // "Emit then stop" — terminate the iteration loop after any turn that
    // produced an emit. Real tool calls (memory_search, web_fetch, etc.)
    // continue iterating; only output emissions end the loop. This caps
    // each processor invocation to a single emission of each output type
    // and prevents Gemini from looping on emit_<type> indefinitely.
    if (emittedThisTurn > 0) {
      return;
    }
  }

  ctx.log(`(${proc.name}) hit maxIterations (${maxIterations}) without emitting`);
}

/**
 * Collect timeline events for context, optionally honoring session boundaries.
 *
 * If `sessionEvents` is provided, finds the most recent event whose type is in
 * that list and only returns events at or after it (capped at `count`). This
 * is how Claudius mirrors a Claude-style session: a `session_start` event
 * makes the model "forget" prior turns; a `conversation_compacted` event
 * collapses earlier context into a summary.
 */
function collectRecentEvents(
  ctx: ProcessorContext,
  count: number,
  sessionEvents?: string[],
): CadmusEvent[] {
  if (!sessionEvents || sessionEvents.length === 0) {
    return ctx.timeline.recent(count);
  }
  let boundarySeq = -1;
  for (const eventType of sessionEvents) {
    const ev = ctx.timeline.latest(eventType);
    if (ev && ev.seq > boundarySeq) boundarySeq = ev.seq;
  }
  if (boundarySeq < 0) {
    return ctx.timeline.recent(count);
  }
  // Get events with seq >= boundarySeq. We use timeline.recent(count) and
  // filter; that keeps the API surface small. `count` becomes the cap.
  const tail = ctx.timeline.recent(count);
  const fromBoundary = tail.filter((e) => e.seq >= boundarySeq);
  // If the boundary is older than the tail, walk backward via the full list.
  if (fromBoundary.length > 0 && fromBoundary[0].seq === boundarySeq) {
    return fromBoundary;
  }
  return ctx.timeline.all().filter((e) => e.seq >= boundarySeq).slice(-count);
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
