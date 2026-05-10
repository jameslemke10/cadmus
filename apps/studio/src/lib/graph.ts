import type { Edge, Node } from "@xyflow/react";
import type { ProcessorMeta } from "./types";

export interface ProcessorNodeData extends Record<string, unknown> {
  processor: ProcessorMeta;
  pulse: number; // ticked when this processor fires
}

const COLUMN_WIDTH = 320;
const ROW_HEIGHT = 180;

/**
 * Build React Flow nodes + edges from the agent's processor list.
 *
 * - Nodes: one per processor. Layout: topological-ish columns (event-source
 *   roots on the left, terminal processors on the right). Falls back to a
 *   simple grid if there are cycles.
 * - Edges: one per (emitter.outputEvents ∩ consumer.filter) overlap, labelled
 *   with the event type. Multiple overlaps between the same pair become
 *   multiple edges (one per event type).
 */
export function buildGraph(processors: ProcessorMeta[]): {
  nodes: Node<ProcessorNodeData>[];
  edges: Edge[];
} {
  const layers = layerProcessors(processors);

  const nodes: Node<ProcessorNodeData>[] = [];
  for (const [layerIdx, layer] of layers.entries()) {
    for (const [rowIdx, p] of layer.entries()) {
      nodes.push({
        id: p.name,
        type: "processor",
        position: { x: 80 + layerIdx * COLUMN_WIDTH, y: 60 + rowIdx * ROW_HEIGHT },
        data: { processor: p, pulse: 0 },
      });
    }
  }

  const edges: Edge[] = [];
  for (const emitter of processors) {
    for (const eventType of emitter.outputEvents ?? []) {
      for (const consumer of processors) {
        if (consumer.filter.includes(eventType)) {
          edges.push({
            id: `${emitter.name}__${eventType}__${consumer.name}`,
            source: emitter.name,
            target: consumer.name,
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
          });
        }
      }
    }
  }

  return { nodes, edges };
}

/**
 * Group processors into layers based on event flow:
 * Layer 0 = processors whose filter is satisfied by external events
 * (input, notification_received, timer_fired) only.
 * Layer N = processors whose filter is satisfied by events emitted by
 * processors in layers ≤ N-1.
 */
function layerProcessors(processors: ProcessorMeta[]): ProcessorMeta[][] {
  const EXTERNAL_TYPES = new Set(["input", "notification_received", "timer_fired"]);
  const byName = new Map(processors.map((p) => [p.name, p] as const));

  // Map event type -> processors that emit it.
  const emittersOf = new Map<string, ProcessorMeta[]>();
  for (const p of processors) {
    for (const t of p.outputEvents ?? []) {
      if (!emittersOf.has(t)) emittersOf.set(t, []);
      emittersOf.get(t)!.push(p);
    }
  }

  const layer = new Map<string, number>();
  let progress = true;
  // up to N passes — handles linear chains and joins, not cycles.
  for (let pass = 0; pass < processors.length + 2 && progress; pass++) {
    progress = false;
    for (const p of processors) {
      if (layer.has(p.name)) continue;

      let maxPredecessor = -1;
      let allResolved = true;
      for (const t of p.filter) {
        if (EXTERNAL_TYPES.has(t)) {
          maxPredecessor = Math.max(maxPredecessor, -1); // external = layer 0 input
          continue;
        }
        const emitters = emittersOf.get(t) ?? [];
        if (emitters.length === 0) {
          // nothing emits this — treat as external
          continue;
        }
        let bestEmitterLayer = -Infinity;
        let anyEmitterUnresolved = false;
        for (const e of emitters) {
          if (e.name === p.name) continue; // self-loop, ignore
          const eLayer = layer.get(e.name);
          if (eLayer === undefined) {
            anyEmitterUnresolved = true;
          } else {
            bestEmitterLayer = Math.max(bestEmitterLayer, eLayer);
          }
        }
        if (anyEmitterUnresolved && bestEmitterLayer === -Infinity) {
          allResolved = false;
          break;
        }
        if (bestEmitterLayer !== -Infinity) {
          maxPredecessor = Math.max(maxPredecessor, bestEmitterLayer);
        }
      }

      if (allResolved) {
        layer.set(p.name, maxPredecessor + 1);
        progress = true;
      }
    }
  }

  // Anything still unresolved (cycles) — drop in layer 0.
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
