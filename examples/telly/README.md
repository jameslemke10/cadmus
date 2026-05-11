# Telly

A Telegram-connected agent. One LLM processor, persistent memory, dual-channel (Telegram + Studio).

## Setup

1. Get a bot token from [@BotFather](https://t.me/botfather).
2. Run `cadmus setup` — paste your LLM API key and the bot token. (Or export `TELEGRAM_BOT_TOKEN` in your shell.)
3. `cadmus use telly`
4. `cadmus start --daemon` — runs in the background so the bot stays live.
5. Message your bot on Telegram, or open the Studio UI in your browser. Both inputs flow through the same agent and the same memory.

## How routing works

Telly's Telegram channel stamps every inbound message with `session_id = "telegram:<chat_id>"`. The runtime propagates that session id to every descendant event automatically, so when the LLM emits `output` the channel knows which chat to reply to. No `chat_id` plumbing in the agent code.

The same agent serves Studio (which uses `session_id` differently — but the chat panel filters output by `data.channel === "studio"` anyway). If you want Telly to only respond on Telegram, tighten the LLM's `emit_output` to set `channel: "telegram"` instead of `"*"`.

## Memory

Memories live in `~/.cadmus/agents/telly/.cadmus/memory.db`. They persist across restarts and across both channels — what Telly learns from your Telegram messages is available when you chat in Studio, and vice versa.
