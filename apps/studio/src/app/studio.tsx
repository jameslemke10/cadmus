"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AgentSidebar } from "../components/AgentSidebar";
import { BrainCanvas } from "../components/BrainCanvas";
import { ChatPanel } from "../components/ChatPanel";
import { EventInspector } from "../components/EventInspector";
import { ProcessorInspector } from "../components/ProcessorInspector";
import { SetupWizard } from "../components/SetupWizard";
import { DEFAULT_API, fetchAgent } from "../lib/api";
import { filterMatchesEvent } from "../lib/filter";
import type { AgentMeta, CadmusEvent } from "../lib/types";

interface KernelStatus {
  agent: { id: string; name: string };
  events: number;
  modelsInUse: string[];
  providers: {
    google: { configured: boolean; needed: boolean };
    anthropic: { configured: boolean; needed: boolean };
  };
}

const EVENT_COLORS: Record<string, string> = {
  input: "bg-stone-900 text-white",
  output: "bg-emerald-50 text-emerald-900 border-emerald-200",
  tool_call: "bg-amber-50 text-amber-900 border-amber-200",
  tool_result: "bg-amber-50 text-amber-900 border-amber-200",
  memory_write: "bg-rose-50 text-rose-900 border-rose-200",
  memory_delete: "bg-rose-50 text-rose-900 border-rose-200",
  event_boundary: "bg-sky-50 text-sky-900 border-sky-200",
  pfc_loop: "bg-violet-50 text-violet-900 border-violet-200",
  working_memory_updated: "bg-sky-50 text-sky-900 border-sky-200",
  memory_retrieved: "bg-rose-50 text-rose-900 border-rose-200",
  subconscious_surfaced: "bg-orange-50 text-orange-900 border-orange-200",
  subconscious_triaged: "bg-orange-50 text-orange-900 border-orange-200",
  notification_received: "bg-orange-50 text-orange-900 border-orange-200",
  error: "bg-red-50 text-red-900 border-red-200",
};

function eventColor(type: string): string {
  return EVENT_COLORS[type] ?? "bg-white text-stone-700 border-stone-200";
}

