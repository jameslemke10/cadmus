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

## Local development

After `npm install` from a fresh clone, you have two `cadmus` commands on your machine. They never collide if you keep them straight:

| Command | Source | Use when |
|---|---|---|
| `node packages/cli/dist/cli.js <cmd>` (this repo) | Your working tree | **Local dev — testing your edits.** |
| `cadmus <cmd>` (the global on PATH, after `install.sh`) | `~/.cadmus/cli/` (clone of GitHub `main`) | **Verifying `cadmus update` works.** Don't use during dev — it doesn't see your edits until you push and update. |

Recommended shell alias to make local invocations short:

```bash
# in ~/.zshrc
alias cad='node ~/Documents/cadmus/packages/cli/dist/cli.js'
```

### Edit-test loop

```bash
# Once: install + build
npm install
npm run build

# Provide an API key for the example
cp .env.example examples/cadmus/.env.local   # paste your GOOGLE_API_KEY (or ANTHROPIC_API_KEY)

# Terminal 1 — keep TypeScript compiling on save:
npx tsc -b packages/kernel packages/tools packages/cli --watch

# Terminal 2 — run an example from your working tree:
cad dev examples/cadmus/cadmus.config.ts
# (Ctrl+C and re-run with a different path to switch agents.)

# Terminal 3 — Studio (Next.js, hot-reloads on save):
npm run studio:dev
```

Open `http://localhost:3001`. The Studio sidebar lists sibling dirs of the running config — so `cad dev examples/foo/cadmus.config.ts` shows every `examples/*/cadmus.config.ts` as a sidebar entry. Switching means Ctrl+C and re-running with a different path; there's no click-to-switch.

### What the runner sees

When you run `cad dev examples/foo/cadmus.config.ts` from this repo:

1. `cli.js` spawns `runner.js`.
2. `runner.js` imports `examples/foo/cadmus.config.ts`.
3. That config imports `@cadmus/kernel` / `@cadmus/tools`, which resolve via the npm workspace symlinks to `packages/kernel` / `packages/tools`.
4. So the running agent and its kernel are 100% from your working tree. `~/.cadmus/cli/` is not consulted.

The runner detects "is this config under `~/.cadmus/agents/`?". If yes (production — `cadmus start`), the sidebar uses the global workspace and the `~/.cadmus/config.json` `activeAgent`. If no (local dev), the sidebar is built from the config's sibling directories. See `packages/cli/src/runner.ts`.

### Verifying the install path

After committing local changes:

```bash
git push
cadmus update      # re-runs ~/.cadmus/cli/install.sh, re-clones from main
cadmus start       # uses the freshly-pulled install
```

If `cadmus start` works after this, the install path is healthy.

### Rebuilding installed agents

`~/.cadmus/agents/<name>/cadmus.config.ts` is a copy made by the installer — not a symlink to `examples/`. Editing the example does not update the installed copy. For local dev, prefer `cad dev examples/<name>/cadmus.config.ts` (loads directly from `examples/`); only re-sync the installed copies when verifying `cadmus start`:

```bash
cp examples/<name>/cadmus.config.ts ~/.cadmus/agents/<name>/
```

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
- **The framework is provider-agnostic.** Adding a new model provider is a new file in `packages/kernel/src/providers/`. Detection from the model string lives in `providers/types.ts`. Don't hard-code Anthropic or Google paths into the template.
- **Examples are first-class documentation.** When you add a feature to the kernel, demonstrate it in `examples/`.
- **Events are the only inter-processor communication.** No direct calls, no shared mutable state. If you want that, the answer is probably an event type with a clear schema.
- **Keep the kernel small.** It's a runtime, not a kitchen sink. New conveniences belong in `@cadmus/tools`, in `examples/`, or in user code — not in `packages/kernel`.

## A note on Next.js (Studio)

The Studio is on **Next.js 16** with breaking changes from earlier versions — APIs, conventions, and file structure may differ from what tutorials and older docs describe. Read the relevant guide in `apps/studio/node_modules/next/dist/docs/` before writing any Next code, and heed deprecation notices.

## License

MIT. Anything you contribute here stays MIT — you keep the copyright on your work.
