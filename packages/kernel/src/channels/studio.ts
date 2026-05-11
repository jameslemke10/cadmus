/**
 * Studio channel — a no-op channel that exists so the brain canvas can
 * visualize the Studio UI as a real source/sink.
 *
 * Studio's actual transport is HTTP+SSE on the kernel's server port
 * (POST /api/inject, GET /api/stream); the server attributes those
 * injected events with `source: "channel:studio"`. This channel object
 * doesn't do any I/O — it just declares its name + inbound/outbound
 * event types so /api/agent reports it and the canvas renders it.
 *
 * The runner auto-adds this channel in dev mode so every agent gets a
 * Studio node on the canvas without the user having to add it manually.
 */

import type { Channel } from "../types.js";

export interface StudioChannelOptions {
  name?: string;
}

export function createStudioChannel(options: StudioChannelOptions = {}): Channel {
  return {
    name: options.name ?? "studio",
    inboundEvents: ["input"],
    outboundEvents: ["output"],
    config: options as Record<string, unknown>,
    async start() {
      // no-op: HTTP server + SSE handle the real I/O
    },
    async stop() {
      // no-op
    },
  };
}
