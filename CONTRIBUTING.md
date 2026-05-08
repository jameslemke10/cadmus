# Contributing to Cadmus

Cadmus is at v0.1 — the foundation is solid, the surface is wide open. If you want to help, the question is which surface.

## The three contribution surfaces

Cadmus has three orthogonal extension points. Most contributions land in one of them.

| Where | What you'd add | Effort |
|---|---|---|
| **`@cadmus/tools`** | A function the model can call. | Small (~50 lines). |
| **`@cadmus/processors`** *(coming)* | A reusable pattern that subscribes to events and emits events. | Small-medium (~100 lines). |
| **`@cadmus/channels`** *(coming)* | An adapter that brings external messages onto the timeline. | Medium (long-running process per channel). |

Plus three more:

| Where | What you'd add |
|---|---|
| **Providers** (`packages/kernel/src/providers/`) | Add OpenAI, Ollama, Groq, xAI, etc. ~80 lines following `google.ts` / `anthropic.ts`. |
| **Examples** (`examples/<name>/`) | A whole agent configuration with its own personality and tools. The smallest reviewable PR. |
| **Studio** (`apps/studio/`) | UI improvements — edit-in-UI, hot-reload, better timeline visualizations. |

## Get the dev loop running

```bash
git clone https://github.com/jameslemke10/cadmus
cd cadmus
npm install
npm run build           # builds @cadmus/kernel + @cadmus/tools + @cadmus/cli

# Test against the brain example
cp .env.example examples/cadmus/.env.local   # paste your GOOGLE_API_KEY
node packages/cli/dist/cli.js dev examples/cadmus/cadmus.config.ts
```

Then in another terminal:

```bash
cd apps/studio && npm run dev
```

Open `http://localhost:3001`.

## Good first issues — concrete tasks

Each of these is small and reviewable. They're filed as actual GitHub issues with the `good first issue` label.

### Add a tool (smallest PR)

- [ ] `calendar_list` / `calendar_create` (Google Calendar via service-account or OAuth)
- [ ] `email_send` (SMTP wrapper)
- [ ] `http_request` (generic HTTP method/headers/body)
- [ ] `github_issue` (read/create issues via `gh` API)
- [ ] `notion_page` (read/append blocks)

Pattern: pick a category folder under `packages/tools/src/`, add your file, export it from the category's `index.ts`. Look at `packages/tools/src/web/index.ts` for the template.

### Add a provider

- [ ] **OpenAI** — `packages/kernel/src/providers/openai.ts`. Detect from model prefix `gpt-*` or `o1-*` / `o3-*`. Map function-calling to `LLMSession`.
- [ ] **Ollama** — local models via Ollama's HTTP API. Detect from prefix `ollama:` (e.g. `ollama:llama3.1`).
- [ ] **Groq** — Groq's OpenAI-compatible API.
- [ ] **xAI / Grok** — xAI's OpenAI-compatible API.

Pattern: copy `google.ts`, swap the SDK, implement `createSession({...})` returning an `LLMSession`. Register in `providers/index.ts` and `providers/types.ts:detectProvider`.

### Add an example agent

- [ ] **Athena** — a research agent. Web tools + memory + a system prompt for citation-aware research.
- [ ] **Hermes** — a fast messaging-style agent. Single LLM, no memory, pure throughput.
- [ ] **Argos** — a browser-automation agent. Wire up Playwright as a tool.

Pattern: `examples/<name>/cadmus.config.ts` exports `defineAgent({...})`. Drop a README. That's it.

### Add MCP support (the big one)

- [ ] Wire `mcp_search` / `mcp_list` / `mcp_call` (currently stubs in `packages/tools/src/mcp/index.ts`) to a real MCP client. Probably uses `@modelcontextprotocol/sdk`. Configure servers in `~/.cadmus/config.json` under `mcpServers: { ... }`. Registry: smithery.ai, mcpm, or your own.

This is the highest-leverage contribution today. Open an issue first if you're going to take it on so we can align on the registry choice.

### Improve Studio

- [ ] **Edit-in-UI** — make the Processor Inspector editable. PATCH endpoint on the kernel. Hot-reload the affected processor.
- [ ] **Timeline filters** — let users hide event types (e.g. only show `agent_message`).
- [ ] **Cost panel** — when a vitals processor lands, show running cost / token spend.

### Tests

- [ ] Vitest setup at the repo root.
- [ ] Smoke test: spin up the kernel + the brain example with a mock LLM, inject a `user_input`, assert `agent_message` lands.

## Code style

- TypeScript with strict mode. ESM modules. `tsc` to ESM, no bundler in `kernel`/`tools`/`cli`.
- React 19 + Tailwind v4 in Studio. No state-management library — `useState` and `useEffect` are enough at the current size.
- Don't add dependencies that require a build step for downstream consumers.
- Prefer composition over abstraction. The `llm` and `code` templates aren't a class hierarchy; they're two functions. Keep it that way.

## Architectural rules

- **The framework is generic.** The brain pattern is one example. Don't push hippocampus/thalamus/PFC concepts into the kernel — they belong in `examples/cadmus`.
- **Provider routing happens in `packages/kernel/src/providers/`.** Detection from the model string lives in `providers/types.ts`.
- **Events are the only inter-processor communication.** No direct calls, no shared mutable state. If you find yourself wanting that, the answer is probably an event type with a clear schema.

## License

MIT. Anything you contribute here stays MIT — you keep the copyright on your work.
