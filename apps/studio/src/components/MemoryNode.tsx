"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ALL_HANDLES } from "../lib/handles";

export interface MemoryNodeData extends Record<string, unknown> {
  pulse: number;
  usedHandles: string[];
  revealAllHandles: boolean;
}

const SIDE_TO_POSITION = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
} as const;

export function MemoryNode({ data, selected }: NodeProps<Node<MemoryNodeData>>) {
  const isFiring = Date.now() - data.pulse < 800;
  const used = new Set(data.usedHandles ?? []);

  return (
    <div
      className={`min-w-[120px] rounded-xl bg-white shadow-sm transition-all border-2 ${
        selected ? "ring-2 ring-stone-900 ring-offset-2" : ""
      } ${isFiring ? "ring-2 ring-emerald-400 ring-offset-2 shadow-lg border-emerald-500" : "border-emerald-400"}`}
    >
      {ALL_HANDLES.map((h) => {
        const isUsed = used.has(h.id);
        const sideStyle =
          h.side === "top" || h.side === "bottom"
            ? { left: `${h.fraction * 100}%` }
            : { top: `${h.fraction * 100}%` };
        const background = isUsed
          ? "#10b981"
          : data.revealAllHandles
            ? "#a7f3d0"
            : "transparent";
        const border = isUsed
          ? "1px solid white"
          : data.revealAllHandles
            ? "1px solid white"
            : "1px solid transparent";
        return (
          <Handle
            key={h.id}
            id={h.id}
            type="source"
            position={SIDE_TO_POSITION[h.side]}
            style={{ background, border, width: 8, height: 8, ...sideStyle }}
          />
        );
      })}

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
