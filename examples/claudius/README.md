# Claudius — the boring agent

The simplest useful agent on Cadmus. One PFC processor that loops `user_input → tool calls → tool results → response`. Modeled to mirror the Claude-style chat assistant most developers already know — sessions, compaction, persistent memory.

```
user_input ─────────┐
tool_result ────────┤
session_started ────┼─▶ pfc (llm + memory tools) ─▶ agent_message
conversation_       │       │
compacted ──────────┘       └─▶ tool_called → tool_result ─▶ pfc loops
```

## What makes it Claude-like

**Session boundaries**

`session_started` and `conversation_compacted` are first-class events. The PFC's `sessionEvents` config tells the LLM template to only show events at or after the most recent boundary. So:

- Inject `session_started` → the model "forgets" the prior conversation. Same effect as `/clear` in Claude Code.
- Inject `conversation_compacted` with a summary in `data.summary` → the model treats that summary as authoritative context for everything that came before. Same shape as Claude's automatic compaction.

You can inject either from Studio's chat input (use the `📜 timeline` panel) or via curl:

```bash
curl -X POST http://localhost:4000/api/inject \
  -H 'content-type: application/json' \
  -d '{"type":"session_started","data":{"reason":"new topic"}}'

curl -X POST http://localhost:4000/api/inject \
  -H 'content-type: application/json' \
  -d '{"type":"conversation_compacted","data":{"summary":"User asked about X, agreed to Y, decided Z."}}'
```

**Persistent memory**

Memories are stored in `.cadmus/memories.json` (a flat JSON file beside the timeline DB). They survive kernel restarts and session boundaries. The PFC has three tools:

| Tool | Purpose |
|---|---|
| `memory_search` | Free-text query against stored memories. |
| `memory_write` | Save a new memory with summary, tags, importance. |
| `memory_list` | List the N most recent memories — useful at the start of a new session. |

The system prompt encourages calling `memory_search` when context might exist and `memory_write` when the user tells you something worth carrying forward.

## Run

```bash
cadmus use claudius
cadmus start
```

Or, headless:

```bash
cadmus dev cadmus.config.ts
```

## Why this exists

Claudius proves the framework isn't opinionated about cognitive architecture. The brain pattern in [`../cadmus`](../cadmus) is one configuration; this is another. Build whatever shape fits your problem.
