"use client";

import {
  Background,
  BackgroundVariant,
  ControlButton,
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
import { useCallback, useEffect, useMemo, useRef } from "react";
import { buildGraph, type ProcessorNodeData } from "../lib/graph";
import { filterMatchesEvent } from "../lib/filter";
import type { AgentMeta, CadmusEvent } from "../lib/types";
import { ProcessorNode } from "./ProcessorNode";
import { ChannelNode, type ChannelNodeData } from "./ChannelNode";
import { MemoryNode, type MemoryNodeData } from "./MemoryNode";

const nodeTypes = { processor: ProcessorNode, channel: ChannelNode, memory: MemoryNode };

type Position = { x: number; y: number };
type SavedPositions = Record<string, Position>;
type AnyNodeData = ProcessorNodeData | ChannelNodeData | MemoryNodeData;

function positionsKey(agentId: string): string {
  return `cadmus.studio.nodePositions.${agentId}`;
}

function loadSavedPositions(agentId: string): SavedPositions {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(positionsKey(agentId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as SavedPositions;
  } catch {
    return {};
  }
}

function savePosition(agentId: string, nodeId: string, pos: Position): void {
  if (typeof window === "undefined") return;
  try {
    const current = loadSavedPositions(agentId);
    current[nodeId] = pos;
    window.localStorage.setItem(positionsKey(agentId), JSON.stringify(current));
  } catch {
    // localStorage full / disabled — silently give up
  }
}

function clearSavedPositions(agentId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(positionsKey(agentId));
  } catch {
    // ignore
  }
}

interface Props {
  agent: AgentMeta;
  latestEvent: CadmusEvent | null;
  onProcessorClick: (processorName: string) => void;
}

export function BrainCanvas({ agent, latestEvent, onProcessorClick }: Props) {
  return (
    <ReactFlowProvider>
      <BrainCanvasInner
        agent={agent}
        latestEvent={latestEvent}
        onProcessorClick={onProcessorClick}
      />
    </ReactFlowProvider>
  );
}

function BrainCanvasInner({ agent, latestEvent, onProcessorClick }: Props) {
  const layoutKey = useMemo(
    () =>
      `${agent.id}::${agent.processors.map((p) => p.name).sort().join(",")}::${(agent.channels ?? [])
        .map((c) => c.name)
        .sort()
        .join(",")}`,
    [agent.id, agent.processors, agent.channels],
  );

  const computeInitial = useCallback(() => {
    const graph = buildGraph(agent.processors, agent.channels ?? []);
    const saved = loadSavedPositions(agent.id);
    return {
      ...graph,
      nodes: graph.nodes.map((n) =>
        saved[n.id] ? { ...n, position: saved[n.id] } : n,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const initial = useMemo(() => computeInitial(), [computeInitial]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AnyNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const lastEventIdRef = useRef<string | null>(null);

  // Refresh nodes/edges when the agent shape changes, but preserve any
  // existing node positions for nodes we already had.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return initial.nodes.map((n) => {
        const existing = byId.get(n.id);
        return existing ? { ...n, position: existing.position } : n;
      });
    });
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);

  // Pulse processors / channels whose filter matches the new event, plus
  // any inbound channel that emitted it and any outbound channel routing it.
  useEffect(() => {
    if (!latestEvent || latestEvent.id === lastEventIdRef.current) return;
    lastEventIdRef.current = latestEvent.id;

    const matchingProcs = new Set(
      agent.processors
        .filter((p) => filterMatchesEvent(p.filter, latestEvent))
        .map((p) => p.name),
    );

    // Channels involved in this event: source (channel-in:X if the event
    // came from that channel and is in its inboundEvents) or sink
    // (channel-out:X if the event is in its outboundEvents).
    const matchingChannels = new Set<string>();
    for (const ch of agent.channels ?? []) {
      const sourceMatches =
        (latestEvent.source === `channel:${ch.name}`) &&
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
        const eventType = (e.data as { eventType?: string } | undefined)?.eventType;
        const targets = new Set<string>([...matchingProcs, ...matchingChannels]);
        const isActive = eventType === latestEvent.type && targets.has(e.target);
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

  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      savePosition(agent.id, node.id, node.position);
    },
    [agent.id],
  );

  const onResetLayout = useCallback(() => {
    clearSavedPositions(agent.id);
    const fresh = buildGraph(agent.processors, agent.channels ?? []);
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
  }, [agent.id, agent.processors, agent.channels, setNodes, setEdges]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
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
        >
          <ControlButton onClick={onResetLayout} title="Auto-layout (reset node positions)">
            {/* layout grid icon — clearer than a refresh arrow */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="9" rx="1" />
              <rect x="14" y="3" width="7" height="5" rx="1" />
              <rect x="14" y="12" width="7" height="9" rx="1" />
              <rect x="3" y="16" width="7" height="5" rx="1" />
            </svg>
          </ControlButton>
        </Controls>
      </ReactFlow>
    </div>
  );
}
