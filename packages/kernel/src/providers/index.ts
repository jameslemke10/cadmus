import { createAnthropicSession } from "./anthropic.js";
import { createGoogleSession } from "./google.js";
import {
  defaultApiKeyEnv,
  detectProvider,
  type LLMSession,
  type SessionInit,
} from "./types.js";

export type {
  LLMSession,
  ProviderName,
  ProviderToolCall,
  ProviderToolDef,
  ProviderToolResult,
  ProviderTurn,
  SessionInit,
} from "./types.js";

export function createSession(init: Omit<SessionInit, "apiKey"> & { apiKey?: string }): LLMSession {
  const provider = detectProvider(init.model);
  const envName = defaultApiKeyEnv(provider);
  const apiKey = init.apiKey ?? process.env[envName];
  if (!apiKey) {
    throw new Error(
      `Missing API key for ${provider} (set ${envName} or pass templateConfig.apiKey).`,
    );
  }
  const full: SessionInit = { ...init, apiKey };
  if (provider === "google") return createGoogleSession(full);
  if (provider === "anthropic") return createAnthropicSession(full);
  throw new Error(`Unsupported provider: ${String(provider)}`);
}
