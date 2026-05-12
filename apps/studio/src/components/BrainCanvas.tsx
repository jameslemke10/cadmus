"use client";

import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { migrateHandleId } from "../lib/handles";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildGraph, type ProcessorNodeData } from "../lib/graph";
import { filterMatchesEvent } from "../lib/filter";
import {
  deleteLayout,
  fetchLayout,
  saveLayout,
  type LayoutEdges,
  type LayoutNodes,
} from "../lib/api";
import type { AgentMeta, CadmusEvent } from "../lib/types";
import { ProcessorNode } from "./ProcessorNode";
import { ChannelNode, type ChannelNodeData } from "./ChannelNode";
import { MemoryNode, type MemoryNodeData } from "./MemoryNode";
import { WaypointEdge } from "./WaypointEdge";

const nodeTypes = { processor: ProcessorNode, channel: ChannelNode, memory: MemoryNode };
const edgeTypes = { flow: WaypointEdge };

type AnyNodeData = ProcessorNodeData | ChannelNodeData | MemoryNodeData;

interface Props {
  api: string;
  agent: AgentMeta;
  latestEvent: CadmusEvent | null;
  /** Names of processors currently in-flight (latest trigger newer than
   *  latest self-emit). Studio computes this from the timeline. */
  runningProcessors: Set<string>;
  onProcessorClick: (processorName: string) => void;
}

export function BrainCanvas({
  api,
  agent,
  latestEvent,
  runningProcessors,
  onProcessorClick,
}: Props) {
  return (
    <ReactFlowProvider>
      <BrainCanvasInner
        api={api}
        agent={agent}
        latestEvent={latestEvent}
        runningProcessors={runningProcessors}
        onProcessorClick={onProcessorClick}
      />
    </ReactFlowProvider>
  );
}

/**
 * Stable string keys for node positions and edge handles, used to detect
 * unsaved changes against the persisted baseline.
 */
function positionsToKey(nodes: Node<AnyNodeData>[]): string {
  return nodes
    .map((n) => `${n.id}:${Math.round(n.position.x)},${Math.round(n.position.y)}`)
    .sort()
    .join("|");
}

function edgeHandlesToKey(edges: Edge[]): string {
  // Handles + waypoints contribute to dirty. Label position is derived
  // from waypoints[0] now, so it's covered by the waypoint key already.
  return edges
    .map((e) => {
      const d = e.data as { waypoints?: { x: number; y: number }[] } | undefined;
      const wps = (d?.waypoints ?? [])
        .map((w) => `${Math.round(w.x)},${Math.round(w.y)}`)
        .join(";");
      return `${e.id}:${e.sourceHandle ?? ""}>${e.targetHandle ?? ""}#${wps}`;
    })
    .sort()
    .join("|");
}

/** Apply saved positions to nodes; missing ids keep their default positions. */
function applyNodeLayout(nodes: Node<AnyNodeData>[], layout: LayoutNodes): Node<AnyNodeData>[] {
  return nodes.map((n) => {
    const saved = layout[n.id];
    if (!saved) return n;
    return { ...n, position: { x: saved.x, y: saved.y } };
  });
}

/** Apply saved handle assignments + waypoints to edges. Legacy handle ids
 *  (from layouts written before the perimeter handle refactor) are migrated
 *  to their nearest positional ID. */
function applyEdgeLayout(edges: Edge[], layout: LayoutEdges): Edge[] {
  return edges.map((e) => {
    const saved = layout[e.id];
    if (!saved) return e;
    const data = (e.data ?? {}) as Record<string, unknown> & {
      waypoints?: { x: number; y: number }[];
    };
    return {
      ...e,
      sourceHandle: migrateHandleId(saved.sourceHandle) ?? e.sourceHandle,
      targetHandle: migrateHandleId(saved.targetHandle) ?? e.targetHandle,
      data: {
        ...data,
        waypoints: saved.waypoints ?? data.waypoints ?? [],
      },
    };
  });
}

/** Extract per-edge overrides for save. Includes edges whose handles or
 *  waypoints differ from build defaults. (labelOffset from older layouts
 *  is silently dropped — label position is now derived from waypoints[0].) */
