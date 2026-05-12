"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { injectEvent, injectMessage } from "../lib/api";
import type { AgentMeta, CadmusEvent } from "../lib/types";

interface Props {
  api: string;
  agent: AgentMeta | null;
  events: CadmusEvent[];
  connected: boolean;
}

interface Message {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  timestamp: string;
}

// Studio is the "studio" channel. It only displays inputs originating from
// itself and outputs targeting itself (or broadcast "*"). Other channels
// (cli, ...) have their own routing. Events from a different agent (when
// the timeline DB is shared across agents) are also filtered out.
function eventsToMessages(events: CadmusEvent[], agentId: string | null): Message[] {
  const messages: Message[] = [];
  for (const e of events) {
    if (agentId && e.agent_id !== agentId) continue;
    if (e.type === "input") {
      const d = e.data as { channel?: string; text?: string };
      if (d.channel !== "studio") continue;
      if (d.text) messages.push({ id: e.id, role: "user", text: d.text, timestamp: e.timestamp });
    } else if (e.type === "output") {
      const d = e.data as { channel?: string; text?: string };
      if (d.channel !== "studio" && d.channel !== "*") continue;
      if (d.text) messages.push({ id: e.id, role: "agent", text: d.text, timestamp: e.timestamp });
    } else if (e.type === "error") {
      const msg = (e.data as { message?: string }).message ?? "(unknown error)";
      messages.push({
        id: e.id,
        role: "system",
        text: `error: ${msg}`,
        timestamp: e.timestamp,
      });
    }
  }
  return messages;
}

export function ChatPanel({ api, agent, events, connected }: Props) {
  const messages = useMemo(
    () => eventsToMessages(events, agent?.id ?? null),
    [events, agent?.id],
  );
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Whether the agent is currently working (last input not yet answered).
  const pending = useMemo(() => {
    let pendingCount = 0;
    for (const m of messages) {
      if (m.role === "user") pendingCount++;
      else if (m.role === "agent") pendingCount = Math.max(0, pendingCount - 1);
    }
    return pendingCount > 0;
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setError(null);
    try {
      await injectMessage(api, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const newConversation = async () => {
    setError(null);
    try {
      await injectEvent(api, "event_boundary", { type: "conversation" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const agentName = agent?.name ?? "Agent";
  const initial = agentName.slice(0, 1).toUpperCase();

  return (
    <div className="flex flex-col h-full bg-white border-l border-stone-200">
      <header className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-stone-900 text-white text-xs font-semibold">
            {initial}
          </span>
          <div>
            <div className="font-semibold text-sm leading-tight">{agentName}</div>
            <div className="text-[11px] text-stone-500">
              {connected ? "live" : "disconnected"}
            </div>
          </div>
        </div>
        <button
          onClick={() => void newConversation()}
          disabled={!connected}
          title="Emit an event_boundary so the model forgets the prior turns"
          className="text-xs text-stone-600 border border-stone-200 rounded-md px-2.5 py-1 hover:bg-stone-50 disabled:opacity-30 transition"
        >
          New conversation
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-stone-400 text-sm py-8 px-4">
            <p className="font-medium text-stone-600 mb-1">
              {agent ? `Say hello to ${agentName}.` : "Connecting…"}
            </p>
            <p>Watch the brain canvas as your message flows through processors.</p>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} agentName={agentName} initial={initial} />
        ))}

        {pending && (
          <div className="flex items-center gap-2 text-stone-400 text-sm pl-9">
            <Dots />
            <span>{agentName.toLowerCase()} is thinking…</span>
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 bg-amber-50 text-amber-900 text-xs border-t border-amber-200">
          {error}
        </div>
      )}

      <div className="border-t border-stone-200 p-3 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder="Type a message…"
          className="flex-1 px-3 py-2 border border-stone-200 rounded-lg text-sm resize-none focus:outline-none focus:border-stone-400 max-h-32"
          disabled={!connected}
        />
        <button
          onClick={() => void send()}
          disabled={!input.trim() || !connected || sending}
          className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium disabled:opacity-30 hover:bg-stone-800 transition"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  agentName,
  initial,
}: {
  message: Message;
  agentName: string;
  initial: string;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-stone-900 text-white rounded-2xl rounded-br-sm px-3.5 py-2 text-sm whitespace-pre-wrap leading-relaxed">
          {message.text}
        </div>
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div className="text-center">
        <span className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-full px-3 py-1 inline-block">
          {message.text}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <span
        className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-stone-100 border border-stone-200 text-xs font-semibold text-stone-700 shrink-0"
        title={agentName}
      >
        {initial}
      </span>
      <div className="max-w-[85%] bg-stone-100 rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm whitespace-pre-wrap leading-relaxed text-stone-800">
        {message.text}
      </div>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-0.5">
      <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-pulse [animation-delay:0ms]" />
      <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-pulse [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-pulse [animation-delay:300ms]" />
    </span>
  );
}
