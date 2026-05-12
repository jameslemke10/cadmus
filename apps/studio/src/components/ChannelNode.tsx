"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ALL_HANDLES } from "../lib/handles";

export interface ChannelNodeData extends Record<string, unknown> {
  name: string;
  /** "in" = source (emits input events), "out" = sink (routes output events). */
  side: "in" | "out";
  events: string[];
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

export function ChannelNode({ data, selected }: NodeProps<Node<ChannelNodeData>>) {
  const isFiring = Date.now() - data.pulse < 800;
  const isInbound = data.side === "in";

  const used = new Set(data.usedHandles ?? []);

  return (
    <div
      className={`min-w-[140px] rounded-2xl border-2 bg-white shadow-sm transition-all ${
        selected ? "ring-2 ring-stone-900 ring-offset-2" : ""
      } ${isFiring ? "ring-2 ring-emerald-400 ring-offset-2 shadow-lg border-emerald-400" : "border-sky-300"}`}
    >
      {ALL_HANDLES.map((h) => {
        const isUsed = used.has(h.id);
        const sideStyle =
          h.side === "top" || h.side === "bottom"
            ? { left: `${h.fraction * 100}%` }
            : { top: `${h.fraction * 100}%` };
        const background = isUsed
          ? "#a8a29e"
          : data.revealAllHandles
            ? "#d6d3d1"
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
          <span className="text-[9px] uppercase tracking-wider text-sky-700 font-semibold">
            {isInbound ? "↘ inbound" : "↗ outbound"}
          </span>
        </div>
        <div className="font-semibold text-sm tracking-tight text-stone-900">
          channel:{data.name}
        </div>
        {data.events.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {data.events.map((e) => (
              <span
                key={e}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-100"
              >
                {e}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
