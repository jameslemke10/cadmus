/**
 * Built-in scheduler channel — emits a periodic event onto the timeline.
 * The "external system" the channel bridges from is the wall clock.
 *
 * Used to drive agents that should think on their own, like a heartbeat
 * (every N seconds, the agent decides whether to act). Pair with a
 * processor whose filter includes the configured event type.
 *
 *   import { createSchedulerChannel } from "@cadmus/kernel";
 *
 *   channels: [
 *     createSchedulerChannel({ intervalMs: 30_000 }),  // every 30 seconds
 *     createCliChannel(),
 *   ],
 *
 *   // and on the processor that should wake:
 *   filter: ["input", "pfc_loop", "heartbeat"],
 */

import type { Channel, ChannelContext } from "../types.js";

export interface SchedulerChannelOptions {
  /** Channel name. Default: "scheduler". */
  name?: string;
  /** Event type to emit. Default: "heartbeat". */
  eventType?: string;
  /** Interval in milliseconds. Default: 30000 (30s). */
  intervalMs?: number;
  /** If true, emit one event immediately on start as well as on the interval. Default: false. */
  fireOnStart?: boolean;
}

export function createSchedulerChannel(options: SchedulerChannelOptions = {}): Channel {
  const name = options.name ?? "scheduler";
  const eventType = options.eventType ?? "heartbeat";
  const intervalMs = options.intervalMs ?? 30_000;
  const fireOnStart = options.fireOnStart ?? false;

  let timer: NodeJS.Timeout | null = null;
  let counter = 0;

  return {
    name,
    inboundEvents: [eventType],
    outboundEvents: [],
    config: options as Record<string, unknown>,

    async start(ctx: ChannelContext) {
      if (timer) return; // idempotent

      const fire = () => {
        counter += 1;
        void ctx.emit(eventType, {
          channel: name,
          tick: counter,
          intervalMs,
        });
      };

      if (fireOnStart) fire();
      timer = setInterval(fire, intervalMs);
      // Don't keep the Node process alive solely for the timer.
      timer.unref?.();
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
