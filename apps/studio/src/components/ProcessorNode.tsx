"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { ProcessorNodeData } from "../lib/graph";
import { filterEntryLabel } from "../lib/filter";

const TEMPLATE_COLORS: Record<string, string> = {
  llm_call: "bg-violet-50 border-violet-200 text-violet-900",
  llm_loop: "bg-indigo-50 border-indigo-200 text-indigo-900",
  code: "bg-amber-50 border-amber-200 text-amber-900",
};

export function ProcessorNode({ data, selected }: NodeProps<Node<ProcessorNodeData>>) {
  const { processor, pulse } = data;
  const colorClass = TEMPLATE_COLORS[processor.template] ?? "bg-stone-50 border-stone-200";
  const isFiring = Date.now() - pulse < 800;
  const usesMemory = (processor.tools ?? []).some((t) =>
    ["memory_search", "memory_get", "memory_write", "memory_delete"].includes(t),
  );

  return (
    <div
      className={`min-w-[230px] rounded-xl border bg-white shadow-sm transition-all ${
        selected ? "ring-2 ring-stone-900 ring-offset-2" : ""
      } ${isFiring ? "ring-2 ring-emerald-400 ring-offset-2 shadow-lg" : ""}`}
    >
      {/* Forward flow: events come in the left, go out the right. */}
      <Handle id="in" type="target" position={Position.Left} style={{ background: "#a8a29e" }} />
      <Handle id="out" type="source" position={Position.Right} style={{ background: "#a8a29e" }} />

      {/* Back-edge handles. When a downstream processor emits an event that
          re-triggers an upstream one (the brain's pfc_loop is the canonical
          case), routing through left/right would force the line through the
          middle of the row. Bottom-out from the looper, top-in to the
          retrigger target — the line bends under the row instead. */}
      <Handle
        id="back-out"
        type="source"
        position={Position.Bottom}
        style={{ background: "#a8a29e", left: "20%" }}
      />
      <Handle
        id="back-in"
        type="target"
        position={Position.Top}
        style={{ background: "#a8a29e", left: "20%" }}
      />

      {/* Memory handles (bottom right): write goes out, read comes in. Only
          present when the processor declares memory_* tools. */}
      {usesMemory && (
        <>
          <Handle
            id="mem-out"
            type="source"
            position={Position.Bottom}
            style={{ background: "#10b981", left: "62%" }}
          />
          <Handle
            id="mem-in"
            type="target"
            position={Position.Bottom}
            style={{ background: "#10b981", left: "82%" }}
          />
        </>
      )}

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
