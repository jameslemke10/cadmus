/**
 * Telly — a Telegram-connected agent.
 *
 * One LLM processor wired to:
 *   - Telegram (long-poll bot, reads TELEGRAM_BOT_TOKEN from env)
 *   - Studio (the brain canvas + chat panel)
 *   - Persistent memory (~/.cadmus/agents/telly/.cadmus/memory.db)
 *
 * Setup:
 *   1. Get a bot token from @BotFather on Telegram.
 *   2. cadmus setup — paste your LLM API key and the bot token, or
 *      set TELEGRAM_BOT_TOKEN in your environment.
 *   3. cadmus use telly
 *   4. cadmus start --daemon
 *   5. Message your bot, or talk to it in Studio (both inputs flow
 *      through the same agent and the same memory).
 *
 * Routing back to the right Telegram chat is automatic: the channel
 * stamps each input with session_id = "telegram:<chat_id>", and any
 * descendant output event (no matter how many processor hops away)
 * carries that session forward.
 */

import { defineAgent, defineProcessor, createTelegramChannel } from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";
import { getCurrentTime } from "@cadmus/tools/time";

const memory = createMemory({ path: ".cadmus/memory.db" });

export default defineAgent({
  agentId: "telly",
  name: "Telly",
  channels: [
    // Reads TELEGRAM_BOT_TOKEN from env. The runner auto-adds the
    // Studio channel in dev mode, so you can also talk to Telly in
    // the browser.
    createTelegramChannel(),
  ],
  tools: {
    ...memory.tools, // memory_search, memory_write, memory_delete
    get_current_time: getCurrentTime,
  },
  processors: [
    defineProcessor({
      name: "agent",
      template: "llm",
      filter: ["input"],
      tools: ["memory_search", "memory_write", "memory_delete", "get_current_time"],
      outputEvents: ["output"],
      outputSchema: {
        output: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Target channel, or '*' to broadcast." },
            kind: { type: "string", description: "Payload variant. Use 'text' for plain text." },
            text: { type: "string" },
          },
          required: ["channel", "kind", "text"],
        },
      },
      templateConfig: {
        model: "gemini-2.5-flash",
        contextEvents: 50,
        systemPrompt: `You are Telly — a friendly assistant that lives in someone's Telegram and Studio. Plainspoken, first person, concise. No "as an AI" disclaimers.

You have access to memory tools:
  - memory_search before responding if context might exist
  - memory_write to remember facts about whoever you're talking to:
      kind: "semantic", tags: ["preference"]  → preferences
      kind: "semantic", tags: ["identity"]    → facts about yourself
      kind: "procedural"                       → skills / how-to
      kind: "episodic"                         → notable events
  - memory_delete to forget something that's no longer true

When you have something to say, call emit_output with { channel: "*", kind: "text", text }. The framework knows which Telegram chat (or Studio session) sent the input and routes your reply back automatically — you don't need to know about chat IDs.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
