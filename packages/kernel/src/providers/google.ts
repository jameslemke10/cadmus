import {
  GoogleGenAI,
  createPartFromFunctionResponse,
  type Chat,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import type {
  LLMSession,
  ProviderTurn,
  ProviderToolResult,
  SessionInit,
} from "./types.js";

let synthIdCounter = 0;
function synthId(): string {
  return `gem_call_${(++synthIdCounter).toString(36)}`;
}

export function createGoogleSession(init: SessionInit): LLMSession {
  const ai = new GoogleGenAI({ apiKey: init.apiKey });

  const functionDeclarations: FunctionDeclaration[] = init.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema as FunctionDeclaration["parameters"],
  }));

  const chat: Chat = ai.chats.create({
    model: init.model,
    config: {
      systemInstruction: init.systemPrompt,
      temperature: init.temperature,
      maxOutputTokens: init.maxTokens,
      tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    },
  });

  // Map our synth ids to Gemini call names so we can match results.
  const idToName = new Map<string, string>();

  let firstSend = true;

  return {
    async send(toolResults?: ProviderToolResult[]): Promise<ProviderTurn> {
      let messageInput: string | Part[];

      if (firstSend) {
        messageInput = init.initialUserMessage;
        firstSend = false;
      } else if (toolResults && toolResults.length > 0) {
        messageInput = toolResults.map((r) => {
          const name = idToName.get(r.id) ?? r.name;
          const response: Record<string, unknown> = r.isError
            ? { error: r.content }
            : { output: r.content };
          return createPartFromFunctionResponse(r.id, name, response);
        });
      } else {
        // No-op continue (rare) — send an empty user turn isn't valid in Gemini,
        // so we just synthesize a small nudge.
        messageInput = "(continue)";
      }

      const response = await chat.sendMessage({
        message: messageInput,
      });

      const calls: FunctionCall[] = response.functionCalls ?? [];
      const toolCalls = calls.map((fc) => {
        const id = fc.id ?? synthId();
        if (fc.name) idToName.set(id, fc.name);
        return {
          id,
          name: fc.name ?? "",
          input: fc.args ?? {},
        };
      });

      return {
        text: response.text ?? "",
        toolCalls,
      };
    },
  };
}
