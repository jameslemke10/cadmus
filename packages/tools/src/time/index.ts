/**
 * Time tools — current time, sleep.
 */

import { defineTool } from "@cadmus/kernel";

export const getCurrentTime = defineTool({
  name: "get_current_time",
  description:
    "Return the current ISO 8601 timestamp, plus the local timezone offset.",
  input_schema: { type: "object", properties: {} },
  handler: async () => ({
    iso: new Date().toISOString(),
    timestamp_ms: Date.now(),
    timezone_offset_minutes: -new Date().getTimezoneOffset(),
  }),
});

export const sleep = defineTool({
  name: "sleep",
  description: "Pause for N milliseconds. Capped at 30 seconds.",
  input_schema: {
    type: "object",
    properties: { ms: { type: "number" } },
    required: ["ms"],
  },
  handler: async (args) => {
    const ms = Math.min(30000, Math.max(0, (args as { ms: number }).ms));
    await new Promise((res) => setTimeout(res, ms));
    return { slept_ms: ms };
  },
});