function edgesToOverrides(current: Edge[], defaults: Edge[]): LayoutEdges {
  const defaultMap = new Map(defaults.map((d) => [d.id, d]));
  const out: LayoutEdges = {};
  for (const e of current) {
    const def = defaultMap.get(e.id);
    if (!def) continue;
    const handlesChanged =
      e.sourceHandle !== def.sourceHandle || e.targetHandle !== def.targetHandle;
    const data = e.data as { waypoints?: { x: number; y: number }[] } | undefined;
    const waypoints = data?.waypoints ?? [];
    const hasWaypoints = waypoints.length > 0;
    if (!handlesChanged && !hasWaypoints) continue;
    const entry: LayoutEdges[string] = {};
    if (e.sourceHandle && e.sourceHandle !== def.sourceHandle) entry.sourceHandle = e.sourceHandle;
    if (e.targetHandle && e.targetHandle !== def.targetHandle) entry.targetHandle = e.targetHandle;
    if (hasWaypoints) {
      entry.waypoints = waypoints.map((w) => ({
        x: Math.round(w.x),
        y: Math.round(w.y),
      }));
    }
    out[e.id] = entry;
  }
  return out;
}

function BrainCanvasInner({
  api,
  agent,
  latestEvent,
  runningProcessors,
  onProcessorClick,
}: Props) {
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

  // Baseline = positions + edge-handle assignments that are currently
  // persisted (or the defaults if no saved layout exists). Drag/reconnect
  // diverges current from baseline; Save pushes current → baseline; Reset
  // deletes the file and reverts.
  const [baselineNodeKey, setBaselineNodeKey] = useState<string>("");
  const [baselineEdgeKey, setBaselineEdgeKey] = useState<string>("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const currentNodeKey = useMemo(() => positionsToKey(nodes), [nodes]);
  const currentEdgeKey = useMemo(() => edgeHandlesToKey(edges), [edges]);
  const dirty =
    (baselineNodeKey !== "" && currentNodeKey !== baselineNodeKey) ||
    (baselineEdgeKey !== "" && currentEdgeKey !== baselineEdgeKey);

  // Mirror the runningProcessors set onto each processor node's data.running.
  // ProcessorNode reads this and renders a "thinking" pulse while in-flight.
  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        if (n.type !== "processor") return n;
        const desired = runningProcessors.has(n.id);
        const current = (n.data as { running?: boolean }).running ?? false;
        if (desired === current) return n;
        changed = true;
        return { ...n, data: { ...n.data, running: desired } };
      });
      return changed ? next : prev;
    });
  }, [runningProcessors, setNodes]);

  // Keep each node's `usedHandles` in sync with the current edge set. Without
  // this, reconnecting an edge moves the LINE (xyflow reads the new handle id)
  // but leaves the visible dot stuck on the old handle, because usedHandles
  // was computed once at buildGraph time. Re-derive on every edge change.
  useEffect(() => {
    const usedByNode = new Map<string, Set<string>>();
    for (const e of edges) {
      if (e.sourceHandle) {
        let s = usedByNode.get(e.source);
        if (!s) {
          s = new Set();
          usedByNode.set(e.source, s);
        }
        s.add(e.sourceHandle);
      }
      if (e.targetHandle) {
        let s = usedByNode.get(e.target);
        if (!s) {
          s = new Set();
          usedByNode.set(e.target, s);
        }
        s.add(e.targetHandle);
      }
    }
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const desired = usedByNode.get(n.id);
        const desiredSorted = desired ? [...desired].sort() : [];
        const current = (((n.data as { usedHandles?: string[] }).usedHandles) ?? [])
          .slice()
          .sort();
        const same =
          desiredSorted.length === current.length &&
          desiredSorted.every((v, i) => v === current[i]);
        if (same) return n;
        changed = true;
        return { ...n, data: { ...n.data, usedHandles: desiredSorted } };
      });
      return changed ? next : prev;
    });
  }, [edges, setNodes]);

  // Rebuild graph + fetch layout whenever the agent shape changes.
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      let nextNodes = initial.nodes;
      let nextEdges = initial.edges;
      try {
        const layout = await fetchLayout(api);
        nextNodes = applyNodeLayout(initial.nodes, layout.nodes);
        nextEdges = applyEdgeLayout(initial.edges, layout.edges);
      } catch {
        // No saved layout — use defaults.
      }
      if (cancelled) return;
      setNodes(nextNodes);
      setEdges(nextEdges);
      setBaselineNodeKey(positionsToKey(nextNodes));
      setBaselineEdgeKey(edgeHandlesToKey(nextEdges));
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

  // Click on an edge that's already selected → drop a waypoint at the click
  // point. First click selects (xyflow default); second click adds. This
  // gives a consistent "click to grab, click to act" rhythm and avoids
  // accidental waypoint sprays while panning.
  const { screenToFlowPosition } = useReactFlow();
  const onEdgeClick: EdgeMouseHandler = useCallback(
    (event, edge) => {
      if (!edge.selected) return;
      const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== edge.id) return e;
          const cur = (e.data ?? {}) as { waypoints?: { x: number; y: number }[] };
          const wps = cur.waypoints ?? [];
          return { ...e, data: { ...cur, waypoints: [...wps, flowPos] } };
        }),
      );
    },
    [screenToFlowPosition, setEdges],
  );

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    setErrorMsg(null);
    const positions: LayoutNodes = {};
    for (const n of nodes) {
      positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    }
    const edgeOverrides = edgesToOverrides(edges, initial.edges);
    try {
      await saveLayout(api, positions, edgeOverrides);
      setBaselineNodeKey(positionsToKey(nodes));
      setBaselineEdgeKey(edgeHandlesToKey(edges));
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err) {
      setSaveState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [api, nodes, edges, initial.edges]);

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
    setBaselineNodeKey(positionsToKey(initial.nodes));
    setBaselineEdgeKey(edgeHandlesToKey(initial.edges));
    setSaveState("idle");
  }, [api, initial, setNodes, setEdges]);

  // Edge reconnection. Use xyflow's reconnectEdge helper, but pass
  // `shouldReplaceId: false` so our edge IDs stay stable across reconnects
  // — the override-tracking in edgesToOverrides keys on edge.id, and
  // xyflow's default behavior of regenerating IDs from source/target/handles
  // would silently break persistence.
  //
  // Cross-node moves are rejected (the kernel's filters define routing,
  // not the canvas), but handle swaps on the same source/target are
  // allowed.
  //
  // reconnectSuccess gates the snap-back behavior: if the drop was invalid
  // or rejected, onReconnectEnd nudges React to re-render so the visually-
  // detached endpoint snaps back to its original handle.
  const reconnectSuccess = useRef(true);

  const onReconnectStart = useCallback(() => {
    reconnectSuccess.current = false;
    setNodes((prev) =>
      prev.map((n) => ({ ...n, data: { ...n.data, revealAllHandles: true } })),
    );
  }, [setNodes]);

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      if (
        newConnection.source !== oldEdge.source ||
        newConnection.target !== oldEdge.target
      ) {
        return; // cross-node — reject
      }
      reconnectSuccess.current = true;
      setEdges((eds) =>
        reconnectEdge(oldEdge, newConnection, eds, { shouldReplaceId: false }),
      );
    },
    [setEdges],
  );

  const onReconnectEnd = useCallback(() => {
    if (!reconnectSuccess.current) {
      setEdges((eds) => [...eds]);
    }
    reconnectSuccess.current = true;
    setNodes((prev) =>
      prev.map((n) => ({ ...n, data: { ...n.data, revealAllHandles: false } })),
    );
  }, [setEdges, setNodes]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onReconnect={onReconnect}
        onReconnectStart={onReconnectStart}
        onReconnectEnd={onReconnectEnd}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // ConnectionMode.Loose lets a single Handle act as either source or
        // target during a drop. We render every handle as type="source"
        // (because xyflow requires a type), and loose mode makes them
        // accept either polarity — so users can drop either endpoint of an
        // edge anywhere on the perimeter.
        connectionMode={ConnectionMode.Loose}
        // Required for handles to accept reconnect drops. We don't wire an
        // onConnect handler, so users can't actually create new edges from
        // scratch — the kernel's filters define routing, not the canvas.
        nodesConnectable
        nodesDraggable
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.6}
          color="#a8a29e"
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
