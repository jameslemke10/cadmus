"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { Waypoint } from "../lib/graph";

interface FlowEdgeData {
  eventType?: string;
  eventTypes?: string[];
  waypoints?: Waypoint[];
}

const CORNER_RADIUS = 12;

/**
 * `flow` edge type. Two routing modes:
 *
 *  - When `data.waypoints` is empty, fall back to xyflow's smoothstep router
 *    so simple edges keep the engineered look they had before.
 *  - When the user drops one or more waypoints on the line, render a polyline
 *    through them (with rounded corners) instead. The user gains full
 *    control over the path; xyflow's auto-router stops trying.
 *
 * Editing UI (only visible when the edge is `selected`):
 *   - draggable squares on each existing waypoint (drag to move),
 *   - small "+" markers on the midpoint of each segment (click to insert),
 *   - "×" on each waypoint marker on hover (click to remove).
 */
export function WaypointEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    label,
    labelStyle,
    labelBgStyle,
    style,
    selected,
    data,
    markerEnd,
  } = props;

  const { setEdges } = useReactFlow();
  const fed = (data ?? {}) as FlowEdgeData;
  const waypoints = fed.waypoints ?? [];

  // Build the geometry. For 0 waypoints, defer to smoothstep so we keep the
  // existing visual. For 1+ waypoints, run our manhattan-style router so the
  // line stays orthogonal AND enters/exits each block perpendicular to the
  // attached side — matching the "no diagonals, perpendicular stubs"
  // expectation users have for this kind of diagram.
  const { path, midX, midY } = useMemo(() => {
    if (waypoints.length === 0) {
      const [d, lx, ly] = getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        borderRadius: 16,
      });
      return { path: d, midX: lx, midY: ly };
    }
    const corners = manhattanCorners(
      { x: sourceX, y: sourceY },
      sourcePosition,
      waypoints,
      { x: targetX, y: targetY },
      targetPosition,
    );
    return {
      path: roundedPolyline(corners, CORNER_RADIUS),
      midX: corners[Math.floor(corners.length / 2)].x,
      midY: corners[Math.floor(corners.length / 2)].y,
    };
  }, [waypoints, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);

  // Mutate this edge's data.waypoints in the global edge state.
  const updateWaypoints = useCallback(
    (next: Waypoint[]) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== id) return e;
          const cur = (e.data ?? {}) as FlowEdgeData;
          return { ...e, data: { ...cur, waypoints: next } };
        }),
      );
    },
    [id, setEdges],
  );

  const removeWaypoint = useCallback(
    (idx: number) => updateWaypoints(waypoints.filter((_, i) => i !== idx)),
    [waypoints, updateWaypoints],
  );

  // Label-as-waypoint: dragging the label updates waypoints[0] (creating
  // it if needed). The line bends through the new position. This is more
  // intuitive than a separate "label position" — the label visibly grabs
  // and pulls the line.
  const setLabelWaypoint = useCallback(
    (next: Waypoint | null) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id !== id) return e;
          const cur = (e.data ?? {}) as FlowEdgeData;
          const wps = cur.waypoints ?? [];
          let nextWps: Waypoint[];
          if (next === null) {
            // Remove waypoint[0] (label snaps back to path midpoint).
            nextWps = wps.slice(1);
          } else if (wps.length === 0) {
            nextWps = [next];
          } else {
            nextWps = [next, ...wps.slice(1)];
          }
          return { ...e, data: { ...cur, waypoints: nextWps } };
        }),
      );
    },
    [id, setEdges],
  );

  // Where the label sits: at the first waypoint if one exists (the
  // "label-anchor" waypoint), else at the path midpoint.
  const labelX = waypoints.length > 0 ? waypoints[0].x : midX;
  const labelY = waypoints.length > 0 ? waypoints[0].y : midY;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
        // Wider hit zone when selected so click-to-add-waypoint is forgiving.
        // Endpoint anchors are rendered above this by xyflow, so the wider
        // zone doesn't block them.
        interactionWidth={selected ? 24 : 16}
      />
      <EdgeLabelRenderer>
        {label !== undefined && label !== null && label !== "" && (
          <DraggableLabel
            x={labelX}
            y={labelY}
            label={label}
            labelStyle={labelStyle}
            labelBgStyle={labelBgStyle}
            onDrag={(flowX, flowY) => setLabelWaypoint({ x: flowX, y: flowY })}
            onReset={() => setLabelWaypoint(null)}
          />
        )}
        {/* Render extra waypoint markers — index 0 is the label-waypoint
            already shown by the label, so skip it. */}
        {selected &&
          waypoints.slice(1).map((wp, i) => {
            const realIdx = i + 1;
            return (
              <WaypointMarker
                key={`${id}-wp-${realIdx}`}
                edgeId={id}
                index={realIdx}
                x={wp.x}
                y={wp.y}
                waypoints={waypoints}
                updateWaypoints={updateWaypoints}
                onRemove={() => removeWaypoint(realIdx)}
              />
            );
          })}
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * Edge label rendered as a draggable HTML pill. Dragging the label calls
 * `onDrag(flowX, flowY)` continuously, which the parent uses to bend the
 * line through the new label position. Double-click resets — the parent
 * removes the label-anchor waypoint and the label snaps to path midpoint.
 */
