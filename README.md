# Cadmus

**An open-source framework for building AI agents that runs on an event-driven architecture.** Every decision, tool call, memory write, and message is a typed event on an append-only timeline. Processors subscribe to event types and emit new ones; the shape of your agent is the way you wire them together.

That sounds abstract, but the punchline is concrete: **agents stop being black-box loops and become inspectable cognitive pipelines.** You can replay them, audit them, debug them with a real timeline, and swap pieces without rewriting the whole thing.

```
┌──────────────────────────────────────────────────┐
│                   TIMELINE (SQLite)              │
│  ···→ [evt1] → [evt2] → [evt3] → [evt4] → ···    │
└────┬─────────────────┬──────────────────┬────────┘
     │                 │                  │
 ┌───▼────┐     ┌──────▼──────┐    ┌──────▼──────┐
 │ Proc A │     │  Proc B     │    │  Proc C     │
 │ (llm)  │     │  (llm)      │    │  (code)     │
 └────────┘     └─────────────┘    └─────────────┘
```

## What's in the box

- **Tools** — built-in `memory_search` / `memory_write` / `memory_delete`, `web_search` / `web_fetch`, `bash` (opt-in), filesystem, time, and an MCP bridge. Write your own — a tool is a name + JSON-Schema input + async handler.
- **Channels** — the bridge between an external system (your terminal, the Studio UI, eventually Slack/voice) and the timeline. Channels emit `input` events and route `output` events back. The CLI channel and Studio channel are built in.
- **Memory** — SQLite-backed by default, with three canonical kinds: `procedural` (skills), `semantic` (facts), `episodic` (events). Backend is pluggable; backends are interchangeable because every memory write hits the timeline and replay rebuilds the store.
- **Timeline** — typed events with full attribution (you can always see *which* processor emitted *which* event). Append-only, indexed, queryable, durable.

But that's just the foundation. **Cadmus is a playground.** Define your own event types. Write a processor that summarizes conversations every N turns. Wire two LLMs in series. Add a processor that watches the agent and yells when costs spike. The framework knows nothing about brain regions or chat assistants — those are just patterns you can compose.

## Quick start

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/jameslemke10/cadmus/main/install.sh | bash

# Drop in your API key
cadmus setup

# Boot the active agent + Studio UI
cadmus start
```

That opens [Studio](#studio) in your browser. Talk to the agent in the chat panel; watch its cognition flow through the brain canvas in real time.

Daily commands you'll use:

```bash
cadmus start            # boot kernel + Studio
cadmus stop             # kill anything running
cadmus list             # see installed agents (★ = active)
cadmus use <name>       # switch active agent
cadmus add <name>       # scaffold a new agent
```

Full CLI reference is at the [bottom](#cli) of this README.

## How it works — through the two example agents

Cadmus ships with two pre-installed agents. Both solve the same problem (you say something, the agent does something) but they show very different shapes the framework supports.

### Claudius — the familiar shape, with sharper context

```
input ─────────────┐
tool_result ───────┤
session_start ─────┼─▶ pfc (llm + tools) ─▶ output
conversation_      │       │
compacted ─────────┘       └─▶ tool_call → tool_result ─▶ pfc loops on the result
```

This is what most chat agents look like today: one LLM processor in a loop. It reads the recent timeline, picks tool calls, tool results come back, it eventually replies. Done.

What Claudius adds on top of the typical loop is **session-aware context**:

- **`session_start`** — a marker event the model treats as a hard boundary. Everything before is invisible. Like `/clear` in Claude Code.
- **`conversation_compacted`** — a marker event that carries a summary of the prior conversation in `data.summary`. The model treats events from this point as the new "beginning" and uses the summary as authoritative context. Like Claude's automatic compaction.

You inject either event from the Studio timeline drawer or via `curl POST /api/inject`. Both events are *patterns* — the kernel honors them via the processor's `sessionEvents` config. There's no built-in summarizer yet; for now `conversation_compacted` is something you (or a future processor) emit yourself with a hand-crafted summary. The plumbing is there; the agent that fills it in is a small `code` processor away.

Memory in Claudius is the canonical SQLite store from `@cadmus/tools/memory` — survives restarts, survives session boundaries, gets searched across sessions.

### Cadmus — the brain pipeline

```
                ┌─► (executor emits pfc_loop when the LLM needs another pass)
                │
   input ───────┴───► hippocampus ──memory_retrieved──► thalamus
                                                          │
                                            working_memory_updated
                                                          │
                                                          ▼
                                                         pfc ──pfc_response──► executor
                                                                                  │
                                                          ┌──── output ◄──────────┤
                                                          └── pfc_loop ◄──────────┘
