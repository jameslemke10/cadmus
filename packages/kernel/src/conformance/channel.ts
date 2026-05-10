/**
 * Conformance test harness for Channel.
 *
 * Channels are inherently coupled to external systems (stdin, sockets,
 * webhooks), so the harness intentionally splits into two layers:
 *
 *  - assertChannelStructure(channel): synchronous structural checks. Run
 *    this on any channel — it's cheap and catches the most common
 *    misconfigurations.
 *
 *  - assertChannelLifecycle(channel, mockTimeline?): exercises start /
 *    stop / idempotency against a mock ChannelContext. Channels that
 *    touch real I/O on start (the built-in CLI channel hooks stdin)
 *    will leave that listener attached during this test — design your
 *    test environment accordingly.
 *
 * Behavioral conformance for inbound (does external traffic produce a
 * correctly-shaped `input` event?) and outbound (does the channel
 * actually deliver matching `output` events to its destination?) is
 * intentionally NOT covered by this harness — those tests are
 * channel-specific and must be written by the author.
 */

import type { CadmusEvent, Channel, ChannelContext, TimelineReader } from "../types.js";

class ConformanceError extends Error {
  constructor(message: string) {
    super(`Channel conformance: ${message}`);
    this.name = "ConformanceError";
  }
}

/** Synchronous structural checks. Cheap; run on every channel. */
export function assertChannelStructure(channel: Channel): void {
  if (typeof channel.name !== "string" || channel.name.length === 0) {
    throw new ConformanceError("channel.name must be a non-empty string");
  }
  if (channel.inboundEvents !== undefined) {
    if (!Array.isArray(channel.inboundEvents)) {
      throw new ConformanceError("channel.inboundEvents must be an array if present");
    }
    for (const t of channel.inboundEvents) {
      if (typeof t !== "string") {
        throw new ConformanceError("channel.inboundEvents must be an array of strings");
      }
    }
  }
  if (channel.outboundEvents !== undefined) {
    if (!Array.isArray(channel.outboundEvents)) {
      throw new ConformanceError("channel.outboundEvents must be an array if present");
    }
    for (const t of channel.outboundEvents) {
      if (typeof t !== "string") {
        throw new ConformanceError("channel.outboundEvents must be an array of strings");
      }
    }
  }
  if (typeof channel.start !== "function") {
    throw new ConformanceError("channel.start must be a function");
  }
  if (typeof channel.stop !== "function") {
    throw new ConformanceError("channel.stop must be a function");
  }
}

/**
 * Exercises start / stop / idempotency. Returns the events emitted by
 * the channel during the test, in case the caller wants to assert on
 * them.
 */
export async function assertChannelLifecycle(channel: Channel): Promise<CadmusEvent[]> {
  assertChannelStructure(channel);

  const emitted: CadmusEvent[] = [];
  const listeners = new Set<(event: CadmusEvent) => void>();

  const fakeTimeline: TimelineReader = {
    recent: () => [],
    byId: () => null,
    latest: () => null,
    all: () => [],
    count: () => 0,
  };

  let nextSeq = 1;
  const ctx: ChannelContext = {
    agentId: "conformance-test-agent",
    timeline: fakeTimeline,
    emit: async (type, data) => {
      const event: CadmusEvent = {
        id: `conf_${nextSeq}`,
        seq: nextSeq++,
        timestamp: new Date().toISOString(),
        type,
        agent_id: "conformance-test-agent",
        session_id: null,
        data,
        parent_event_id: null,
        tags: [],
      };
      emitted.push(event);
      // Echo to listeners so subscribe() works in the harness.
      for (const l of listeners) {
        try {
          l(event);
        } catch {
          // ignore listener throws
        }
      }
      return event;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log: () => undefined,
  };

  // ── 1. start returns a Promise
  const startResult = channel.start(ctx);
  if (!(startResult instanceof Promise)) {
    throw new ConformanceError("channel.start must return a Promise");
  }
  await startResult;

  // ── 2. start is idempotent — second call should not throw
  try {
    await channel.start(ctx);
  } catch (err) {
    throw new ConformanceError(
      `start() must be idempotent; second call threw: ${err instanceof Error ? err.message : err}`,
    );
  }

  // ── 3. inbound events emitted by the channel during start MUST have
  // data.channel === channel.name and a kind field (if any inbound was emitted).
  for (const ev of emitted) {
    if (ev.type === "input") {
      const d = ev.data as { channel?: unknown; kind?: unknown };
      if (d.channel !== channel.name) {
        throw new ConformanceError(
          `channel emitted input with data.channel="${String(d.channel)}", expected "${channel.name}"`,
        );
      }
      if (typeof d.kind !== "string") {
        throw new ConformanceError("channel emitted input without a string data.kind");
      }
    }
  }

  // ── 4. stop returns a Promise
  const stopResult = channel.stop();
  if (!(stopResult instanceof Promise)) {
    throw new ConformanceError("channel.stop must return a Promise");
  }
  await stopResult;

  // ── 5. start can be called again after stop (full lifecycle)
  try {
    await channel.start(ctx);
    await channel.stop();
  } catch (err) {
    throw new ConformanceError(
      `start/stop cycle should be repeatable; second cycle threw: ${err instanceof Error ? err.message : err}`,
    );
  }

  return emitted;
}

/** Convenience: runs both structural and lifecycle checks. */
export async function assertChannelConforms(channel: Channel): Promise<CadmusEvent[]> {
  return assertChannelLifecycle(channel);
}
