/**
 * Shared helpers for the llm_call and llm_loop templates.
 */

import type { CadmusEvent, Processor, ProcessorContext } from "../types.js";

export const DEFAULT_MODEL = "gemini-2.5-flash";
export const DEFAULT_CONTEXT_EVENTS = 50;
export const BOUNDARY_EVENT_TYPE = "event_boundary";

export function asObjectSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) {
    return { type: "object", properties: {}, required: [] };
  }
  if (schema.type === "object") {
    return schema;
  }
  return {
    type: "object",
    properties: { data: schema as Record<string, unknown> },
    required: ["data"],
  };
}

export function formatEventForPrompt(event: CadmusEvent): string {
  return `[${event.seq}] ${event.type} (${event.id})
${JSON.stringify(event.data, null, 2)}`;
}

/**
 * Collect timeline events for context. Always scopes the window to events
 * at-or-after the most recent `event_boundary`, capped at `count` events.
 */
export function collectRecentEvents(ctx: ProcessorContext, count: number): CadmusEvent[] {
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
 * Pick the best output event to use as the carrier for plain text. Heuristic:
 *   1. An output event whose schema declares a `text: string` property.
 *   2. An output event named like a message (output, message, response).
 *   3. Otherwise, null — caller decides what to do.
 */
export function pickTextOutputEvent(proc: Processor): string | null {
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
