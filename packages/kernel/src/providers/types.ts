/**
 * Provider-agnostic interface that the `llm` template talks to.
 *
 * The template doesn't know whether it's calling Anthropic, Google, or
 * something else — it sees only `LLMSession.send(toolResults?)` returning
 * a `ProviderTurn` of `{ text, toolCalls }`.
 */

export interface ProviderToolDef {
  name: string;
  description: string;
  /** JSON Schema. Both Anthropic and Google accept this shape. */
  input_schema: Record<string, unknown>;
}

export interface ProviderToolCall {
  /** Stable id within the current session. Anthropic gives us one; Gemini we synthesize. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderTurn {
  text: string;
  toolCalls: ProviderToolCall[];
}

export interface ProviderToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface SessionInit {
  model: string;
  systemPrompt: string;
  initialUserMessage: string;
  tools: ProviderToolDef[];
  maxTokens: number;
  temperature: number;
  apiKey: string;
}

export interface LLMSession {
  /** First call — send no tool results; subsequent calls — pass results from the prior turn. */
  send(toolResults?: ProviderToolResult[]): Promise<ProviderTurn>;
}

export type ProviderName = "anthropic" | "google";

export function detectProvider(model: string): ProviderName {
  if (model.startsWith("gemini-") || model.startsWith("models/gemini-")) return "google";
  if (model.startsWith("claude-")) return "anthropic";
  throw new Error(
    `Unknown model "${model}". Supported prefixes: "gemini-*" (Google), "claude-*" (Anthropic).`,
  );
}

export function defaultApiKeyEnv(provider: ProviderName): string {
  return provider === "google" ? "GOOGLE_API_KEY" : "ANTHROPIC_API_KEY";
}
