# @cadmus/kernel

Event-driven runtime for AI agents. Timeline + processors + filters. The shape of your agent emerges from how you wire processors together.

```bash
npm install @cadmus/kernel
```

## 60-second overview

```ts
import { Runtime, defineAgent, defineProcessor, defineTool } from "@cadmus/kernel";

const responder = defineProcessor({
  name: "responder",
  template: "llm",
  filter: ["user_input"],
  outputEvents: ["agent_message"],
  templateConfig: {
    // Provider auto-detected from model prefix:
    //   "gemini-*" → Google (uses GOOGLE_API_KEY)
    //   "claude-*" → Anthropic (uses ANTHROPIC_API_KEY)
    model: "gemini-2.5-flash",
    systemPrompt: "Reply with a single short sentence. Use emit_agent_message.",
  },
});

const agent = defineAgent({
  agentId: "demo",
  name: "Demo",
  processors: [responder],
});

const runtime = new Runtime(agent, { verbose: true });
runtime.start();

await runtime.inject("Hello, agent.");
```

The runtime appends a `user_input` event onto its SQLite timeline. The `responder` processor's filter matches; the framework calls Claude, exposes a synthetic `emit_agent_message` tool, and Claude emits the response by tool-calling. The tool-use loop runs until the model has nothing more to say.

## Concepts

- **Event** — `{ id, seq, timestamp, type, agent_id, source, data, tags }`. Any string is a valid `type`. Events are append-only.
- **Processor** — listens to event types via `filter`, emits via `outputEvents`. Three templates:
  - `llm_call` — one provider turn per invocation. Synthesized `emit_<type>` tools wrap each output event. Loops via timeline events.
  - `llm_loop` — multi-turn provider session per invocation. Tool results are fed back into the same session; final text becomes the output event.
  - `code` — your async handler. Same `ProcessorContext` (emit, callTool, timeline, log). No LLM cost.
- **Tool** — JSON-schema input + handler. Any processor can declare tools it has access to.

## Server

```ts
import { Runtime, startServer } from "@cadmus/kernel";

const runtime = new Runtime(agent);
runtime.start();
startServer(runtime, { port: 4000 });
```

Endpoints:
- `GET /api/agent` — agent metadata + processor list
- `GET /api/events?since=<seq>` — events since seq
- `GET /api/events/all` — full timeline
- `GET /api/stream` — SSE stream of new events
- `POST /api/inject` — `{ text }` or `{ type, data }`

## License

MIT.
