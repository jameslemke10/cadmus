# Cadmus

**Every agent framework manages context windows. Cadmus manages cognition.**

Cadmus is an open-source framework for building AI agents around an append-only timeline of typed events. Processors subscribe to event types and emit new events; the shape of an agent emerges from how the processors are wired. The brain pattern (hippocampus → thalamus → PFC → executor) is one example. The simplest user-input → response loop is another. Build whatever shape fits your problem.

```
┌──────────────────────────────────────────────────┐
│                   TIMELINE (SQLite)              │
│  ···→ [evt1] → [evt2] → [evt3] → [evt4] → ···   │
└────┬─────────────────┬──────────────────┬────────┘
     │                 │                  │
 ┌───▼────┐     ┌──────▼──────┐    ┌──────▼──────┐
 │ Proc A │     │  Proc B     │    │  Proc C     │
 │ (llm)  │     │  (llm)      │    │  (code)     │
 └────────┘     └─────────────┘    └─────────────┘
```

---

## Install

One line:

```bash
curl -fsSL https://raw.githubusercontent.com/jameslemke10/cadmus/main/install.sh | bash
```

Then:

```bash
cadmus setup        # paste your GOOGLE_API_KEY (or ANTHROPIC_API_KEY)
cadmus start        # opens Studio in your browser
```

The installer drops everything into `~/.cadmus/` and ships two agents pre-installed:

- **Cadmus** — the flagship. Five-processor brain pipeline with retrieved memory and working-memory assembly.
- **Claudius** — a Claude-style chat assistant. Single LLM processor, persistent memory, session boundaries. Closer to what most developers already know.

Switch between them: `cadmus use cadmus` or `cadmus use claudius`.

---

## Studio

When `cadmus start` runs, your browser opens to Studio at `http://localhost:3001`.

- **Agent sidebar (left):** every agent in `~/.cadmus/agents/`. Click to switch.
- **Brain canvas (center):** every processor rendered as a node. Edges show event flow (which processor's output triggers which other processor's filter). Click a node to inspect its system prompt, model, and tools. Edges and nodes pulse green as events flow through.
- **Chat (right):** talk to the agent.
- **Timeline drawer (📜 toolbar):** every event as it lands.

The kernel and Studio talk over HTTP and Server-Sent Events on `localhost:4000`. The browser opens automatically.

---

## How it works

### Three primitives

1. **Event** — `{ id, seq, timestamp, type, agent_id, data, parent_event_id, tags }`. Append-only. Any string is a valid `type`.
2. **Processor** — `{ name, template, filter, outputEvents, tools, templateConfig | handler }`. Subscribes to event types via `filter`, emits new ones via `outputEvents`.
3. **Tool** — JSON-schema input + handler. Processors declare which tools they can call.

### Two templates

- **`llm`** — calls a model. Synthesized `emit_<type>` tools wrap each output event so the model emits events by tool-calling. Provider auto-detected from model name (`gemini-*` → Google, `claude-*` → Anthropic).
- **`code`** — your async handler with `(event, ctx) => Promise<void>`. Same `ctx.emit` and `ctx.callTool`. No LLM cost, deterministic.

### Storage

SQLite via `better-sqlite3` (WAL mode, indexed on type, agent_id, parent_event_id). One DB per agent at `~/.cadmus/agents/<name>/.cadmus/timeline.db`. The timeline is also a pub/sub — the runtime subscribes and dispatches events to matching processors as they land.

### Wiring is checked at boot

The runtime warns if a processor filters on an event type that nothing emits. Lets you catch broken pipelines before a user is waiting.

### Tools

Tools are plain async functions with a JSON-schema input. A tool def looks like:

```ts
const calculate = defineTool({
  name: "calculate",
  description: "Evaluate an arithmetic expression.",
  input_schema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
  handler: async (args) => {
    /* ... */
  },
});
```

A processor declares which tools it can call by listing their names in `tools: [...]`. The framework injects them into the model's tool list. When the model tool-calls, the framework runs the handler and sends the result back. Tool calls produce `tool_called` and `tool_result` events on the timeline so everything is observable.

---

## Server endpoints

The kernel exposes a small HTTP API on port `4000` (configurable via `CADMUS_PORT`). Studio uses it; you can call it from anything.

| Endpoint | Purpose |
|---|---|
| `GET /api/agent` | Agent metadata: id, name, processors (with system prompts and schemas), tools. |
| `GET /api/status` | Provider config health: which providers are needed, which are configured. Powers Studio's setup wizard. |
| `GET /api/workspace` | List of agents installed in `~/.cadmus/agents/` + which is active. |
| `POST /api/workspace/active-agent` | Set the active agent. `{ name }`. |
| `GET /api/events` | Timeline events since a given seq. Query: `?since=<seq>&limit=<n>`. |
| `GET /api/events/all` | Full timeline. |
| `GET /api/stream` | SSE stream — every new event as it lands. |
| `POST /api/inject` | Inject an event. `{ text }` for `user_input`, or `{ type, data }` for any event type. |

CORS is permissive. Use it to build dashboards, eval pipelines, or your own UIs.

---

## The two agents

### Cadmus — the brain pipeline

```
user_input ─┐
tool_result ┼─▶ hippocampus (llm) ─▶ memory_retrieved
            │
            ▼
        thalamus (llm) ─▶ working_memory_updated
            │
            ▼
          pfc (llm) ─▶ pfc_response
            │
            ▼
        executor (code) ─▶ tool_called → tool_result OR agent_message
```

