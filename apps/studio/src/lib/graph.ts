import type { Edge, Node } from "@xyflow/react";
import type { ChannelMeta, ProcessorMeta } from "./types";
import { filterEventTypes, filterMatchesType } from "./filter";
import type { ChannelNodeData } from "../components/ChannelNode";
import type { MemoryNodeData } from "../components/MemoryNode";

export interface ProcessorNodeData extends Record<string, unknown> {
  processor: ProcessorMeta;
  pulse: number;
}

const COLUMN_WIDTH = 380;
const ROW_HEIGHT = 220;

const MEMORY_NODE_ID = "memory:store";

const MEMORY_READ_TOOLS = new Set(["memory_search", "memory_get"]);
const MEMORY_WRITE_TOOLS = new Set(["memory_write", "memory_delete"]);

/**
 * Build React Flow nodes + edges from the agent's processors + channels.
 *
 * Layout is left-to-right: inbound channels far left, processors in
 * topological columns, outbound channels far right, memory below the row.
 *
 * Edges:
 *  - Forward edges (source col < target col) use right→left handles.
 *  - Back-edges (source col >= target col) use bottom→top handles, so the
 *    line bends UNDER the row instead of cutting through it. This matters
 *    a lot for loops like the brain's pfc_loop (PFC at col 2 → hippocampus
 *    at col 0).
 *  - Multiple event types between the same (source, target) pair are
 *    bundled into a single edge whose label is "evt1 | evt2".
 */
export function buildGraph(
  processors: ProcessorMeta[],
  channels: ChannelMeta[] = [],
): {
  nodes: Node<ProcessorNodeData | ChannelNodeData | MemoryNodeData>[];
  edges: Edge[];
} {
  const layers = layerProcessors(processors);
  const procColumns = layers.length;

  // Column index per node id — used to detect back-edges and pick handles.
  const nodeColumn = new Map<string, number>();

  const nodes: Node<ProcessorNodeData | ChannelNodeData | MemoryNodeData>[] = [];

  const inboundChannels = channels.filter((c) => (c.inboundEvents ?? []).length > 0);
  for (const [rowIdx, ch] of inboundChannels.entries()) {
    const id = `channel-in:${ch.name}`;
    nodes.push({
      id,
      type: "channel",
      position: { x: 80, y: 60 + rowIdx * ROW_HEIGHT },
      data: { name: ch.name, side: "in", events: ch.inboundEvents ?? [], pulse: 0 },
    });
    nodeColumn.set(id, -1);
  }

  const procXOffset = inboundChannels.length > 0 ? 80 + COLUMN_WIDTH : 80;
  for (const [layerIdx, layer] of layers.entries()) {
    for (const [rowIdx, p] of layer.entries()) {
      nodes.push({
        id: p.name,
        type: "processor",
        position: { x: procXOffset + layerIdx * COLUMN_WIDTH, y: 60 + rowIdx * ROW_HEIGHT },
        data: { processor: p, pulse: 0 },
      });
      nodeColumn.set(p.name, layerIdx);
    }
  }

  const outboundChannels = channels.filter((c) => (c.outboundEvents ?? []).length > 0);
  const outX = procXOffset + procColumns * COLUMN_WIDTH;
  for (const [rowIdx, ch] of outboundChannels.entries()) {
    const id = `channel-out:${ch.name}`;
    nodes.push({
      id,
      type: "channel",
      position: { x: outX, y: 60 + rowIdx * ROW_HEIGHT },
      data: { name: ch.name, side: "out", events: ch.outboundEvents ?? [], pulse: 0 },
    });
    nodeColumn.set(id, procColumns);
  }

  // Memory node — show it if any processor uses memory tools.
  const memoryUsers = processors.filter((p) =>
    (p.tools ?? []).some((t) => MEMORY_READ_TOOLS.has(t) || MEMORY_WRITE_TOOLS.has(t)),
  );
  if (memoryUsers.length > 0) {
    const maxRowsPerLayer = Math.max(...layers.map((l) => l.length), 1);
    const memoryY = 60 + maxRowsPerLayer * ROW_HEIGHT + 60;
    const memoryX = procXOffset + Math.floor(procColumns / 2) * COLUMN_WIDTH + 50;
    nodes.push({
      id: MEMORY_NODE_ID,
      type: "memory",
      position: { x: memoryX, y: memoryY },
      data: { pulse: 0 },
    });
  }

  // Build the (source, target) → eventTypes[] map. Bundling happens here:
  // multiple event types between the same pair collapse into one edge.
  const flowBundle = new Map<string, { source: string; target: string; events: string[] }>();
  const addFlow = (source: string, target: string, eventType: string) => {
    const key = `${source}__${target}`;
    let entry = flowBundle.get(key);
    if (!entry) {
      entry = { source, target, events: [] };
      flowBundle.set(key, entry);
    }
    if (!entry.events.includes(eventType)) entry.events.push(eventType);
  };

  for (const emitter of processors) {
    for (const eventType of emitter.outputEvents ?? []) {
      for (const consumer of processors) {
        if (filterMatchesType(consumer.filter, eventType)) {
          addFlow(emitter.name, consumer.name, eventType);
        }
      }
    }
  }

  for (const ch of inboundChannels) {
    for (const eventType of ch.inboundEvents ?? []) {
      for (const consumer of processors) {
        if (filterMatchesType(consumer.filter, eventType)) {
          addFlow(`channel-in:${ch.name}`, consumer.name, eventType);
        }
      }
    }
  }

  for (const ch of outboundChannels) {
    for (const eventType of ch.outboundEvents ?? []) {
      for (const emitter of processors) {
        if ((emitter.outputEvents ?? []).includes(eventType)) {
          addFlow(emitter.name, `channel-out:${ch.name}`, eventType);
        }
      }
    }
  }

  const edges: Edge[] = [];
  for (const { source, target, events } of flowBundle.values()) {
    const srcCol = nodeColumn.get(source) ?? 0;
    const tgtCol = nodeColumn.get(target) ?? 0;
    const isBack = srcCol >= tgtCol && source !== target;
    edges.push(makeFlowEdge(source, target, events, isBack));
  }

  // Memory edges. Connect processor.memHandles ↔ memory.top via explicit
  // handles so they don't try to route through the side flow.
  for (const p of memoryUsers) {
    const tools = p.tools ?? [];
    const reads = tools.filter((t) => MEMORY_READ_TOOLS.has(t));
    const writes = tools.filter((t) => MEMORY_WRITE_TOOLS.has(t));
    if (reads.length > 0) {
      edges.push(makeMemoryEdge(MEMORY_NODE_ID, "read-out", p.name, "mem-in", "memory_read"));
    }
    if (writes.length > 0) {
      edges.push(makeMemoryEdge(p.name, "mem-out", MEMORY_NODE_ID, "write-in", "memory_write"));
    }
  }

  return { nodes, edges };
}

