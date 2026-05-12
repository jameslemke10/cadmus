# Claud — single-processor chat agent (llm_loop)

A friendly chat assistant where the LLM/tool loop runs INSIDE one provider session per user input. The runtime feeds tool results back into the same session and the model keeps going until it stops calling tools.

```
input ──► pfc (one provider session: tool → result → tool → result → text) ──► output
```

This is the shape most people imagine when they think "talk to Claude" — the SDK loop is hidden inside one processor invocation, so each user message produces one assistant response (which may have used several tools internally).

## Run

```bash
cadmus use claud
cadmus start
```

Or headless:

```bash
cadmus dev cadmus.config.ts
```

## Compare with claudius

[`../claudius`](../claudius) implements the same end-user behavior with `llm_call`, where every step (input, tool_call, tool_result, output) is a separate event on the timeline and the loop is made of those events instead of provider turns.

| | claud (`llm_loop`) | claudius (`llm_call`) |
|---|---|---|
| Provider sessions per user input | 1 | 1 per turn |
| `tool_call` / `tool_result` events | yes | yes |
| Re-trigger on `tool_result` | no (handled in-session) | yes (next turn sees it) |
| Branchable / replayable per step | coarser | finer |

Pick whichever fits your introspection and replay needs. The framework supports both.
