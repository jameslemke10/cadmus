# Brain example

A Cadmus agent wired into the brain-mapped processor pipeline:

```
user_input ─┐
tool_result ┼─▶ hippocampus ─▶ memory_retrieved
            │   (llm, haiku)
            ▼
        thalamus ─▶ working_memory_updated
        (llm, haiku)
            │
            ▼
          pfc ─▶ pfc_response
        (llm, haiku — swap to opus in prod)
            │
            ▼
        executor ─▶ tool_called → tool_result OR agent_message
        (code)
```

This is one configuration of the framework. The framework knows nothing
about brain regions — these are just five processors with names that map
onto a useful mental model.

## Run

```bash
cp .env.local.example .env.local   # add your ANTHROPIC_API_KEY
cd ../..                            # repo root
npm install
npm run kernel:build && npm run cli:build
cd examples/brain

# Terminal 1: start the runtime
node ../../packages/cli/dist/cli.js dev

# Terminal 2: start Studio
cd ../../apps/studio && npm run dev

# Terminal 3: poke it
curl -X POST http://localhost:4000/api/inject \
  -H 'content-type: application/json' \
  -d '{"text":"What is 47 * 31, and what time is it?"}'
```

Open http://localhost:3001 to see the live timeline.

## What you should see

For a question like "What is 47 * 31, and what time is it?", the events
will land in roughly this order:

1. `user_input` — your message.
2. `memory_retrieved` — hippocampus searched memory.
3. `working_memory_updated` — thalamus assembled context for the PFC.
4. `pfc_response` — PFC's plan + tool calls + draft message.
5. `tool_called` × 2 — `calculate` and `get_current_time`.
6. `tool_result` × 2 — results come back.
7. `agent_message` — the executor emitted PFC's response.

Each `tool_result` re-triggers the hippocampus, so the loop continues until
the PFC produces a response with no further tool calls.
