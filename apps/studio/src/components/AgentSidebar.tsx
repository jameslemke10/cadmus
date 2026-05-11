"use client";

import { useEffect, useState } from "react";

interface WorkspaceAgent {
  name: string;
  path: string;
  active: boolean;
}

interface Workspace {
  activeAgent: string;
  agents: WorkspaceAgent[];
}

interface Props {
  api: string;
  currentAgentName: string;
  onSwitchRequest: (newActive: string) => void;
}

export function AgentSidebar({ api, currentAgentName, onSwitchRequest }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${api}/api/workspace`);
        if (!res.ok) return;
        const data = (await res.json()) as Workspace;
        if (!cancelled) setWorkspace(data);
      } catch {
        // silent
      }
    };
    void tick();
    const int = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(int);
    };
  }, [api]);

  const requestSwitch = async (name: string) => {
    if (name === currentAgentName) return;
    setSwitching(name);
    try {
      const res = await fetch(`${api}/api/workspace/active-agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setPending(name);
      onSwitchRequest(name);
    } catch (err) {
      console.error(err);
    } finally {
      setSwitching(null);
    }
  };

  if (!workspace || workspace.agents.length === 0) return null;

  return (
    <aside className="w-full h-full bg-stone-50 border-r border-stone-200 flex flex-col overflow-hidden">
      <header className="px-3 py-2.5 border-b border-stone-200">
        <div className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
          agents
        </div>
      </header>

      <div className="flex-1 overflow-y-auto py-1.5">
        {workspace.agents.map((a) => {
          const isCurrent = a.name === currentAgentName;
          const isPending = a.name === pending;
          return (
            <button
              key={a.name}
              onClick={() => void requestSwitch(a.name)}
              disabled={switching !== null}
              className={`w-full text-left px-3 py-2 transition flex items-center gap-2 group ${
                isCurrent
                  ? "bg-stone-900 text-white"
                  : isPending
                    ? "bg-amber-50 text-amber-900 hover:bg-amber-100"
                    : "hover:bg-stone-100 text-stone-700"
              }`}
              title={a.path}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isCurrent
                    ? "bg-emerald-400"
                    : isPending
                      ? "bg-amber-500"
                      : "bg-stone-300"
                }`}
              />
              <span className="text-sm font-medium truncate">{a.name}</span>
              {isPending && (
                <span className="text-[10px] uppercase tracking-wide ml-auto opacity-70">
                  restart →
                </span>
              )}
            </button>
          );
        })}
      </div>

      {pending && (
        <div className="px-3 py-2.5 border-t border-stone-200 bg-amber-50 text-amber-900 text-[11px] leading-relaxed">
          <div className="font-semibold mb-0.5">Restart needed</div>
          <div>
            Run <code className="font-mono bg-white border border-amber-200 px-1 py-0.5 rounded text-[10px]">cadmus stop</code> then <code className="font-mono bg-white border border-amber-200 px-1 py-0.5 rounded text-[10px]">cadmus start</code> to load <span className="font-semibold">{pending}</span>.
          </div>
        </div>
      )}
    </aside>
  );
}
