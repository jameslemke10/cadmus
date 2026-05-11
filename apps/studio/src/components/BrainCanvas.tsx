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
import { useCallback, useEffect, useMemo, useRef } from "react";
import { buildGraph, type ProcessorNodeData } from "../lib/graph";
import { filterMatchesEvent } from "../lib/filter";
import type { AgentMeta, CadmusEvent } from "../lib/types";
import { ProcessorNode } from "./ProcessorNode";

const nodeTypes = { processor: ProcessorNode };

type Position = { x: number; y: number };
type SavedPositions = Record<string, Position>;

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
  // Layout is computed once per (agent.id, processor names). Pulling in
  // every metadata refresh (which happens every 5s) would otherwise stomp
  // user-dragged positions.
  const layoutKey = useMemo(
    () => `${agent.id}::${agent.processors.map((p) => p.name).sort().join(",")}`,
    [agent.id, agent.processors],
  );

  const initial = useMemo(() => {
    const graph = buildGraph(agent.processors);
    const saved = loadSavedPositions(agent.id);
    return {
      ...graph,
      nodes: graph.nodes.map((n) =>
        saved[n.id] ? { ...n, position: saved[n.id] } : n,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ProcessorNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const lastEventIdRef = useRef<string | null>(null);

  // When the processor set changes (new agent, added/removed processor),
  // refresh nodes/edges but PRESERVE existing positions for processors we
  // already know about.
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

  // Pulse processors whose filter matches the new event; animate the
  // edges that delivered it.
  useEffect(() => {
    if (!latestEvent || latestEvent.id === lastEventIdRef.current) return;
    lastEventIdRef.current = latestEvent.id;

    const matchingNames = new Set(
      agent.processors
        .filter((p) => filterMatchesEvent(p.filter, latestEvent))
        .map((p) => p.name),
    );
    if (matchingNames.size === 0) return;

    const now = Date.now();

    setNodes((prev) =>
      prev.map((n) =>
        matchingNames.has(n.id)
          ? { ...n, data: { ...n.data, pulse: now } }
          : n,
      ),
    );

    setEdges((prev) =>
      prev.map((e) => {
        const eventType = (e.data as { eventType?: string } | undefined)?.eventType;
        const isActive =
          eventType === latestEvent.type && matchingNames.has(e.target);
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
          style: {
            ...(e.style ?? {}),
            stroke: "#a8a29e",
            strokeWidth: 1.5,
          },
        })),
      );
      setNodes((prev) => prev.map((n) => ({ ...n })));
    }, 900);

    return () => clearTimeout(t);
  }, [latestEvent, agent.processors, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = (_, node) => {
    onProcessorClick(node.id);
  };

  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      savePosition(agent.id, node.id, node.position);
    },
    [agent.id],
  );

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
        />
      </ReactFlow>
    </div>
  );
}
