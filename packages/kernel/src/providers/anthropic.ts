import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMSession,
  ProviderTurn,
  ProviderToolResult,
  SessionInit,
} from "./types.js";

export function createAnthropicSession(init: SessionInit): LLMSession {
  const client = new Anthropic({ apiKey: init.apiKey });
  const tools: Anthropic.Tool[] = init.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: init.initialUserMessage },
  ];
  let lastAssistantContent: Anthropic.ContentBlock[] | null = null;

  return {
    async send(toolResults?: ProviderToolResult[]): Promise<ProviderTurn> {
      if (toolResults && toolResults.length > 0) {
        if (lastAssistantContent) {
          messages.push({ role: "assistant", content: lastAssistantContent });
        }
        const blocks: Anthropic.ToolResultBlockParam[] = toolResults.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        }));
        messages.push({ role: "user", content: blocks });
      }

      const response = await client.messages.create({
        model: init.model,
        max_tokens: init.maxTokens,
        temperature: init.temperature,
        system: init.systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      });

      lastAssistantContent = response.content;

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const toolCalls = response.content
        .filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use")
        .map((c) => ({
          id: c.id,
          name: c.name,
          input: (c.input as Record<string, unknown>) ?? {},
        }));

      return { text, toolCalls };
    },
  };
}
