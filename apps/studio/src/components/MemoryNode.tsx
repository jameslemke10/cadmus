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
      {/* Handles on all four sides — edges to/from memory can come from any
          processor regardless of where it sits on the canvas. */}
      <Handle id="left-in" type="target" position={Position.Left} style={{ background: "#a8a29e" }} />
      <Handle id="left-out" type="source" position={Position.Left} style={{ background: "#a8a29e" }} />
      <Handle id="top-in" type="target" position={Position.Top} style={{ background: "#a8a29e" }} />
      <Handle id="top-out" type="source" position={Position.Top} style={{ background: "#a8a29e" }} />
      <Handle id="bottom-in" type="target" position={Position.Bottom} style={{ background: "#a8a29e" }} />
      <Handle id="bottom-out" type="source" position={Position.Bottom} style={{ background: "#a8a29e" }} />
      <Handle id="right-in" type="target" position={Position.Right} style={{ background: "#a8a29e" }} />
      <Handle id="right-out" type="source" position={Position.Right} style={{ background: "#a8a29e" }} />

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
