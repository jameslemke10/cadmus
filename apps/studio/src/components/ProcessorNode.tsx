"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { ProcessorNodeData } from "../lib/graph";

const TEMPLATE_COLORS: Record<string, string> = {
  llm: "bg-violet-50 border-violet-200 text-violet-900",
  code: "bg-amber-50 border-amber-200 text-amber-900",
};

export function ProcessorNode({ data, selected }: NodeProps<Node<ProcessorNodeData>>) {
  const { processor, pulse } = data;
  const colorClass = TEMPLATE_COLORS[processor.template] ?? "bg-stone-50 border-stone-200";
  const isFiring = Date.now() - pulse < 800;

  return (
    <div
      className={`min-w-[230px] rounded-xl border bg-white shadow-sm transition-all ${
        selected ? "ring-2 ring-stone-900 ring-offset-2" : ""
      } ${isFiring ? "ring-2 ring-emerald-400 ring-offset-2 shadow-lg" : ""}`}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#a8a29e" }} />

      <div className="px-3 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold text-sm tracking-tight">{processor.name}</div>
          <span
            className={`text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border ${colorClass}`}
          >
            {processor.template}
          </span>
        </div>
        {processor.template === "llm" && processor.templateConfig?.model && (
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
          {processor.filter.map((f) => (
            <span
              key={f}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100 text-stone-700"
            >
              {f}
            </span>
          ))}
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

      <Handle type="source" position={Position.Right} style={{ background: "#a8a29e" }} />
    </div>
  );
}
