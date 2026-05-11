import type { Edge, Node } from "@xyflow/react";
import type { ChannelMeta, ProcessorMeta } from "./types";
import { filterEventTypes, filterMatchesType } from "./filter";
import type { ChannelNodeData } from "../components/ChannelNode";

export interface ProcessorNodeData extends Record<string, unknown> {
  processor: ProcessorMeta;
  pulse: number;
}

const COLUMN_WIDTH = 320;
const ROW_HEIGHT = 180;

/**
 * Build React Flow nodes + edges from the agent's processors + channels.
 *
 * - Processors are laid out in topological-ish columns.
 * - Each channel becomes (up to) two channel nodes:
 *     - an "inbound" source on the far left (if it emits anything)
 *     - an "outbound" sink on the far right (if it routes anything)
 * - Edges connect channel sources → processors that filter on the channel's
 *   inbound events, and processors that emit a channel's outbound events
 *   → that channel sink.
 * - Cyclic back-edges between processors are ignored for layering and
 *   render as natural back-curves on the graph.
 */
export function buildGraph(
  processors: ProcessorMeta[],
  channels: ChannelMeta[] = [],
): {
  nodes: Node<ProcessorNodeData | ChannelNodeData>[];
  edges: Edge[];
} {
  const layers = layerProcessors(processors);
  const procColumns = layers.length;

  const nodes: Node<ProcessorNodeData | ChannelNodeData>[] = [];

  // Inbound channel sources go to the LEFT of the first processor column.
  const inboundChannels = channels.filter((c) => (c.inboundEvents ?? []).length > 0);
  for (const [rowIdx, ch] of inboundChannels.entries()) {
    nodes.push({
      id: `channel-in:${ch.name}`,
      type: "channel",
      position: { x: 80, y: 60 + rowIdx * ROW_HEIGHT },
      data: { name: ch.name, side: "in", events: ch.inboundEvents ?? [], pulse: 0 },
    });
  }

  // Processors fill the middle columns.
  const procXOffset = inboundChannels.length > 0 ? 80 + COLUMN_WIDTH : 80;
  for (const [layerIdx, layer] of layers.entries()) {
    for (const [rowIdx, p] of layer.entries()) {
      nodes.push({
        id: p.name,
        type: "processor",
        position: { x: procXOffset + layerIdx * COLUMN_WIDTH, y: 60 + rowIdx * ROW_HEIGHT },
        data: { processor: p, pulse: 0 },
      });
    }
  }

  // Outbound channel sinks go to the RIGHT of the last processor column.
  const outboundChannels = channels.filter((c) => (c.outboundEvents ?? []).length > 0);
  const outX = procXOffset + procColumns * COLUMN_WIDTH;
  for (const [rowIdx, ch] of outboundChannels.entries()) {
    nodes.push({
      id: `channel-out:${ch.name}`,
      type: "channel",
      position: { x: outX, y: 60 + rowIdx * ROW_HEIGHT },
      data: { name: ch.name, side: "out", events: ch.outboundEvents ?? [], pulse: 0 },
    });
  }

  const edges: Edge[] = [];

  // Processor → processor edges (existing logic).
  for (const emitter of processors) {
    for (const eventType of emitter.outputEvents ?? []) {
      for (const consumer of processors) {
        if (filterMatchesType(consumer.filter, eventType)) {
          edges.push(makeEdge(emitter.name, consumer.name, eventType));
        }
      }
    }
  }

  // Inbound channel → processor edges.
  for (const ch of inboundChannels) {
    for (const eventType of ch.inboundEvents ?? []) {
      for (const consumer of processors) {
        if (filterMatchesType(consumer.filter, eventType)) {
          edges.push(makeEdge(`channel-in:${ch.name}`, consumer.name, eventType));
        }
      }
    }
  }

  // Processor → outbound channel edges.
  for (const ch of outboundChannels) {
    for (const eventType of ch.outboundEvents ?? []) {
      for (const emitter of processors) {
        if ((emitter.outputEvents ?? []).includes(eventType)) {
          edges.push(makeEdge(emitter.name, `channel-out:${ch.name}`, eventType));
        }
      }
    }
  }

  return { nodes, edges };
}

function makeEdge(source: string, target: string, eventType: string): Edge {
  return {
    id: `${source}__${eventType}__${target}`,
    source,
    target,
    label: eventType,
    type: "smoothstep",
    animated: false,
    data: { eventType },
    labelStyle: {
      fontSize: 11,
      fontFamily: "ui-monospace, monospace",
      fill: "#57534e",
    },
    labelBgStyle: { fill: "#fafaf9", fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 4,
    style: { stroke: "#a8a29e", strokeWidth: 1.5 },
  };
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
