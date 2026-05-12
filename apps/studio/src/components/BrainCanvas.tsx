"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildGraph, type ProcessorNodeData } from "../lib/graph";
import { filterMatchesEvent } from "../lib/filter";
import { deleteLayout, fetchLayout, saveLayout, type LayoutNodes } from "../lib/api";
import type { AgentMeta, CadmusEvent } from "../lib/types";
import { ProcessorNode } from "./ProcessorNode";
import { ChannelNode, type ChannelNodeData } from "./ChannelNode";
import { MemoryNode, type MemoryNodeData } from "./MemoryNode";

const nodeTypes = { processor: ProcessorNode, channel: ChannelNode, memory: MemoryNode };

type AnyNodeData = ProcessorNodeData | ChannelNodeData | MemoryNodeData;

interface Props {
  api: string;
  agent: AgentMeta;
  latestEvent: CadmusEvent | null;
  onProcessorClick: (processorName: string) => void;
}

export function BrainCanvas({ api, agent, latestEvent, onProcessorClick }: Props) {
  return (
    <ReactFlowProvider>
      <BrainCanvasInner
        api={api}
        agent={agent}
        latestEvent={latestEvent}
        onProcessorClick={onProcessorClick}
      />
    </ReactFlowProvider>
  );
}

/**
 * Returns a stable string key for a position map so we can compare current
 * positions against the saved baseline cheaply.
 */
function positionsToKey(nodes: Node<AnyNodeData>[]): string {
  return nodes
    .map((n) => `${n.id}:${Math.round(n.position.x)},${Math.round(n.position.y)}`)
    .sort()
    .join("|");
}

/** Apply saved positions to nodes; missing ids keep their default positions. */
function applyLayout(nodes: Node<AnyNodeData>[], layout: LayoutNodes): Node<AnyNodeData>[] {
  return nodes.map((n) => {
    const saved = layout[n.id];
    if (!saved) return n;
    return { ...n, position: { x: saved.x, y: saved.y } };
  });
}