```

The Cadmus agent sidesteps the "session" framing entirely. Instead of compacting the conversation when it grows too long, it borrows a slice of how a brain handles attention:

- **Hippocampus** — small fast LLM. Watches for new input or `pfc_loop` signals. Runs targeted memory searches and emits a `memory_retrieved` event with relevant records. (Memory recall.)
- **Thalamus** — small fast LLM. Sees the trigger, the retrieved memories, and the recent timeline. Decides what the PFC actually needs to know *right now* and emits `working_memory_updated` — a tight, curated snapshot. (Working memory assembly.)
- **PFC** — the conscious reasoner. Larger model. Sees *only* the working_memory_updated event. Plans actions, drafts the reply, decides on tool calls. Emits `pfc_response`.
- **Executor** — code processor (no LLM). Runs the PFC's tool calls and emits either `output` (final reply) or `pfc_loop` (PFC needs more info — re-trigger hippocampus).

The point isn't that "brain-shaped" is mystically better. The point is what this *unlocks*:

**Adaptive context.** Each LLM call sees only what it needs. The PFC doesn't get a 30k-token transcript; it gets a curated paragraph. The agent decides what's relevant per turn instead of stuffing everything into one ever-growing context window. That makes it cheaper, faster, and crucially — it stops degrading as conversations get long.

**Decomposed reasoning.** Memory recall, attention, and reasoning live in different processors with different models, different prompts, different costs. You can swap in a bigger model for the PFC without paying for it on every memory lookup.

**Inspectable cognition.** Every step is an event on the timeline with a `source` field saying which processor emitted it. You can see exactly what the agent retrieved, what made it into working memory, and what the PFC reasoned over.

## Build your own

The two examples are starting points, not destinations. Drop them and write something that fits your problem.

```bash
cadmus add my-agent     # scaffolds ~/.cadmus/agents/my-agent/cadmus.config.ts
cadmus use my-agent
cadmus start
```

The scaffold is a working single-processor agent with persistent memory. Edit the config and reload. Common starting points:

- **A research agent** — add `web_search` + `web_fetch` tools, write a processor that emits structured `finding` events, write a second processor that aggregates them into a report.
- **A code reviewer** — add `bash` (opt-in) and `read_file` tools, give the PFC a system prompt about review style, wire a vitals processor that flags PRs whose cost crosses a threshold.
- **A scheduler** — write a `code` processor that emits `timer_fired` events on a schedule. Any other processor can filter on them.
- **A multi-LLM critic** — wire two PFCs. The first drafts; the second critiques and either approves or asks for a revision. The two filter on each other's outputs.

**Contributing back** — three orthogonal surfaces:

- A new tool → `@cadmus/tools` package. Smallest reviewable PR.
- A new channel (Slack, Discord) → conforms to the `Channel` interface in [spec/channel.md](spec/channel.md).
- A new memory backend (Postgres, pgvector, Pinecone) → conforms to `MemoryStore` in [spec/memory.md](spec/memory.md). Runs against `assertMemoryStoreConforms` for free.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for shaped tasks.

---

## Studio

When `cadmus start` runs, your browser opens to Studio at `http://localhost:3001`.

- **Agent sidebar (left):** every agent in `~/.cadmus/agents/`. Click to switch.
- **Brain canvas (center):** processors as nodes, event flow as edges. Edges and nodes pulse green as events flow through. Click a node to inspect its system prompt, model, and tools.
- **Chat (right):** talk to the agent. Messages go in as `input` events with `channel: "studio"`; replies come back as `output` events routed to the same channel.
- **Timeline drawer (📜 toolbar):** every event as it lands, with type, source attribution, and payload preview.

