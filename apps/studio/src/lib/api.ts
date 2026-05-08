import type { AgentMeta } from "./types";

export const DEFAULT_API = "http://localhost:4000";

export async function fetchAgent(api: string): Promise<AgentMeta> {
  const res = await fetch(`${api}/api/agent`);
  if (!res.ok) throw new Error(`agent fetch failed: ${res.status}`);
  return (await res.json()) as AgentMeta;
}

export async function injectMessage(api: string, text: string): Promise<void> {
  const res = await fetch(`${api}/api/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`inject failed: ${res.status}`);
}

export async function injectEvent(
  api: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${api}/api/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, data }),
  });
  if (!res.ok) throw new Error(`inject failed: ${res.status}`);
}
