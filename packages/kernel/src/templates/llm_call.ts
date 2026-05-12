/**
 * llm_call template — single provider turn per processor invocation.
 *
 * The model can call real tools and emit_<type> tools in this turn, but it
 * does NOT see tool results within the same turn. The next invocation,
 * triggered by some downstream filter match, will see them in the JSON
 * context dump.
 *
 * Loops are external. A processor that wants to "keep thinking" emits an
 * event whose type its own filter matches; emitting a terminal event nothing
 * loops on (e.g. `output`) exits the cycle.
 */

import { createSession } from "../providers/index.js";
import type { ProviderToolDef } from "../providers/index.js";
import type { CadmusEvent, Processor, ProcessorContext, Tool } from "../types.js";
import {
  DEFAULT_CONTEXT_EVENTS,
  DEFAULT_MODEL,
  asObjectSchema,
  collectRecentEvents,
  formatEventForPrompt,
  pickTextOutputEvent,
} from "./shared.js";

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

export async function runLLMCallTemplate(
  proc: Processor,
  event: CadmusEvent,
  ctx: ProcessorContext,
  toolRegistry: Record<string, Tool>,
): Promise<void> {
  const cfg = proc.templateConfig;
  if (!cfg?.systemPrompt) {
    throw new Error(`Processor ${proc.name} (llm_call) is missing templateConfig.systemPrompt`);
  }

  const recent = collectRecentEvents(ctx, cfg.contextEvents ?? DEFAULT_CONTEXT_EVENTS);

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
    // Forgiving fallback: text-only response → emit it as a text-shaped output.
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

  // Dedupe emit_<type> within a single turn.
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
        await ctx.callTool(tc.name, tc.input);
      } else {
        ctx.log(`(${proc.name}) ignoring unknown tool: ${tc.name}`);
      }
    } catch (err) {
      ctx.log(`(${proc.name}) tool ${tc.name} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
