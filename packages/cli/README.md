# @cadmus/cli

Scaffold and run [Cadmus](https://github.com/cadmus-dev/cadmus) agents.

```bash
npm install -g @cadmus/cli
```

## Commands

```
cadmus start [config]  One command: kernel + Studio UI + opens browser
cadmus init [name]     Scaffold a new agent project
cadmus dev [config]    Kernel only (no Studio) — for headless deployments
cadmus run [config]    One-shot mode: reads stdin, no HTTP API
cadmus inspect         Print the current timeline as JSON
```

Looks for `cadmus.config.ts` (or `.mts` / `.js` / `.mjs`) in the current directory by default.

## Env

| Variable | Purpose |
|---|---|
| `GOOGLE_API_KEY` | Default model is Gemini. Get one: [aistudio.google.com](https://aistudio.google.com/apikey). |
| `ANTHROPIC_API_KEY` | Required if your config uses a Claude model. |
| `CADMUS_PORT` | Kernel HTTP port (default `4000`). |
| `CADMUS_STUDIO_PORT` | Studio UI port (default `3001`). |
| `CADMUS_TIMELINE` | Path to SQLite timeline file (default `.cadmus/timeline.db`). |

`.env.local` and `.env` are loaded automatically from the current directory.

## License

MIT.
