# Cadmus — agent guidance for contributors

This file is for AI assistants and humans contributing to this repo.

Cadmus is a runtime for building AI agents around a shared timeline of typed events.

## Mental model

The framework is intentionally generic:
- **Timeline** — append-only log of typed events (SQLite, WAL).
- **Processor** — a unit that subscribes to event types via `filter` and emits new events via `outputEvents`.
- **Templates** — `llm` (calls a model, can use tools, emits via synthesized `emit_<type>` tools) or `code` (a TypeScript handler).
- **Tool** — a JSON-schema'd function any processor can declare access to.

The brain pattern (hippocampus → thalamus → PFC → executor) is one example configuration. The framework knows nothing about brain regions; users build any topology they want.

## Repo layout

| Path | What it is |
|---|---|
| `packages/kernel` | The runtime library — Timeline, Runtime, providers, HTTP+SSE server. |
| `packages/cli` | The `cadmus` command-line wrapper. |
| `apps/studio` | Local UI (Next.js): brain canvas, chat, processor inspector. |
| `examples/cadmus` | Brain pipeline example. |
| `examples/claudius` | Single-LLM-loop example. |

## Rules

- **The framework is provider-agnostic.** Adding a new model provider is a new file in `packages/kernel/src/providers/`. Don't hard-code Anthropic or Google paths into the template.
- **Examples are first-class documentation.** When you add a feature to the kernel, demonstrate it in `examples/`.
- **Don't add dependencies that require a build step for downstream consumers** — `tsc` to ESM, no bundler in `kernel` or `cli`.
- **Keep the kernel small.** It's a runtime, not a kitchen sink. New conveniences belong in `examples/` or in user code, not in `packages/kernel`.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

The Studio is on Next.js 16 with breaking changes from your training data — APIs, conventions, and file structure may all differ. Read the relevant guide in `apps/studio/node_modules/next/dist/docs/` before writing any Next code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
