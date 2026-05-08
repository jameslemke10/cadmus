# {{AGENT_NAME}}

A Cadmus agent. One LLM processor + a memory store. Customize it.

## Try it

```bash
cadmus start
```

That's it — the kernel reads API keys from `~/.cadmus/config.json` (set them with `cadmus setup` if you haven't yet).

## What's here

- `cadmus.config.ts` — your agent's definition.
- `node_modules/@cadmus/kernel` — symlink to the framework, so the imports in your config resolve without `npm install`.
- `.cadmus/timeline.db` — created on first run; the agent's full event log.

## What's next

- Edit `cadmus.config.ts`. Change the system prompt, swap the model, add tools, add processors.
- Want the full brain pipeline (hippocampus → thalamus → PFC → executor)? Run `cadmus use cadmus`.
- Want the simplest possible loop? Run `cadmus use claudius`.

## Add a new processor

```ts
defineProcessor({
  name: "my-processor",
  template: "code",          // or "llm"
  filter: ["agent_message"], // event types this triggers on
  outputEvents: ["my_event"],
  handler: async (event, ctx) => {
    // do something
    await ctx.emit("my_event", { ... });
  },
}),
```

The framework dispatches events to your processor's filter automatically. No registration, no router, no glue.
