/**
 * Built-in CLI channel — bridges process.stdin / process.stdout to the
 * timeline. Reference implementation of the Channel spec for the local
 * terminal case.
 *
 * Inbound: each line on stdin becomes an `input` event with
 *   { channel: "cli", kind: "text", text: <line> }.
 * Outbound: any `output` event whose data.channel is "cli" or "*" is
 * written to stdout (currently text kind only).
 */

import type { Channel, ChannelContext } from "../types.js";

export interface CliChannelOptions {
  /** Override the channel name. Default: "cli". */
  name?: string;
}

export function createCliChannel(options: CliChannelOptions = {}): Channel {
  const name = options.name ?? "cli";
  let unsubscribe: (() => void) | null = null;
  let stdinHandler: ((chunk: Buffer | string) => void) | null = null;

  return {
    name,
    inboundEvents: ["input"],
    outboundEvents: ["output"],
    config: options as Record<string, unknown>,

    async start(ctx: ChannelContext) {
      if (unsubscribe || stdinHandler) return; // idempotent

      // Outbound: route output events targeting this channel to stdout.
      unsubscribe = ctx.subscribe((event) => {
        if (event.type !== "output") return;
        const d = event.data as { channel?: string; kind?: string; text?: string };
        if (d.channel !== name && d.channel !== "*") return;
        if (d.kind === "text" && typeof d.text === "string") {
          process.stdout.write(d.text + "\n");
        }
      });

      // Inbound: each newline-terminated line on stdin becomes an input event.
      process.stdin.setEncoding("utf8");
      let buffer = "";
      stdinHandler = (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          void ctx.emit("input", {
            channel: name,
            kind: "text",
            text: line,
          });
        }
      };
      process.stdin.on("data", stdinHandler);
    },

    async stop() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (stdinHandler) {
        process.stdin.off("data", stdinHandler);
        stdinHandler = null;
      }
    },
  };
}
