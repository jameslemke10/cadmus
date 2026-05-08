/**
 * {{AGENT_NAME}} — your agent.
 *
 * One LLM processor. Listens for user_input, replies with agent_message.
 * Uses persistent memory tools from @cadmus/tools — memories survive
 * across sessions and kernel restarts.
 *
 * For pre-built examples:
 *   cadmus    — flagship brain pipeline (hippocampus → thalamus → PFC → executor)
 *   claudius  — Claude-style chat assistant with session boundaries
 *
 * Run them with `cadmus use cadmus` or `cadmus use claudius`.
 *
 * To grow this agent, look in @cadmus/tools for built-in tools you can
 * pull in — web_search, web_fetch, fs, bash, time, mcp, and more.
 */

import { defineAgent, defineProcessor } from "@cadmus/kernel";
import { createMemoryStore } from "@cadmus/tools/memory";
import { getCurrentTime } from "@cadmus/tools/time";

const memory = createMemoryStore();

export default defineAgent({
  agentId: "{{AGENT_NAME}}",
  name: "{{AGENT_NAME}}",
  tools: {
    memory_search: memory.memorySearch,
    memory_write: memory.memoryWrite,
    memory_list: memory.memoryList,
    get_current_time: getCurrentTime,
  },
  processors: [
    defineProcessor({
      name: "agent",
      template: "llm",
      filter: ["user_input"],
      tools: ["memory_search", "memory_write", "memory_list", "get_current_time"],
      outputEvents: ["agent_message"],
      outputSchema: {
        agent_message: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      templateConfig: {
        // Provider auto-detected: gemini-* uses GOOGLE_API_KEY,
        // claude-* uses ANTHROPIC_API_KEY.
        model: "gemini-2.5-flash",
        contextEvents: 30,
        maxIterations: 4,
        systemPrompt: `You are {{AGENT_NAME}}.

Be helpful. Keep responses concise unless detail is asked for. First person, plainspoken.

You have access to memory tools — call memory_search before responding when context might exist, memory_write to remember facts about the user that should carry across conversations, memory_list to see recent memories at the start of a session.

When you have something to say, call emit_agent_message with { text }, then stop.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