The kernel and Studio talk over HTTP and SSE on `localhost:4000`. Browser opens automatically.

---

## How it works under the hood

### Three primitives

1. **Event** — `{ id, seq, timestamp, type, agent_id, source, tags, data }`. Append-only. Any string is a valid `type`. The `source` field auto-attributes who emitted it (`processor:<name>` | `channel:<name>` | `tool:<name>` | `kernel`).
2. **Processor** — `{ name, template, filter, outputEvents, tools, templateConfig | handler }`. Subscribes to events via `filter` (bare event types OR `{type, source}` for attribution-aware matches), emits new ones via `outputEvents`.
3. **Tool** — JSON-schema input + async handler. Processors declare which tools they can call.

### Two templates

- **`llm`** — calls a model. Synthesized `emit_<type>` tools wrap each output event so the model emits by tool-calling. Provider auto-detected from model name (`gemini-*` → Google, `claude-*` → Anthropic).
- **`code`** — your async handler with `(event, ctx) => Promise<void>`. Same `ctx.emit` and `ctx.callTool`. No LLM cost, deterministic.

### Storage

SQLite via `better-sqlite3` (WAL mode, indexed on type/agent_id/source). One DB per agent at `~/.cadmus/agents/<name>/.cadmus/timeline.db`. The timeline is also a pub/sub — the runtime subscribes and dispatches events to matching processors as they land.

### Wiring is checked at boot

The runtime warns if a processor filters on an event type that nothing emits. Lets you catch broken pipelines before a user is waiting.

### The spec

The four core primitives are formally documented in `spec/`. Implementations get conformance harnesses (`assertTimelineConforms`, `assertMemoryStoreConforms`, `assertChannelConforms`) — if a third-party backend or channel passes the harness, it's interoperable with the rest of the ecosystem.

- [spec/glossary.md](spec/glossary.md) — vocabulary, naming rules
- [spec/events-v1.md](spec/events-v1.md) — envelope + 9 stable event types
- [spec/timeline.md](spec/timeline.md), [spec/processor.md](spec/processor.md), [spec/tool.md](spec/tool.md), [spec/channel.md](spec/channel.md), [spec/memory.md](spec/memory.md)

---

## Built-in tools (`@cadmus/tools`)

| Subpath | Tools | What |
|---|---|---|
| `@cadmus/tools/memory` | `memory_search`, `memory_write`, `memory_delete` | SQLite + canonical three-kind taxonomy (procedural / semantic / episodic). |
| `@cadmus/tools/web` | `web_search`, `web_fetch` | DuckDuckGo by default; Brave with `BRAVE_SEARCH_API_KEY`. |
| `@cadmus/tools/fs` | `read_file`, `write_file`, `list_dir` | Sandboxed to `process.cwd()` by default. |
| `@cadmus/tools/shell` | `bash` | Disabled by default — opt in with `{ enabled: true }`. Timeouts + allowlist. |
| `@cadmus/tools/time` | `get_current_time`, `sleep` | The basics. |
| `@cadmus/tools/mcp` | `mcp_search`, `mcp_list`, `mcp_call` | **Stubs.** Three meta-tools for runtime MCP discovery. Real implementation is the next big chunk. |

```ts
import { defineAgent, defineProcessor } from "@cadmus/kernel";
import { createMemory } from "@cadmus/tools/memory";
import { getCurrentTime } from "@cadmus/tools/time";

const memory = createMemory({ path: ".cadmus/memory.db" });

export default defineAgent({
  agentId: "my-agent",
  name: "My Agent",
  tools: {
    ...memory.tools,                  // memory_search, memory_write, memory_delete
    get_current_time: getCurrentTime,
  },
  // ... processors
});
```

---

## Server endpoints

The kernel exposes a small HTTP API on port `4000` (override via `CADMUS_PORT`). Studio uses it; you can call it from anything.

