import type { Edge, Node } from "@xyflow/react";
import type { ProcessorMeta } from "./types";
import { filterEventTypes, filterMatchesType } from "./filter";

export interface ProcessorNodeData extends Record<string, unknown> {
  processor: ProcessorMeta;
  pulse: number; // ticked when this processor fires
}

const COLUMN_WIDTH = 320;
const ROW_HEIGHT = 180;

/**
 * Build React Flow nodes + edges from the agent's processor list.
 *
 * - Nodes: one per processor, laid out in topological-ish columns. Cyclic
 *   back-edges (e.g. executor's pfc_loop → hippocampus) are ignored for
 *   layering — the processor at the cycle's "entry point" (one that also
 *   takes external input) is placed greedily so the rest can chain off it.
 * - Edges: one per (emitter.outputEvent → consumer.filter) match.
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
        if (filterMatchesType(consumer.filter, eventType)) {
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
 * Place each processor on a layer (column) based on event flow.
 *
 * A processor is placed greedily as soon as at least one of its filter
 * entries is satisfied — either by an external event (input,
 * timer_fired, notification_received) or by an emitter that's already
 * been placed. Filter entries that point at unplaced emitters are
 * ignored at that moment; if those emitters get placed in a later pass,
 * the placement here doesn't move (back-edges remain back-edges).
 *
 * This handles the brain example's loop: hippocampus takes
 * `["input", "pfc_loop"]` where pfc_loop comes from executor (which
 * itself depends back through pfc → thalamus → hippocampus). Pre-fix,
 * the algorithm refused to place hippocampus until pfc_loop's emitter
 * was placed, but executor's chain ultimately required hippocampus, so
 * nothing got placed and everything fell into the layer-0 fallback.
 */
function layerProcessors(processors: ProcessorMeta[]): ProcessorMeta[][] {
  const EXTERNAL_TYPES = new Set(["input", "notification_received", "timer_fired"]);

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

      let bestResolved = -Infinity; // highest layer of any already-placed predecessor
      let hasExternal = false;

      for (const t of filterEventTypes(p.filter)) {
        if (EXTERNAL_TYPES.has(t)) {
          hasExternal = true;
          continue;
        }
        const emitters = emittersOf.get(t) ?? [];
        if (emitters.length === 0) {
          // Nothing emits this — treat as external (could be manually injected).
          hasExternal = true;
          continue;
        }
        for (const e of emitters) {
          if (e.name === p.name) continue; // self-loop
          const eLayer = layer.get(e.name);
          if (eLayer !== undefined) {
            bestResolved = Math.max(bestResolved, eLayer);
          }
          // Unresolved emitters are ignored — they become back-edges.
        }
      }

      // Place greedily if anything resolved OR there's an external trigger.
      if (hasExternal || bestResolved !== -Infinity) {
        const place = bestResolved !== -Infinity ? bestResolved + 1 : 0;
        layer.set(p.name, place);
        changed = true;
      }
    }
  }

  // Anything still unresolved (pure cycle with no entry point) — drop in layer 0.
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