export function Studio() {
  const [api, setApi] = useState(DEFAULT_API);
  const [agent, setAgent] = useState<AgentMeta | null>(null);
  const [events, setEvents] = useState<CadmusEvent[]>([]);
  const [latestEvent, setLatestEvent] = useState<CadmusEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProcessor, setSelectedProcessor] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [wizardDismissed, setWizardDismissed] = useState(false);

  // Fetch kernel status (provider configuration health).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${api}/api/status`);
        if (!res.ok) return;
        const data = (await res.json()) as KernelStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // ignored — status is non-critical
      }
    };
    void tick();
    const int = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(int);
    };
  }, [api]);

  // Fetch agent metadata.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await fetchAgent(api);
        if (!cancelled) {
          setAgent(data);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(`Could not reach kernel at ${api}. Is \`cadmus start\` running?`);
        }
      }
    };
    void tick();
    const int = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(int);
    };
  }, [api]);

  // Subscribe to SSE timeline.
  useEffect(() => {
    const es = new EventSource(`${api}/api/stream`);
    setEvents([]);
    setLatestEvent(null);
    es.addEventListener("append", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as CadmusEvent;
      setEvents((prev) => {
        if (prev.some((x) => x.id === data.id)) return prev;
        return [...prev, data];
      });
      setLatestEvent(data);
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [api]);

  const selectedProcessorMeta = useMemo(
    () => agent?.processors.find((p) => p.name === selectedProcessor) ?? null,
    [agent, selectedProcessor],
  );

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  const firingsByProcessor = useMemo(() => {
    if (!agent) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const p of agent.processors) counts.set(p.name, 0);
    for (const e of events) {
      for (const p of agent.processors) {
        if (filterMatchesEvent(p.filter, e)) {
          counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [agent, events]);

  // A processor is "running" if its most recent triggering event has a higher
  // seq than its most recent self-emitted event. The runtime stamps every
  // event a processor emits (including auto-emitted tool_call/tool_result
  // around ctx.callTool) with `source: "processor:<name>"`, so as long as
  // the processor emits anything during its invocation we can detect when
  // it's still in-flight just by reading the timeline.
  const runningProcessors = useMemo(() => {
    if (!agent) return new Set<string>();
    const lastTrigger = new Map<string, number>();
    const lastResponse = new Map<string, number>();
    for (const e of events) {
      for (const p of agent.processors) {
        if (filterMatchesEvent(p.filter, e)) {
          const cur = lastTrigger.get(p.name) ?? -1;
          if (e.seq > cur) lastTrigger.set(p.name, e.seq);
        }
        if (e.source === `processor:${p.name}`) {
          const cur = lastResponse.get(p.name) ?? -1;
          if (e.seq > cur) lastResponse.set(p.name, e.seq);
        }
      }
    }
    const running = new Set<string>();
    for (const p of agent.processors) {
      const t = lastTrigger.get(p.name) ?? -1;
      const r = lastResponse.get(p.name) ?? -1;
      if (t > r) running.add(p.name);
    }
    return running;
  }, [agent, events]);

  return (
    <div className="h-screen w-screen flex flex-col bg-stone-50 overflow-hidden">
      <Header
        agent={agent}
        api={api}
        onApiChange={setApi}
        connected={connected}
        timelineOpen={timelineOpen}
        onToggleTimeline={() => setTimelineOpen((v) => !v)}
        eventCount={events.length}
      />

      {error && !connected && (
        <div className="px-6 py-2 bg-amber-50 text-amber-900 text-sm border-b border-amber-200">
          {error}
        </div>
      )}

      {/*
        Three panels with a single, stable structure so the resize library
        doesn't lose its place when the agent finishes loading. autoSaveId
        is bumped to v2 to drop any stale entries from the broken layout.
      */}
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal" autoSaveId="cadmus-studio-v2">
          <Panel id="sidebar" order={1} defaultSize={18} minSize={12} maxSize={30}>
            {agent ? (
              <AgentSidebar
                api={api}
                currentAgentName={agent.id}
                onSwitchRequest={() => undefined}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-stone-300 text-xs">
                …
              </div>
            )}
          </Panel>

          <ResizeHandle />

          <Panel id="canvas" order={2} defaultSize={52} minSize={30}>
            <main className="relative bg-stone-50 h-full">
              {agent ? (
                <BrainCanvas
                  api={api}
                  agent={agent}
                  latestEvent={latestEvent}
                  runningProcessors={runningProcessors}
                  onProcessorClick={setSelectedProcessor}
                />
              ) : (
                <div className="h-full flex items-center justify-center text-stone-400 text-sm">
                  waiting for kernel…
                </div>
              )}

              {timelineOpen && (
                <TimelineDrawer
                  events={events}
                  currentAgentId={agent?.id ?? null}
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                  onClose={() => setTimelineOpen(false)}
                />
              )}
            </main>
          </Panel>

          <ResizeHandle />

          <Panel id="chat" order={3} defaultSize={30} minSize={20} maxSize={50}>
            <aside className="overflow-hidden h-full">
              <ChatPanel
                api={api}
                agent={agent}
                events={events}
                connected={connected}
              />
            </aside>
          </Panel>
        </PanelGroup>
      </div>

      <ProcessorInspector
        processor={selectedProcessorMeta}
        recentEvents={firingsByProcessor.get(selectedProcessor ?? "") ?? 0}
        onClose={() => setSelectedProcessor(null)}
      />

      <EventInspector
        event={selectedEvent}
        events={events}
        onSelect={(e) => setSelectedEventId(e.id)}
        onClose={() => setSelectedEventId(null)}
      />

      {status && !wizardDismissed && (
        <SetupWizard status={status} onDismiss={() => setWizardDismissed(true)} />
      )}
    </div>
  );
}

function ResizeHandle() {
  // 1px visible line, generous invisible hit area via the library's prop.
  // No overflowing inner div — that was hijacking pointer events and
  // making drags resolve to the wrong handle.
  return (
    <PanelResizeHandle
      hitAreaMargins={{ coarse: 14, fine: 6 }}
      className="w-px bg-stone-200 hover:bg-stone-400 data-[resize-handle-state=drag]:bg-stone-500 transition-colors"
    />
  );
}

function Header({
  agent,
  api,
  onApiChange,
  connected,
  timelineOpen,
  onToggleTimeline,
  eventCount,
}: {
  agent: AgentMeta | null;
  api: string;
  onApiChange: (v: string) => void;
  connected: boolean;
  timelineOpen: boolean;
  onToggleTimeline: () => void;
  eventCount: number;
}) {
  return (
    <header className="flex items-center justify-between px-5 py-2.5 border-b border-stone-200 bg-white">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="inline-block w-6 h-6 rounded-md bg-stone-900 flex items-center justify-center text-white font-bold text-xs">
            ⬢
          </span>
          <span className="font-semibold tracking-tight">cadmus studio</span>
        </div>
        {agent && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-stone-300">/</span>
            <span className="font-medium text-stone-700">{agent.name}</span>
            <span className="font-mono text-[11px] text-stone-400">{agent.id}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs">
        <button
          onClick={onToggleTimeline}
          className={`px-2.5 py-1 rounded font-mono text-[11px] transition ${
            timelineOpen
              ? "bg-stone-900 text-white"
              : "bg-white border border-stone-200 text-stone-600 hover:bg-stone-50"
          }`}
        >
          📜 timeline ({eventCount})
        </button>
        <input
          value={api}
          onChange={(e) => onApiChange(e.target.value)}
          className="px-2 py-1 border border-stone-200 rounded font-mono text-[11px] w-56 bg-stone-50"
          placeholder="http://localhost:4000"
        />
        <span
          className={`inline-flex items-center gap-1.5 ${
            connected ? "text-emerald-600" : "text-stone-400"
          }`}
        >
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? "bg-emerald-500" : "bg-stone-300"
            }`}
          />
          {connected ? "live" : "off"}
        </span>
      </div>
    </header>
  );
}

function TimelineDrawer({
  events,
  currentAgentId,
  selectedEventId,
  onSelectEvent,
  onClose,
}: {
  events: CadmusEvent[];
  currentAgentId: string | null;
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);

  // Default: only show events for the active agent. Toggle "all" to see
  // events from other agents that share this timeline DB.
  const visible = useMemo(() => {
    if (showAll || !currentAgentId) return events;
    return events.filter((e) => e.agent_id === currentAgentId);
  }, [events, showAll, currentAgentId]);

  // Distinct agents in the buffer — only show the toggle if there's something to toggle.
  const otherAgents = useMemo(() => {
    if (!currentAgentId) return [] as string[];
    const seen = new Set<string>();
    for (const e of events) if (e.agent_id !== currentAgentId) seen.add(e.agent_id);
    return [...seen];
  }, [events, currentAgentId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visible.length]);

  return (
    <div className="absolute right-3 top-3 bottom-3 w-[360px] bg-white border border-stone-200 rounded-xl shadow-lg z-20 flex flex-col">
      <header className="px-3 py-2 border-b border-stone-200 flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wider text-stone-500 font-semibold truncate">
          timeline · {visible.length}
          {!showAll && events.length !== visible.length && (
            <span className="ml-1 text-stone-400 normal-case font-normal">
              of {events.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {otherAgents.length > 0 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition ${
                showAll
                  ? "bg-stone-900 text-white border-stone-900"
                  : "bg-white text-stone-600 border-stone-200 hover:bg-stone-50"
              }`}
              title={
                showAll
                  ? `Showing all agents (${otherAgents.length + 1})`
                  : `Hiding ${otherAgents.length} other agent(s) on this timeline`
              }
            >
              all agents
            </button>
          )}
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-700 text-sm px-1"
          >
            ✕
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {visible.length === 0 && (
          <div className="text-center text-stone-400 text-xs py-8">
            no events yet
          </div>
        )}
        {visible.map((e) => {
          const isSelected = e.id === selectedEventId;
          return (
            <button
              key={e.id}
              onClick={() => onSelectEvent(e.id)}
              className={`block w-full text-left px-2 py-1.5 rounded border text-xs transition cursor-pointer ${eventColor(e.type)} ${
                isSelected ? "ring-2 ring-stone-900 ring-offset-1" : "hover:brightness-95"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono opacity-50">#{e.seq}</span>
                <span className="font-mono font-medium truncate">{e.type}</span>
                {showAll && e.agent_id !== currentAgentId && (
                  <span className="font-mono opacity-60 text-[10px] bg-white/60 border border-current/20 rounded px-1">
                    {e.agent_id}
                  </span>
                )}
                <span className="font-mono opacity-40 text-[10px] ml-auto">
                  {new Date(e.timestamp).toLocaleTimeString().slice(0, 8)}
                </span>
              </div>
              <div className="mt-0.5 font-mono opacity-70 text-[11px] line-clamp-2 break-words whitespace-pre-wrap">
                {summary(e)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function summary(e: CadmusEvent): string {
  const d = e.data as Record<string, unknown>;
  if (typeof d.text === "string") return d.text;
  if (typeof d.message === "string") return d.message;
  if (typeof d.summary === "string") return d.summary;
  try {
    const j = JSON.stringify(d);
    return j.length > 240 ? j.slice(0, 240) + "…" : j;
  } catch {
    return String(d);
  }
}