function BrainCanvasInner({ api, agent, latestEvent, onProcessorClick }: Props) {
  const layoutKey = useMemo(
    () =>
      `${agent.id}::${agent.processors.map((p) => p.name).sort().join(",")}::${(agent.channels ?? [])
        .map((c) => c.name)
        .sort()
        .join(",")}`,
    [agent.id, agent.processors, agent.channels],
  );

  const initial = useMemo(
    () => buildGraph(agent.processors, agent.channels ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AnyNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const lastEventIdRef = useRef<string | null>(null);

  // Baseline = positions that are currently persisted (or the defaults if no
  // saved layout exists). Drag changes diverge current from baseline; Save
  // pushes current → baseline; Reset deletes the file and reverts.
  const [baselineKey, setBaselineKey] = useState<string>("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentKey = useMemo(() => positionsToKey(nodes), [nodes]);
  const dirty = baselineKey !== "" && currentKey !== baselineKey;

  // Rebuild graph + fetch layout whenever the agent shape changes.
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      let withLayout = initial.nodes;
      try {
        const layout = await fetchLayout(api);
        withLayout = applyLayout(initial.nodes, layout);
      } catch {
        // No saved layout — use defaults.
      }
      if (cancelled) return;
      setNodes(withLayout);
      setEdges(initial.edges);
      setBaselineKey(positionsToKey(withLayout));
      setSaveState("idle");
      setErrorMsg(null);
    };
    void init();
    return () => {
      cancelled = true;
    };
  }, [initial, setNodes, setEdges, api]);

  // Pulse the nodes whose filter matches the new event + the channels
  // emitting or receiving it.
  useEffect(() => {
    if (!latestEvent || latestEvent.id === lastEventIdRef.current) return;
    lastEventIdRef.current = latestEvent.id;

    const matchingProcs = new Set(
      agent.processors
        .filter((p) => filterMatchesEvent(p.filter, latestEvent))
        .map((p) => p.name),
    );

    const matchingChannels = new Set<string>();
    for (const ch of agent.channels ?? []) {
      const sourceMatches =
        latestEvent.source === `channel:${ch.name}` &&
        (ch.inboundEvents ?? []).includes(latestEvent.type);
      if (sourceMatches) matchingChannels.add(`channel-in:${ch.name}`);
      if ((ch.outboundEvents ?? []).includes(latestEvent.type)) {
        matchingChannels.add(`channel-out:${ch.name}`);
      }
    }

    if (matchingProcs.size === 0 && matchingChannels.size === 0) return;

    const now = Date.now();

    setNodes((prev) =>
      prev.map((n) => {
        const isProc = matchingProcs.has(n.id);
        const isChan = matchingChannels.has(n.id);
        if (!isProc && !isChan) return n;
        return { ...n, data: { ...n.data, pulse: now } };
      }),
    );

    setEdges((prev) =>
      prev.map((e) => {
        const data = e.data as { eventType?: string; eventTypes?: string[] } | undefined;
        const types = data?.eventTypes ?? (data?.eventType ? [data.eventType] : []);
        const carriesType = types.includes(latestEvent.type);
        const targets = new Set<string>([...matchingProcs, ...matchingChannels]);
        const isActive = carriesType && targets.has(e.target);
        return {
          ...e,
          animated: isActive,
          style: {
            ...(e.style ?? {}),
            stroke: isActive ? "#10b981" : "#a8a29e",
            strokeWidth: isActive ? 2.5 : 1.5,
          },
        };
      }),
    );

    const t = setTimeout(() => {
      setEdges((prev) =>
        prev.map((e) => ({
          ...e,
          animated: false,
          style: { ...(e.style ?? {}), stroke: "#a8a29e", strokeWidth: 1.5 },
        })),
      );
      setNodes((prev) => prev.map((n) => ({ ...n })));
    }, 900);

    return () => clearTimeout(t);
  }, [latestEvent, agent.processors, agent.channels, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = (_, node) => {
    if (node.type === "processor") onProcessorClick(node.id);
  };

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    setErrorMsg(null);
    const positions: LayoutNodes = {};
    for (const n of nodes) {
      positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    }
    try {
      await saveLayout(api, positions);
      setBaselineKey(positionsToKey(nodes));
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err) {
      setSaveState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [api, nodes]);

  const handleReset = useCallback(async () => {
    setErrorMsg(null);
    try {
      await deleteLayout(api);
    } catch (err) {
      setSaveState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      return;
    }
    setNodes(initial.nodes);
    setEdges(initial.edges);
    setBaselineKey(positionsToKey(initial.nodes));
    setSaveState("idle");
  }, [api, initial, setNodes, setEdges]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#d6d3d1"
        />
        <Controls
          showInteractive={false}
          style={{ button: { background: "#fafaf9", border: "1px solid #e7e5e4" } } as never}
        />
      </ReactFlow>

      <LayoutToolbar
        dirty={dirty}
        saveState={saveState}
        errorMsg={errorMsg}
        onSave={() => void handleSave()}
        onReset={() => void handleReset()}
      />
    </div>
  );
}

function LayoutToolbar({
  dirty,
  saveState,
  errorMsg,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  errorMsg: string | null;
  onSave: () => void;
  onReset: () => void;
}) {
  const label =
    saveState === "saving"
      ? "saving…"
      : saveState === "saved"
        ? "saved ✓"
        : saveState === "error"
          ? "save failed"
          : dirty
            ? "save layout"
            : "saved";

  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-white/95 backdrop-blur-sm border border-stone-200 rounded-lg shadow-sm px-2 py-1.5">
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${
          dirty ? "bg-amber-500" : "bg-emerald-500"
        }`}
        title={dirty ? "unsaved changes" : "in sync with cadmus.layout.json"}
      />
      <button
        onClick={onSave}
        disabled={!dirty || saveState === "saving"}
        className={`text-[11px] font-medium px-2 py-1 rounded transition ${
          dirty
            ? "bg-stone-900 text-white hover:bg-stone-700"
            : "text-stone-400 cursor-default"
        }`}
      >
        {label}
      </button>
      <button
        onClick={onReset}
        className="text-[11px] text-stone-500 hover:text-stone-900 px-2 py-1 transition"
        title="Delete cadmus.layout.json and revert to default positions"
      >
        reset
      </button>
      {errorMsg && (
        <span
          className="text-[11px] text-rose-700 max-w-[300px] truncate"
          title={errorMsg}
        >
          {errorMsg}
        </span>
      )}
    </div>
  );
}
