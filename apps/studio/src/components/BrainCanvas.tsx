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
import { useEffect, useMemo, useRef } from "react";
import { buildGraph, type ProcessorNodeData } from "../lib/graph";
import type { AgentMeta, CadmusEvent } from "../lib/types";
import { ProcessorNode } from "./ProcessorNode";

const nodeTypes = { processor: ProcessorNode };

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
  const initial = useMemo(() => buildGraph(agent.processors), [agent.processors]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ProcessorNodeData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const lastEventIdRef = useRef<string | null>(null);

  // Rebuild when the agent metadata changes.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);

  // Pulse processors whose filter matches the new event; animate their outgoing edges.
  useEffect(() => {
    if (!latestEvent || latestEvent.id === lastEventIdRef.current) return;
    lastEventIdRef.current = latestEvent.id;

    const matchingNames = new Set(
      agent.processors.filter((p) => p.filter.includes(latestEvent.type)).map((p) => p.name),
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

    // Animate the edges that delivered this event type.
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

    // After 900ms, calm down.
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
      setNodes((prev) => prev.map((n) => ({ ...n }))); // force re-render so isFiring drops
    }, 900);

    return () => clearTimeout(t);
  }, [latestEvent, agent.processors, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = (_, node) => {
    onProcessorClick(node.id);
  };

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
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