- **hippocampus** — small/fast model. Reads the trigger event + recent timeline. Calls `memory_search` 1–3 times with targeted queries. Emits `memory_retrieved` with merged results.
- **thalamus** — small/fast model. Compresses the conversation, picks the 2–5 most relevant memories, surfaces recent tool results. Emits `working_memory_updated` — a single tight snapshot the PFC will see.
- **pfc** — the conscious reasoner. Carries the Cadmus mythology persona. Reads only the working memory. Decides on tool calls and the response.
- **executor** — code processor (no LLM). Runs the PFC's tool calls, emits `tool_called`/`tool_result`. If the PFC produced a `response_to_user`, emits `agent_message`.

Tools available: `memory_search`, `memory_write` (hippocampus), `calculate`, `get_current_time` (PFC).

Memory is in-memory in this example (cleared on restart). Replace with a vector store or Postgres-backed implementation by swapping the tool's handler — the rest of the pipeline doesn't change.

### Claudius — the boring loop

```
user_input ─────────┐
tool_result ────────┤
session_started ────┼─▶ pfc (llm + tools) ─▶ agent_message
conversation_       │       │
compacted ──────────┘       └─▶ tool_called → tool_result ─▶ pfc loops
```

A single PFC processor. Whatever fits in the context window IS the working memory. Closer to a Claude-style chat assistant.

**Session boundaries** — Claudius honors two events:
- `session_started` — model "forgets" prior turns. Like `/clear` in Claude Code.
- `conversation_compacted` — collapses earlier context into a summary in `data.summary`. Like Claude's automatic compaction.

The PFC's `sessionEvents` config makes the framework only show events at or after the most recent boundary. Inject either event from the timeline drawer or via `POST /api/inject`.

**Persistent memory** — `.cadmus/memories.json` beside the timeline DB, survives kernel restarts. Three tools:
- `memory_search` — free-text query.
- `memory_write` — save a new memory.
- `memory_list` — N most recent. Useful at session start.

Other tools: `calculate`, `get_current_time`.

---

## CLI

```
Daily use
  cadmus start              Boot the active agent's kernel + Studio UI
  cadmus stop               Kill any running cadmus processes
  cadmus list               Show installed agents (★ marks the active one)
  cadmus use <name>         Switch the active agent

Setup
  cadmus setup              Interactive: pick provider, paste API key
  cadmus config             Edit settings (alias for setup)

Agents
  cadmus add <name>         Create a new agent under ~/.cadmus/agents/<name>/
  cadmus rm <name>          Move an agent to ~/.Trash/
  cadmus export <name>      Export to <name>.cadmus.json (--with-timeline optional)
  cadmus import <file>      Import an agent (.cadmus.json)

Other
  cadmus inspect            Print the active agent's timeline as JSON
  cadmus uninstall          Move ~/.cadmus to trash (with confirm)
  cadmus help               Show this help
```

`cadmus add my-agent` scaffolds a fresh agent under `~/.cadmus/agents/my-agent/` with a starter `cadmus.config.ts`. Multi-agent works out of the box: install as many as you want, switch with `cadmus use`.

### Sharing agents

```bash
cadmus export my-agent              # → ./my-agent.cadmus.json
# send the file to a friend, or commit it to a repo
cadmus import their-agent.cadmus.json
cadmus import their-agent.cadmus.json --as their-renamed
```

Exports include the agent's `cadmus.config.ts`, README, and persistent memories. Add `--with-timeline` to include the event log too. Imports drop the agent into `~/.cadmus/agents/<name>/` and make it active.

---

## Build a custom processor

The minimum viable processor — a code processor that watches every `agent_message` and counts tokens — is about 20 lines:

```ts
import { defineProcessor } from "@cadmus/kernel";

export default defineProcessor({
  name: "token_counter",
  template: "code",
  filter: ["agent_message"],
  outputEvents: ["token_count"],
  handler: async (event, ctx) => {
    const text = (event.data as { text?: string }).text ?? "";
    const tokens = text.split(/\s+/).length; // rough
    await ctx.emit("token_count", { tokens });
  },
});
```

Add it to your agent's `processors: [...]` array. The framework dispatches events automatically — no router, no glue code.

---

## Repo layout

```
cadmus/
├── packages/
│   ├── kernel/       @cadmus/kernel  — runtime, timeline, providers, server
│   └── cli/          @cadmus/cli     — `cadmus start/stop/setup/list/use/add/...`
├── apps/
│   └── studio/       Local UI: agent sidebar + brain canvas + chat + timeline
├── examples/
│   ├── cadmus/       brain pipeline
│   └── claudius/     Claude-style chat assistant
└── install.sh
```

---

## Why this shape

- **The brain pattern is one configuration, not the framework.** Build any topology by composing processors.
- **Code and LLM mix freely.** Use `llm` where reasoning matters, `code` where determinism does.
- **Everything is observable.** Every reasoning step is an event on the timeline. Replay, debug, audit, eval — all reduce to "filter the timeline."
- **Tools first-class.** Every tool call produces `tool_called` and `tool_result` events. No hidden side effects.
- **Provider-agnostic.** Gemini and Claude today, more on the way. Swap by changing one model name.

---

## Roadmap

- [x] Kernel: timeline, processors, llm/code templates, HTTP+SSE server
- [x] Provider routing: Google (Gemini) + Anthropic (Claude)
- [x] CLI: install / start / stop / list / use / add / setup / export / import / uninstall
- [x] Studio: brain canvas, chat, processor inspector, agent sidebar
- [x] Two example agents: Cadmus (brain pipeline) + Claudius (Claude-style)
- [ ] Edit-in-UI: change a processor's prompt or model from Studio, hot-reload
- [ ] Hot-switch: `cadmus use` from Studio without restart
- [ ] OpenAI provider, local models via Ollama
- [ ] Vector memory backend
- [ ] Timeline replay on import (currently `cadmus import` drops the timeline)

## License

MIT. See [LICENSE](./LICENSE).
