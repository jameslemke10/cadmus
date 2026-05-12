"use client";

import { useEffect, useMemo, useState } from "react";
import type { CadmusEvent } from "../lib/types";

interface Props {
  event: CadmusEvent | null;
  /** All events in the buffer — used to find paired tool_call/tool_result. */
  events: CadmusEvent[];
  onClose: () => void;
  onSelect: (event: CadmusEvent) => void;
}

export function EventInspector({ event, events, onClose, onSelect }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!event) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [event, onClose]);

  // Reset copy-confirmation when switching events.
  useEffect(() => {
    setCopied(false);
  }, [event?.id]);

  // Pair tool_call ↔ tool_result via call_id, so the panel can offer a
  // one-click jump between the two halves of a tool invocation.
  const paired = useMemo<CadmusEvent | null>(() => {
    if (!event) return null;
    const callId = (event.data as { call_id?: unknown }).call_id;
    if (typeof callId !== "string") return null;
    const otherType = event.type === "tool_call" ? "tool_result" : event.type === "tool_result" ? "tool_call" : null;
    if (!otherType) return null;
    return (
      events.find((e) => {
        if (e.id === event.id) return false;
        if (e.type !== otherType) return false;
        return (e.data as { call_id?: unknown }).call_id === callId;
      }) ?? null
    );
  }, [event, events]);

  if (!event) return null;

  const dataPretty = JSON.stringify(event.data, null, 2);

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-stone-900/20 z-30 transition-opacity"
        onClick={onClose}
      />
      <aside className="fixed right-0 top-0 bottom-0 w-[480px] bg-white border-l border-stone-200 z-40 flex flex-col shadow-2xl">
        <header className="px-5 py-4 border-b border-stone-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
              Event #{event.seq}
            </div>
            <h2 className="text-xl font-semibold tracking-tight font-mono break-all">
              {event.type}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-xs text-stone-500 flex-wrap">
              {event.source && <span className="font-mono">{event.source}</span>}
              <span>·</span>
              <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-700 transition px-2 -mr-2 shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <Section label="Envelope">
            <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-xs">
              <KV k="id" v={event.id} mono />
              <KV k="seq" v={String(event.seq)} mono />
              <KV k="timestamp" v={event.timestamp} mono />
              <KV k="type" v={event.type} mono />
              <KV k="agent_id" v={event.agent_id} mono />
              <KV k="source" v={event.source ?? "—"} mono />
              <KV k="tags" v={event.tags.length > 0 ? event.tags.join(", ") : "—"} mono />
            </dl>
          </Section>

          {paired && (
            <Section label={paired.type === "tool_result" ? "Result" : "Call"}>
              <button
                onClick={() => onSelect(paired)}
                className="w-full text-left px-3 py-2 rounded border border-stone-200 hover:border-stone-400 hover:bg-stone-50 transition text-xs"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono font-medium">{paired.type}</span>
                  <span className="font-mono text-stone-400">#{paired.seq}</span>
                </div>
                <div className="mt-0.5 font-mono text-stone-500 text-[11px] truncate">
                  {summarizePaired(paired)}
                </div>
              </button>
            </Section>
          )}

          <Section
            label="Data"
            right={
              <button
                onClick={() => void copyJson()}
                className="text-[10px] uppercase tracking-wide text-stone-500 hover:text-stone-900 transition font-mono"
              >
                {copied ? "copied ✓" : "copy json"}
              </button>
            }
          >
            <pre className="text-[12px] font-mono bg-stone-50 border border-stone-200 rounded p-3 whitespace-pre-wrap break-words leading-relaxed text-stone-800 max-h-[60vh] overflow-y-auto">
              {dataPretty}
            </pre>
          </Section>
        </div>
      </aside>
    </>
  );
}

function summarizePaired(e: CadmusEvent): string {
  const d = e.data as Record<string, unknown>;
  if (typeof d.tool === "string") {
    if (e.type === "tool_call") return `${d.tool}(${truncate(JSON.stringify(d.args ?? {}), 60)})`;
    if (e.type === "tool_result") {
      if (d.is_error) return `${d.tool} → error: ${truncate(String(d.error_message ?? ""), 60)}`;
      return `${d.tool} → ${truncate(JSON.stringify(d.result ?? null), 60)}`;
    }
  }
  return truncate(JSON.stringify(d), 80);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function Section({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-stone-400 font-semibold">
          {label}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="font-mono text-stone-500">{k}</dt>
      <dd className={mono ? "font-mono text-stone-800 break-all" : "text-stone-800"}>
        {v}
      </dd>
    </>
  );
}
