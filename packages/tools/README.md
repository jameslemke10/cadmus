# @cadmus/tools

Built-in tools for [Cadmus](https://github.com/jameslemke10/cadmus) agents. Each tool is a small TypeScript file. Agents opt in by listing the tools they want.

```bash
npm install @cadmus/tools
```

## Tools shipped today

| Subpath | Tool(s) | What it does |
|---|---|---|
| `@cadmus/tools/memory` | `memory_search`, `memory_write`, `memory_list` | JSON-backed persistent memory store. |
| `@cadmus/tools/web` | `web_search`, `web_fetch` | DuckDuckGo by default; Brave Search if `BRAVE_SEARCH_API_KEY` is set. |
| `@cadmus/tools/fs` | `read_file`, `write_file`, `list_dir` | Sandboxed to `process.cwd()` by default. |
| `@cadmus/tools/shell` | `bash` | Disabled by default. Pass `{ enabled: true }` to opt in. Supports timeouts and an allowlist. |
| `@cadmus/tools/time` | `get_current_time`, `sleep` | The basics. |
| `@cadmus/tools/mcp` | `mcp_search`, `mcp_list`, `mcp_call` | Stubs today — real implementation coming. |

## Usage

```ts
import { defineAgent, defineProcessor } from "@cadmus/kernel";
import { webSearch, webFetch } from "@cadmus/tools/web";
import { createMemoryStore } from "@cadmus/tools/memory";
import { getCurrentTime } from "@cadmus/tools/time";

const memory = createMemoryStore();
// memory.memorySearch / memory.memoryWrite / memory.memoryList

export default defineAgent({
  agentId: "researcher",
  name: "Researcher",
  tools: {
    web_search: webSearch,
    web_fetch: webFetch,
    memory_search: memory.memorySearch,
    memory_write: memory.memoryWrite,
    get_current_time: getCurrentTime,
  },
  processors: [
    defineProcessor({
      name: "agent",
      template: "llm",
      filter: ["user_input"],
      tools: ["web_search", "web_fetch", "memory_search", "memory_write", "get_current_time"],
      outputEvents: ["agent_message"],
      templateConfig: {
        model: "gemini-2.5-flash",
        systemPrompt: `You research things on the web. Cite sources. Save anything important to memory.`,
      },
    }),
  ],
});
```

## Adding a tool

A tool is just a `defineTool({...})` call. Pick a category folder, add your file, export it from the category's `index.ts`. PR welcome.

```ts
// src/calendar/index.ts
import { defineTool } from "@cadmus/kernel";

export const calendarList = defineTool({
  name: "calendar_list",
  description: "List upcoming calendar events.",
  input_schema: { /* ... */ },
  handler: async () => { /* ... */ },
});
```

See [CONTRIBUTING.md](https://github.com/jameslemke10/cadmus/blob/main/CONTRIBUTING.md) in the main repo for the full contribution guide.

## License

MIT.