function makeFlowEdge(source: string, target: string, events: string[], isBack: boolean): Edge {
  // Bundle: two events become "evt1 | evt2"; three or more get collapsed
  // visually with a count so labels stay readable.
  const label =
    events.length <= 2 ? events.join(" | ") : `${events[0]} | +${events.length - 1} more`;

  // Forward edges flow right→left as before. Back-edges route under the
  // row using the bottom→top handles defined on ProcessorNode.
  const sourceHandle = isBack ? "back-out" : "out";
  const targetHandle = isBack ? "back-in" : "in";

  return {
    id: `${source}__${events.join(",")}__${target}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    label,
    type: "smoothstep",
    animated: false,
    // Store the underlying event types so the runtime pulse can still match.
    data: { eventType: events[0], eventTypes: events },
    pathOptions: { borderRadius: 16, offset: isBack ? 28 : 16 },
    labelStyle: {
      fontSize: 11,
      fontFamily: "ui-monospace, monospace",
      fill: "#1c1917",
    },
    labelBgStyle: {
      fill: "#ffffff",
      stroke: "#e7e5e4",
      strokeWidth: 1,
    },
    labelBgPadding: [6, 4] as [number, number],
    labelBgBorderRadius: 6,
    style: { stroke: "#a8a29e", strokeWidth: 1.5 },
  } as Edge;
}

function makeMemoryEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  label: string,
): Edge {
  return {
    id: `${source}__${label}__${target}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    label,
    type: "smoothstep",
    animated: false,
    data: { eventType: label },
    pathOptions: { borderRadius: 12, offset: 12 },
    labelStyle: { fontSize: 10, fontFamily: "ui-monospace, monospace", fill: "#1c1917" },
    labelBgStyle: { fill: "#ffffff", stroke: "#d1fae5", strokeWidth: 1 },
    labelBgPadding: [5, 3] as [number, number],
    labelBgBorderRadius: 6,
    style: { stroke: "#10b981", strokeWidth: 1.25, strokeDasharray: "4 3" },
  } as Edge;
}

function layerProcessors(processors: ProcessorMeta[]): ProcessorMeta[][] {
  const EXTERNAL_TYPES = new Set([
    "input",
    "notification_received",
    "timer_fired",
    "heartbeat",
  ]);

  const emittersOf = new Map<string, ProcessorMeta[]>();
  for (const p of processors) {
    for (const t of p.outputEvents ?? []) {
      if (!emittersOf.has(t)) emittersOf.set(t, []);
      emittersOf.get(t)!.push(p);
    }
  }

  const layer = new Map<string, number>();
  let changed = true;
  for (let pass = 0; pass < processors.length + 2 && changed; pass++) {
    changed = false;
    for (const p of processors) {
      if (layer.has(p.name)) continue;

      let bestResolved = -Infinity;
      let hasExternal = false;

      for (const t of filterEventTypes(p.filter)) {
        if (EXTERNAL_TYPES.has(t)) {
          hasExternal = true;
          continue;
        }
        const emitters = emittersOf.get(t) ?? [];
        if (emitters.length === 0) {
          hasExternal = true;
          continue;
        }
        for (const e of emitters) {
          if (e.name === p.name) continue;
          const eLayer = layer.get(e.name);
          if (eLayer !== undefined) {
            bestResolved = Math.max(bestResolved, eLayer);
          }
        }
      }

      if (hasExternal || bestResolved !== -Infinity) {
        const place = bestResolved !== -Infinity ? bestResolved + 1 : 0;
        layer.set(p.name, place);
        changed = true;
      }
    }
  }

  for (const p of processors) {
    if (!layer.has(p.name)) layer.set(p.name, 0);
  }

  const maxLayer = Math.max(0, ...layer.values());
  const result: ProcessorMeta[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const p of processors) {
    result[layer.get(p.name) ?? 0].push(p);
  }
  return result;
}
