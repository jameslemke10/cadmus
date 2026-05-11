/**
 * {{AGENT_NAME}} — your agent.
 *
 * One LLM processor. Listens for input, replies with output.
 * Persistent memory lives in .cadmus/memory.db (SQLite). The canonical
 * memory_search / memory_write / memory_delete tools come from
 * @cadmus/tools/memory.
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
import { createMemory } from "@cadmus/tools/memory";
import { getCurrentTime } from "@cadmus/tools/time";

const memory = createMemory({ path: ".cadmus/memory.db" });

export default defineAgent({
  agentId: "{{AGENT_NAME}}",
  name: "{{AGENT_NAME}}",
  tools: {
    ...memory.tools,           // memory_search, memory_write, memory_delete
    get_current_time: getCurrentTime,
  },
  processors: [
    defineProcessor({
      name: "agent",
      template: "llm",
      filter: ["input", "tool_result"],
      tools: ["memory_search", "memory_write", "memory_delete", "get_current_time"],
      outputEvents: ["output"],
      outputSchema: {
        output: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Target channel, or '*' to broadcast." },
            kind: { type: "string", description: "Payload variant. Use 'text' for plain text." },
            text: { type: "string" },
          },
          required: ["channel", "kind", "text"],
        },
      },
      templateConfig: {
        // Provider auto-detected: gemini-* uses GOOGLE_API_KEY,
        // claude-* uses ANTHROPIC_API_KEY.
        model: "gemini-2.5-flash",
        contextEvents: 50,
        systemPrompt: `You are {{AGENT_NAME}}.

Be helpful. Keep responses concise unless detail is asked for. First person, plainspoken.

You have access to memory tools — call memory_search before responding when context might exist, memory_write to remember facts about the user (use kind: "semantic"), procedures (kind: "procedural"), or events (kind: "episodic"). Use memory_delete to forget something that's no longer true.

When you have something to say, call emit_output with { channel: "*", kind: "text", text }, then stop. Channel "*" broadcasts to whichever channel sent the input.`,
      },
    }),
  ],
  storage: {
    timelinePath: ".cadmus/timeline.db",
  },
});
