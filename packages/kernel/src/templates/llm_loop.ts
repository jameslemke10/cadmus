/**
 * llm_loop template — multi-turn provider session per processor invocation.
 *
 * The model calls tools; the runtime feeds the tool results back into the
 * SAME provider session; the model keeps going until it stops calling tools.
 * Then its final text is emitted as a text-shaped outputEvent.
 *
 * This is the "Claude Code" style of conversation: one user input → one
 * assistant response that may include any number of internal tool calls.
 *
 * Tool calls are still recorded on the timeline (tool_call + tool_result),
 * but the loop does NOT exit on each tool_result; the same processor
 * invocation continues across turns.
 */

import { createSession } from "../providers/index.js";
import type { ProviderToolDef, ProviderToolResult } from "../providers/index.js";
import type { CadmusEvent, Processor, ProcessorContext, Tool } from "../types.js";
import {
  DEFAULT_CONTEXT_EVENTS,
  DEFAULT_MODEL,
  collectRecentEvents,
  formatEventForPrompt,
  pickTextOutputEvent,
} from "./shared.js";

const DEFAULT_MAX_ITERATIONS = 10;

function buildContextMessage(
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

  lines.push(`# Your job`);
  lines.push(
    `Call the tools you need. Tool results will be returned to you in the same conversation, so you can chain calls. When you have nothing more to do, stop calling tools and reply in plain text — that text becomes your final output.`,
  );

  return lines.join("\n");
}

export async function runLLMLoopTemplate(
  proc: Processor,
  event: CadmusEvent,
  ctx: ProcessorContext,
  toolRegistry: Record<string, Tool>,
): Promise<void> {
  const cfg = proc.templateConfig;
  if (!cfg?.systemPrompt) {
    throw new Error(`Processor ${proc.name} (llm_loop) is missing templateConfig.systemPrompt`);
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

  const session = createSession({
    model: cfg.model ?? DEFAULT_MODEL,
    systemPrompt: cfg.systemPrompt,
    initialUserMessage: buildContextMessage(event, recent),
    tools,
    maxTokens: cfg.maxTokens ?? 4096,
    temperature: cfg.temperature ?? 0.7,
    apiKey: cfg.apiKey,
  });

  const maxIterations = cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let lastText = "";
  let pendingResults: ProviderToolResult[] | undefined = undefined;

  for (let i = 0; i < maxIterations; i++) {
    const turn = await session.send(pendingResults);
    if (turn.text.trim()) lastText = turn.text;

    if (turn.toolCalls.length === 0) {
      break;
    }

    pendingResults = [];
    for (const tc of turn.toolCalls) {
      if (!realToolNames.has(tc.name)) {
        ctx.log(`(${proc.name}) ignoring unknown tool: ${tc.name}`);
        pendingResults.push({
          id: tc.id,
          name: tc.name,
          content: `unknown tool: ${tc.name}`,
          isError: true,
        });
        continue;
      }
      try {
        const result = await ctx.callTool(tc.name, tc.input);
        pendingResults.push({
          id: tc.id,
          name: tc.name,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (err) {
        pendingResults.push({
          id: tc.id,
          name: tc.name,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        });
      }
    }

    if (i === maxIterations - 1) {
      ctx.log(`(${proc.name}) hit maxIterations=${maxIterations} — stopping loop`);
    }
  }

  if (!lastText.trim()) return;

  const fallbackEvent = pickTextOutputEvent(proc);
  if (!fallbackEvent) {
    ctx.log(`(${proc.name}) loop ended with text but no text-shaped outputEvent: ${lastText.slice(0, 200)}`);
    return;
  }
  await ctx.emit(fallbackEvent, {
    channel: "*",
    kind: "text",
    text: lastText.trim(),
  });
}
