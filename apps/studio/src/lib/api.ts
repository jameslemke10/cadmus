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
    body: JSON.stringify({ text, channel: "studio" }),
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

export type LayoutNodes = Record<string, { x: number; y: number }>;

export async function fetchLayout(api: string): Promise<LayoutNodes> {
  const res = await fetch(`${api}/api/layout`);
  if (!res.ok) return {};
  const body = (await res.json()) as { nodes?: LayoutNodes };
  return body.nodes ?? {};
}

export async function saveLayout(api: string, nodes: LayoutNodes): Promise<void> {
  const res = await fetch(`${api}/api/layout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodes }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `save failed: ${res.status}`);
  }
}

export async function deleteLayout(api: string): Promise<void> {
  const res = await fetch(`${api}/api/layout`, { method: "DELETE" });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `delete failed: ${res.status}`);
  }
}
