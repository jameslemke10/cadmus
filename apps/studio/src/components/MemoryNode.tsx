"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface MemoryNodeData extends Record<string, unknown> {
  pulse: number;
}

export function MemoryNode({ data, selected }: NodeProps<Node<MemoryNodeData>>) {
  const isFiring = Date.now() - data.pulse < 800;

  return (
    <div
      className={`min-w-[140px] rounded-xl bg-white shadow-sm transition-all ${
        selected ? "ring-2 ring-stone-900 ring-offset-2" : ""
      } ${
        isFiring
          ? "ring-2 ring-emerald-400 ring-offset-2 shadow-lg border-2 border-emerald-400"
          : "border-2 border-rose-300"
      }`}
    >
      {/* Two left-side handles so read (search/get) and write (write/delete)
          can render with different vertical positions. We expose generic
          ports here; the edges set sourceHandle/targetHandle explicitly. */}
      <Handle
        type="target"
        position={Position.Left}
        id="write-in"
        style={{ background: "#ef4444", top: "30%" }}
      />
      <Handle
        type="source"
        position={Position.Left}
        id="read-out"
        style={{ background: "#10b981", top: "70%" }}
      />

      <div className="px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[9px] uppercase tracking-wider text-rose-700 font-semibold">
            ◇ memory
          </span>
        </div>
        <div className="font-semibold text-sm tracking-tight text-stone-900">
          store
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-100">
            read
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-100">
            write
          </span>
        </div>
      </div>
    </div>
  );
}