| Endpoint | Purpose |
|---|---|
| `GET /api/agent` | Agent metadata: id, name, processors (with system prompts and schemas), tools. |
| `GET /api/status` | Provider config health. Powers Studio's setup wizard. |
| `GET /api/workspace` | List of agents in `~/.cadmus/agents/` + which is active. |
| `POST /api/workspace/active-agent` | Set the active agent. `{ name }`. |
| `GET /api/events` | Timeline events since a given seq. Query: `?since=<seq>&limit=<n>`. |
| `GET /api/events/all` | Full timeline. |
| `GET /api/stream` | SSE stream — every new event as it lands. |
| `POST /api/inject` | Inject an event. `{ text, channel?, kind? }` for an `input` event, or `{ type, data }` for any event type. |

CORS is permissive. Build dashboards, eval pipelines, or your own UIs.

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

### Sharing agents

```bash
cadmus export my-agent              # → ./my-agent.cadmus.json
cadmus import their-agent.cadmus.json --as their-renamed
```

Exports include the agent's `cadmus.config.ts`, README, and persistent memories. Add `--with-timeline` to include the event log too.

---

## Repo layout

```
cadmus/
├── spec/             v1 specs — vocabulary, event envelope, processor / tool / channel / memory / timeline contracts
├── packages/
│   ├── kernel/       @cadmus/kernel  — runtime, timeline, providers, server, channels, conformance
│   ├── tools/        @cadmus/tools   — memory, web, fs, shell, time, mcp
│   └── cli/          @cadmus/cli     — `cadmus start / stop / setup / list / use / add / ...`
├── apps/
│   └── studio/       Local UI: agent sidebar + brain canvas + chat + timeline
├── examples/
│   ├── cadmus/       brain pipeline (three llm_call processors)
│   ├── claudius/     single-processor llm_call chat — loop over timeline events
│   └── claud/        single-processor llm_loop chat — loop inside one provider session
└── install.sh
```

---

## Local development

Want to hack on the framework itself or build your own examples without `git push`-ing each iteration? See [CONTRIBUTING.md → Local development](CONTRIBUTING.md#local-development). Short version:

```bash
# Build dist (or run tsc --watch in another terminal)
npm run build

# Run an example from your working tree (uses LOCAL kernel, not ~/.cadmus/cli)
node packages/cli/dist/cli.js dev examples/cadmus/cadmus.config.ts

# Studio in another terminal
npm run studio:dev
```

The global `cadmus` command on your PATH points at `~/.cadmus/cli/` (the installer's clone) — useful for verifying `cadmus update` works, but it doesn't see your edits until you push and update. For local dev, always invoke via `node packages/cli/dist/cli.js` (or alias it to something short like `cad`).

---

## Roadmap

Shipped (v1):
- [x] Kernel: timeline, processors, llm/code templates, HTTP+SSE server
- [x] Provider routing: Google (Gemini) + Anthropic (Claude)
- [x] CLI: install / start / stop / list / use / add / setup / export / import / uninstall
- [x] Studio: brain canvas, chat, processor inspector, agent sidebar
- [x] `@cadmus/tools`: memory (SQLite, 3 canonical kinds), web, fs, shell, time, mcp stubs
- [x] `Channel` primitive + built-in CLI / Studio channels
- [x] `MemoryStore` contract with portable record shape (cross-backend export/import)
- [x] Source attribution on every event + source-constrained filters
- [x] Conformance harnesses for Timeline, MemoryStore, Channel

Next big chunks (contributors welcome — see open issues):
- [ ] **Real MCP client** — wire the three `mcp_*` meta-tools to an actual MCP client
- [ ] **More providers** — OpenAI, Ollama, Groq, xAI (~80 lines each)
- [ ] **`@cadmus/channels`** — Slack, Discord, email
- [ ] **`@cadmus/processors`** — vitals (token/cost tracking), auto-compaction summarizer, schedulers
- [ ] **More built-in tools** — calendar, GitHub, Notion, http (~50 lines each)
- [ ] **Vector memory backend** — sqlite-vec, pgvector, Pinecone
- [ ] **Studio editing** — change a processor's prompt or model from the UI with hot-reload
- [ ] **Timeline replay on import** — currently `cadmus import` drops events

## License

MIT. See [LICENSE](./LICENSE).
