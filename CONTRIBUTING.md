# Contributing to Cadmus

Thanks for being here. Cadmus is an open-source framework for building AI agents on a shared timeline of typed events. We're at v0.1 — the foundation is in place but a lot of the surface area is still wide open.

## Get the dev loop running

```bash
git clone https://github.com/jameslemke10/cadmus
cd cadmus
npm install
npm run build           # builds @cadmus/kernel + @cadmus/cli

# Boot the brain example end-to-end
cp .env.example examples/brain/.env.local   # add your GOOGLE_API_KEY
node packages/cli/dist/cli.js start examples/brain/cadmus.config.ts
```

`cadmus start` boots the kernel on `:4000` and the Studio UI on `:3001`, and opens your browser. Inject a message in the chat panel; watch the brain canvas light up.

## What we're working on (and what we'd love help with)

| Area | Status | Where help is welcome |
|---|---|---|
| Kernel runtime | Stable | New providers (OpenAI, local models via Ollama), MCP-server tools |
| CLI | Stable | Bundling Studio for the npm-installed install path |
| Studio UI | v0.1 read-only | **Editing processors in the UI**, multi-agent management, custom canvas layouts |
| Examples | Just `brain/` | More example agents — coding assistant, research agent, scheduler |
| Docs | Bare bones | Tutorials, walkthroughs, a published architecture site |

If you want to take on something big, please open an issue first so we can align on direction. Small fixes — typos, broken examples, dependency bumps — go straight to a PR.

## Code style

- TypeScript with strict mode. ESM modules. `tsc` to ESM, no bundler in the kernel/CLI.
- React 19 + Tailwind v4 in Studio. No state-management library — `useState` and `useEffect` are enough at the current size.
- Don't add dependencies that require a build step for downstream consumers.
- Prefer composition over abstraction. The `llm` and `code` templates aren't a class hierarchy; they're two functions. Keep it that way.

## Architectural rules

- **The framework is generic.** The brain pattern is one example. Don't add hippocampus/thalamus/PFC concepts to the kernel — they belong in `examples/brain`.
- **Provider routing happens in `packages/kernel/src/providers/`.** Each provider is a separate file implementing the `LLMSession` interface. Detection from the model string (`gemini-*`, `claude-*`, etc.) lives in `providers/types.ts`.
- **Events are the only inter-processor communication.** No direct calls, no shared mutable state. If you find yourself wanting that, the answer is probably an event type with a clear schema.

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full picture.

## License

MIT. See [LICENSE](./LICENSE). Anything you contribute here stays MIT — you keep the copyright on your work.
