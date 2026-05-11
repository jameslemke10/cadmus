/**
 * Telegram channel — bridges a Telegram bot to the timeline using long-polling.
 *
 *   import { createTelegramChannel } from "@cadmus/kernel";
 *
 *   channels: [
 *     createTelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN }),
 *   ],
 *
 * Inbound: each user message arrives as an `input` event with
 *   { channel: "telegram", kind: "text", text, chat_id, telegram_user, telegram_message_id }
 *
 * Outbound: any `output` event with channel: "telegram" or "*" routes back
 * to the chat that started the conversation. We find the chat_id by walking
 * the event's parent_event_id chain back to the originating `input`.
 *
 * Token: pass {token} explicitly, or set TELEGRAM_BOT_TOKEN in env.
 * Get a token from BotFather: https://t.me/botfather
 *
 * NOTE: this currently lives in @cadmus/kernel for v0.1 to avoid a package
 * shuffle. It will move to @cadmus/channels/telegram once that package
 * exists (per spec/channel.md).
 */

import type { CadmusEvent, Channel, ChannelContext, TimelineReader } from "../types.js";

export interface TelegramChannelOptions {
  /** Bot token. If omitted, reads from TELEGRAM_BOT_TOKEN env var. */
  token?: string;
  /** Channel name. Default: "telegram". */
  name?: string;
  /** Long-poll timeout in seconds. Default: 30. */
  longPollSeconds?: number;
  /** Override the API base URL (rarely useful — testing only). */
  apiBase?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; username?: string; first_name?: string; type?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  date?: number;
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

interface SendMessageResponse {
  ok: boolean;
  description?: string;
}

export function createTelegramChannel(options: TelegramChannelOptions = {}): Channel {
  const name = options.name ?? "telegram";
  const token = options.token ?? process.env.TELEGRAM_BOT_TOKEN;
  const longPoll = options.longPollSeconds ?? 30;
  const apiBase = options.apiBase ?? "https://api.telegram.org";

  if (!token) {
    throw new Error(
      `createTelegramChannel: no bot token. Pass { token } or set TELEGRAM_BOT_TOKEN.`,
    );
  }

  const endpoint = (method: string): string => `${apiBase}/bot${token}/${method}`;

  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let lastUpdateId = 0;
  let pollPromise: Promise<void> | null = null;

  /**
   * Walk back along parent_event_id to find the originating telegram input
   * event and return its chat_id. Returns null if no telegram input is in
   * the parent chain.
   */
  function findChatId(eventId: string | null, timeline: TimelineReader): number | null {
    let cursor: string | null = eventId;
    let safety = 100;
    while (cursor && safety-- > 0) {
      const ev: CadmusEvent | null = timeline.byId(cursor);
      if (!ev) return null;
      if (ev.type === "input") {
        const d = ev.data as { channel?: string; chat_id?: number };
        if (d.channel === name && typeof d.chat_id === "number") {
          return d.chat_id;
        }
      }
      cursor = ev.parent_event_id;
    }
    return null;
  }

  return {
    name,
    inboundEvents: ["input"],
    outboundEvents: ["output"],
    config: {
      name,
      longPollSeconds: longPoll,
      tokenSet: true,
    },

    async start(ctx: ChannelContext) {
      if (pollPromise) return; // idempotent
      stopped = false;

      // Outbound: route output events back to the originating Telegram chat.
      unsubscribe = ctx.subscribe(async (event) => {
        if (event.type !== "output") return;
        const d = event.data as { channel?: string; kind?: string; text?: string };
        if (d.channel !== name && d.channel !== "*") return;
        if (d.kind !== "text" || typeof d.text !== "string" || !d.text.trim()) return;

        const chatId = findChatId(event.parent_event_id, ctx.timeline);
        if (!chatId) {
          ctx.log(
            `output event ${event.id} has no telegram input in its parent chain — can't route`,
          );
          return;
        }

        try {
          const res = await fetch(endpoint("sendMessage"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: d.text }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as SendMessageResponse;
            ctx.log(`sendMessage failed (${res.status}): ${body.description ?? "no detail"}`);
          }
        } catch (err) {
          ctx.log(`sendMessage error: ${err instanceof Error ? err.message : err}`);
        }
      });

      // Inbound: long-poll for updates.
      pollPromise = (async () => {
        ctx.log(`telegram: long-polling started`);
        while (!stopped) {
          try {
            const url =
              `${endpoint("getUpdates")}?timeout=${longPoll}` +
              (lastUpdateId > 0 ? `&offset=${lastUpdateId + 1}` : "");
            const res = await fetch(url);
            if (!res.ok) {
              ctx.log(`getUpdates failed (${res.status}); backing off 5s`);
              await sleep(5000);
              continue;
            }
            const body = (await res.json()) as GetUpdatesResponse;
            if (!body.ok || !body.result) {
              if (body.description) ctx.log(`getUpdates: ${body.description}`);
              await sleep(2000);
              continue;
            }
            for (const update of body.result) {
              if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
              const msg = update.message ?? update.edited_message;
              if (!msg || !msg.text) continue;
              await ctx.emit("input", {
                channel: name,
                kind: "text",
                text: msg.text,
                chat_id: msg.chat.id,
                chat_type: msg.chat.type,
                telegram_user:
                  msg.from?.username ?? msg.from?.first_name ?? msg.chat.first_name,
                telegram_message_id: msg.message_id,
              });
            }
          } catch (err) {
            if (stopped) break;
            ctx.log(`poll error: ${err instanceof Error ? err.message : err}; backing off 5s`);
            await sleep(5000);
          }
        }
        ctx.log(`telegram: long-polling stopped`);
      })();
    },

    async stop() {
      stopped = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      // Don't await pollPromise — fetch has up to longPoll seconds of latency.
      // The flag will end the loop on next iteration. Caller can move on.
      pollPromise = null;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
