"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { ProcessorNodeData } from "../lib/graph";
import { filterEntryLabel } from "../lib/filter";
import { ALL_HANDLES } from "../lib/handles";

const TEMPLATE_COLORS: Record<string, string> = {
  llm_call: "bg-violet-50 border-violet-200 text-violet-900",
  llm_loop: "bg-indigo-50 border-indigo-200 text-indigo-900",
  code: "bg-amber-50 border-amber-200 text-amber-900",
};

const SIDE_TO_POSITION = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
} as const;

export function ProcessorNode({ data, selected }: NodeProps<Node<ProcessorNodeData>>) {
  const { processor, pulse, usedHandles, revealAllHandles, running } = data;
  const colorClass = TEMPLATE_COLORS[processor.template] ?? "bg-stone-50 border-stone-200";
  const isFiring = Date.now() - pulse < 800;

  // Render every position-handle so xyflow can route to any of them. The
  // ones not currently in use are visually invisible until the user starts
  // a reconnect drag (xyflow swaps in `.connectingto` styling) — that's
  // what makes the whole perimeter feel like a continuous attach surface.
  const used = new Set(usedHandles ?? []);

  // Visual priority: running > firing-pulse > selected > idle. Running
  // gets a sustained amber ring with a pulse animation so the user can
  // see at a glance which boxes are doing work right now.
  const ringClass = running
    ? "ring-2 ring-amber-400 ring-offset-2 shadow-lg animate-pulse"
    : isFiring
      ? "ring-2 ring-emerald-400 ring-offset-2 shadow-lg"
      : selected
        ? "ring-2 ring-stone-900 ring-offset-2"
        : "";

  return (
    <div className={`min-w-[230px] rounded-xl border bg-white shadow-sm transition-all ${ringClass}`}>
      {running && (
        <div className="absolute -top-2 -right-2 z-10 inline-flex items-center gap-1 rounded-full bg-amber-400 text-stone-900 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 shadow">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-stone-900 animate-pulse" />
          thinking
        </div>
      )}
      {ALL_HANDLES.map((h) => {
        const isUsed = used.has(h.id);
        const sideStyle =
          h.side === "top" || h.side === "bottom"
            ? { left: `${h.fraction * 100}%` }
            : { top: `${h.fraction * 100}%` };
        // Visual styling tiers:
        //   - in active edge → solid dark dot
        //   - reveal mode (reconnect) → light dot so user sees drop targets
        //   - idle and unused → fully transparent (still hit-testable for drops)
        const background = isUsed
          ? "#a8a29e"
          : revealAllHandles
            ? "#d6d3d1"
            : "transparent";
        const border = isUsed
          ? "1px solid white"
          : revealAllHandles
            ? "1px solid white"
            : "1px solid transparent";
        return (
          <Handle
            key={h.id}
            id={h.id}
            type="source"
            position={SIDE_TO_POSITION[h.side]}
            style={{
              background,
              border,
              width: 8,
              height: 8,
              ...sideStyle,
            }}
          />
        );
      })}

      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold text-sm tracking-tight">{processor.name}</div>
          <span
            className={`text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border ${colorClass}`}
          >
            {processor.template}
          </span>
        </div>
        {processor.template.startsWith("llm") && processor.templateConfig?.model && (
          <div className="mt-0.5 text-[11px] font-mono text-stone-400">
            {processor.templateConfig.model}
          </div>
        )}
      </div>

      <div className="px-3 pb-3 space-y-1.5">
        <div className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
          listens to
        </div>
        <div className="flex flex-wrap gap-1">
          {processor.filter.map((f, i) => {
            const label = filterEntryLabel(f);
            return (
              <span
                key={`${label}_${i}`}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 text-stone-700"
                title={typeof f === "string" ? undefined : `type: ${f.type}${f.source ? `\nsource: ${f.source}` : ""}`}
              >
                {label}
              </span>
            );
          })}
        </div>

        {processor.outputEvents.length > 0 && (
          <>
            <div className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold pt-1">
              emits
            </div>
            <div className="flex flex-wrap gap-1">
              {processor.outputEvents.map((e) => (
                <span
                  key={e}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-100"
                >
                  {e}
                </span>
              ))}
            </div>
          </>
        )}

        {processor.tools.length > 0 && (
          <>
            <div className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold pt-1">
              tools
            </div>
            <div className="flex flex-wrap gap-1">
              {processor.tools.map((t) => (
                <span
                  key={t}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-100"
                >
                  {t}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