function DraggableLabel({
  x,
  y,
  label,
  labelStyle,
  labelBgStyle,
  onDrag,
  onReset,
}: {
  x: number;
  y: number;
  label: React.ReactNode;
  labelStyle?: React.CSSProperties;
  labelBgStyle?: React.CSSProperties;
  onDrag: (flowX: number, flowY: number) => void;
  onReset: () => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const draggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    onDrag(flow.x, flow.y);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        pointerEvents: "all",
        cursor: draggingRef.current ? "grabbing" : "grab",
        userSelect: "none",
        ...(labelBgStyle as React.CSSProperties),
        background: (labelBgStyle as { fill?: string } | undefined)?.fill ?? "#ffffff",
        border:
          labelBgStyle && (labelBgStyle as { stroke?: string }).stroke
            ? `1px solid ${(labelBgStyle as { stroke?: string }).stroke}`
            : "1px solid #e7e5e4",
        borderRadius: 6,
        padding: "3px 6px",
        ...(labelStyle as React.CSSProperties),
        whiteSpace: "nowrap",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      title="drag to bend the line · double-click to reset"
    >
      {label}
    </div>
  );
}

function WaypointMarker({
  index,
  x,
  y,
  waypoints,
  updateWaypoints,
  onRemove,
}: {
  edgeId: string;
  index: number;
  x: number;
  y: number;
  waypoints: Waypoint[];
  updateWaypoints: (wps: Waypoint[]) => void;
  onRemove: () => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [hover, setHover] = useState(false);
  const draggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const next = [...waypoints];
    next[index] = { x: flow.x, y: flow.y };
    updateWaypoints(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        pointerEvents: "all",
        zIndex: 10,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      title="drag to move · double-click to remove"
    >
      <div
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          background: "#1c1917",
          border: "2px solid #fafaf9",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          cursor: "grab",
        }}
      />
      {hover && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            position: "absolute",
            top: -10,
            right: -10,
            width: 16,
            height: 16,
            borderRadius: 8,
            background: "#dc2626",
            color: "white",
            border: "1px solid #fafaf9",
            fontSize: 10,
            lineHeight: "14px",
            padding: 0,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Compute the sequence of corners for an orthogonal (manhattan) path
 * through `waypoints`, exiting `source` perpendicular to its side and
 * entering `target` perpendicular to its side.
 *
 * Algorithm: walk through the points in order; for each segment, insert
 * one L-corner if needed (so the segment has exactly one bend) and
 * alternate direction. If the final entry direction doesn't match the
 * target's side, add a perpendicular stub + corner to flip.
 */
function manhattanCorners(
  source: Waypoint,
  sourcePosition: Position,
  waypoints: Waypoint[],
  target: Waypoint,
  targetPosition: Position,
): Waypoint[] {
  const sourceDir: "H" | "V" = positionToDir(sourcePosition);
  const targetDir: "H" | "V" = positionToDir(targetPosition);

  const corners: Waypoint[] = [{ ...source }];
  let dir: "H" | "V" = sourceDir;

  const intermediates = [...waypoints, target];
  for (const next of intermediates) {
    const prev = corners[corners.length - 1];
    if (dir === "H" && prev.x !== next.x) {
      corners.push({ x: next.x, y: prev.y });
    } else if (dir === "V" && prev.y !== next.y) {
      corners.push({ x: prev.x, y: next.y });
    }
    corners.push({ ...next });
    dir = dir === "H" ? "V" : "H";
  }

  // Verify that the line entered the target in `targetDir`. If not, swap
  // the last two points for a perpendicular stub so the entry is correct.
  if (corners.length >= 2) {
    const last = corners[corners.length - 1];
    const before = corners[corners.length - 2];
    const enteredDir: "H" | "V" = last.y === before.y ? "H" : "V";
    if (enteredDir !== targetDir && (last.x !== before.x || last.y !== before.y)) {
      // Pop target. Insert a stub aligned to target's required direction.
      corners.pop();
      const STUB = 30;
      const stub = stubBefore(target, targetPosition, STUB);
      // Route from previous corner to stub via one L-segment, then to target.
      const newLast = corners[corners.length - 1];
      if (targetDir === "H" && newLast.y !== stub.y) {
        corners.push({ x: newLast.x, y: stub.y });
      } else if (targetDir === "V" && newLast.x !== stub.x) {
        corners.push({ x: stub.x, y: newLast.y });
      }
      corners.push(stub);
      corners.push({ ...target });
    }
  }

  return corners;
}

function positionToDir(p: Position): "H" | "V" {
  return p === Position.Left || p === Position.Right ? "H" : "V";
}

/** Point a small stub-length away from `target` on the side it attaches. */
function stubBefore(target: Waypoint, side: Position, len: number): Waypoint {
  switch (side) {
    case Position.Left:
      return { x: target.x - len, y: target.y };
    case Position.Right:
      return { x: target.x + len, y: target.y };
    case Position.Top:
      return { x: target.x, y: target.y - len };
    case Position.Bottom:
      return { x: target.x, y: target.y + len };
  }
}

/** Build an SVG path through `points` with rounded corners of radius `r`. */
function roundedPolyline(points: Waypoint[], r: number): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
  }
  const cmds: string[] = [`M ${points[0].x},${points[0].y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dxIn = curr.x - prev.x;
    const dyIn = curr.y - prev.y;
    const lenIn = Math.hypot(dxIn, dyIn) || 1;
    const dxOut = next.x - curr.x;
    const dyOut = next.y - curr.y;
    const lenOut = Math.hypot(dxOut, dyOut) || 1;
    const radius = Math.min(r, lenIn / 2, lenOut / 2);

    const cornerInX = curr.x - (dxIn / lenIn) * radius;
    const cornerInY = curr.y - (dyIn / lenIn) * radius;
    const cornerOutX = curr.x + (dxOut / lenOut) * radius;
    const cornerOutY = curr.y + (dyOut / lenOut) * radius;

    cmds.push(`L ${cornerInX},${cornerInY}`);
    cmds.push(`Q ${curr.x},${curr.y} ${cornerOutX},${cornerOutY}`);
  }
  const last = points[points.length - 1];
  cmds.push(`L ${last.x},${last.y}`);
  return cmds.join(" ");
}

/** Squared distance from point p to segment ab. */
function distToSegment(p: Waypoint, a: Waypoint, b: Waypoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = p.x - a.x;
    const ddy = p.y - a.y;
    return ddx * ddx + ddy * ddy;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ddx = p.x - cx;
  const ddy = p.y - cy;
  return ddx * ddx + ddy * ddy;
}
