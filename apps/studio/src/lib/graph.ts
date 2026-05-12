import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { ChannelMeta, ProcessorMeta } from "./types";
import { filterEventTypes, filterMatchesType } from "./filter";
import { CENTER } from "./handles";
import type { ChannelNodeData } from "../components/ChannelNode";
import type { MemoryNodeData } from "../components/MemoryNode";

/** A point in flow (graph) coordinates that an edge passes through. */
export interface Waypoint {
  x: number;
  y: number;
}

export interface ProcessorNodeData extends Record<string, unknown> {
  processor: ProcessorMeta;
  pulse: number;
  /** Handle ids actually used by an edge in the current graph. Nodes only
   *  render handles in this set unless `revealAllHandles` is true. */
  usedHandles: string[];
  /** When true (during a reconnect drag), the node renders ALL of its
   *  declared handles so the user has somewhere to drop the endpoint. */
  revealAllHandles: boolean;
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
      data: {
        name: ch.name,
        side: "in",
        events: ch.inboundEvents ?? [],
        pulse: 0,
        usedHandles: [],
        revealAllHandles: false,
      },
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
        data: { processor: p, pulse: 0, usedHandles: [], revealAllHandles: false },
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
      data: {
        name: ch.name,
        side: "out",
        events: ch.outboundEvents ?? [],
        pulse: 0,
        usedHandles: [],
        revealAllHandles: false,
      },
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
      data: { pulse: 0, usedHandles: [], revealAllHandles: false },
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

  // Memory edges. Connect processor.bottom ↔ memory.top with positional
  // handles. We pick offset positions so writes/reads don't visually overlap.
  for (const p of memoryUsers) {
    const tools = p.tools ?? [];
    const reads = tools.filter((t) => MEMORY_READ_TOOLS.has(t));
    const writes = tools.filter((t) => MEMORY_WRITE_TOOLS.has(t));
    if (reads.length > 0) {
      edges.push(makeMemoryEdge(MEMORY_NODE_ID, "top-3", p.name, "bottom-4", "memory_read"));
    }
    if (writes.length > 0) {
      edges.push(makeMemoryEdge(p.name, "bottom-3", MEMORY_NODE_ID, "top-1", "memory_write"));
    }
  }

  // Tally which handles each node actually exposes via an edge. Nodes use
  // this to decide which Handle dots to render — empty boxes don't sprout
  // decorative circles.
  const usedByNode = new Map<string, Set<string>>();
  const note = (nodeId: string, handle: string | null | undefined) => {
    if (!handle) return;
    let set = usedByNode.get(nodeId);
    if (!set) {
      set = new Set();
      usedByNode.set(nodeId, set);
    }
    set.add(handle);
  };
  for (const e of edges) {
    note(e.source, e.sourceHandle);
    note(e.target, e.targetHandle);
  }
  for (const n of nodes) {
    const set = usedByNode.get(n.id);
    n.data = { ...n.data, usedHandles: set ? [...set] : [] };
  }

  return { nodes, edges };
}

function makeFlowEdge(source: string, target: string, events: string[], isBack: boolean): Edge {
  // Bundle: two events become "evt1 | evt2"; three or more get collapsed
  // visually with a count so labels stay readable.
  const label =
    events.length <= 2 ? events.join(" | ") : `${events[0]} | +${events.length - 1} more`;

  // Forward edges go right-center → left-center. Back-edges route under
  // the row via bottom-edge → top-edge so the line bends below instead of
  // through the row of nodes.
  const sourceHandle = isBack ? "bottom-0" : CENTER.right;
  const targetHandle = isBack ? "top-0" : CENTER.left;

  return {
    id: `${source}__${events.join(",")}__${target}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    label,
    type: "flow",
    animated: false,
    // Store the underlying event types (for pulse matching) and an empty
    // waypoint array (for manual routing — populated by the user via
    // click-to-add on the canvas).
    data: { eventType: events[0], eventTypes: events, waypoints: [] as Waypoint[] },
    pathOptions: { borderRadius: 16, offset: isBack ? 28 : 16 },
    // Allow the user to drag either endpoint to a different handle on the
    // same source/target node (the canvas restricts cross-node moves).
    reconnectable: true,
    // Arrowhead at the target end so flow direction is unambiguous.
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
      color: "#a8a29e",
    },
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
    type: "flow",
    animated: false,
    data: { eventType: label, waypoints: [] as Waypoint[] },
    pathOptions: { borderRadius: 12, offset: 12 },
    reconnectable: true,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: "#10b981",
    },
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
