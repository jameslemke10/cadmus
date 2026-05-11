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
import { filterMatchesEvent } from "../lib/filter";
import type { AgentMeta, CadmusEvent } from "../lib/types";
import { ProcessorNode } from "./ProcessorNode";
import { ChannelNode, type ChannelNodeData } from "./ChannelNode";
import { MemoryNode, type MemoryNodeData } from "./MemoryNode";

const nodeTypes = { processor: ProcessorNode, channel: ChannelNode, memory: MemoryNode };

type AnyNodeData = ProcessorNodeData | ChannelNodeData | MemoryNodeData;

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
  // Layout is deterministic — depends only on the set of processors and
  // channels, not on the live agent object identity.
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

  // Whenever the agent shape changes (new processor/channel arrives or
  // the user switches agents), rebuild from scratch. Positions are
  // deterministic so there's nothing to preserve.
  useEffect(() => {
    setNodes(initial.nodes);
    setEdges(initial.edges);
  }, [initial, setNodes, setEdges]);

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

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
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
