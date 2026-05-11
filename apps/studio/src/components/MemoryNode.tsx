"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface MemoryNodeData extends Record<string, unknown> {
  pulse: number;
}

export function MemoryNode({ data, selected }: NodeProps<Node<MemoryNodeData>>) {
  const isFiring = Date.now() - data.pulse < 800;

  return (
    <div
      className={`min-w-[120px] rounded-xl bg-white shadow-sm transition-all border-2 ${
        selected ? "ring-2 ring-stone-900 ring-offset-2" : ""
      } ${isFiring ? "ring-2 ring-emerald-400 ring-offset-2 shadow-lg border-emerald-500" : "border-emerald-400"}`}
    >
      {/* Top handles — paired with processors' bottom handles. write comes
          in, read goes out. Offsetting them so they don't collide visually. */}
      <Handle
        id="write-in"
        type="target"
        position={Position.Top}
        style={{ background: "#10b981", left: "38%" }}
      />
      <Handle
        id="read-out"
        type="source"
        position={Position.Top}
        style={{ background: "#10b981", left: "62%" }}
      />

      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[9px] uppercase tracking-wider text-emerald-700 font-semibold">
            ◇ memory
          </span>
        </div>
        <div className="font-semibold text-sm tracking-tight text-stone-900">
          store
        </div>
      </div>
    </div>
  );
}
